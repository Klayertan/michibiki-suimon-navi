"""Single-instance protection.

Two SuisuiNavi windows on one machine would race for COM10 and for the backend
port, so a second launch must decline rather than compete. It must never
terminate or disturb the running instance.

Authoritative mechanism: a **named kernel object**.

* Windows -- a named mutex (``CreateMutexW``). The kernel owns the name, so
  existence is decided atomically by the OS, and the object disappears the
  moment the last handle closes. A crash therefore frees it automatically:
  there is no stale state to reclaim and no liveness check to get wrong.
* POSIX -- an ``flock`` on a lock file, which has the same crash-release
  property. Used for development and CI on non-Windows machines.

Why not a PID file
------------------
The previous implementation stored a PID and asked "is that process alive?"
via ``os.kill(pid, 0)``. On POSIX that is a valid no-op probe; **on Windows it
is not a probe at all**. CPython implements ``os.kill`` on Windows as::

    handle = OpenProcess(PROCESS_ALL_ACCESS, FALSE, pid)
    TerminateProcess(handle, signal)

so ``os.kill(pid, 0)`` either raises (when ``OpenProcess`` is denied) or
*terminates the target process*. Observed in practice: ``OpenProcess`` failed,
the exception was read as "process is gone", the lock was treated as stale, and
a second full application started. Had ``OpenProcess`` succeeded it would have
killed the running instance instead. ``os.kill`` appears nowhere in this module
now, and a test asserts that.

A small JSON file is still written, but **only for diagnostics** (which port
the running instance chose, when it started). Nothing reads it to decide
whether to start.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: Stable, application-specific identity for the kernel object. Generated once
#: for SuisuiNavi and never derived from a path or version -- two builds
#: installed in different folders are still the same application and must not
#: both open COM10.
APP_GUID = "9f2b7c41-5a3e-4d18-b6c0-71e4d9a2f83b"

#: ``Local\`` scopes the name to the current login session, which is what a
#: desktop application wants: two different signed-in users each get their own
#: instance, but one user cannot start it twice.
MUTEX_NAME = rf"Local\SuisuiNavi.Desktop.{APP_GUID}"

#: Windows: the named object already existed, so somebody else has it.
ERROR_ALREADY_EXISTS = 183

#: Process exit code used when a second instance declines to start. Documented
#: in docs/DESKTOP_OPERATOR_GUIDE.md and asserted by the packaged smoke test.
EXIT_ALREADY_RUNNING = 3


class SingleInstanceError(RuntimeError):
    """Base class for single-instance failures."""


class AlreadyRunningError(SingleInstanceError):
    """Another live instance holds the application's named object."""


class GuardUnavailableError(SingleInstanceError):
    """The OS refused to create the named object.

    Distinct from :class:`AlreadyRunningError`: this means the guard itself
    could not be established (a kernel-object failure, a denied namespace),
    which is an environment problem the operator must be told about rather
    than a normal "already running".
    """


class InstanceGuard(Protocol):
    """A held-for-process-lifetime exclusion primitive."""

    def acquire(self) -> None: ...
    def release(self) -> None: ...
    @property
    def held(self) -> bool: ...


# --------------------------------------------------------------------------
# Windows: named mutex
# --------------------------------------------------------------------------


def load_kernel32() -> Any:
    """Return a configured ``kernel32`` handle, or raise on non-Windows."""
    import ctypes  # noqa: PLC0415 - Windows only
    from ctypes import wintypes  # noqa: PLC0415

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
    kernel32.ReleaseMutex.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    return kernel32


class WindowsMutexGuard:
    """Single-instance guard backed by a named Windows mutex.

    The handle is deliberately kept open for the whole process lifetime: the
    kernel destroys the named object when the last handle closes, so holding
    it *is* the exclusion. Closing it early would let a second instance in.
    """

    def __init__(self, name: str = MUTEX_NAME, *, kernel32: Any = None, get_last_error: Any = None) -> None:
        self.name = name
        # Injected in tests so this class can be exercised on any OS.
        self._kernel32 = kernel32
        self._get_last_error = get_last_error
        self._handle: int | None = None
        self._owns_object = False

    @property
    def held(self) -> bool:
        return self._handle is not None and self._owns_object

    def _api(self) -> tuple[Any, Any]:
        if self._kernel32 is not None:
            getter = self._get_last_error
            if getter is None:
                import ctypes  # noqa: PLC0415

                getter = ctypes.get_last_error
            return self._kernel32, getter
        import ctypes  # noqa: PLC0415

        return load_kernel32(), ctypes.get_last_error

    def acquire(self) -> None:
        """Create the named mutex, or report that it already exists.

        Raises:
            AlreadyRunningError: the named object exists -- another instance.
            GuardUnavailableError: the API call itself failed.
        """
        if self.held:
            return

        kernel32, get_last_error = self._api()

        # bInitialOwner=True: we take ownership when we are the creator. The
        # decisive signal is ERROR_ALREADY_EXISTS, which reports whether the
        # *name* was already present regardless of ownership.
        handle = kernel32.CreateMutexW(None, True, self.name)
        last_error = get_last_error()

        if not handle:
            raise GuardUnavailableError(
                f"Windows could not create the single-instance mutex "
                f"({self.name!r}, error {last_error}). SuisuiNavi cannot guarantee that only one "
                f"copy is running, so it will not start."
            )

        if last_error == ERROR_ALREADY_EXISTS:
            # Somebody else owns the application. Close our handle to the
            # existing object immediately -- keeping it would delay the real
            # owner's cleanup when it exits.
            with contextlib.suppress(Exception):
                kernel32.CloseHandle(handle)
            raise AlreadyRunningError(
                "SuisuiNavi is already running. Switch to the existing SuisuiNavi window "
                "instead of starting a second copy."
            )

        self._handle = handle
        self._owns_object = True
        logger.info("single-instance mutex acquired: %s", self.name)

    def release(self) -> None:
        """Release and close the mutex. Idempotent; never raises."""
        handle, self._handle = self._handle, None
        owned, self._owns_object = self._owns_object, False
        if handle is None:
            return

        kernel32, _ = self._api()
        if owned:
            # Releasing before closing is not strictly required (closing the
            # last handle destroys the object either way) but it is the
            # correct pairing for a mutex we took ownership of, and it keeps
            # the object from being reported as abandoned.
            with contextlib.suppress(Exception):
                kernel32.ReleaseMutex(handle)
        with contextlib.suppress(Exception):
            kernel32.CloseHandle(handle)
        logger.info("single-instance mutex released: %s", self.name)


# --------------------------------------------------------------------------
# POSIX: flock
# --------------------------------------------------------------------------


class PosixFlockGuard:
    """Single-instance guard backed by ``flock`` on a lock file.

    Same crash-release property as the Windows mutex: the kernel drops the
    lock when the process dies, so there is no stale state and no liveness
    check. Used on development/CI machines that are not Windows.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._descriptor: int | None = None

    @property
    def held(self) -> bool:
        return self._descriptor is not None

    def acquire(self) -> None:
        if self.held:
            return
        import fcntl  # noqa: PLC0415 - POSIX only

        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(descriptor)
            raise AlreadyRunningError(
                "SuisuiNavi is already running. Switch to the existing SuisuiNavi window "
                "instead of starting a second copy."
            ) from error
        self._descriptor = descriptor
        logger.info("single-instance flock acquired: %s", self.path)

    def release(self) -> None:
        descriptor, self._descriptor = self._descriptor, None
        if descriptor is None:
            return
        with contextlib.suppress(Exception):
            import fcntl  # noqa: PLC0415

            fcntl.flock(descriptor, fcntl.LOCK_UN)
        with contextlib.suppress(Exception):
            os.close(descriptor)
        logger.info("single-instance flock released: %s", self.path)


def build_guard(state_path: Path, *, force_posix: bool = False) -> InstanceGuard:
    """Choose the right guard for this platform."""
    if sys.platform == "win32" and not force_posix:
        return WindowsMutexGuard()
    return PosixFlockGuard(state_path.with_suffix(".flock"))


# --------------------------------------------------------------------------
# Diagnostics-only state file
# --------------------------------------------------------------------------


def read_state(path: Path) -> dict[str, Any] | None:
    """Read the diagnostics state file, or ``None``.

    Purely informational -- which port the running instance chose, when it
    started. **Never** consulted to decide whether to start; that decision
    belongs entirely to the kernel object.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        logger.debug("diagnostics state file at %s is unreadable (%s)", path, error)
        return None
    return raw if isinstance(raw, dict) else None


class SingleInstanceLock:
    """Application-level single-instance guard.

    Wraps the platform guard (the authority) and a diagnostics state file
    (informational). Usable as a context manager::

        with SingleInstanceLock(path, version="0.1.0"):
            ...  # only one process reaches here at a time
    """

    def __init__(
        self,
        path: Path,
        *,
        version: str = "",
        payload: dict[str, Any] | None = None,
        guard: InstanceGuard | None = None,
    ) -> None:
        self.path = Path(path)
        self.version = version
        self.payload = payload or {}
        self._guard = guard if guard is not None else build_guard(self.path)
        self._acquired = False

    @property
    def acquired(self) -> bool:
        return self._acquired

    @property
    def guard(self) -> InstanceGuard:
        return self._guard

    def acquire(self) -> "SingleInstanceLock":
        """Take the guard, then write the diagnostics file.

        Raises:
            AlreadyRunningError: another instance holds the application.
            GuardUnavailableError: the guard could not be established.
        """
        self._guard.acquire()  # authoritative; raises if taken
        self._acquired = True
        self._write_state(
            {
                "pid": os.getpid(),
                "startedAt": time.time(),
                "version": self.version,
                "note": "diagnostics only; the named kernel object is the authority",
                **self.payload,
            }
        )
        return self

    def update(self, **fields: Any) -> None:
        """Merge extra diagnostics (backend URL, port) into the state file."""
        if not self._acquired:
            return
        document = read_state(self.path) or {"pid": os.getpid(), "version": self.version}
        document.update(fields)
        self._write_state(document)

    def _write_state(self, document: dict[str, Any]) -> None:
        """Best-effort: losing diagnostics must never affect correctness."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(document, indent=2), encoding="utf-8")
        except (OSError, ValueError) as error:
            logger.warning("could not write the diagnostics state file at %s: %s", self.path, error)

    def release(self) -> None:
        """Release the guard and remove the state file. Never raises.

        The guard is released first and unconditionally: even if the state
        file cannot be removed, the next launch must be able to start.
        """
        if not self._acquired:
            # Still close any handle the guard may hold from a partial
            # acquire, so a failed startup cannot leak the mutex.
            with contextlib.suppress(Exception):
                self._guard.release()
            return
        self._acquired = False

        try:
            self._guard.release()
        except Exception:  # noqa: BLE001 - shutdown must continue
            logger.exception("error releasing the single-instance guard")

        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            logger.warning("could not remove the diagnostics state file at %s: %s", self.path, error)

    def __enter__(self) -> "SingleInstanceLock":
        return self.acquire()

    def __exit__(self, *exc_info: object) -> None:
        self.release()

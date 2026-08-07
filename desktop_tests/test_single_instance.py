"""Single-instance protection.

Regression coverage for a verified defect: launching SuisuiNavi.exe twice
opened two application windows. The old guard stored a PID and probed it with
``os.kill(pid, 0)``. On Windows CPython implements that as
``OpenProcess(PROCESS_ALL_ACCESS) + TerminateProcess`` -- not a probe. In the
observed failure ``OpenProcess`` was denied, the resulting ``OSError`` was read
as "the process is gone", the lock was reclaimed as stale, and a second full
application started. Had ``OpenProcess`` succeeded it would have *terminated*
the running instance instead.

The guard is now a named kernel object (a Windows mutex; ``flock`` on POSIX),
so existence is decided atomically by the OS and a crash releases it with no
stale state to reclaim.

The Windows tests inject a fake ``kernel32`` so they run unchanged on any
platform -- the point is the protocol (CreateMutexW / ERROR_ALREADY_EXISTS /
ReleaseMutex / CloseHandle), which is testable without the real API.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
for candidate in (REPO_ROOT, REPO_ROOT / "backend"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from desktop.single_instance import (  # noqa: E402
    APP_GUID,
    ERROR_ALREADY_EXISTS,
    EXIT_ALREADY_RUNNING,
    MUTEX_NAME,
    AlreadyRunningError,
    GuardUnavailableError,
    PosixFlockGuard,
    SingleInstanceLock,
    WindowsMutexGuard,
    build_guard,
    read_state,
)


# ======================================================================
# A fake Windows kernel32, modelling the real named-object semantics
# ======================================================================


class FakeKernel32:
    """Models CreateMutexW's contract for a shared namespace.

    The namespace is class-level state shared between instances, exactly like
    the real kernel's: a second "process" creating the same name observes
    ERROR_ALREADY_EXISTS.
    """

    def __init__(self, namespace: dict[str, int], *, fail_create: bool = False) -> None:
        self.namespace = namespace
        self.fail_create = fail_create
        self.last_error = 0
        self.created: list[str] = []
        self.released: list[int] = []
        self.closed: list[int] = []
        self._next_handle = 1000

    def CreateMutexW(self, security, initial_owner, name):  # noqa: N802 - Win32 name
        if self.fail_create:
            self.last_error = 5  # ERROR_ACCESS_DENIED
            return 0
        self.created.append(name)
        self._next_handle += 1
        handle = self._next_handle
        if name in self.namespace:
            # The named object exists; a handle to it is still returned.
            self.last_error = ERROR_ALREADY_EXISTS
            self.namespace[name] += 1
        else:
            self.last_error = 0
            self.namespace[name] = 1
        return handle

    def ReleaseMutex(self, handle):  # noqa: N802
        self.released.append(handle)
        return True

    def CloseHandle(self, handle):  # noqa: N802
        self.closed.append(handle)
        return True

    def get_last_error(self) -> int:
        return self.last_error


@pytest.fixture
def namespace() -> dict[str, int]:
    """A fresh kernel object namespace per test."""
    return {}


def make_guard(namespace: dict[str, int], **kwargs) -> WindowsMutexGuard:
    fake = FakeKernel32(namespace, **kwargs)
    return WindowsMutexGuard(kernel32=fake, get_last_error=fake.get_last_error)


def _release_name(namespace: dict[str, int], name: str = MUTEX_NAME) -> None:
    """Model the kernel destroying the object when the last handle closes."""
    namespace.pop(name, None)


# ======================================================================
# Mutex acquisition
# ======================================================================


def test_first_acquisition_succeeds(namespace) -> None:
    guard = make_guard(namespace)
    guard.acquire()

    assert guard.held is True
    assert MUTEX_NAME in namespace


def test_second_acquisition_reports_already_running(namespace) -> None:
    first = make_guard(namespace)
    first.acquire()

    second = make_guard(namespace)
    with pytest.raises(AlreadyRunningError) as excinfo:
        second.acquire()

    assert "already running" in str(excinfo.value).lower()
    assert second.held is False


def test_the_refused_second_instance_closes_its_handle_and_does_not_release_the_owner(namespace) -> None:
    """A refused instance must not disturb the owner: it closes only the
    handle it just opened, and never calls ReleaseMutex on somebody else's
    object."""
    first = make_guard(namespace)
    first.acquire()

    fake = FakeKernel32(namespace)
    second = WindowsMutexGuard(kernel32=fake, get_last_error=fake.get_last_error)
    with pytest.raises(AlreadyRunningError):
        second.acquire()

    assert fake.closed, "the refused instance must close the handle it opened"
    assert fake.released == [], "a refused instance must never release the owner's mutex"
    assert first.held is True, "the running instance must be untouched"


def test_mutex_remains_held_for_the_process_lifetime(namespace) -> None:
    """The handle stays open; holding it *is* the exclusion."""
    fake = FakeKernel32(namespace)
    guard = WindowsMutexGuard(kernel32=fake, get_last_error=fake.get_last_error)
    guard.acquire()

    assert guard.held is True
    assert fake.closed == [], "the handle must not be closed while the app runs"
    # A second attempt still sees it.
    with pytest.raises(AlreadyRunningError):
        make_guard(namespace).acquire()


def test_closing_the_first_instance_releases_the_mutex(namespace) -> None:
    fake = FakeKernel32(namespace)
    guard = WindowsMutexGuard(kernel32=fake, get_last_error=fake.get_last_error)
    guard.acquire()
    guard.release()

    assert guard.held is False
    assert fake.released, "an owned mutex should be released"
    assert fake.closed, "the handle must be closed"


def test_a_new_process_can_start_after_release(namespace) -> None:
    first = make_guard(namespace)
    first.acquire()
    first.release()
    _release_name(namespace)  # the kernel destroys the object with the last handle

    second = make_guard(namespace)
    second.acquire()
    assert second.held is True


def test_release_is_idempotent_and_never_raises(namespace) -> None:
    guard = make_guard(namespace)
    guard.acquire()
    guard.release()
    guard.release()  # must not raise
    assert guard.held is False


def test_releasing_a_guard_that_was_never_acquired_is_safe(namespace) -> None:
    make_guard(namespace).release()


def test_acquire_is_idempotent_for_the_owner(namespace) -> None:
    fake = FakeKernel32(namespace)
    guard = WindowsMutexGuard(kernel32=fake, get_last_error=fake.get_last_error)
    guard.acquire()
    guard.acquire()  # already held: must not create a second object
    assert len(fake.created) == 1


# ======================================================================
# Windows API failure
# ======================================================================


def test_api_failure_produces_an_actionable_error_not_a_silent_start(namespace) -> None:
    """A NULL handle means the guard could not be established. Starting anyway
    would risk two instances owning COM10, so it must refuse -- and say why."""
    guard = make_guard(namespace, fail_create=True)

    with pytest.raises(GuardUnavailableError) as excinfo:
        guard.acquire()

    message = str(excinfo.value)
    assert "mutex" in message.lower()
    assert "will not start" in message.lower()
    assert guard.held is False


def test_api_failure_is_distinct_from_already_running(namespace) -> None:
    """The two conditions need different operator responses, so they must not
    be reported as the same thing."""
    guard = make_guard(namespace, fail_create=True)
    with pytest.raises(GuardUnavailableError):
        guard.acquire()
    assert not isinstance(GuardUnavailableError("x"), AlreadyRunningError)


# ======================================================================
# The named object identity
# ======================================================================


def test_mutex_name_is_session_scoped_and_application_specific() -> None:
    assert MUTEX_NAME.startswith(r"Local\SuisuiNavi.Desktop.")
    assert APP_GUID in MUTEX_NAME


def test_mutex_name_does_not_depend_on_the_install_path_or_version() -> None:
    """Two builds in different folders are still one application and must not
    both open COM10."""
    assert str(REPO_ROOT) not in MUTEX_NAME
    assert "0.1.0" not in MUTEX_NAME


# ======================================================================
# SingleInstanceLock: guard + diagnostics file
# ======================================================================


def test_lock_acquires_the_guard_and_writes_diagnostics(tmp_path: Path, namespace) -> None:
    state = tmp_path / "suisuinavi.lock"
    lock = SingleInstanceLock(state, version="0.1.0", guard=make_guard(namespace))
    lock.acquire()

    assert lock.acquired is True
    document = read_state(state)
    assert document["version"] == "0.1.0"
    assert "diagnostics only" in document["note"]

    lock.release()
    assert not state.exists()


def test_a_second_lock_is_refused_by_the_guard_not_by_the_file(tmp_path: Path, namespace) -> None:
    """Correctness comes from the kernel object. Deleting the diagnostics file
    must not let a second instance in."""
    state = tmp_path / "suisuinavi.lock"
    first = SingleInstanceLock(state, guard=make_guard(namespace))
    first.acquire()

    state.unlink()  # sabotage the informational file

    second = SingleInstanceLock(state, guard=make_guard(namespace))
    with pytest.raises(AlreadyRunningError):
        second.acquire()


def test_a_stale_diagnostics_file_alone_does_not_block_startup(tmp_path: Path, namespace) -> None:
    """The mirror case: a leftover file from a crash must not lock the
    operator out, because nothing reads it to decide."""
    state = tmp_path / "suisuinavi.lock"
    state.write_text('{"pid": 424242, "startedAt": 0}', encoding="utf-8")

    lock = SingleInstanceLock(state, guard=make_guard(namespace))
    lock.acquire()
    assert lock.acquired is True
    lock.release()


def test_release_frees_the_guard_even_if_the_state_file_cannot_be_removed(tmp_path: Path, namespace, monkeypatch) -> None:
    """The next launch must be able to start regardless of file-system trouble."""
    state = tmp_path / "suisuinavi.lock"
    guard = make_guard(namespace)
    lock = SingleInstanceLock(state, guard=guard)
    lock.acquire()

    def refuse_unlink(self, *args, **kwargs):
        raise OSError("locked by another program")

    monkeypatch.setattr(Path, "unlink", refuse_unlink)
    lock.release()

    assert guard.held is False, "the guard must be released even when the file cannot be"


def test_exception_during_startup_still_closes_the_handle(tmp_path: Path, namespace) -> None:
    """A failure after acquiring must not leak the mutex, or the application
    could never be started again without a reboot."""
    state = tmp_path / "suisuinavi.lock"
    guard = make_guard(namespace)
    lock = SingleInstanceLock(state, guard=guard)

    try:
        with lock:
            assert guard.held is True
            raise RuntimeError("simulated startup failure")
    except RuntimeError:
        pass

    assert guard.held is False, "__exit__ must release the guard on an exception"


def test_release_after_a_failed_acquire_still_closes_any_partial_handle(tmp_path: Path, namespace) -> None:
    state = tmp_path / "suisuinavi.lock"
    first = SingleInstanceLock(state, guard=make_guard(namespace))
    first.acquire()

    second = SingleInstanceLock(state, guard=make_guard(namespace))
    with pytest.raises(AlreadyRunningError):
        second.acquire()
    second.release()  # must be safe even though acquire failed
    assert second.acquired is False


def test_update_merges_backend_diagnostics(tmp_path: Path, namespace) -> None:
    state = tmp_path / "suisuinavi.lock"
    with SingleInstanceLock(state, version="0.1.0", guard=make_guard(namespace)) as lock:
        lock.update(backendUrl="http://127.0.0.1:5555", port=5555)
        document = read_state(state)
        assert document["backendUrl"] == "http://127.0.0.1:5555"
        assert document["port"] == 5555


def test_update_before_acquire_is_a_no_op(tmp_path: Path, namespace) -> None:
    state = tmp_path / "suisuinavi.lock"
    SingleInstanceLock(state, guard=make_guard(namespace)).update(port=1)
    assert not state.exists()


def test_malformed_diagnostics_file_reads_as_none(tmp_path: Path) -> None:
    state = tmp_path / "suisuinavi.lock"
    state.write_text("{{{ not json", encoding="utf-8")
    assert read_state(state) is None


# ======================================================================
# POSIX guard (exercised natively on POSIX, structurally everywhere)
# ======================================================================


@pytest.mark.skipif(sys.platform == "win32", reason="flock is POSIX-only")
def test_posix_flock_guard_excludes_a_second_holder(tmp_path: Path) -> None:
    first = PosixFlockGuard(tmp_path / "app.flock")
    first.acquire()
    assert first.held is True

    with pytest.raises(AlreadyRunningError):
        PosixFlockGuard(tmp_path / "app.flock").acquire()

    first.release()
    second = PosixFlockGuard(tmp_path / "app.flock")
    second.acquire()
    assert second.held is True
    second.release()


def test_build_guard_selects_the_platform_mechanism(tmp_path: Path) -> None:
    guard = build_guard(tmp_path / "suisuinavi.lock")
    expected = WindowsMutexGuard if sys.platform == "win32" else PosixFlockGuard
    assert isinstance(guard, expected)


def test_build_guard_can_be_forced_to_the_portable_mechanism(tmp_path: Path) -> None:
    assert isinstance(build_guard(tmp_path / "s.lock", force_posix=True), PosixFlockGuard)


# ======================================================================
# The dangerous call must never come back
# ======================================================================


def _executable_source(path: Path) -> str:
    """Module source with comments and docstrings removed.

    Compares *code*, not prose. The module deliberately documents why
    ``os.kill`` is wrong on Windows, and a naive substring scan would flag its
    own warning -- so docstrings are stripped via the AST rather than by
    guessing at line prefixes.
    """
    import ast  # noqa: PLC0415
    import io  # noqa: PLC0415
    import tokenize  # noqa: PLC0415

    source = path.read_text(encoding="utf-8")

    # Drop every docstring node.
    tree = ast.parse(source)
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                if isinstance(body[0].value.value, str):
                    for line in range(body[0].lineno, (body[0].end_lineno or body[0].lineno) + 1):
                        docstrings.add(line)

    # Drop comments.
    comments: set[int] = set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            comments.add(token.start[0])

    return "\n".join(
        line
        for number, line in enumerate(source.splitlines(), start=1)
        if number not in docstrings and number not in comments
    )


def test_no_os_kill_anywhere_in_the_single_instance_module() -> None:
    """os.kill(pid, 0) is not a liveness probe on Windows -- CPython
    implements it as OpenProcess + TerminateProcess, so it either raises or
    kills the target. It must never reappear in executable code here."""
    code = _executable_source(REPO_ROOT / "desktop" / "single_instance.py")
    assert "os.kill" not in code, "os.kill must not be used in single-instance logic"
    assert "TerminateProcess" not in code
    assert "PROCESS_ALL_ACCESS" not in code


def test_no_os_kill_in_any_desktop_module() -> None:
    for module in sorted((REPO_ROOT / "desktop").glob("*.py")):
        code = _executable_source(module)
        assert "os.kill(" not in code, f"os.kill found in executable code of {module.name}"


def test_the_guard_uses_the_documented_win32_calls() -> None:
    """Positive counterpart to the prohibitions above: confirm the mechanism
    really is CreateMutexW + ERROR_ALREADY_EXISTS + ReleaseMutex/CloseHandle."""
    code = _executable_source(REPO_ROOT / "desktop" / "single_instance.py")
    for symbol in ("CreateMutexW", "ERROR_ALREADY_EXISTS", "ReleaseMutex", "CloseHandle"):
        assert symbol in code, f"{symbol} missing from the single-instance guard"


def test_pid_liveness_is_not_used_for_the_start_decision() -> None:
    """The authority is the kernel object; the PID is diagnostics only."""
    source = (REPO_ROOT / "desktop" / "single_instance.py").read_text(encoding="utf-8")
    assert "process_is_alive" not in source
    assert "lock_is_stale" not in source


def test_exit_code_for_a_second_instance_is_deterministic() -> None:
    assert EXIT_ALREADY_RUNNING == 3
    launcher = (REPO_ROOT / "desktop" / "launcher.py").read_text(encoding="utf-8")
    assert "return EXIT_ALREADY_RUNNING" in launcher

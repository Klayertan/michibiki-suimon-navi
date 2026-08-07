"""PyInstaller entry point for SuisuiNavi.exe.

Why this file exists
--------------------
PyInstaller executes its entry script as ``__main__``, not as a module inside
its package. Pointing the spec straight at ``desktop/launcher.py`` therefore
breaks every relative import in it::

    ImportError: attempted relative import with no known parent package

This wrapper is executed as ``__main__`` instead and imports
``desktop.launcher`` *absolutely*, so the package is imported normally and its
relative imports resolve. ``python -m desktop.launcher`` keeps working
unchanged for development.

It also makes the bundled ``backend`` importable as ``app.*`` before anything
else runs: in a frozen build both ``desktop/`` and the backend's ``app/`` are
collected into the bundle root, and the backend is imported lazily (inside
``BackendProcess.build_app``), so ``sys.path`` must already be right by then.
"""

from __future__ import annotations

import os
import sys


def _prepare_import_path() -> None:
    """Ensure ``desktop`` and ``app`` are importable in both run styles."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        roots = [sys._MEIPASS]  # type: ignore[attr-defined]
    else:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        roots = [repo_root, os.path.join(repo_root, "backend")]

    for root in roots:
        if root and root not in sys.path:
            sys.path.insert(0, root)


_prepare_import_path()

from desktop.launcher import main  # noqa: E402 - must follow the path setup

if __name__ == "__main__":
    sys.exit(main())

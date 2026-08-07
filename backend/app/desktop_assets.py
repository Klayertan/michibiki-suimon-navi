"""Serve the existing SuisuiNavi frontend from the backend, for the desktop shell.

Only used by the desktop application. The browser development workflow keeps
using ``scripts/dev-server.mjs`` on port 4173 and is completely unaffected:
:func:`mount_frontend` is never called unless the desktop launcher calls it.

Two jobs:

1. Static delivery of the *existing* files -- ``index.html``, ``css/``,
   ``js/``, ``data/`` -- with no build step, no npm, and no duplication of the
   frontend. The packaged ``.exe`` stages the same files and serves them the
   same way.
2. Injecting ``window.SUISUI_DESKTOP`` into ``index.html`` on the way out, so
   the frontend can tell it is running in the desktop shell and which runtime
   mode is active.

The injection is done on the response, never on the file: ``index.html`` on
disk is untouched, so the same file works in the browser (where the global is
simply absent).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

#: Subdirectories of the frontend root that may be served. An allow-list, not
#: a filter: a caller cannot reach `backend/`, `.venv/`, `.git/` or anything
#: else in a development checkout, because those names are simply not mounted.
SERVED_DIRECTORIES = ("css", "js", "data", "assets", "icons", "img")

#: Individual files served from the frontend root.
SERVED_ROOT_FILES = ("favicon.ico", "manifest.json", "manifest.webmanifest", "sw.js", ".nojekyll")

_INJECTION_MARKER = "<!--suisui-desktop-runtime-->"


def build_desktop_bootstrap(context: dict[str, Any]) -> str:
    """The ``<script>`` injected into ``index.html`` for desktop runs.

    Sets two globals before any module loads:

    * ``window.SUISUI_DESKTOP`` -- the desktop context (runtime mode, version,
      whether serial is even permitted). Absent in the browser, which is how
      the frontend distinguishes the two.
    * ``window.SUISUI_DRONE_BACKEND_URL`` -- pinned to the page's own origin.
      In the desktop the backend serves the frontend, so same-origin is
      correct and the hard-coded ``http://127.0.0.1:8787`` development default
      (which is a *different*, possibly absent server) must not be used.
    """
    payload = json.dumps(context, ensure_ascii=False)
    return (
        f"{_INJECTION_MARKER}\n"
        "<script>\n"
        f"window.SUISUI_DESKTOP = Object.freeze({payload});\n"
        "window.SUISUI_DRONE_BACKEND_URL = window.location.origin;\n"
        "</script>\n"
    )


def render_index(index_path: Path, context: dict[str, Any]) -> str:
    """Read ``index.html`` and inject the desktop bootstrap into its ``<head>``.

    Injected immediately after ``<head>`` so the globals exist before any
    stylesheet, script, or module on the page runs -- the frontend's own
    bootstrap reads ``SUISUI_DRONE_BACKEND_URL`` while it is evaluating, so a
    tag appended at the end of ``<body>`` would be too late.
    """
    html = index_path.read_text(encoding="utf-8")
    bootstrap = build_desktop_bootstrap(context)

    lower = html.lower()
    head_index = lower.find("<head>")
    if head_index == -1:
        # No <head> to anchor to: prepend rather than silently shipping a page
        # with no desktop context.
        logger.warning("index.html has no <head>; prepending the desktop bootstrap")
        return bootstrap + html

    insert_at = head_index + len("<head>")
    return html[:insert_at] + "\n" + bootstrap + html[insert_at:]


def mount_frontend(app: FastAPI, frontend_root: Path, *, desktop_context: dict[str, Any] | None = None) -> FastAPI:
    """Attach the static frontend to ``app``.

    Args:
        app: The FastAPI application from ``app.main.create_app``.
        frontend_root: Directory holding ``index.html`` and its asset folders.
        desktop_context: Values exposed as ``window.SUISUI_DESKTOP``.

    Raises:
        FileNotFoundError: ``index.html`` is missing -- a broken build, which
            must fail loudly at startup rather than as a blank window.

    Routes are added *after* the API routes already registered by
    ``create_app``, and none of them live under ``/api``, so the MAVLink
    surface is untouched.
    """
    root = Path(frontend_root).resolve()
    index_path = root / "index.html"
    if not index_path.is_file():
        raise FileNotFoundError(f"index.html was not found in {root}")

    context = dict(desktop_context or {})

    for name in SERVED_DIRECTORIES:
        directory = root / name
        if directory.is_dir():
            # StaticFiles resolves and confines paths to `directory`, so a
            # `../` traversal cannot escape it.
            app.mount(f"/{name}", StaticFiles(directory=str(directory)), name=f"frontend-{name}")
            logger.debug("serving frontend directory /%s from %s", name, directory)

    @app.get("/", include_in_schema=False)
    async def desktop_index() -> HTMLResponse:
        return HTMLResponse(
            render_index(index_path, context),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/index.html", include_in_schema=False)
    async def desktop_index_html() -> HTMLResponse:
        return await desktop_index()

    @app.get("/{filename}", include_in_schema=False)
    async def desktop_root_file(filename: str) -> Response:
        """Serve the handful of allow-listed files that live at the root.

        Registered last so it cannot shadow ``/api/...`` (already routed) or
        the mounted asset directories. Only exact matches from
        :data:`SERVED_ROOT_FILES` are served -- an arbitrary filename is a
        404, so this is not a general file-read endpoint.
        """
        if filename not in SERVED_ROOT_FILES:
            raise HTTPException(status_code=404, detail="Not found")
        candidate = root / filename
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(candidate, headers={"Cache-Control": "no-store"})

    logger.info("desktop frontend mounted from %s", root)
    return app

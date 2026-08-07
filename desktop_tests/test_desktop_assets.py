"""Packaged frontend asset serving.

Covers the bundle-resolution and delivery path that turns "PyInstaller staged
some files" into "the window shows the application": index.html rendering,
desktop-context injection, asset routes, and the fact that a bundle root is
not a general file-read endpoint.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]
for candidate in (REPO_ROOT, REPO_ROOT / "backend"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app.desktop_assets import (  # noqa: E402
    SERVED_DIRECTORIES,
    build_desktop_bootstrap,
    mount_frontend,
    render_index,
)


@pytest.fixture
def bundle(tmp_path: Path) -> Path:
    """A minimal staged bundle shaped like the PyInstaller output."""
    (tmp_path / "index.html").write_text(
        "<!doctype html><html><head>\n<title>SuisuiNavi</title>\n</head><body>ok</body></html>",
        encoding="utf-8",
    )
    (tmp_path / "css").mkdir()
    (tmp_path / "css" / "drone.css").write_text(".drone{}", encoding="utf-8")
    (tmp_path / "js").mkdir()
    (tmp_path / "js" / "app.js").write_text("export const x = 1;", encoding="utf-8")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "field.json").write_text("{}", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("must not be served", encoding="utf-8")
    return tmp_path


@pytest.fixture
def client(bundle: Path) -> TestClient:
    app = FastAPI()

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    mount_frontend(app, bundle, desktop_context={"mode": "preview", "modeLabel": "Preview"})
    return TestClient(app)


# ----------------------------------------------------------------------
# Desktop context injection
# ----------------------------------------------------------------------


def test_bootstrap_defines_both_globals_the_frontend_needs() -> None:
    script = build_desktop_bootstrap({"mode": "preview"})
    assert "window.SUISUI_DESKTOP" in script
    # Must be same-origin: the desktop backend serves the page, so the
    # hard-coded :8787 development default would point at the wrong server.
    assert "window.SUISUI_DRONE_BACKEND_URL = window.location.origin;" in script


def test_bootstrap_is_injected_inside_head_before_any_module_runs(bundle: Path) -> None:
    html = render_index(bundle / "index.html", {"mode": "preview"})
    head_at = html.lower().index("<head>")
    script_at = html.index("window.SUISUI_DESKTOP")
    title_at = html.lower().index("<title>")
    assert head_at < script_at < title_at, "the desktop globals must exist before the rest of <head>"


def test_injection_does_not_modify_the_file_on_disk(bundle: Path) -> None:
    original = (bundle / "index.html").read_text(encoding="utf-8")
    render_index(bundle / "index.html", {"mode": "preview"})
    assert (bundle / "index.html").read_text(encoding="utf-8") == original


def test_context_values_survive_into_the_page(client: TestClient) -> None:
    body = client.get("/").text
    assert '"mode": "preview"' in body or '"mode":"preview"' in body
    assert "Preview" in body


def test_context_is_valid_json(bundle: Path) -> None:
    script = build_desktop_bootstrap({"mode": "preview", "allowsSerial": False, "nested": {"a": 1}})
    start = script.index("Object.freeze(") + len("Object.freeze(")
    end = script.index(");", start)
    assert json.loads(script[start:end])["allowsSerial"] is False


def test_page_without_a_head_still_receives_the_context(tmp_path: Path) -> None:
    page = tmp_path / "index.html"
    page.write_text("<html><body>no head here</body></html>", encoding="utf-8")
    assert "window.SUISUI_DESKTOP" in render_index(page, {"mode": "preview"})


# ----------------------------------------------------------------------
# Asset delivery
# ----------------------------------------------------------------------


def test_index_is_served_at_root_and_at_index_html(client: TestClient) -> None:
    for path in ("/", "/index.html"):
        response = client.get(path)
        assert response.status_code == 200
        assert "SuisuiNavi" in response.text


@pytest.mark.parametrize(("path", "needle"), [("/css/drone.css", ".drone"), ("/js/app.js", "export"), ("/data/field.json", "{}")])
def test_bundled_directories_are_served(client: TestClient, path: str, needle: str) -> None:
    response = client.get(path)
    assert response.status_code == 200
    assert needle in response.text


def test_javascript_modules_get_a_usable_content_type(client: TestClient) -> None:
    """A wrong MIME type makes the browser refuse an ES module outright."""
    content_type = client.get("/js/app.js").headers["content-type"]
    assert "javascript" in content_type.lower()


def test_api_routes_are_not_shadowed_by_the_frontend(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}


def test_missing_bundle_fails_loudly_rather_than_showing_a_blank_window(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="index.html"):
        mount_frontend(FastAPI(), tmp_path)


def test_only_declared_directories_are_mounted(bundle: Path) -> None:
    """The mount list is an allow-list; a checkout's backend/ or .venv/ is
    never reachable because those names are simply not mounted."""
    assert "backend" not in SERVED_DIRECTORIES
    assert ".venv" not in SERVED_DIRECTORIES
    assert "tests" not in SERVED_DIRECTORIES


# ----------------------------------------------------------------------
# The bundle root is not a file-read endpoint
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    ["/secret.txt", "/../conftest.py", "/css/../secret.txt", "/js/../../etc/passwd"],
)
def test_arbitrary_files_are_not_served(client: TestClient, path: str) -> None:
    assert client.get(path).status_code in (404, 400)


def test_root_file_allowlist_rejects_an_unlisted_name(client: TestClient) -> None:
    assert client.get("/package.json").status_code == 404


def test_allowlisted_root_file_is_served_when_present(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    (tmp_path / "favicon.ico").write_bytes(b"\x00")
    app = FastAPI()
    mount_frontend(app, tmp_path)
    assert TestClient(app).get("/favicon.ico").status_code == 200


# ----------------------------------------------------------------------
# The real repository bundles correctly
# ----------------------------------------------------------------------


def test_the_actual_repository_frontend_mounts_and_serves(tmp_path: Path) -> None:
    """Guards the real asset layout, not just a synthetic fixture: this is
    what PyInstaller stages and what the packaged app must serve."""
    app = FastAPI()
    mount_frontend(app, REPO_ROOT, desktop_context={"mode": "preview"})
    client = TestClient(app)

    index = client.get("/")
    assert index.status_code == 200
    assert "SuisuiNavi" in index.text or "スイスイナビ" in index.text
    assert "window.SUISUI_DESKTOP" in index.text

    for asset in ("/css/drone.css", "/css/gamepad.css", "/js/drone/drone-view.js", "/js/gamepad/keyboard-provider.js"):
        assert client.get(asset).status_code == 200, f"{asset} must be served from the bundle"

    # And repository source must not be reachable through it.
    for leak in ("/backend/app/main.py", "/desktop/launcher.py", "/package.json"):
        assert client.get(leak).status_code == 404, f"{leak} must not be served"

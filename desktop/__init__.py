"""SuisuiNavi Windows desktop shell.

Wraps the existing FastAPI backend and the existing static HTML/CSS/JS
frontend in a WebView2 window so the whole application launches from one
``SuisuiNavi.exe`` with no PowerShell, no npm, and no separate browser.

Nothing in this package changes MAVLink behaviour, command safety, or the
frontend's own logic -- it starts the same backend on a loopback port, points
a WebView at it, and coordinates a clean shutdown.

Importing this package must never start a server, open a window, or touch a
serial port. :func:`desktop.launcher.main` does that, explicitly.
"""

__version__ = "0.1.0"

#: Product name used for the window title, the %LOCALAPPDATA% folder, and the
#: single-instance lock. Changing it moves the user's stored configuration.
APP_NAME = "SuisuiNavi"

"""SuisuiNavi MAVLink backend.

A local-only FastAPI service that owns the serial telemetry link to the
aircraft and exposes normalized, read-mostly telemetry to the SuisuiNavi
browser frontend.

Importing this package never opens a serial port. The link is created only
when :func:`app.main.create_app` builds a link manager and something calls
``connect()`` explicitly.
"""

__version__ = "0.1.0"

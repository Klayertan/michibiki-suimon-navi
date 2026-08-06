"""Structured logging setup.

One line per event, machine-greppable prefix, no ``print`` anywhere in the
backend. Log records carry the logger name so it is obvious whether a message
came from the link worker, the command service, or the API layer.
"""

from __future__ import annotations

import logging
import sys

_FORMAT = "%(asctime)s %(levelname)-8s %(name)-28s %(message)s"
_DATEFMT = "%Y-%m-%dT%H:%M:%S"


def configure_logging(level: str = "INFO") -> None:
    """Install a single stderr handler at ``level``.

    Idempotent: calling it twice (app factory plus uvicorn reload) does not
    duplicate handlers or duplicate every log line.
    """
    root = logging.getLogger()
    resolved = getattr(logging, level.upper(), logging.INFO)
    root.setLevel(resolved)

    for handler in root.handlers:
        if getattr(handler, "_suisui_mavlink", False):
            handler.setLevel(resolved)
            return

    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(logging.Formatter(_FORMAT, datefmt=_DATEFMT))
    handler.setLevel(resolved)
    handler._suisui_mavlink = True  # type: ignore[attr-defined]
    root.addHandler(handler)

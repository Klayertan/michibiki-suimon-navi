"""Shared pytest fixtures.

Every fixture here builds a **mock** link. No test in this suite opens a serial
port, imports pymavlink for transport, or can reach real hardware.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make `app` importable when pytest is invoked from the repository root.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import MODE_MOCK, Settings  # noqa: E402
from app.mavlink.link_manager import LinkManager  # noqa: E402
from app.mavlink.mock_connection import MockMavlinkLink, MockScenario  # noqa: E402


@pytest.fixture
def settings() -> Settings:
    """Mock-mode settings with short timeouts so tests stay fast."""
    return Settings(
        mode=MODE_MOCK,
        heartbeat_interval=0.2,
        stale_timeout=1.0,
        link_lost_timeout=2.0,
        connect_timeout=3.0,
        command_timeout=2.0,
        mode_verify_timeout=2.0,
        reconnect_delay=0.3,
        auto_reconnect=False,
        allow_safe_commands=True,
        ws_interval=0.05,
    )


@pytest.fixture
def scenario() -> MockScenario:
    return MockScenario()


@pytest.fixture
def mock_link(scenario: MockScenario) -> MockMavlinkLink:
    """A single mock link instance the test can drive scenarios through."""
    return MockMavlinkLink(target_system=1, target_component=1, scenario=scenario)


@pytest.fixture
def manager(settings: Settings, mock_link: MockMavlinkLink):
    """A link manager wired to ``mock_link``, always stopped after the test."""
    instance = LinkManager(settings, lambda: mock_link)
    try:
        yield instance
    finally:
        instance.shutdown()


def wait_until(predicate, timeout: float = 5.0, interval: float = 0.02) -> bool:
    """Poll ``predicate`` until true or ``timeout`` elapses.

    Used instead of a fixed ``sleep`` so tests finish as soon as the condition
    holds and still fail deterministically if it never does.
    """
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()

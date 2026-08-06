"""Configuration parsing and its safety defaults."""

from __future__ import annotations

import pytest

from app.config import ConfigError, Settings, load_settings


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove any SUISUI_MAVLINK_* left over from the developer's shell."""
    import os

    for key in [k for k in os.environ if k.startswith("SUISUI_MAVLINK_")]:
        monkeypatch.delenv(key, raising=False)


def test_defaults_are_the_safe_ones() -> None:
    settings = load_settings()
    assert settings.mode == "mock", "real mode must never be the default"
    assert settings.allow_safe_commands is False, "a real link must start read-only"
    assert settings.allow_arm is False
    assert settings.allow_takeoff is False
    assert settings.host == "127.0.0.1", "the backend must not default to a LAN interface"
    assert settings.require_props_removed_ack is True


def test_documented_defaults_match_the_specification() -> None:
    settings = load_settings()
    assert settings.port == "COM10"
    assert settings.baud == 57600
    assert settings.source_system == 255
    assert settings.source_component == 190
    assert settings.heartbeat_interval == 1.0
    assert settings.stale_timeout == 3.0


def test_env_overrides_are_applied(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUISUI_MAVLINK_MODE", "real")
    monkeypatch.setenv("SUISUI_MAVLINK_PORT", "COM7")
    monkeypatch.setenv("SUISUI_MAVLINK_BAUD", "115200")
    monkeypatch.setenv("SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS", "1")

    settings = load_settings()
    assert settings.is_real
    assert settings.port == "COM7"
    assert settings.baud == 115200
    assert settings.allow_safe_commands is True


def test_invalid_mode_is_rejected_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUISUI_MAVLINK_MODE", "live")
    with pytest.raises(ConfigError):
        load_settings()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("SUISUI_MAVLINK_BAUD", "not-a-number"),
        ("SUISUI_MAVLINK_BAUD", "17"),
        ("SUISUI_MAVLINK_SOURCE_SYSTEM", "300"),
        ("SUISUI_MAVLINK_HEARTBEAT_INTERVAL", "0"),
        ("SUISUI_MAVLINK_STALE_TIMEOUT", "-1"),
        ("SUISUI_MAVLINK_ALLOW_SAFE_COMMANDS", "maybe"),
        ("SUISUI_MAVLINK_HTTP_PORT", "70000"),
    ],
)
def test_unusable_values_raise_instead_of_falling_back(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(ConfigError):
        load_settings()


def test_link_lost_timeout_must_not_be_shorter_than_stale_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUISUI_MAVLINK_STALE_TIMEOUT", "10")
    monkeypatch.setenv("SUISUI_MAVLINK_LINK_LOST_TIMEOUT", "5")
    with pytest.raises(ConfigError):
        load_settings()


def test_allow_arm_flag_does_not_advertise_arming_support() -> None:
    """Even with the flag on, the reported capability stays false."""
    settings = Settings(allow_arm=True, allow_takeoff=True)
    public = settings.public_dict()
    assert public["armSupported"] is False
    assert public["takeoffSupported"] is False


def test_public_config_hides_serial_details_in_mock_mode() -> None:
    public = Settings(mode="mock").public_dict()
    assert public["port"] is None
    assert public["baud"] is None


def test_public_config_exposes_only_the_two_allowed_modes() -> None:
    assert Settings().public_dict()["allowedModes"] == ["STABILIZE", "ALT_HOLD"]

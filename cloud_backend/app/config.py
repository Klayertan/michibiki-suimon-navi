"""Environment-driven settings for the SuisuiNavi cloud (accounts/fields) API.

Network posture
---------------
This service is the ONE public-facing backend in this repository. It owns
user accounts and per-user field/observation data. It must never gain a
dependency on ``backend/`` (the local MAVLink/drone service) — see
docs/AUTH_ARCHITECTURE.md's "Security boundary" section for why that
separation is load-bearing, not incidental.

All secrets (database URL, session signing material, SMTP credentials) come
from the environment / a server-side ``.env`` file, never from a value
committed to this repository. See ``.env.example`` for the documented list.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "production"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SUISUI_CLOUD_", env_file=".env", extra="ignore")

    environment: Environment = "development"

    # -- database ---------------------------------------------------------
    # Async URL used by the running app, e.g.
    #   postgresql+asyncpg://user:pass@127.0.0.1:5432/suisuinavi
    database_url: str = "postgresql+asyncpg://suisuinavi:suisuinavi@127.0.0.1:5432/suisuinavi"

    # -- sessions -----------------------------------------------------------
    # Opaque server-side sessions (see app/security.py): the cookie carries a
    # random token whose HASH is looked up in the `sessions` table. There is
    # no JWT and nothing here is decoded client-side, so this key protects
    # nothing cryptographically important on its own — it exists as a second
    # factor mixed into the token derivation, not as a signing secret whose
    # compromise alone forges a session. It still must never be committed.
    session_secret: str = Field(default="", description="Required in production; see .env.example")
    session_cookie_name: str = "suisui_session"
    # Empty by default = a host-only cookie (no Domain attribute at all),
    # which is what every non-production topology needs: local dev
    # (127.0.0.1), the Docker Compose integration environment (Phase 15),
    # and this test suite all talk to the API on a host that is not a
    # subdomain of suisuinavi.sakura.ne.jp, and a browser/HTTP client
    # rejects outright any Set-Cookie whose Domain isn't the responding
    # host or one of its parents — a non-empty default here would silently
    # break session cookies everywhere except the one real production host.
    # Production sets SUISUI_CLOUD_SESSION_COOKIE_DOMAIN=.suisuinavi.sakura.ne.jp
    # explicitly (see .env.example) so the cookie is shared between the
    # frontend host (suisuinavi.sakura.ne.jp) and the API host
    # (api.suisuinavi.sakura.ne.jp) as same-site siblings. See
    # docs/AUTH_ARCHITECTURE.md — "Cookie domain and SameSite" for the full
    # reasoning and the SameSite=None fallback if this assumption is wrong
    # for a given deployment.
    session_cookie_domain: str = ""
    session_cookie_samesite: Literal["lax", "strict", "none"] = "lax"
    session_ttl_days: int = 30
    csrf_cookie_name: str = "suisui_csrf"
    csrf_header_name: str = "x-suisui-csrf"

    # -- CORS -----------------------------------------------------------------
    # Comma-separated in the environment; parsed into a list below. No
    # wildcard is ever accepted alongside credentials (enforced in main.py).
    allowed_origins_raw: str = Field(
        default="https://suisuinavi.sakura.ne.jp,https://klayertan.github.io,http://127.0.0.1:4173",
        alias="SUISUI_CLOUD_ALLOWED_ORIGINS",
    )

    # -- auth / passwords -----------------------------------------------------
    min_password_length: int = 8
    # Development / field-trial escape hatch (Phase 6): explicit, never the
    # default in a real deployment. See docs/AUTH_ARCHITECTURE.md.
    require_email_verification: bool = False

    # -- rate limiting (in-memory, single-process — see app/security.py) ------
    login_rate_limit_attempts: int = 10
    login_rate_limit_window_seconds: int = 300
    register_rate_limit_attempts: int = 5
    register_rate_limit_window_seconds: int = 3600

    # -- email delivery (Phase 6) ---------------------------------------------
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_sender: str = "no-reply@suisuinavi.sakura.ne.jp"
    smtp_use_tls: bool = True

    # -- misc -------------------------------------------------------------
    max_request_body_bytes: int = 1_000_000  # 1 MB; field/observation JSON blobs are small

    @field_validator("session_secret")
    @classmethod
    def _warn_empty_secret_in_dev_only(cls, value: str, info):  # noqa: ANN001 - pydantic validator signature
        # Enforcement (refuse to boot in production with no secret) lives in
        # main.py's startup check, not here, so unit tests can construct a
        # Settings object freely without an environment secret.
        return value

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins_raw.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def cookie_secure(self) -> bool:
        # Only ever false for a plain-HTTP local dev server. Production is
        # HTTPS-only — see docs/SAKURA_CLOUD_DEPLOYMENT.md.
        return self.is_production or self.session_cookie_samesite == "none"


@lru_cache
def get_settings() -> Settings:
    return Settings()

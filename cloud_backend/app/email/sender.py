"""Email delivery abstraction (Phase 6).

Nothing calls this yet for real — ``Settings.require_email_verification``
defaults to ``False`` (see config.py and docs/AUTH_ARCHITECTURE.md), which is
the explicit, documented "no SMTP configured" mode Phase 6 asks for: accounts
are usable immediately, and this module is inert. The moment
``require_email_verification`` is turned on and SMTP settings are filled in,
``auth/service.py`` gains a verification-token step that calls
``send_verification_email`` below — that wiring is intentionally not built
yet, so this repository never "fakes" sending an email nobody configured
delivery for.

Token design (for when this is wired up): a random ``secrets.token_urlsafe``
value, stored ONLY as its SHA-256 hash (same pattern as session tokens — see
security.py), single-use (consumed row deleted or marked used on success),
with an expiry column. No email content is ever templated with the raw
token; only the hash is persisted.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from ..config import Settings

logger = logging.getLogger(__name__)


class EmailNotConfigured(Exception):
    pass


def send_email(settings: Settings, *, to: str, subject: str, body: str) -> None:
    """Synchronous SMTP send. Raises EmailNotConfigured rather than silently
    no-op'ing, so a caller can never mistake "nothing was sent" for success."""
    if not settings.smtp_host:
        raise EmailNotConfigured("SUISUI_CLOUD_SMTP_HOST is not set")
    message = EmailMessage()
    message["From"] = settings.smtp_sender
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as client:
        if settings.smtp_use_tls:
            client.starttls()
        if settings.smtp_username:
            client.login(settings.smtp_username, settings.smtp_password)
        client.send_message(message)
    logger.info("email sent", extra={"to_domain": to.rsplit("@", 1)[-1]})


def send_verification_email(settings: Settings, *, to: str, token: str, redirect_base: str) -> None:
    link = f"{redirect_base.rstrip('/')}/#verify-email?token={token}"
    send_email(
        settings,
        to=to,
        subject="スイスイナビ — メールアドレスの確認",
        body=(
            "スイスイナビのアカウント登録を受け付けました。\n"
            f"以下のリンクを開いて、メールアドレスの確認を完了してください。\n\n{link}\n\n"
            "このメールに心当たりがない場合は、破棄してください。"
        ),
    )


def send_password_reset_email(settings: Settings, *, to: str, token: str, redirect_base: str) -> None:
    link = f"{redirect_base.rstrip('/')}/#reset-password?token={token}"
    send_email(
        settings,
        to=to,
        subject="スイスイナビ — パスワード再設定",
        body=(
            "パスワード再設定のリクエストを受け付けました。\n"
            f"以下のリンクを開いて、新しいパスワードを設定してください。\n\n{link}\n\n"
            "このメールに心当たりがない場合は、破棄してください。パスワードは変更されていません。"
        ),
    )

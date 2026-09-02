"""Password hashing, session tokens, CSRF tokens, and in-memory rate limiting.

No homemade cryptography: password hashing is Argon2id via ``argon2-cffi``
(the PHC-recommended default), and every random value (session token, CSRF
token) comes from ``secrets.token_urlsafe`` (CSPRNG). Nothing here rolls its
own cipher or signing scheme.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHash

# Argon2id, argon2-cffi's default variant. Parameters are the library's own
# current recommended defaults (time_cost=3, memory_cost=64 MiB, parallelism)
# — deliberately not hand-tuned here; a single Sakura Cloud VM should not be
# guessing at KDF cost parameters, and the library's defaults already target
# "expensive enough for an attacker, fast enough for one login request".
_hasher = PasswordHasher()

SESSION_TOKEN_BYTES = 32
CSRF_TOKEN_BYTES = 32


def normalize_email(email: str) -> str:
    """Trims and lowercases. The unique index on users.email enforces the rest."""
    return email.strip().lower()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHash):
        return False


def needs_rehash(password_hash: str) -> bool:
    """True if the hash was made with older/weaker parameters than today's default."""
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHash:
        return False


def new_session_token() -> str:
    """The plaintext value that goes in the cookie. Never stored server-side."""
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)


def hash_session_token(token: str) -> str:
    """SHA-256 is fine here: this is a lookup key for an already-high-entropy
    random token, not a password — there is nothing for a slow KDF to protect
    against, and a fast hash keeps every authenticated request cheap."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_csrf_token() -> str:
    return secrets.token_urlsafe(CSRF_TOKEN_BYTES)


def constant_time_equals(a: str, b: str) -> bool:
    return secrets.compare_digest(a, b)


class RateLimiter:
    """Fixed-window, in-memory, per-process rate limiter.

    Explicitly NOT a distributed limiter: state lives in this process's
    memory, so it resets on restart and does not share state across multiple
    API instances. That is the correct tradeoff for "one Sakura Cloud VM,
    one process" (see docs/SAKURA_CLOUD_DEPLOYMENT.md) — scaling to more than
    one API instance would need a shared store (Redis) instead, which this
    deployment does not have and should not pretend to.
    """

    def __init__(self, max_attempts: int, window_seconds: int) -> None:
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> bool:
        """Records an attempt and returns True if it is allowed (under the limit)."""
        now = time.monotonic()
        window_start = now - self.window_seconds
        hits = self._hits[key]
        while hits and hits[0] < window_start:
            hits.popleft()
        if len(hits) >= self.max_attempts:
            return False
        hits.append(now)
        return True

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)

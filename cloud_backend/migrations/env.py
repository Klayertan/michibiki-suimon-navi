"""Alembic environment.

Deliberately synchronous (psycopg2), even though the running app is async
(asyncpg) — see app/database.py's module docstring for why: a migration run
is a one-shot, ordered, operator-invoked action, and async buys nothing
there but an extra dependency (greenlet-based async engine bridging) for no
benefit. The DATABASE_URL is read from the same SUISUI_CLOUD_DATABASE_URL
environment variable the app itself uses (via app/config.Settings), so there
is exactly one place an operator sets the database location — its
"+asyncpg" driver marker is swapped for "+psycopg2" here before Alembic
connects.
"""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import get_settings
from app.database import Base
from app.models import db as _models  # noqa: F401 - import registers all tables on Base.metadata

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _sync_database_url() -> str:
    url = get_settings().database_url
    if "+asyncpg" in url:
        url = url.replace("+asyncpg", "+psycopg2")
    return url


def run_migrations_offline() -> None:
    context.configure(
        url=_sync_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = _sync_database_url()
    connectable = engine_from_config(configuration, prefix="sqlalchemy.", poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

# SuisuiNavi cloud (accounts/fields) API.
#
# Runs as exactly ONE uvicorn worker, deliberately — app/security.py's
# RateLimiter and app/auth/router.py's lazily-built limiter singletons are
# in-memory and per-process (see their own docstrings on why that is the
# correct tradeoff for one Sakura Cloud VM). Running more than one worker
# or more than one container of this image behind a shared load balancer
# would silently make rate limiting inconsistent — do not add --workers or
# scale replicas without first moving that state to Redis.
FROM python:3.12-slim

WORKDIR /app

# System deps: none beyond what python:3.12-slim already has. Every
# dependency in requirements.txt (argon2-cffi's C bindings, psycopg2-binary,
# asyncpg) ships manylinux wheels for this base image, so no compiler
# toolchain is installed here — keeps the image small and avoids carrying
# build tools into a running container.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini

# Non-root: this process only ever needs to listen on a port and talk to
# PostgreSQL over the network — no reason to run as root inside the
# container.
RUN useradd --create-home --uid 1000 suisui && chown -R suisui:suisui /app
USER suisui

EXPOSE 8000

# Runs the initial-schema migration (and any future ones) before serving —
# safe to run on every container start: Alembic no-ops once the database is
# already at head. See docs/SAKURA_CLOUD_DEPLOYMENT.md's "Migrations" and
# "Backups" sections before running this against a production database for
# the first time.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]

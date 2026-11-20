# syntax=docker/dockerfile:1

# ---- build: install dependencies into an isolated virtualenv ---------------
FROM python:3.13-slim AS build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Requirements first, so code changes don't invalidate the dependency layer.
COPY requirements.txt .
RUN pip install -r requirements.txt

# ---- runtime ---------------------------------------------------------------
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PORT=8000

# Unprivileged user; the app never needs to write to disk.
RUN groupadd --system app && useradd --system --gid app --no-create-home app

COPY --from=build /opt/venv /opt/venv
WORKDIR /srv
# Only application code: no tests, no .env (see .dockerignore).
COPY --chown=app:app app ./app

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8000\")}/health', timeout=2)" || exit 1

# Configuration comes only from the environment (see .env.example).
# --proxy-headers trusts X-Forwarded-* only from FORWARDED_ALLOW_IPS (uvicorn
# default 127.0.0.1); set it to your load balancer's address when deployed.
CMD ["sh", "-c", "exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT} --proxy-headers --no-server-header"]

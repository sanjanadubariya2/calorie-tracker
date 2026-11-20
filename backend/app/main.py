"""Application factory.

Run with:  uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000

A factory (rather than a module-level `app`) means importing this module has
no side effects, and settings are validated when the server starts: a missing
or invalid variable stops startup with a clear error.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import daily_status, health
from app.core.config import Environment, Settings, get_settings
from app.core.security import JwksCache, TokenVerifier
from app.db.supabase import DatabaseError, DatabaseUnavailable, SupabaseRest

logger = logging.getLogger("app")


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """`transport` lets tests replace the network (Supabase JWKS and REST)."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with httpx.AsyncClient(transport=transport, timeout=settings.upstream_timeout_seconds) as http:
            app.state.token_verifier = TokenVerifier(
                settings, JwksCache(settings.jwks_url, http, settings.jwks_cache_seconds)
            )
            app.state.db = SupabaseRest(settings, http)
            yield

    is_prod = settings.environment is Environment.production
    app = FastAPI(
        title="Calorie Tracker API",
        version="0.1.0",
        lifespan=lifespan,
        debug=False,
        # Interactive docs only outside production.
        docs_url=None if is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if is_prod else "/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=False,  # bearer tokens, not cookies
        allow_methods=["GET"],
        allow_headers=["Authorization", "Content-Type"],
    )

    # Error responses never include upstream messages, SQL, or stack traces.
    @app.exception_handler(DatabaseUnavailable)
    async def _db_unavailable(_: Request, __: DatabaseUnavailable) -> JSONResponse:
        return JSONResponse({"detail": "The database is temporarily unavailable."}, status.HTTP_503_SERVICE_UNAVAILABLE)

    @app.exception_handler(DatabaseError)
    async def _db_error(_: Request, exc: DatabaseError) -> JSONResponse:
        if exc.status_code in (401, 403):
            # PostgREST rejected the forwarded token (e.g. revoked session).
            return JSONResponse(
                {"detail": "Invalid or expired token"},
                status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": "Bearer"},
            )
        return JSONResponse({"detail": "The database could not complete the request."}, status.HTTP_502_BAD_GATEWAY)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error: %s", type(exc).__name__)
        return JSONResponse({"detail": "Internal server error"}, status.HTTP_500_INTERNAL_SERVER_ERROR)

    app.include_router(health.router)
    app.include_router(daily_status.router)
    return app

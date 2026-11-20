"""Settings, read from the environment and validated at startup.

Nothing here has a default for a secret, and secrets are SecretStr so they never
appear in reprs, logs or error messages. A missing or inconsistent value makes
the app refuse to start (see create_app), rather than failing on first request.
"""

from __future__ import annotations

from enum import Enum
from functools import lru_cache
from typing import Annotated

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Algorithms this service will ever accept. Supabase signs user tokens with
# asymmetric keys (ES256 by default, RS256 possible) published at the project's
# JWKS endpoint; HS256 only exists for projects still on the legacy shared secret.
SUPPORTED_ALGORITHMS = {"ES256", "RS256", "HS256"}


class Environment(str, Enum):
    development = "development"
    test = "test"
    production = "production"


def _split_csv(value: object) -> object:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


class Settings(BaseSettings):
    # hide_input_in_errors: a validation failure must not print the input values,
    # which include SUPABASE_JWT_SECRET, into startup logs.
    model_config = SettingsConfigDict(
        env_file=None, extra="ignore", case_sensitive=False, hide_input_in_errors=True
    )

    environment: Environment = Environment.production

    # Supabase project, e.g. https://<ref>.supabase.co (no trailing slash).
    supabase_url: str
    # The project's anon / publishable key. Not a secret (it ships in every app
    # build), but it is sent as `apikey` to PostgREST, so treat it as config.
    supabase_anon_key: SecretStr

    # JWT verification.
    supabase_jwt_algorithms: Annotated[list[str], NoDecode] = Field(default_factory=lambda: ["ES256"])
    supabase_jwt_audience: str = "authenticated"
    supabase_jwt_issuer: str | None = None  # default: <supabase_url>/auth/v1
    supabase_jwks_url: str | None = None  # default: <supabase_url>/auth/v1/.well-known/jwks.json
    # Only for projects still signing with the legacy HS256 secret.
    supabase_jwt_secret: SecretStr | None = None
    jwt_leeway_seconds: int = Field(default=30, ge=0, le=300)
    jwks_cache_seconds: int = Field(default=600, ge=30)

    # CORS: exact origins of the web app, comma-separated.
    allowed_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # Upstream timeout for Supabase calls.
    upstream_timeout_seconds: float = Field(default=10.0, gt=0, le=60)

    _split_algorithms = field_validator("supabase_jwt_algorithms", mode="before")(_split_csv)
    _split_origins = field_validator("allowed_origins", mode="before")(_split_csv)

    @field_validator("supabase_url")
    @classmethod
    def _normalize_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if not value.startswith(("https://", "http://")):
            raise ValueError("SUPABASE_URL must be an http(s) URL")
        return value

    @field_validator("supabase_jwt_algorithms")
    @classmethod
    def _check_algorithms(cls, value: list[str]) -> list[str]:
        algs = [a.upper() for a in value]
        unknown = set(algs) - SUPPORTED_ALGORITHMS
        if not algs or unknown:
            raise ValueError(f"SUPABASE_JWT_ALGORITHMS must be a non-empty subset of {sorted(SUPPORTED_ALGORITHMS)}")
        return algs

    @model_validator(mode="after")
    def _check_consistency(self) -> "Settings":
        if "HS256" in self.supabase_jwt_algorithms and not self.supabase_jwt_secret:
            raise ValueError("HS256 is enabled but SUPABASE_JWT_SECRET is not set")
        if self.environment is Environment.production:
            if not self.supabase_url.startswith("https://"):
                raise ValueError("SUPABASE_URL must use https in production")
            if not self.allowed_origins:
                raise ValueError("ALLOWED_ORIGINS must be set in production")
            if "*" in self.allowed_origins:
                raise ValueError("ALLOWED_ORIGINS cannot be '*' in production")
        return self

    @property
    def jwt_issuer(self) -> str:
        return self.supabase_jwt_issuer or f"{self.supabase_url}/auth/v1"

    @property
    def jwks_url(self) -> str:
        return self.supabase_jwks_url or f"{self.supabase_url}/auth/v1/.well-known/jwks.json"

    @property
    def rest_url(self) -> str:
        return f"{self.supabase_url}/rest/v1"


@lru_cache
def get_settings() -> Settings:
    """Settings from the process environment (cached)."""
    return Settings()  # type: ignore[call-arg]  # values come from env

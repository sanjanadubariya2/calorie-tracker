"""Configuration must fail closed, and never echo secrets."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import Environment, Settings, get_settings

BASE = {"SUPABASE_URL": "https://project-ref.supabase.co", "SUPABASE_ANON_KEY": "anon-key"}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("ENVIRONMENT", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_JWT_SECRET",
                 "SUPABASE_JWT_ALGORITHMS", "ALLOWED_ORIGINS", "SUPABASE_JWT_ISSUER", "SUPABASE_JWKS_URL"):
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()


def _env(monkeypatch: pytest.MonkeyPatch, **values: str) -> None:
    for k, v in values.items():
        monkeypatch.setenv(k, v)


@pytest.mark.parametrize("missing", ["SUPABASE_URL", "SUPABASE_ANON_KEY"])
def test_missing_required_value_fails(monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    _env(monkeypatch, ENVIRONMENT="development", **{k: v for k, v in BASE.items() if k != missing})
    with pytest.raises(ValidationError) as err:
        Settings()
    assert missing.lower() in str(err.value).lower()


def test_app_refuses_to_start_without_config() -> None:
    from app.main import create_app

    with pytest.raises(ValidationError):
        create_app()


def test_production_requires_https_and_origins(monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, **BASE, ENVIRONMENT="production")
    with pytest.raises(ValidationError, match="ALLOWED_ORIGINS"):
        Settings()

    _env(monkeypatch, ALLOWED_ORIGINS="*")
    with pytest.raises(ValidationError, match="cannot be"):
        Settings()

    _env(monkeypatch, ALLOWED_ORIGINS="https://app.example.com", SUPABASE_URL="http://project-ref.supabase.co")
    with pytest.raises(ValidationError, match="https"):
        Settings()


def test_production_defaults_to_production(monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, **BASE, ALLOWED_ORIGINS="https://a.example.com, https://b.example.com")
    s = Settings()
    assert s.environment is Environment.production
    assert s.allowed_origins == ["https://a.example.com", "https://b.example.com"]


def test_hs256_requires_a_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, **BASE, ENVIRONMENT="development", SUPABASE_JWT_ALGORITHMS="ES256,HS256")
    with pytest.raises(ValidationError, match="SUPABASE_JWT_SECRET"):
        Settings()


def test_unknown_algorithm_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, **BASE, ENVIRONMENT="development", SUPABASE_JWT_ALGORITHMS="none")
    with pytest.raises(ValidationError):
        Settings()


def test_defaults_are_derived_from_the_project_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, **{**BASE, "SUPABASE_URL": "https://project-ref.supabase.co/"}, ENVIRONMENT="development")
    s = Settings()
    assert s.supabase_jwt_algorithms == ["ES256"]
    assert s.jwt_issuer == "https://project-ref.supabase.co/auth/v1"
    assert s.jwks_url == "https://project-ref.supabase.co/auth/v1/.well-known/jwks.json"
    assert s.rest_url == "https://project-ref.supabase.co/rest/v1"


def test_secrets_never_appear_in_repr_or_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, **BASE, ENVIRONMENT="development", SUPABASE_JWT_ALGORITHMS="HS256",
         SUPABASE_JWT_SECRET="super-secret-value-123")
    s = Settings()
    assert "super-secret-value-123" not in repr(s)
    assert "anon-key" not in repr(s)

    # A validation failure elsewhere must not echo the secret either.
    _env(monkeypatch, ENVIRONMENT="production")
    with pytest.raises(ValidationError) as err:
        Settings()
    assert "super-secret-value-123" not in str(err.value)

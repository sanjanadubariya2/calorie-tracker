"""Shared FastAPI dependencies."""

from fastapi import Request

from app.db.supabase import SupabaseRest


def get_db(request: Request) -> SupabaseRest:
    return request.app.state.db

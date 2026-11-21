"""Meal recommendations API (Phase 3, Tasks 3-5).

Identity comes only from the Supabase access token; no endpoint accepts a
user id. Everything runs as the user through PostgREST (RLS), and the same
service backs the assistant's recommend_meals tool.
"""

import datetime as dt
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import ValidationError

from app.api.deps import get_db
from app.assistant.proposals import FoodLogProposal
from app.assistant.store import StoreNotConfigured
from app.core.security import AuthenticatedUser, get_current_user
from app.db.supabase import SupabaseRest
from app.recommendations import service
from app.recommendations.repository import RecommendationRepository
from app.schemas.recommendations import (
    FeedbackIn,
    FeedbackOut,
    FeedbackResult,
    LogProposalIn,
    RecommendationDetail,
    RecommendationQuery,
    RecommendationResponse,
)
from app.services.daily_status import DailyStatusError

router = APIRouter(tags=["recommendations"])

ERRORS = {
    401: {"description": "Missing, invalid or expired Supabase access token"},
    502: {"description": "The database returned an error"},
    503: {"description": "The database could not be reached"},
}
QUERY_PARAMS = set(RecommendationQuery.model_fields)


def get_repository(request: Request) -> RecommendationRepository:
    return request.app.state.recommendations


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Recommendation not found.")


def _gone() -> HTTPException:
    return HTTPException(status.HTTP_410_GONE, detail="This meal is no longer available.")


@router.get("/v1/me/recommendations", response_model=RecommendationResponse,
            summary="Ranked meal recommendations for the signed-in user",
            responses={400: {"description": "No date given and the profile has no time zone yet"},
                       422: {"description": "Invalid or unknown parameter"}, **ERRORS})
async def list_recommendations(
    request: Request,
    meal_type: Literal["breakfast", "lunch", "dinner", "snack"],
    count: int = Query(5, ge=1, le=10),
    mode: Literal["meals", "foods", "both"] = "both",
    tolerance: Literal["strict", "standard", "flexible"] = "standard",
    max_kcal: int | None = Query(None, ge=50, le=2500),
    target_kcal: int | None = Query(None, ge=50, le=2500),
    protein: Literal["normal", "high"] = "normal",
    cuisine: str | None = Query(None, min_length=2, max_length=40),
    exclude: list[str] = Query(default_factory=list, max_length=40),
    date: dt.date | None = None,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
    repo: RecommendationRepository = Depends(get_repository),
) -> RecommendationResponse:
    """Deterministic (no LLM). Nutrition comes from the catalogue and is priced
    by the database for the exact portions. Nothing is logged; the request is
    recorded in the user's own recommendation history. Fewer than `count`
    items are returned when fewer fit well."""
    unknown = sorted(set(request.query_params) - QUERY_PARAMS)
    if unknown:   # e.g. user_id: identity is never taken from parameters
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Unknown parameter: {', '.join(unknown)}")
    try:
        q = RecommendationQuery(meal_type=meal_type, count=count, mode=mode, tolerance=tolerance, max_kcal=max_kcal,
                                target_kcal=target_kcal, protein=protein, cuisine=cuisine, exclude=exclude, date=date)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=[{"loc": e["loc"], "msg": e["msg"]} for e in exc.errors()]) from None
    try:
        return await service.recommend(db, user, repo, q)
    except DailyStatusError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=exc.message) from None


@router.get("/v1/me/recommendations/{recommendation_id}", response_model=RecommendationDetail,
            summary="One recommendation: recipe details, ingredients, instructions, re-priced for servings",
            responses={404: {"description": "Not found (or not yours)"},
                       410: {"description": "No longer available"}, **ERRORS})
async def read_recommendation(
    recommendation_id: uuid.UUID,
    servings: list[float] | None = Query(None, max_length=8, description="One value per portion, in order."),
    optional: list[uuid.UUID] = Query(default_factory=list, max_length=8,
                                      description="Optional components to include (ids from optional_components)."),
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
    repo: RecommendationRepository = Depends(get_repository),
) -> RecommendationDetail:
    """total_nutrition is re-priced by the database for the chosen servings and
    optional components; optional components are re-checked against your
    current preferences."""
    try:
        return await service.get_detail(db, user, repo, recommendation_id, servings, [str(o) for o in optional])
    except service.RecommendationNotFound:
        raise _not_found() from None
    except service.RecommendationUnavailable:
        raise _gone() from None
    except (service.InvalidServings, service.InvalidOptional) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.message) from None


@router.post("/v1/me/recommendations/{recommendation_id}/feedback", response_model=FeedbackResult,
             status_code=status.HTTP_201_CREATED, summary="Record what you did with a recommendation",
             responses={404: {"description": "Not found (or not yours)"}, **ERRORS})
async def send_feedback(
    recommendation_id: uuid.UUID, body: FeedbackIn,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> FeedbackResult:
    """viewed / selected / rejected / planned are recorded as events (viewing
    is never treated as liking). saved / unsaved manage a bookmark;
    not_interested shows it less often (180 days); never removes it until you
    delete that feedback."""
    try:
        return await service.record_feedback(db, user, recommendation_id, body.action)
    except service.RecommendationNotFound:
        raise _not_found() from None


@router.post("/v1/me/recommendations/{recommendation_id}/log-proposal", response_model=FoodLogProposal,
             status_code=status.HTTP_201_CREATED,
             summary="Prepare a food-log proposal from a recommendation (nothing is logged yet)",
             responses={404: {"description": "Not found (or not yours)"},
                        410: {"description": "No longer available"}, **ERRORS})
async def prepare_log(
    recommendation_id: uuid.UUID, body: LogProposalIn, request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
    repo: RecommendationRepository = Depends(get_repository),
) -> FoodLogProposal:
    """Creates a PENDING proposal, re-priced by the database. The user confirms
    it with POST /v1/assistant/proposals/{id}/confirm, the same single path
    the assistant uses; only that writes food logs."""
    try:
        return await service.create_log_proposal(db, user, repo, request.app.state.assistant.proposals,
                                                 recommendation_id, body)
    except service.RecommendationNotFound:
        raise _not_found() from None
    except service.RecommendationUnavailable:
        raise _gone() from None
    except (service.InvalidServings, service.InvalidOptional) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=exc.message) from None
    except StoreNotConfigured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="Logging proposals aren't available.") from None


@router.get("/v1/me/recommendation-feedback", response_model=list[FeedbackOut],
            summary="Your recommendation feedback (saved, never, less often, liked)", responses=ERRORS)
async def read_feedback(
    feedback: Literal["never", "less_often", "liked", "saved"] | None = None,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> list[FeedbackOut]:
    return await service.list_feedback(db, user, feedback)


@router.delete("/v1/me/recommendation-feedback/{feedback_id}", status_code=status.HTTP_204_NO_CONTENT,
               summary="Remove one piece of feedback (e.g. undo 'never')",
               responses={404: {"description": "Not found (or not yours)"}, **ERRORS})
async def remove_feedback(
    feedback_id: uuid.UUID,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> Response:
    if not await service.delete_feedback(db, user, feedback_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Feedback not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)

"""AI food recognition (Task 3) and nutrition grounding (Task 4).

POST /v1/recognitions/text    {text}       -> candidates + grounded proposal
POST /v1/recognitions/image   {image_id}   -> candidates + grounded proposal
POST /v1/proposals/ground     {items}      -> re-grounded proposal (after edits)

Images are read from the caller's own private storage (migration 009) as the
caller: an image id belonging to someone else is "not found". Provider
credentials never leave the backend, the provider never receives user
identifiers, and nothing is logged as food here: the app saves only after the
user confirms.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.deps import get_db
from app.core.config import Settings
from app.core.security import AuthenticatedUser, get_current_user
from app.db.supabase import SupabaseRest
from app.schemas.recognition import (
    GroundRequest,
    ImageRecognitionRequest,
    MealProposal,
    ProposalItemInput,
    RecognitionResponse,
    RecognitionResult,
    TextRecognitionRequest,
)
from app.services import grounding
from app.services.catalogue.importer import _SlidingWindow
from app.services.recognition import pipeline
from app.services.recognition.providers import (
    InvalidModelOutput,
    ProviderNotConfigured,
    ProviderRateLimited,
    ProviderRefused,
    ProviderTimeout,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["recognition"])

_RESPONSES = {
    401: {"description": "Not signed in"},
    404: {"description": "Image not found"},
    422: {"description": "Empty or unusable input, or the model declined to analyse it"},
    429: {"description": "Too many recognitions (per user, or the AI provider's limit)"},
    502: {"description": "The AI provider failed or returned an unusable result"},
    503: {"description": "AI recognition is not configured"},
    504: {"description": "The AI provider timed out"},
}


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _check_rate(request: Request, user: AuthenticatedUser) -> None:
    limiter: _SlidingWindow = request.app.state.recognition_limiter
    if not limiter.hit(user.user_id):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many recognitions. Try again later.",
                            headers={"Retry-After": "600"})


async def _recognize(coro) -> RecognitionResult:  # type: ignore[no-untyped-def]
    try:
        return await coro
    except ProviderNotConfigured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="AI recognition isn't available right now.") from None
    except ProviderTimeout:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, detail="Recognition took too long. Please try again.") from None
    except ProviderRateLimited as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="The AI service is busy. Try again shortly.",
                            headers=headers) from None
    except ProviderRefused:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="This input couldn't be analysed. Try another photo or describe the meal.") from None
    except InvalidModelOutput as exc:
        logger.warning("Recognition output rejected: %s", exc)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail="Recognition returned an unusable result. Please try again.") from None
    except ProviderUnavailable as exc:
        logger.warning("Recognition provider unavailable: %s", exc)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail="The AI service is unavailable. Please try again.") from None


def _to_inputs(result: RecognitionResult) -> list[ProposalItemInput]:
    return [
        ProposalItemInput(
            candidate_id=c.candidate_id, food_name=c.food_name, brand=c.brand, quantity=c.estimated_quantity,
            unit=c.quantity_unit, quantity_source=c.quantity_source, estimated_weight_g=c.estimated_weight_g,
            recognition_confidence=c.recognition_confidence,
        )
        for c in result.candidates
    ]


async def _respond(db: SupabaseRest, user: AuthenticatedUser, result: RecognitionResult) -> RecognitionResponse:
    proposal = await grounding.ground(db, user, _to_inputs(result)) if result.candidates else grounding.build_proposal([])
    logger.info("Recognition %s: %s, %d candidates", result.input_type, result.status, len(result.candidates))
    return RecognitionResponse(recognition=result, proposal=proposal)


@router.post("/v1/recognitions/text", response_model=RecognitionResponse, responses=_RESPONSES,
             summary="Recognise foods in a meal description")
async def recognize_text(
    body: TextRecognitionRequest,
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> RecognitionResponse:
    """Explicit quantities in the text are kept exactly as written (and checked
    against the text). Returns candidates plus a grounded proposal. Nothing is
    saved."""
    settings = _settings(request)
    if len(body.text) > settings.recognition_max_text_chars:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Keep the description under {settings.recognition_max_text_chars} characters.")
    _check_rate(request, user)
    result = await _recognize(pipeline.recognize_text(request.app.state.recognizer, body.text, settings.recognition_max_items))
    return await _respond(db, user, result)


@router.post("/v1/recognitions/image", response_model=RecognitionResponse, responses=_RESPONSES,
             summary="Recognise foods in an uploaded meal photo")
async def recognize_image(
    body: ImageRecognitionRequest,
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> RecognitionResponse:
    """`image_id` is from POST /v1/meal-images (validated, re-encoded,
    metadata-free). Returns candidates plus a grounded proposal. Nothing is saved."""
    settings = _settings(request)
    rows = await db.select(user, "meal_images", {"select": "storage_path", "id": f"eq.{body.image_id}"})
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Image not found")
    _check_rate(request, user)
    image = await request.app.state.storage.download(
        user, settings.meal_images_bucket, rows[0]["storage_path"], 5 * 1024 * 1024
    )
    if not image.startswith(b"\xff\xd8\xff"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The stored image isn't a usable photo.")
    result = await _recognize(pipeline.recognize_image(request.app.state.recognizer, image, settings.recognition_max_items))
    return await _respond(db, user, result)


@router.post("/v1/proposals/ground", response_model=MealProposal, summary="Price edited proposal items")
async def ground_items(
    body: GroundRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> MealProposal:
    """Re-grounds items after the user edits a name, picks another food, or
    changes the portion or unit. Deterministic: no AI call. Nothing is saved."""
    return await grounding.ground(db, user, body.items)

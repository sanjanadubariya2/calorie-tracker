"""Meal photo upload, retrieval and deletion.

Upload flow (all as the signed-in user, so RLS and storage policies apply):
  1. Size-capped read of the raw body (Content-Type image/jpeg|png|webp).
  2. Validate + re-encode (app.services.meal_images): metadata stripped.
  3. Insert the meal_images row (enforces ownership, path shape, rate limit).
  4. Upload the object to the private bucket at <user_id>/<id>.jpg (no overwrite).
     If this fails, the row is deleted again.
  5. Return metadata and a short-lived signed URL.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_db
from app.core.config import Settings
from app.core.security import AuthenticatedUser, get_current_user
from app.db.storage import SupabaseStorage
from app.db.supabase import DatabaseError, SupabaseRest
from app.schemas.meal_images import MealImageOut
from app.services.meal_images import ACCEPTED_CONTENT_TYPES, InvalidImage, UnsupportedImage, process_image

router = APIRouter(prefix="/v1/meal-images", tags=["meal images"])

_ROW_FIELDS = "id,storage_path,status,width,height,size_bytes,created_at,expires_at"


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _storage(request: Request) -> SupabaseStorage:
    return request.app.state.storage


async def _read_capped(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="The photo is too large.")
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="The photo is too large.")
        chunks.append(chunk)
    return b"".join(chunks)


async def _to_out(storage: SupabaseStorage, settings: Settings, user: AuthenticatedUser, row: dict[str, Any]) -> MealImageOut:
    url = await storage.signed_url(
        user, settings.meal_images_bucket, row["storage_path"], settings.meal_image_signed_url_seconds
    )
    return MealImageOut(
        id=row["id"], status=row["status"], width=row["width"], height=row["height"],
        size_bytes=row["size_bytes"], created_at=row["created_at"], expires_at=row["expires_at"],
        url=url, url_expires_in=settings.meal_image_signed_url_seconds,
    )


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=MealImageOut,
    summary="Upload a meal photo",
    responses={
        413: {"description": "Larger than the upload limit"},
        415: {"description": "Not JPEG, PNG or WebP"},
        422: {"description": "Not a readable image"},
        429: {"description": "Upload rate limit reached"},
    },
)
async def upload_meal_image(
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> MealImageOut:
    """Send the image bytes as the request body with `Content-Type: image/jpeg`
    (or png/webp). The server re-encodes it to JPEG and strips all metadata."""
    settings = _settings(request)
    storage = _storage(request)

    content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type not in ACCEPTED_CONTENT_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Send a JPEG, PNG or WebP photo.")

    raw = await _read_capped(request, settings.meal_image_max_upload_bytes)
    try:
        image = await run_in_threadpool(process_image, raw, settings.meal_image_max_dimension)
    except UnsupportedImage as exc:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(exc)) from None
    except InvalidImage as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from None

    image_id = str(uuid.uuid4())
    path = f"{user.user_id}/{image_id}.jpg"
    try:
        row = await db.insert(user, "meal_images", {
            "id": image_id, "user_id": user.user_id, "storage_path": path, "mime_type": "image/jpeg",
            "size_bytes": len(image.data), "width": image.width, "height": image.height, "sha256": image.sha256,
        })
    except DatabaseError as exc:
        if exc.code == "54000":
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many photos uploaded. Try again later.") from None
        raise

    try:
        await storage.upload(user, settings.meal_images_bucket, path, image.data, image.content_type)
    except Exception:
        # Don't leave a row pointing at nothing.
        await db.delete(user, "meal_images", {"id": f"eq.{image_id}"})
        raise

    return await _to_out(storage, settings, user, row)


async def _own_row(db: SupabaseRest, user: AuthenticatedUser, image_id: uuid.UUID) -> dict[str, Any]:
    # RLS limits this to the caller's own rows; another user's id is simply "not found".
    rows = await db.select(user, "meal_images", {"select": _ROW_FIELDS, "id": f"eq.{image_id}"})
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Image not found")
    return rows[0]


@router.get("/{image_id}", response_model=MealImageOut, summary="A meal photo's details and a fresh signed URL")
async def get_meal_image(
    image_id: uuid.UUID,
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> MealImageOut:
    row = await _own_row(db, user, image_id)
    return await _to_out(_storage(request), _settings(request), user, row)


@router.delete("/{image_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a meal photo")
async def delete_meal_image(
    image_id: uuid.UUID,
    request: Request,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> Response:
    row = await _own_row(db, user, image_id)
    try:
        await _storage(request).delete(user, _settings(request).meal_images_bucket, row["storage_path"])
    except DatabaseError as exc:
        if exc.status_code not in (400, 404):   # already gone is fine
            raise
    await db.delete(user, "meal_images", {"id": f"eq.{image_id}"})
    return Response(status_code=status.HTTP_204_NO_CONTENT)

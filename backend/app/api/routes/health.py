from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health", summary="Liveness check")
async def health() -> dict[str, str]:
    """Reports that the process is up. Deliberately reveals nothing about
    configuration, versions or dependencies, and needs no authentication."""
    return {"status": "ok"}

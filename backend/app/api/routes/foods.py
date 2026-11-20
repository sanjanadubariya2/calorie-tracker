import uuid

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status

from app.api.deps import get_db
from app.core.security import AuthenticatedUser, get_current_user
from app.db.supabase import SupabaseRest
from app.schemas.foods import (
    FoodAliasOut,
    FoodDetail,
    FoodMatch,
    ImportResult,
    MatchRequest,
    MatchResponse,
    NutritionPer100,
    Quality,
    Serving,
)
from app.services.catalogue import importer as importer_mod
from app.services.catalogue import matching, off
from app.services.catalogue.records import RecordError

router = APIRouter(prefix="/v1/foods", tags=["foods"])


@router.post(
    "/match",
    response_model=MatchResponse,
    summary="Match food names (e.g. from AI recognition) to catalogue foods",
)
async def match_foods(
    body: MatchRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> MatchResponse:
    """For each candidate: ranked catalogue matches with confidence, nutrition
    per 100 g/ml from the catalogue, and the estimated portion. Nutrition in the
    request is rejected (422): it only ever comes from catalogue rows. Every
    result needs user confirmation before logging."""
    results = [await matching.match_candidate(db, user, c) for c in body.candidates]
    return MatchResponse(results=results)


@router.get("/search", response_model=list[FoodMatch], summary="Search the food catalogue")
async def search_foods(
    q: str = Query(min_length=1, max_length=120),
    brand: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=10, ge=1, le=50),
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> list[FoodMatch]:
    return await matching.search(db, user, q, brand, None, "g", limit)


_DETAIL_SELECT = (
    "id,name,brand,category,food_kind,source,source_ref,source_version,basis,density_g_per_ml,"
    "kcal_per_100,protein_g_per_100,carbs_g_per_100,fat_g_per_100,fiber_g_per_100,sugars_g_per_100,"
    "saturated_fat_g_per_100,sodium_g_per_100,salt_g_per_100,micronutrients,completeness,quality_flags,"
    "verification,is_matchable,food_aliases(alias,kind),food_servings(label,grams,is_default)"
)


def _opt(v: object) -> float | None:
    return None if v is None else float(v)  # type: ignore[arg-type]


@router.get("/{food_id}", response_model=FoodDetail, summary="One catalogue food with aliases and servings")
async def get_food(
    food_id: uuid.UUID,
    user: AuthenticatedUser = Depends(get_current_user),
    db: SupabaseRest = Depends(get_db),
) -> FoodDetail:
    rows = await db.select(user, "foods", {"select": _DETAIL_SELECT, "id": f"eq.{food_id}"})
    if not rows or not rows[0].get("is_matchable"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Food not found")
    r = rows[0]
    servings = sorted(r.get("food_servings") or [], key=lambda s: (not s.get("is_default"), s["label"]))
    return FoodDetail(
        food_id=r["id"], name=r["name"], brand=r.get("brand"), category=r.get("category"),
        food_kind=r["food_kind"], source=r["source"], source_ref=r.get("source_ref"),
        source_version=r.get("source_version"),
        per_100=NutritionPer100(
            basis=r["basis"], kcal=float(r["kcal_per_100"]), protein_g=float(r["protein_g_per_100"]),
            carbs_g=float(r["carbs_g_per_100"]), fat_g=float(r["fat_g_per_100"]),
            fiber_g=_opt(r.get("fiber_g_per_100")), sugars_g=_opt(r.get("sugars_g_per_100")),
            saturated_fat_g=_opt(r.get("saturated_fat_g_per_100")), sodium_g=_opt(r.get("sodium_g_per_100")),
        ),
        salt_g=_opt(r.get("salt_g_per_100")),
        micronutrients={k: float(v) for k, v in (r.get("micronutrients") or {}).items()},
        density_g_per_ml=_opt(r.get("density_g_per_ml")),
        quality=Quality(completeness=float(r["completeness"]), verification=r["verification"],
                        flags=list(r.get("quality_flags") or [])),
        aliases=[FoodAliasOut(alias=a["alias"], kind=a["kind"]) for a in (r.get("food_aliases") or [])],
        servings=[Serving(label=s["label"], grams=float(s["grams"])) for s in servings],
    )


@router.post(
    "/import/off/{barcode}",
    response_model=ImportResult,
    summary="Add an Open Food Facts product to the catalogue by barcode",
    responses={404: {"description": "Unknown barcode"}, 422: {"description": "Product data unusable"},
               429: {"description": "Too many imports"}, 503: {"description": "Import not configured"}},
)
async def import_off(
    request: Request,
    barcode: str = Path(pattern=r"^\d{6,14}$"),
    user: AuthenticatedUser = Depends(get_current_user),
) -> ImportResult:
    """The server fetches the product from Open Food Facts itself; nutrition
    supplied by a client is never accepted."""
    importer: importer_mod.OffImporter = request.app.state.off_importer
    try:
        return await importer.import_barcode(user, barcode)
    except importer_mod.ImportDisabled:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="Catalogue import is not enabled.") from None
    except importer_mod.RateLimited:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many imports. Try again later.") from None
    except off.OffProductNotFound:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="No Open Food Facts product with that barcode.") from None
    except off.OffUnavailable:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail="Open Food Facts is not responding.") from None
    except RecordError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Product can't be used: {exc}") from None

"""Open Food Facts -> catalogue record, fetched by the server itself.

The client only names a barcode; the server fetches the product from Open
Food Facts, so nutrition sent by a client is never trusted. Products without
the four core values per 100 g are refused rather than stored half-empty.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from app.services.catalogue.records import AliasRecord, FoodRecord, RecordError, ServingRecord, check_ranges

SOURCE = "open_food_facts"
BARCODE = re.compile(r"^\d{6,14}$")
_FIELDS = (
    "code,product_name,product_name_en,brands,categories_tags,quantity,product_quantity_unit,"
    "nutriments,serving_size,serving_quantity,serving_quantity_unit"
)
# Generic client identification: OFF asks API users to identify the app; no
# user or project details are sent.
USER_AGENT = "CalorieTrackerAPI/0.1 (food catalogue import)"


class OffProductNotFound(Exception):
    pass


class OffUnavailable(Exception):
    pass


async def fetch_product(http: httpx.AsyncClient, api_url: str, barcode: str, timeout: float) -> dict[str, Any]:
    if not BARCODE.match(barcode):
        raise RecordError("barcode must be 6-14 digits")
    try:
        response = await http.get(
            f"{api_url.rstrip('/')}/{barcode}.json",
            params={"fields": _FIELDS},
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        raise OffUnavailable() from exc
    if response.status_code == 404:
        raise OffProductNotFound()
    if not response.is_success:
        raise OffUnavailable()
    try:
        body = response.json()
    except ValueError as exc:
        raise OffUnavailable() from exc
    product = body.get("product")
    if body.get("status") != 1 or not isinstance(product, dict):
        raise OffProductNotFound()
    return product


def _opt(nutriments: dict[str, Any], key: str) -> float | None:
    value = nutriments.get(key)
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def map_product(product: dict[str, Any], barcode: str) -> FoodRecord:
    name = " ".join(str(product.get("product_name") or product.get("product_name_en") or "").split())
    if not name:
        raise RecordError("product has no name")
    brands = str(product.get("brands") or "")
    brand = next((b.strip() for b in brands.split(",") if b.strip()), None)

    n = product.get("nutriments") or {}
    flags: list[str] = []
    kcal = _opt(n, "energy-kcal_100g")
    if kcal is None:
        kj = _opt(n, "energy-kj_100g") or _opt(n, "energy_100g")
        if kj is not None:
            kcal = kj / 4.184
            flags.append("kcal_from_kj")
    protein, carbs, fat = _opt(n, "proteins_100g"), _opt(n, "carbohydrates_100g"), _opt(n, "fat_100g")
    if protein is None or carbs is None or fat is None:
        raise RecordError("product lacks protein, carbohydrate or fat per 100 g")

    sodium = _opt(n, "sodium_100g")
    salt = _opt(n, "salt_100g")
    if salt is None and sodium is not None:
        salt = sodium * 2.5
    if sodium is None and salt is not None:
        sodium = salt / 2.5

    categories = product.get("categories_tags") or []
    is_beverage = "en:beverages" in categories or str(product.get("product_quantity_unit") or "").lower() == "ml"

    rec = FoodRecord(
        name=name,
        brand=brand,
        source=SOURCE,
        source_ref=barcode,
        # None: the database trigger derives kcal from macros and flags kcal_derived.
        kcal_per_100=round(kcal, 1) if kcal is not None else None,
        protein_g_per_100=round(protein, 2),
        carbs_g_per_100=round(carbs, 2),
        fat_g_per_100=round(fat, 2),
        fiber_g_per_100=_round(_opt(n, "fiber_100g")),
        sugars_g_per_100=_round(_opt(n, "sugars_100g")),
        saturated_fat_g_per_100=_round(_opt(n, "saturated-fat_100g")),
        sodium_g_per_100=_round(sodium, 4),
        salt_g_per_100=_round(salt, 4),
        food_kind="beverage" if is_beverage else "packaged",
        category="beverage" if is_beverage else None,
        # OFF stores beverages "per 100 g" fields that are in practice per 100 ml.
        basis="ml" if is_beverage else "g",
        density_g_per_ml=1.0 if is_beverage else None,
        quality_flags=flags + (["density_assumed"] if is_beverage else []),
        verification="auto_checked",
        aliases=[AliasRecord(alias=f"{brand} {name}", kind="name_variant", source=SOURCE)] if brand else [],
    )

    serving_qty = _opt(product, "serving_quantity")
    serving_label = " ".join(str(product.get("serving_size") or "").split())[:60]
    if serving_qty and 1 <= serving_qty <= 5000:
        rec.servings.append(ServingRecord(
            label=f"1 serving ({serving_label})" if serving_label else "1 serving",
            grams=round(serving_qty, 1), is_default=True, source=SOURCE,
            ml=round(serving_qty, 1) if is_beverage else None,
        ))

    check_ranges(rec)
    return rec


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)

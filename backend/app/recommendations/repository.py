"""Loads recommendation candidates and the user's context through PostgREST,
always as the signed-in user (RLS applies; no service-role key).

Candidates are catalogue data that every signed-in user sees identically
(migration 017 excludes user-owned recipes), so they are cached per process
for a few minutes. User context is never cached.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import re
import time
from collections import Counter
from typing import Any

from app.assistant.preferences import get_preferences
from app.core.security import AuthenticatedUser
from app.db.supabase import SupabaseRest
from app.recommendations.config import DEFAULT_CONFIG, VERIFICATION_QUALITY, EngineConfig
from app.recommendations.engine import (
    build_combinations,
    is_countable_label,
    portion_options,
    prep_style,
    range_options,
)
from app.recommendations.models import AddOn, Candidate, Nutrition, Part, UserContext, normalize
from app.services import daily_status

CANDIDATE_TTL_SECONDS = 900
SHOW_WINDOW_DAYS = 7       # novelty looks at recent showings...
EVENT_WINDOW_DAYS = 30     # ...history at what the user did with them

CANDIDATE_FUNCTIONS = {
    "recipe": "recommendation_recipe_candidates",
    "meal": "recommendation_template_candidates",
    "food": "recommendation_food_candidates",
}
MODE_SOURCES = {"meals": ("recipe", "meal"), "foods": ("food",), "both": ("recipe", "meal", "food")}

DISH_TYPE_PRIORITY = ("egg_dish", "curry", "dal", "sabzi", "one_pot", "breakfast_dish", "rice", "bread", "side")

# Canonical main ingredient from a dish or ingredient name (diversity only).
# Proteins come first so "egg curry" is egg and "aloo paratha" is potato.
KEY_INGREDIENTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("paneer", ("paneer",)),
    ("chicken", ("chicken", "murgh")),
    ("mutton", ("mutton", "lamb", "goat", "keema", "kheema")),
    ("fish", ("fish", "machli", "machhi", "pomfret", "rohu", "surmai", "tilapia")),
    ("prawn", ("prawn", "shrimp", "jhinga")),
    ("egg", ("egg", "eggs", "anda", "omelette", "omelet", "bhurji")),
    ("soya", ("soya", "soy", "tofu")),
    ("rajma", ("rajma", "kidney")),
    ("chickpea", ("chole", "chana", "chickpea", "chickpeas", "kabuli")),
    ("lentil", ("dal", "daal", "dhal", "lentil", "lentils", "moong", "mung", "masoor", "toor", "arhar", "urad")),
    ("gram flour", ("besan", "chilla", "cheela", "dhokla", "kadhi", "pakora", "pakoda")),
    ("potato", ("aloo", "potato", "potatoes")),
    ("cauliflower", ("gobi", "cauliflower")),
    ("spinach", ("palak", "spinach")),
    ("okra", ("bhindi", "okra")),
    ("semolina", ("rava", "sooji", "suji", "semolina", "upma")),
    ("poha", ("poha",)),
    ("oats", ("oats", "oat")),
    ("millet", ("ragi", "jowar", "bajra", "millet")),
    ("curd", ("curd", "dahi", "yogurt", "yoghurt", "raita", "lassi", "chaas")),
    ("milk", ("milk", "kheer")),
    ("rice", ("rice", "pulao", "biryani", "khichdi", "idli", "dosa")),
    ("wheat", ("roti", "chapati", "phulka", "paratha", "puri", "poori", "naan", "atta", "wheat", "bread")),
)
IGNORED_QUALIFIERS = frozenset({"raw", "dry", "cooked", "boiled", "whole", "skinless", "fresh", "plain"})


def key_ingredient(name: str | None) -> str | None:
    text = normalize(name)
    for canonical, words in KEY_INGREDIENTS:
        if any(re.search(rf"\b{w}\b", text) for w in words):
            return canonical
    return None


def _main_name(name: str | None) -> str | None:
    """Main ingredient of a recipe: canonical if known, else its name without qualifiers."""
    if not name:
        return None
    return key_ingredient(name) or " ".join(w for w in normalize(name).split() if w not in IGNORED_QUALIFIERS) or None


def _nutrition(d: dict[str, Any] | None) -> Nutrition | None:
    if not d or any(d.get(k) is None for k in ("calories", "protein_g", "carbs_g", "fat_g")):
        return None
    return Nutrition(float(d["calories"]), float(d["protein_g"]), float(d["carbs_g"]), float(d["fat_g"]))


def _attrs(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "diet_classes": frozenset(row.get("diet_classes") or ["unknown"]),
        "diet_status": row.get("diet_status") or "unknown",
        "vegan": row.get("vegan_compatible"),
        "jain": row.get("jain_compatible"),
        "allergens": frozenset(row.get("allergens") or []),
        "allergen_status": row.get("allergen_status") or "unknown",
        "quality_flags": frozenset(row.get("quality_flags") or []),
    }


# ------------------------------------------------------------------ row -> candidate

def recipe_candidate(row: dict[str, Any], cfg: EngineConfig = DEFAULT_CONFIG) -> Candidate:
    per = _nutrition(row.get("per_serving"))
    complete = bool(row.get("complete")) and per is not None
    rid, family = str(row["recipe_id"]), str(row["family_id"])
    parts: tuple[Part, ...] = ()
    ingredients = sorted(row.get("ingredients") or [], key=lambda i: i.get("position") or 0)
    if complete:
        parts = (Part("recipe", rid, row["name"], row["serving_label"], per,
                      portion_options(is_countable_label(row["serving_label"]), cfg),
                      yields=float(row["servings"]) if row.get("servings") else None,
                      ingredients=tuple(ingredients)),)
    dish_types = row.get("dish_types") or []
    return Candidate(
        kind="recipe", key=f"recipe:{rid}", group=f"family:{family}", name=row["name"], variant=row.get("variant"),
        parts=parts, complete=complete,
        meal_types=frozenset(row.get("meal_types") or []), regions=frozenset(row.get("regions") or []),
        dish_type=next((d for d in DISH_TYPE_PRIORITY if d in dish_types), None),
        main_ingredient=_main_name(row.get("main_food_name")),
        prep_style=prep_style(row["name"], row.get("variant")),
        terms=tuple(t for t in (row["name"], row.get("variant"), *(i.get("food_name") for i in ingredients)) if t),
        dish_names=frozenset({normalize(row["name"])}),
        source=row.get("source") or "curated", verification=row.get("verification") or "unverified",
        quantities_estimated=bool(row.get("quantities_estimated")),
        history_keys=(f"recipe:{rid}",), feedback_keys=(f"family:{family}",),
        recipe_id=rid, family_id=family,
        description=row.get("description"),
        total_minutes=(None if row.get("prep_minutes") is None and row.get("cook_minutes") is None
                       else int(row.get("prep_minutes") or 0) + int(row.get("cook_minutes") or 0)),
        equipment=None if row.get("equipment") is None else frozenset(row["equipment"]),
        **_attrs(row),
    )


def template_candidate(row: dict[str, Any], cfg: EngineConfig = DEFAULT_CONFIG) -> Candidate:
    tid = str(row["template_id"])
    components = sorted(row.get("components") or [], key=lambda c: c.get("position") or 0)
    required = [c for c in components if not c.get("optional")]
    priced = [(c, _nutrition(c.get("per_serving"))) for c in required]
    complete = bool(row.get("complete")) and bool(required) and all(
        n is not None and c.get("serving_grams") for c, n in priced)
    parts: tuple[Part, ...] = ()
    if complete:
        parts = tuple(
            Part("food", str(c["food_id"]), c["food_name"], c["serving_label"], n,  # type: ignore[arg-type]
                 range_options(float(c["min_servings"]), float(c["max_servings"]), float(c["servings_step"])),
                 default=float(c["default_servings"]), serving_grams=float(c["serving_grams"]), slot=c.get("slot"))
            for c, n in priced)
    addons: list[AddOn] = []
    for c in components:
        n = _nutrition(c.get("per_serving"))
        if not c.get("optional") or n is None or not c.get("serving_grams"):
            continue                                # an unpriceable add-on is simply not offered
        addons.append(AddOn(
            part=Part("food", str(c["food_id"]), c["food_name"], c["serving_label"], n,
                      range_options(float(c["min_servings"]), float(c["max_servings"]), float(c["servings_step"])),
                      default=float(c["default_servings"]), serving_grams=float(c["serving_grams"]), slot=c.get("slot")),
            diet_classes=frozenset([c.get("diet_class") or "unknown"]), diet_status=c.get("diet_status") or "unknown",
            vegan=c.get("vegan_compatible"), jain=c.get("jain_compatible"),
            allergens=frozenset(c.get("allergens") or []), allergen_status=c.get("allergen_status") or "unknown",
            quality_flags=frozenset(c.get("quality_flags") or [])))
    main = next((c for c in required if c.get("slot") == "main"), required[0] if required else None)
    levels = [c.get("verification") or "unverified" for c in required]
    verification = min(levels, key=lambda v: VERIFICATION_QUALITY.get(v, 0)) if levels else "unverified"
    return Candidate(
        kind="meal", key=f"meal:{tid}", group=f"meal:{tid}", name=row["name"], parts=parts, complete=complete,
        meal_types=frozenset(row.get("meal_types") or []), regions=frozenset(row.get("regions") or []),
        dish_type=(main or {}).get("category"),
        main_ingredient=key_ingredient((main or {}).get("food_name")) or _main_name(row.get("main_food_name")),
        prep_style=prep_style(*((main or {}).get("food_name"),)),
        # Required components only: a title such as "Poha with tea" names an OPTIONAL
        # component, which must not exclude the base meal (the add-on is filtered itself).
        terms=tuple(t for t in (c.get("food_name") for c in required) if t),
        dish_names=frozenset(normalize(c.get("food_name")) for c in required),
        dish_food_ids=frozenset(str(c["food_id"]) for c in required),
        source="template", verification=verification, quantities_estimated=False,
        history_keys=(f"meal:{tid}",), feedback_keys=(f"meal:{tid}",), template_id=tid, addons=tuple(addons),
        # Before migration 020 there was no level: never assume "verified".
        approval_level=row.get("approval_level") or "provisional",
        **_attrs(row),
    )


def food_candidate(row: dict[str, Any], cfg: EngineConfig = DEFAULT_CONFIG) -> Candidate:
    fid = str(row["food_id"])
    per = _nutrition(row)
    complete = per is not None and bool(row.get("serving_grams"))
    parts = ()
    if complete:
        assert per is not None
        parts = (Part("food", fid, row["name"], row["serving_label"], per,
                      portion_options(bool(row.get("countable")), cfg), serving_grams=float(row["serving_grams"])),)
    return Candidate(
        kind="food", key=f"food:{fid}", group=f"food:{fid}", name=row["name"], parts=parts, complete=complete,
        meal_types=frozenset(row.get("meal_types") or []), regions=frozenset(row.get("regions") or []),
        dish_type=row.get("category"), main_ingredient=key_ingredient(row["name"]), prep_style=prep_style(row["name"]),
        terms=(row["name"],), dish_names=frozenset({normalize(row["name"])}), dish_food_ids=frozenset({fid}),
        source=row.get("source") or "", verification=row.get("verification") or "unverified",
        history_keys=(f"food:{fid}",), feedback_keys=(f"food:{fid}",), food_id=fid, **_attrs(row),
    )


MAPPERS = {"recipe": recipe_candidate, "meal": template_candidate, "food": food_candidate}


# ------------------------------------------------------------------ context helpers (pure)

def _age_days(created_at: Any, now: dt.datetime) -> float | None:
    if not created_at:
        return None
    t = dt.datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    return max(0.0, (now - t).total_seconds() / 86400)


def item_key(item: dict[str, Any] | None) -> str | None:
    """The candidate key a stored recommendation item refers to."""
    if not item:
        return None
    if item.get("kind") == "food" and item.get("food_id"):
        return f"food:{item['food_id']}"
    if item.get("kind") == "meal" and item.get("template_id"):
        return f"meal:{item['template_id']}"
    if item.get("kind") in ("recipe", "combo") and item.get("recipe_id"):
        return f"recipe:{item['recipe_id']}"
    return None


def show_ages(rows: list[dict[str, Any]], now: dt.datetime) -> dict[str, tuple[float, ...]]:
    """Key -> ages (days) of each time it was recommended (newest first)."""
    out: dict[str, list[float]] = {}
    for r in rows:
        key, age = item_key(r), _age_days(r.get("created_at"), now)
        if key and age is not None:
            out.setdefault(key, []).append(round(age, 4))
    return {k: tuple(sorted(v)) for k, v in sorted(out.items())}


def event_ages(rows: list[dict[str, Any]], now: dt.datetime) -> dict[str, tuple[tuple[str, float], ...]]:
    """Key -> (event, age in days). 'viewed' is kept for the record but the
    engine never treats it as a preference."""
    out: dict[str, list[tuple[str, float]]] = {}
    for r in rows:
        key, age = item_key(r.get("recommendation_items")), _age_days(r.get("created_at"), now)
        if key and age is not None:
            out.setdefault(key, []).append((r["event"], round(age, 4)))
    return {k: tuple(sorted(v, key=lambda e: (e[1], e[0]))) for k, v in sorted(out.items())}


def feedback_map(rows: list[dict[str, Any]], now: dt.datetime) -> dict[str, str]:
    out: dict[str, str] = {}
    for r in rows:
        expires = r.get("expires_at")
        if expires and dt.datetime.fromisoformat(str(expires).replace("Z", "+00:00")) <= now:
            continue
        if r.get("food_id"):
            out[f"food:{r['food_id']}"] = r["feedback"]
        elif r.get("template_id"):
            out[f"meal:{r['template_id']}"] = r["feedback"]
        elif r.get("recipe_family_id"):
            out[f"family:{r['recipe_family_id']}"] = r["feedback"]
    return dict(sorted(out.items()))


# ------------------------------------------------------------------ repository

class RecommendationRepository:
    def __init__(self, db: SupabaseRest, cfg: EngineConfig = DEFAULT_CONFIG,
                 ttl_seconds: float = CANDIDATE_TTL_SECONDS) -> None:
        self._db = db
        self._cfg = cfg
        self._ttl = ttl_seconds
        self._cache: dict[str, tuple[float, list[Candidate]]] = {}
        self._lock = asyncio.Lock()

    def clear_cache(self) -> None:
        self._cache.clear()

    async def find(self, user: AuthenticatedUser, key: str) -> Candidate | None:
        """A current candidate by key (combos are rebuilt from their recipes).
        None when it is no longer available (retired recipe, inactive food...)."""
        kind = key.split(":", 1)[0]
        if kind == "combo":
            recipes = await self._load(user, "recipe")
            return next((c for c in build_combinations(recipes) if c.key == key), None)
        source = {"recipe": "recipe", "meal": "meal", "food": "food"}.get(kind)
        if source is None:
            return None
        return next((c for c in await self._load(user, source) if c.key == key), None)

    async def candidates(self, user: AuthenticatedUser, mode: str) -> list[Candidate]:
        lists = await asyncio.gather(*(self._load(user, source) for source in MODE_SOURCES[mode]))
        return [c for lst in lists for c in lst]

    async def _load(self, user: AuthenticatedUser, source: str) -> list[Candidate]:
        cached = self._cache.get(source)
        if cached and time.monotonic() - cached[0] < self._ttl:
            return cached[1]
        rows = await self._db.rpc(user, CANDIDATE_FUNCTIONS[source], {}) or []
        mapper = MAPPERS[source]
        candidates = [mapper(r, self._cfg) for r in rows]
        self._cache[source] = (time.monotonic(), candidates)
        return candidates

    async def preference_context(self, user: AuthenticatedUser) -> UserContext:
        """Only the user's explicit preferences (for re-checking optional
        components when a stored recommendation is opened or logged)."""
        prefs = await get_preferences(self._db, user)
        return UserContext(
            local_date=dt.date.today(), goal=None, targets=None, remaining=None, has_preferences=prefs is not None,
            diet=prefs.diet if prefs else None, allergies=frozenset(prefs.allergies) if prefs else frozenset(),
            dislikes=tuple(prefs.dislikes) if prefs else (),
            excluded_ingredients=tuple(prefs.excluded_ingredients) if prefs else (),
            equipment=frozenset(prefs.equipment) if prefs and prefs.equipment is not None else None)

    async def context(self, user: AuthenticatedUser, date: dt.date | None,
                      now: dt.datetime | None = None) -> UserContext:
        status = await daily_status.get_daily_status(self._db, user, date)
        local = status.date
        yesterday = local - dt.timedelta(days=1)
        now = now or dt.datetime.now(dt.UTC)
        shows_since = (now - dt.timedelta(days=SHOW_WINDOW_DAYS)).isoformat()
        events_since = (now - dt.timedelta(days=EVENT_WINDOW_DAYS)).isoformat()
        prefs, profile, logs, feedback, history, events = await asyncio.gather(
            get_preferences(self._db, user),
            self._db.select(user, "profiles", {"select": "goal", "user_id": f"eq.{user.user_id}", "limit": "1"}),
            self._db.select(user, "food_logs", {
                "select": "food_id,food_name,logged_date", "user_id": f"eq.{user.user_id}",
                "and": f"(logged_date.gte.{yesterday.isoformat()},logged_date.lte.{local.isoformat()})",
                "limit": "200"}),
            self._db.select(user, "recommendation_feedback", {
                "select": "food_id,template_id,recipe_family_id,feedback,expires_at", "limit": "1000"}),
            self._db.select(user, "recommendation_items", {
                "select": "kind,food_id,template_id,recipe_id,created_at", "created_at": f"gte.{shows_since}",
                "order": "created_at.desc", "limit": "1000"}),
            self._db.select(user, "recommendation_events", {
                "select": "event,created_at,recommendation_items(kind,food_id,template_id,recipe_id)",
                "created_at": f"gte.{events_since}", "order": "created_at.desc", "limit": "1000"}),
        )
        t, r, c = status.targets, status.remaining, status.consumed
        today = [x for x in logs if str(x.get("logged_date")) == local.isoformat()]
        before = [x for x in logs if str(x.get("logged_date")) == yesterday.isoformat()]
        return UserContext(
            local_date=local,
            goal=profile[0].get("goal") if profile else None,
            targets=Nutrition(t.kcal, t.protein_g, t.carbs_g, t.fat_g) if t else None,
            remaining=Nutrition(r.kcal, r.protein_g, r.carbs_g, r.fat_g) if r else None,
            consumed=Nutrition(c.kcal, c.protein_g, c.carbs_g, c.fat_g),
            has_preferences=prefs is not None,
            diet=prefs.diet if prefs else None,
            allergies=frozenset(prefs.allergies) if prefs else frozenset(),
            dislikes=tuple(prefs.dislikes) if prefs else (),
            cuisines=tuple(prefs.cuisines) if prefs else (),
            excluded_ingredients=tuple(prefs.excluded_ingredients) if prefs else (),
            meal_styles=frozenset(prefs.preferred_meal_styles) if prefs else frozenset(),
            max_prep_minutes=prefs.max_prep_minutes if prefs else None,
            equipment=frozenset(prefs.equipment) if prefs and prefs.equipment is not None else None,
            budget=prefs.budget if prefs else None,
            today_food_ids=frozenset(str(x["food_id"]) for x in today if x.get("food_id")),
            today_names=frozenset(normalize(x.get("food_name")) for x in today if x.get("food_name")),
            yesterday_food_ids=frozenset(str(x["food_id"]) for x in before if x.get("food_id")),
            yesterday_names=frozenset(normalize(x.get("food_name")) for x in before if x.get("food_name")),
            feedback=feedback_map(feedback, now),
            shows=show_ages(history, now),
            events=event_ages(events, now),
        )

"""recommend_meals: deterministic ranking of catalogue foods for a meal.

Inputs: the user's remaining calories/macros (get_daily_status), their stated
preferences, foods they have logged recently, and the catalogue. Output
numbers are computed by the database (food_portion) for the catalogue's
default serving; the model may explain them, never invent them.

Diet and allergen filtering uses catalogue categories and food-name keywords:
the catalogue has no ingredient lists, so results always carry a caution.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import re
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.assistant.preferences import PreferencesOut, get_preferences
from app.assistant.tools.base import Tool, ToolContext, clean_text
from app.assistant.tools.nutrition import _status

RecommendMealType = Literal["breakfast", "lunch", "dinner", "snack"]

MEAL_SHARE = {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.30, "snack": 0.10}
MEAL_CATEGORIES: dict[str, set[str | None]] = {
    "breakfast": {"south_indian", "bread", "egg_dish", "beverage", "snack", "sweet", "other", None},
    "lunch": {"rice_dish", "dal", "sabzi", "paneer_dish", "non_veg", "egg_dish", "bread", "south_indian", "salad", "side", "other", None},
    "dinner": {"rice_dish", "dal", "sabzi", "paneer_dish", "non_veg", "egg_dish", "bread", "south_indian", "soup", "salad", "other", None},
    "snack": {"snack", "beverage", "sweet", "salad", "south_indian", "soup", "side", "other", None},
}
ASSUMED_DAILY_KCAL = 2000          # only when the user has no targets; always stated in notes
LIGHT_MEAL_KCAL = 150              # when little or nothing remains
CATALOGUE_TTL_SECONDS = 900
MAX_PER_CATEGORY = 2

MEAT_WORDS = ("chicken", "mutton", "lamb", "goat", "beef", "pork", "bacon", "ham", "sausage", "keema", "kheema",
              "meat", "gosht", "murg", "murgh", "liver", "kebab")
FISH_WORDS = ("fish", "machli", "machhi", "tuna", "salmon", "sardine", "pomfret", "rohu", "hilsa", "mackerel", "surmai")
SHELLFISH_WORDS = ("prawn", "shrimp", "jhinga", "crab", "lobster", "mussel", "oyster", "squid")
EGG_WORDS = ("egg", "anda", "omelette", "omelet", "bhurji")
DAIRY_WORDS = ("paneer", "milk", "curd", "dahi", "ghee", "butter", "cheese", "cream", "lassi", "raita", "kheer",
               "yogurt", "yoghurt", "khoa", "khoya", "malai", "buttermilk", "chaas", "chhena", "rabri", "kulfi", "shrikhand")
JAIN_EXCLUDED = ("onion", "garlic", "potato", "aloo", "carrot", "gajar", "beetroot", "radish", "mooli", "ginger", "shakarkandi")
ALLERGEN_WORDS: dict[str, tuple[str, ...]] = {
    "peanut": ("peanut", "groundnut", "moongphali", "mungfali"),
    "tree_nut": ("almond", "badam", "cashew", "kaju", "pista", "pistachio", "walnut", "akhrot", "nut"),
    "milk": DAIRY_WORDS,
    "egg": EGG_WORDS,
    "wheat_gluten": ("wheat", "atta", "maida", "roti", "chapati", "chapatti", "naan", "paratha", "parantha", "bread",
                     "puri", "poori", "kulcha", "bhatura", "suji", "sooji", "semolina", "rava", "upma", "dalia",
                     "pasta", "noodle", "biscuit", "cake", "samosa"),
    "soy": ("soy", "soya", "tofu"),
    "fish": FISH_WORDS,
    "shellfish": SHELLFISH_WORDS,
    "sesame": ("sesame", "til", "gingelly"),
    "mustard": ("mustard", "sarson", "rai"),
}


# ============================================================================ catalogue pool (shared, cached)

@dataclass(frozen=True)
class PoolFood:
    food_id: str
    name: str
    lname: str
    category: str | None
    source: str
    source_ref: str | None
    serving_label: str
    serving_g: float
    kcal: float          # for the default serving (ranking only; final numbers come from food_portion)
    protein: float
    carbs: float
    fat: float


class CataloguePool:
    """Matchable generic catalogue foods with a default serving. The catalogue
    is shared by all users and changes rarely, so it is cached per process."""

    def __init__(self) -> None:
        self._foods: list[PoolFood] = []
        self._loaded_at = 0.0
        self._lock = asyncio.Lock()

    async def foods(self, ctx: ToolContext) -> list[PoolFood]:
        async with self._lock:
            if not self._foods or time.monotonic() - self._loaded_at > CATALOGUE_TTL_SECONDS:
                self._foods = await self._load(ctx)
                self._loaded_at = time.monotonic()
            return self._foods

    @staticmethod
    async def _load(ctx: ToolContext) -> list[PoolFood]:
        rows = await ctx.db.select(ctx.user, "foods", {
            "select": ("id,name,category,source,source_ref,basis,density_g_per_ml,kcal_per_100,protein_g_per_100,"
                       "carbs_g_per_100,fat_g_per_100,food_servings(label,grams,is_default)"),
            "is_active": "eq.true", "is_matchable": "eq.true", "food_kind": "neq.packaged", "limit": "3000",
        })
        out: list[PoolFood] = []
        for r in rows:
            serving = next((s for s in r.get("food_servings") or [] if s.get("is_default")), None)
            if not serving or not serving.get("grams"):
                continue
            per_g = 1.0
            if r.get("basis") == "ml":
                density = r.get("density_g_per_ml")
                if not density:
                    continue
                per_g = 1 / float(density)      # values per 100 ml -> per 100 g
            g = float(serving["grams"])
            f = g / 100 * per_g
            name = clean_text(r["name"]) or ""
            out.append(PoolFood(
                food_id=str(r["id"]), name=name, lname=name.lower(), category=r.get("category"),
                source=r["source"], source_ref=r.get("source_ref"),
                serving_label=clean_text(serving["label"], 60) or "1 serving", serving_g=g,
                kcal=float(r["kcal_per_100"]) * f, protein=float(r["protein_g_per_100"]) * f,
                carbs=float(r["carbs_g_per_100"]) * f, fat=float(r["fat_g_per_100"]) * f,
            ))
        return out


# ============================================================================ preference filters

_PATTERNS: dict[tuple[str, ...], re.Pattern[str]] = {}


def _has(name: str, words: tuple[str, ...]) -> bool:
    """True if any word starts a word in `name` ("egg" matches "eggs", not "veggie").
    Errs on the side of excluding: a false exclusion is cheaper than a missed allergen."""
    pattern = _PATTERNS.get(words)
    if pattern is None:
        pattern = _PATTERNS[words] = re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + ")")
    return bool(pattern.search(name))


def excluded_by(food: PoolFood, prefs: PreferencesOut | None) -> str | None:
    """Why a food is excluded for these preferences, or None."""
    if prefs is None:
        return None
    n, cat = food.lname, food.category
    diet = prefs.diet
    if diet in ("vegetarian", "vegan", "jain", "eggetarian", "pescatarian"):
        meat = cat == "non_veg" or _has(n, MEAT_WORDS)
        fish = _has(n, FISH_WORDS) or _has(n, SHELLFISH_WORDS)
        egg = cat == "egg_dish" or _has(n, EGG_WORDS)
        if diet == "pescatarian":
            if meat and not fish:
                return "diet"
        elif meat or fish or (egg and diet != "eggetarian"):
            return "diet"
        if diet == "vegan" and _has(n, DAIRY_WORDS):
            return "diet"
        if diet == "jain" and _has(n, JAIN_EXCLUDED):
            return "diet"
    for allergy in prefs.allergies:
        if _has(n, ALLERGEN_WORDS.get(allergy, ())):
            return "allergy"
    for dislike in prefs.dislikes:
        d = dislike.lower().strip()
        if d and d in n:
            return "dislike"
    return None


# ============================================================================ tool

class RecommendArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    meal_type: RecommendMealType = Field(description="Which meal to suggest for. Ask the user if unclear.")
    count: int = Field(default=3, ge=1, le=5)


class MealTarget(BaseModel):
    calories_kcal: float
    protein_g: float | None


class RecNutrition(BaseModel):
    calories_kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float


class Recommendation(BaseModel):
    food_id: uuid.UUID
    name: str
    category: str | None
    serving_label: str
    serving_g: float
    nutrition: RecNutrition
    source: str
    source_ref: str | None
    score: float
    reasons: list[str]


class RecommendResult(BaseModel):
    meal_type: RecommendMealType
    meal_target: MealTarget
    remaining_today: RecNutrition | None
    recommendations: list[Recommendation]
    filters_applied: list[str]
    cautions: list[str]
    notes: list[str]
    data_source: Literal["catalogue"] = "catalogue"


def score(food: PoolFood, target_kcal: float, target_protein: float | None, remaining_fat: float | None,
          remaining_carbs: float | None, times_logged: int) -> float:
    kcal_fit = max(0.0, 1 - abs(food.kcal - target_kcal) / max(target_kcal, 1))
    if target_protein and target_protein > 0:
        protein_fit = min(1.0, food.protein / target_protein)
    else:
        protein_fit = min(1.0, (food.protein * 4 / max(food.kcal, 1)) / 0.25)
    s = 0.55 * kcal_fit + 0.30 * protein_fit
    if remaining_fat is not None and food.fat > max(remaining_fat, 0) + 2:
        s -= 0.15
    if remaining_carbs is not None and food.carbs > max(remaining_carbs, 0) + 5:
        s -= 0.10
    if times_logged >= 3:
        s += 0.15
    elif times_logged >= 1:
        s += 0.10
    return round(s, 4)


async def _recent_food_counts(ctx: ToolContext) -> Counter[str]:
    since = (ctx.today - dt.timedelta(days=30)).isoformat()
    rows = await ctx.db.select(ctx.user, "food_logs", {
        "select": "food_id", "user_id": f"eq.{ctx.user.user_id}", "food_id": "not.is.null",
        "logged_date": f"gte.{since}", "limit": "500",
    })
    return Counter(str(r["food_id"]) for r in rows if r.get("food_id"))


async def _portion(ctx: ToolContext, food: PoolFood) -> dict[str, Any] | None:
    rows = await ctx.db.rpc(ctx.user, "food_portion", {"p_food_id": food.food_id, "p_grams": food.serving_g})
    row = rows[0] if rows else None
    return row if row and row.get("calories") is not None else None


async def run_recommend(ctx: ToolContext, args: RecommendArgs) -> RecommendResult:
    meal = args.meal_type
    status = await _status(ctx, None)
    prefs = await get_preferences(ctx.db, ctx.user)
    pool = ctx.services.setdefault("catalogue_pool", CataloguePool())
    foods = await pool.foods(ctx)
    counts = await _recent_food_counts(ctx)

    notes: list[str] = []
    t, r = status.targets, status.remaining
    if t is None:
        daily = ASSUMED_DAILY_KCAL
        notes.append(f"No personal targets are set, so a typical {ASSUMED_DAILY_KCAL} kcal day was assumed.")
    else:
        daily = t.kcal
    meal_kcal = MEAL_SHARE[meal] * daily
    remaining = None
    target_protein = None
    if r is not None:
        remaining = RecNutrition(calories_kcal=round(r.kcal, 1), protein_g=round(r.protein_g, 1),
                                 carbs_g=round(r.carbs_g, 1), fat_g=round(r.fat_g, 1))
        if r.kcal <= 100:
            meal_kcal = LIGHT_MEAL_KCAL
            notes.append("Little or nothing remains of today's calorie target, so only light options are suggested.")
        else:
            meal_kcal = min(meal_kcal, r.kcal)
            if r.protein_g > 0:
                target_protein = round(r.protein_g * min(1.0, meal_kcal / r.kcal), 1)

    filters = []
    if prefs and prefs.diet:
        filters.append(f"diet: {prefs.diet}")
    if prefs and prefs.allergies:
        filters.append("allergies: " + ", ".join(prefs.allergies))
    if prefs and prefs.dislikes:
        filters.append("dislikes: " + ", ".join(prefs.dislikes))

    allowed = MEAL_CATEGORIES[meal]
    eligible = [f for f in foods if f.category in allowed and excluded_by(f, prefs) is None
                and f.kcal > 0 and f.kcal <= meal_kcal * 1.6]
    ranked = sorted(
        eligible,
        key=lambda f: (-score(f, meal_kcal, target_protein, r.fat_g if r else None, r.carbs_g if r else None,
                              counts.get(f.food_id, 0)), f.name),
    )
    picked: list[PoolFood] = []
    per_cat: Counter[str | None] = Counter()
    for f in ranked:
        if per_cat[f.category] >= MAX_PER_CATEGORY:
            continue
        picked.append(f)
        per_cat[f.category] += 1
        if len(picked) >= args.count * 2:      # spares in case a portion can't be priced
            break

    portions = await asyncio.gather(*(_portion(ctx, f) for f in picked))
    recs: list[Recommendation] = []
    for f, p in zip(picked, portions):
        if p is None or len(recs) >= args.count:
            continue
        reasons = [f"About {round(float(p['calories']))} kcal for {f.serving_label}, against roughly "
                   f"{round(meal_kcal)} kcal available for {meal}."]
        if float(p["protein_g"]) >= 10:
            reasons.append(f"{float(p['protein_g']):g} g protein.")
        if counts.get(f.food_id):
            reasons.append("You've logged this before.")
        recs.append(Recommendation(
            food_id=uuid.UUID(f.food_id), name=f.name, category=f.category, serving_label=f.serving_label,
            serving_g=f.serving_g,
            nutrition=RecNutrition(calories_kcal=float(p["calories"]), protein_g=float(p["protein_g"]),
                                   carbs_g=float(p["carbs_g"]), fat_g=float(p["fat_g"])),
            source=f.source, source_ref=f.source_ref,
            score=score(f, meal_kcal, target_protein, r.fat_g if r else None, r.carbs_g if r else None,
                        counts.get(f.food_id, 0)),
            reasons=reasons,
        ))
    cautions = ["Portions are the catalogue's standard serving; adjust to what you actually eat."]
    if prefs and (prefs.diet or prefs.allergies):
        cautions.append("Diet and allergy filtering is based on food names and categories only. "
                        "Always check ingredients, especially for allergies.")
    if not recs:
        notes.append("No catalogue foods fit these limits and preferences.")
    return RecommendResult(
        meal_type=meal, meal_target=MealTarget(calories_kcal=round(meal_kcal, 1), protein_g=target_protein),
        remaining_today=remaining, recommendations=recs, filters_applied=filters, cautions=cautions, notes=notes,
    )


RECOMMEND_MEALS = Tool(
    name="recommend_meals",
    description=("Suggest catalogue foods for a meal that fit the user's remaining calories and macros today and "
                 "their stated diet, allergies and dislikes. Ranking and nutrition are computed by the backend; "
                 "explain the results, don't change their numbers."),
    args=RecommendArgs, result=RecommendResult, run=run_recommend, supports=("meal_recommendation",),
)

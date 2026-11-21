"""Recipe drafts: validation, loading (as drafts) and review report (Phase 3).

Recipes are written by people (data/recipes_draft.csv and
data/recipe_ingredients_draft.csv). This module never invents ingredients,
quantities or nutrition: nutrition is computed by the database
(recipe_nutrition: ingredient grams x catalogue per-100 g values).

Loading creates DRAFTS only (invisible to users). An existing draft with the
same slug is replaced; a published recipe is never touched (changes to it go
into a new version via new_recipe_version()). Publishing is a separate,
reviewed step (publish_recipe).
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

CATEGORIES = {
    "breakfast", "lunch", "dinner", "snack", "bread", "rice", "dal", "sabzi", "curry", "breakfast_dish", "one_pot",
    "side", "egg_dish", "north_indian", "south_indian", "east_indian", "west_indian", "pan_indian",
}
EQUIPMENT = {"stove", "pressure_cooker", "tawa", "kadai", "oven", "microwave", "blender", "steamer", "air_fryer"}
UNITS = {"g", "kg", "ml", "l", "piece", "cup", "tbsp", "tsp", "katori", "bowl", "pinch", "clove", "bunch"}
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
DIET_ORDER = ["vegan", "vegetarian", "egg", "fish", "meat"]
FLAG_WARNINGS = {
    "density_assumed": "volume converted assuming water-like density",
    "energy_mismatch": "catalogue energy doesn't match its macros",
    "cooking_oil_uncertain": "catalogue values count all cooking oil",
}


@dataclass
class Ingredient:
    position: int
    food_ref: str
    name_check: str
    quantity: float
    unit: str
    grams: float | None
    preparation: str | None
    optional: bool


@dataclass
class Recipe:
    slug: str
    name: str
    variant: str | None
    servings: float
    serving_label: str
    categories: list[str]
    prep_minutes: int | None
    cook_minutes: int | None
    description: str | None
    instructions: list[str]
    ingredients: list[Ingredient] = field(default_factory=list)
    # None: not recorded; []: needs no equipment ("none" in the CSV).
    equipment: list[str] | None = None


def _num(value: str) -> float | None:
    value = (value or "").strip()
    return float(value) if value else None


def _equipment(value: str | None) -> list[str] | None:
    value = (value or "").strip()
    if not value:
        return None
    if value == "none":
        return []
    return [e.strip() for e in value.split("|") if e.strip()]


def read_drafts(recipes_csv: Path, ingredients_csv: Path) -> tuple[list[Recipe], list[str]]:
    problems: list[str] = []
    recipes: dict[str, Recipe] = {}
    with recipes_csv.open(encoding="utf-8", newline="") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            slug = row["slug"].strip()
            if not SLUG.match(slug):
                problems.append(f"recipes line {n}: invalid slug {slug!r}")
                continue
            if slug in recipes:
                problems.append(f"recipes line {n}: duplicate slug {slug!r}")
                continue
            try:
                servings = float(row["servings"])
            except ValueError:
                problems.append(f"{slug}: servings {row['servings']!r} is not a number")
                continue
            if not 0 < servings <= 100:
                problems.append(f"{slug}: servings must be between 0 and 100")
            cats = [c for c in row["categories"].split("|") if c]
            unknown = sorted(set(cats) - CATEGORIES)
            if unknown:
                problems.append(f"{slug}: unknown categories {unknown}")
            equipment = _equipment(row.get("equipment"))
            bad = sorted(set(equipment or []) - EQUIPMENT)
            if bad:
                problems.append(f"{slug}: unknown equipment {bad}")
            recipes[slug] = Recipe(
                slug=slug, name=row["name"].strip(), variant=(row["variant"] or "").strip() or None, servings=servings,
                serving_label=row["serving_label"].strip(), categories=cats,
                prep_minutes=int(row["prep_minutes"]) if row["prep_minutes"].strip() else None,
                cook_minutes=int(row["cook_minutes"]) if row["cook_minutes"].strip() else None,
                description=(row["description"] or "").strip() or None,
                instructions=[s.strip() for s in row["instructions"].split("|") if s.strip()], equipment=equipment)

    with ingredients_csv.open(encoding="utf-8", newline="") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            slug = row["slug"].strip()
            r = recipes.get(slug)
            if r is None:
                problems.append(f"ingredients line {n}: unknown recipe {slug!r}")
                continue
            try:
                ing = Ingredient(position=int(row["position"]), food_ref=row["food_ref"].strip(),
                                 name_check=row["food_name_check"].strip(), quantity=float(row["quantity"]),
                                 unit=row["unit"].strip(), grams=_num(row["grams"]),
                                 preparation=(row["preparation"] or "").strip() or None,
                                 optional=row["optional"].strip().lower() == "true")
            except ValueError as exc:
                problems.append(f"ingredients line {n}: {slug}: unreadable ({exc})")
                continue
            r.ingredients.append(ing)

    seen_names: dict[tuple[str, str], str] = {}
    for r in recipes.values():
        key = (" ".join(r.name.lower().split()), (r.variant or "").lower())
        if key in seen_names:
            problems.append(f"{r.slug}: duplicate of {seen_names[key]} (same name and variant)")
        seen_names[key] = r.slug
        if not any(not i.optional for i in r.ingredients):
            problems.append(f"{r.slug}: no required ingredients")
        positions = [i.position for i in r.ingredients]
        if len(set(positions)) != len(positions):
            problems.append(f"{r.slug}: duplicate ingredient positions")
        for i in r.ingredients:
            where = f"{r.slug} #{i.position}"
            if i.unit not in UNITS:
                problems.append(f"{where}: unknown unit {i.unit!r}")
            if not 0 < i.quantity <= 10000:
                problems.append(f"{where}: quantity {i.quantity} out of range")
            if i.unit in ("g", "kg") and i.grams is not None:
                expected = i.quantity * (1000 if i.unit == "kg" else 1)
                if abs(expected - i.grams) > 0.001:
                    problems.append(f"{where}: inconsistent units ({i.quantity} {i.unit} is not {i.grams} g)")
            if i.unit not in ("g", "kg", "ml", "l") and i.grams is None and not i.optional:
                problems.append(f"{where}: '{i.unit}' needs a weight in grams (nutrition would be incomplete)")
            if i.grams is not None and not 0 < i.grams <= 20000:
                problems.append(f"{where}: grams {i.grams} out of range")
    return list(recipes.values()), problems


def _ref_key(ref: str) -> tuple[str, str]:
    source, _, code = ref.rpartition(":")
    return (source or "indb", code)


def resolve_foods(conn: Any, recipes: list[Recipe]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    keys = sorted({_ref_key(i.food_ref) for r in recipes for i in r.ingredients})
    rows = conn.execute("""
        select f.source, f.source_ref, f.id::text as food_id, f.name, f.is_active, f.is_matchable, f.quality_flags,
               a.diet_class, a.diet_status, a.allergens
        from public.foods f left join public.food_attributes a on a.food_id = f.id
        where (f.source, f.source_ref) in (select * from unnest(%s::text[], %s::text[]))""",
        ([k[0] for k in keys], [k[1] for k in keys])).fetchall()
    by_key = {(r["source"], r["source_ref"]): r for r in rows}
    foods: dict[str, dict[str, Any]] = {}
    problems: list[str] = []
    for r in recipes:
        for i in r.ingredients:
            f = by_key.get(_ref_key(i.food_ref))
            if f is None:
                problems.append(f"{r.slug} #{i.position}: {i.food_ref} is not in the catalogue")
            elif f["name"] != i.name_check:
                problems.append(f"{r.slug} #{i.position}: {i.food_ref} is {f['name']!r}, CSV says {i.name_check!r}")
            elif not f["is_active"]:
                problems.append(f"{r.slug} #{i.position}: {i.food_ref} is inactive")
            else:
                foods[i.food_ref] = f
    return foods, problems


def load_drafts(conn: Any, recipes: list[Recipe], foods: dict[str, dict[str, Any]], source_name: str) -> list[str]:
    """Inserts recipes as drafts in one transaction. Returns notes (skipped recipes)."""
    notes: list[str] = []
    with conn.transaction():
        for r in recipes:
            current = conn.execute("select id, status from public.recipes where slug = %s and owner_id is null and is_current",
                                   (r.slug,)).fetchone()
            if current and current["status"] != "draft":
                notes.append(f"{r.slug}: already {current['status']}; not changed (use a new version)")
                continue
            if current:
                conn.execute("delete from public.recipes where id = %s", (current["id"],))
            rid = conn.execute("""
                insert into public.recipes (slug, name, variant, description, servings, serving_label, instructions,
                  prep_minutes, cook_minutes, equipment, source, source_name, verification, quantities_estimated)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'curated', %s, 'unverified', true) returning id""",
                (r.slug, r.name, r.variant, r.description, r.servings, r.serving_label, r.instructions,
                 r.prep_minutes, r.cook_minutes, r.equipment, source_name)).fetchone()["id"]
            for c in r.categories:
                conn.execute("insert into public.recipe_category_assignments (recipe_id, category_slug) values (%s, %s)",
                             (rid, c))
            for i in sorted(r.ingredients, key=lambda x: x.position):
                conn.execute("""
                    insert into public.recipe_ingredients (recipe_id, position, food_id, quantity, unit, grams,
                      preparation, optional, is_estimate)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, true)""",
                    (rid, i.position, foods[i.food_ref]["food_id"], i.quantity, i.unit,
                     i.grams if i.unit not in ("g", "kg") else None, i.preparation, i.optional))
    return notes


def build_report(conn: Any, recipes: list[Recipe], foods: dict[str, dict[str, Any]], problems: list[str],
                 notes: list[str]) -> str:
    sections: list[str] = []
    summary: list[str] = []
    for r in recipes:
        row = conn.execute("""
            select r.id, r.status, n.complete, n.missing, n.missing_nutrients, n.total, n.per_serving
            from public.recipes r cross join lateral public.recipe_nutrition(r.id) n
            where r.slug = %s and r.owner_id is null and r.is_current""", (r.slug,)).fetchone()
        title = f"{r.name}" + (f" — {r.variant}" if r.variant else "")
        if row is None:
            sections.append(f"### {title} (`{r.slug}`)\n\nNot loaded.\n")
            continue
        diets, allergens, warnings = [], set(), set()
        lines = [f"### {title} (`{r.slug}`)", "",
                 f"Makes {r.servings:g} × {r.serving_label} · {', '.join(r.categories)} · status: {row['status']}", "",
                 "| # | Ingredient | Quantity | Grams | Notes |", "|---|---|---|---|---|"]
        for i in sorted(r.ingredients, key=lambda x: x.position):
            f = foods.get(i.food_ref, {})
            grams = i.grams if i.grams is not None else (i.quantity * (1000 if i.unit == "kg" else 1) if i.unit in ("g", "kg") else None)
            note = "optional (not counted)" if i.optional else ""
            lines.append(f"| {i.position} | {f.get('name', i.food_ref)} | {i.quantity:g} {i.unit} | "
                         f"{'' if grams is None else f'{grams:g}'} | {', '.join(x for x in (i.preparation, note) if x)} |")
            if not i.optional:
                diets.append(f.get("diet_class") or "unknown")
                allergens.update(f.get("allergens") or [])
            for flag in f.get("quality_flags") or []:
                if flag in FLAG_WARNINGS:
                    warnings.add(f"{f['name']}: {FLAG_WARNINGS[flag]}")
        diet = "unknown" if "unknown" in diets or not diets else max(diets, key=DIET_ORDER.index)
        if row["complete"]:
            t, s = row["total"], row["per_serving"]
            extra = ", ".join(f"{k.replace('_g', '')} {s[k]} g" for k in ("fiber_g", "sugars_g", "saturated_fat_g") if k in s)
            sodium = f", sodium {s['sodium_g'] * 1000:.0f} mg" if "sodium_g" in s else ""
            lines += ["", f"**Per serving:** {s['calories']} kcal · P {s['protein_g']} g · C {s['carbs_g']} g · "
                      f"F {s['fat_g']} g" + (f" · {extra}" if extra else "") + sodium,
                      f"**Whole recipe:** {t['calories']} kcal from {t['grams']} g of ingredients (raw weight)"]
            if row["missing_nutrients"]:
                lines.append(f"Not reported (an ingredient lacks it): {', '.join(row['missing_nutrients'])}")
            summary.append(f"| {title} | {r.servings:g} × {r.serving_label} | {s['calories']} | {s['protein_g']} | {diet} |")
        else:
            lines += ["", "**Nutrition incomplete:** " + "; ".join(row["missing"])]
            summary.append(f"| {title} | {r.servings:g} × {r.serving_label} | incomplete | – | {diet} |")
        lines.append(f"**Diet (from ingredients, inferred):** {diet} · **Allergens detected:** "
                     f"{', '.join(sorted(allergens)) or 'none detected'} (keywords only; absence not verified)")
        if warnings:
            lines.append("**Data-quality warnings:** " + "; ".join(sorted(warnings)))
        lines.append("**Quantities:** typical home amounts (estimated), not measured.")
        lines.append("")
        sections.append("\n".join(lines))

    head = ["# Recipes: review", "",
            f"{len(recipes)} draft recipes. Nutrition is computed by the database (`recipe_nutrition`: ingredient grams × "
            "catalogue per-100 g values, rounded like food logging). Ingredient nutrition comes from USDA FoodData "
            "Central (SR Legacy). No value was typed in or generated by a model. Recipes stay drafts until published.", ""]
    if problems:
        head += ["## Blocking problems", ""] + [f"- {p}" for p in problems] + [""]
    if notes:
        head += ["## Notes", ""] + [f"- {n}" for n in notes] + [""]
    head += ["## Summary (per serving)", "", "| Recipe | Makes | kcal | Protein g | Diet |", "|---|---|---|---|---|",
             *summary, "", "## Recipes", ""]
    return "\n".join(head + sections)

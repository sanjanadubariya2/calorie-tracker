"""Meal template drafts: validation, review checks and review report (Phase 3).

The CSV (data/meal_templates_draft.csv) is written by a person; nothing here
invents foods, portions or nutrition. The report:
  * checks every component against the catalogue (exists, name matches, active,
    matchable, default serving, servings range/step);
  * prices every component with the database's own food_portion() (the
    logging path) and reports the BASE meal (required components) and the meal
    WITH every optional component at its default servings;
  * keeps diet/allergen attributes per component with their status (reviewed /
    inferred / unknown); "none detected" is never presented as allergen-free;
  * keeps catalogue data-quality warnings (e.g. assumed density);
  * flags unusual catalogue serving weights for human review, with the
    serving-weight audit's assessment (serving_audit.py). Catalogue values are
    never changed here;
  * notes when a base meal is outside a typical calorie range. That is a soft
    recommendation target only, never a reason to change portions, so no
    portion change is ever proposed from it;
  * shows the human decisions recorded in data/meal_templates_decisions.csv.

Review status lives in data/meal_templates_review_status.csv:
  pending               not reviewed
  approved_provisional  usable by the recommendation engine, but NOT individually
                        verified by a person (needs reviewer, timestamp, notes)
  approved              individually verified by a person
  needs_correction      reviewed, must change first (needs notes)
  rejected              reviewed, not to be used (needs notes)
This module never sets it, and never loads or approves templates.
"""

from __future__ import annotations

import csv
import datetime as dt
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.services.catalogue.serving_audit import EVIDENCE

DIET_ORDER = ["vegan", "vegetarian", "egg", "fish", "meat"]          # less -> more restrictive to eat
SLOTS = {"main", "side", "bread", "rice", "drink", "accompaniment"}
MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}
REGIONS = {"north_indian", "south_indian", "east_indian", "west_indian", "pan_indian"}
REVIEW_STATUSES = ("pending", "approved_provisional", "approved", "needs_correction", "rejected")
USABLE_STATUSES = ("approved_provisional", "approved")      # may be loaded as approved templates
STATUS_LABEL = {"pending": "pending", "approved_provisional": "approved (provisional, not individually verified)",
                "approved": "approved (verified)", "needs_correction": "needs correction", "rejected": "rejected"}
FLAG_WARNINGS = {
    "density_assumed": "Volume converted assuming water-like density.",
    "energy_mismatch": "Catalogue energy doesn't match its macros.",
    "cooking_oil_uncertain": "Values count all the cooking oil; real intake is likely lower.",
}

# Review thresholds. They only raise flags for a person; they never change data.
# Grams for ONE unit of a household serving label, as typically served.
UNIT_GRAMS: dict[str, tuple[float, float]] = {
    "small bowl": (80, 200), "curry bowl": (150, 300), "bowl": (120, 300), "katori": (100, 200),
    "plate": (150, 350), "tall glass": (200, 350), "glass": (150, 300), "tea cup": (100, 200), "cup": (150, 250),
    "tablespoon": (10, 25), "teaspoon": (3, 8),
    "idli": (30, 60), "dosa": (60, 150), "uttapam": (80, 160), "parantha": (60, 130), "paratha": (60, 130),
    "chapati": (25, 45), "roti": (25, 45), "thepla": (25, 50), "cheela": (40, 120), "chilla": (40, 120),
    "egg": (40, 75), "piece": (20, 60),
}
SEVERE_FACTOR = 2.0          # a unit weight beyond 2x the range (or below half) needs correction, not just a check
# Base meal energy at default servings, by meal type.
MEAL_KCAL: dict[str, tuple[float, float]] = {
    "breakfast": (250, 600), "lunch": (400, 850), "dinner": (400, 850), "snack": (100, 350),
}


@dataclass
class Component:
    position: int
    slot: str
    source_ref: str
    name_check: str
    default: float
    min: float
    max: float
    step: float
    optional: bool


@dataclass
class Template:
    slug: str
    name: str
    meal_types: list[str]
    regions: list[str]
    components: list[Component] = field(default_factory=list)


@dataclass
class Priced:
    """One component priced by the database at its default servings."""
    c: Component
    food: dict[str, Any]
    grams: float
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float


@dataclass
class Flag:
    slug: str
    position: int | None           # None: the whole meal
    check: str                     # serving_weight | meal_energy | name_mentions_optional
    severity: str                  # info | review | correction
    message: str


@dataclass
class Proposal:
    slug: str
    position: int
    component: str
    field: str
    original: str
    proposed: str
    reason: str


@dataclass
class Decision:
    """A recorded human decision (data/meal_templates_decisions.csv)."""
    slug: str
    position: str
    component: str
    change: str
    original: str
    proposed: str
    status: str                    # applied | rejected
    reason: str
    decided_by: str


@dataclass
class ReviewStatus:
    status: str = "pending"
    reviewer: str = ""
    reviewed_at: str = ""
    notes: str = ""


# ============================================================================ CSV

def read_csv(path: Path) -> tuple[list[Template], list[str]]:
    templates: dict[str, Template] = {}
    problems: list[str] = []
    with path.open(encoding="utf-8", newline="") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            slug = row["slug"].strip()
            t = templates.get(slug)
            meal_types = [m for m in row["meal_types"].split("|") if m]
            regions = [r for r in row["regions"].split("|") if r]
            if t is None:
                t = templates[slug] = Template(slug=slug, name=row["name"].strip(), meal_types=meal_types, regions=regions)
            elif (t.name, t.meal_types, t.regions) != (row["name"].strip(), meal_types, regions):
                problems.append(f"line {n}: {slug}: template fields differ between rows")
            try:
                c = Component(position=int(row["position"]), slot=row["slot"].strip(), source_ref=row["food_source_ref"].strip(),
                              name_check=row["food_name_check"].strip(), default=float(row["default_servings"]),
                              min=float(row["min_servings"]), max=float(row["max_servings"]),
                              step=float(row["servings_step"]), optional=row["optional"].strip().lower() == "true")
            except (KeyError, ValueError) as exc:
                problems.append(f"line {n}: {slug}: unreadable component ({exc})")
                continue
            t.components.append(c)
    for t in templates.values():
        if not t.meal_types or set(t.meal_types) - MEAL_TYPES:
            problems.append(f"{t.slug}: invalid meal_types {t.meal_types}")
        if set(t.regions) - REGIONS:
            problems.append(f"{t.slug}: invalid regions {t.regions}")
        positions = [c.position for c in t.components]
        if len(set(positions)) != len(positions):
            problems.append(f"{t.slug}: duplicate positions")
        if len({c.source_ref for c in t.components}) != len(t.components):
            problems.append(f"{t.slug}: the same food appears twice")
        if not any(not c.optional for c in t.components):
            problems.append(f"{t.slug}: every component is optional")
        for c in t.components:
            if c.slot not in SLOTS:
                problems.append(f"{t.slug}: invalid slot {c.slot!r}")
            if not (0 < c.min <= c.default <= c.max <= 10) or c.step not in (0.25, 0.5, 1):
                problems.append(f"{t.slug}: {c.source_ref}: servings {c.min}..{c.default}..{c.max} step {c.step} invalid")
            elif abs(((c.default - c.min) / c.step) - round((c.default - c.min) / c.step)) > 1e-9:
                problems.append(f"{t.slug}: {c.source_ref}: default isn't reachable from min in steps of {c.step}")
    return list(templates.values()), problems


def read_review_status(path: Path, slugs: list[str]) -> tuple[dict[str, ReviewStatus], list[str]]:
    """Human review decisions. A missing file or row means 'pending'."""
    out = {s: ReviewStatus() for s in slugs}
    problems: list[str] = []
    if not path.exists():
        return out, problems
    with path.open(encoding="utf-8", newline="") as f:
        for n, row in enumerate(csv.DictReader(f), start=2):
            slug = (row.get("slug") or "").strip()
            status = (row.get("review_status") or "pending").strip() or "pending"
            r = ReviewStatus(status=status, reviewer=(row.get("reviewer") or "").strip(),
                             reviewed_at=(row.get("reviewed_at") or "").strip(), notes=(row.get("notes") or "").strip())
            if slug not in out:
                problems.append(f"review status line {n}: unknown template {slug!r}")
                continue
            if status not in REVIEW_STATUSES:
                problems.append(f"review status line {n}: {slug}: {status!r} is not one of {', '.join(REVIEW_STATUSES)}")
                continue
            if status != "pending" and not (r.reviewer and r.reviewed_at):
                problems.append(f"review status line {n}: {slug}: {status} needs a reviewer and a date")
            if status in ("needs_correction", "rejected", "approved_provisional") and not r.notes:
                problems.append(f"review status line {n}: {slug}: {status} needs notes saying why")
            out[slug] = r
    return out, problems


def read_decisions(path: Path) -> list[Decision]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        return [Decision(**{k: (v or "").strip() for k, v in row.items()}) for row in csv.DictReader(f)]


def write_review_status(path: Path, statuses: dict[str, ReviewStatus]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["slug", "review_status", "reviewer", "reviewed_at", "notes"])
        for slug, r in statuses.items():
            w.writerow([slug, r.status, r.reviewer, r.reviewed_at, r.notes])


# ============================================================================ review checks (pure)

def serving_unit(label: str) -> tuple[str | None, float]:
    """('bowl', 1) for '1 bowl'; ('tea cup', 1) for '1 tea cup'; (None, 1) if unknown."""
    text = label.lower().strip()
    m = re.match(r"^(\d+(?:\.\d+)?)\s+(.*)$", text)
    count, noun = (float(m.group(1)), m.group(2)) if m else (1.0, text)
    noun = re.sub(r"\(.*?\)", "", noun).strip()
    for unit in sorted(UNIT_GRAMS, key=len, reverse=True):
        if re.search(rf"\b{re.escape(unit)}(e?s)?\b$", noun) or noun == unit:
            return unit, count or 1.0
    return None, count or 1.0


def unit_weight_status(p: Priced) -> str:
    """'small', 'large', 'ok' or 'unknown' for one household unit of the catalogue serving."""
    unit, count = serving_unit(p.food["serving_label"])
    if unit is None:
        return "unknown"
    per_unit = float(p.food["serving_grams"]) / count
    lo, hi = UNIT_GRAMS[unit]
    return "small" if per_unit < lo else ("large" if per_unit > hi else "ok")


def serving_flags(t: Template, priced: list[Priced]) -> list[Flag]:
    """Catalogue serving weights far from what that household unit usually weighs."""
    flags = []
    for p in priced:
        label, grams_per_serving = p.food["serving_label"], float(p.food["serving_grams"])
        unit, count = serving_unit(label)
        if unit is None:
            continue
        per_unit = grams_per_serving / count
        lo, hi = UNIT_GRAMS[unit]
        if lo <= per_unit <= hi:
            continue
        severe = per_unit > hi * SEVERE_FACTOR or per_unit < lo / SEVERE_FACTOR
        message = (f"{p.food['name']}: the catalogue's '{label}' weighs {per_unit:.0f} g; a {unit} is usually "
                   f"{lo:.0f}–{hi:.0f} g{' (far outside)' if severe else ''}.")
        evidence = EVIDENCE.get(p.food["source_ref"])
        if evidence and evidence.assessment == "plausible":
            severity = "info"
            message += f" Serving-weight audit: plausible ({evidence.verification}); kept as is."
        else:
            # A catalogue question, tracked in the serving-weight audit; it does not by
            # itself make the template wrong (template nutrition is INDB's per-serving value).
            severity = "review"
            message += (" Serving-weight audit: " + (f"{evidence.assessment}, {evidence.verification}"
                        if evidence else "not individually assessed") + "; no catalogue change without a traceable "
                        "source or approval.")
        flags.append(Flag(t.slug, p.c.position, "serving_weight", severity, message))
    return flags


def meal_range(meal_types: list[str]) -> tuple[float, float] | None:
    """Energy range that suits EVERY listed meal type; None if they don't overlap."""
    lo = max(MEAL_KCAL[m][0] for m in meal_types)
    hi = min(MEAL_KCAL[m][1] for m in meal_types)
    return (lo, hi) if lo <= hi else None


def meal_flags(t: Template, priced: list[Priced], price_kcal: Callable[[Priced, float], float] | None = None
               ) -> tuple[list[Flag], list[Proposal]]:
    """Base-meal energy against typical ranges for the listed meal types.

    A calorie range is a soft recommendation target (the engine scales
    portions to the user's budget at recommendation time), not evidence that a
    serving is wrong, so this only notes it and never proposes a portion
    change. Meal types that cannot share any size are still a correction."""
    base = [p for p in priced if not p.c.optional]
    kcal = sum(p.kcal for p in base)
    rng = meal_range(t.meal_types)
    if rng is None:
        ranges = "; ".join(f"{m} {MEAL_KCAL[m][0]:.0f}–{MEAL_KCAL[m][1]:.0f}" for m in t.meal_types)
        return [Flag(t.slug, None, "meal_energy", "correction",
                     f"The listed meal types need different sizes ({ranges}); no single portion suits all of them. "
                     "Consider listing fewer meal types.")], []
    lo, hi = rng
    if lo <= kcal <= hi:
        return [], []
    meals = "+".join(t.meal_types)
    return [Flag(t.slug, None, "meal_energy", "info",
                 f"The base meal is {kcal:.0f} kcal at default servings; {meals} is often {lo:.0f}–{hi:.0f} kcal. "
                 "Soft target only: recommendations scale servings to each user's budget within the component "
                 "ranges, so default servings are kept.")], []


NAME_STOPWORDS = frozenset({"with", "and", "the", "of", "a", "plain", "mixed", "ki", "ka", "ke", "aur", "dal", "curry"})


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if len(w) > 2 and w not in NAME_STOPWORDS}


def name_flags(t: Template, priced: list[Priced]) -> list[Flag]:
    """A title that names an OPTIONAL component suggests something the base meal
    doesn't include ("Poha with tea" when the tea is optional)."""
    required = set().union(*(_words(p.food["name"]) | _words(p.c.name_check) for p in priced if not p.c.optional))         if any(not p.c.optional for p in priced) else set()
    flags = []
    for p in priced:
        if not p.c.optional:
            continue
        named = sorted((_words(p.food["name"]) | _words(p.c.name_check)) & _words(t.name) - required)
        if named:
            flags.append(Flag(t.slug, p.c.position, "name_mentions_optional", "review",
                              f"The name '{t.name}' mentions {', '.join(named)}, but {p.food['name']} is optional. "
                              "Rename the template or make the component required, so the name matches the base meal."))
    return flags


def suggested_status(flags: list[Flag]) -> str:
    """What the automated checks suggest. Never 'approved': that is a person's decision."""
    return "needs_correction" if any(f.severity == "correction" for f in flags) else "no_automated_issues"


# ============================================================================ report

def _diet_text(diets: list[tuple[str, str]]) -> str:
    if not diets:
        return "unknown"
    if any(d == "unknown" for d, _ in diets):
        return "unknown (a component's diet is unknown)"
    diet = max((d for d, _ in diets), key=DIET_ORDER.index)
    basis = "reviewed" if all(s == "reviewed" for _, s in diets) else "inferred, not verified"
    return f"{diet} ({basis})"


def _allergen_text(items: list[Priced]) -> str:
    found = sorted({a for p in items for a in (p.food["allergens"] or [])})
    statuses = {p.food["allergen_status"] or "unknown" for p in items}
    if statuses == {"reviewed"}:
        return f"{', '.join(found)} (reviewed)" if found else "none (reviewed allergen list)"
    detected = ", ".join(found) if found else "none detected"
    # Never "allergen-free": detection is keyword-based and presence-only.
    return f"{detected} — detected from names only; NOT an allergen-free check"


def _yesno(values: list[bool | None]) -> str:
    if False in values:
        return "no"
    if values and all(v is True for v in values):
        return "yes (reviewed)"
    return "unknown (needs review)"


def build_report(conn: Any, templates: list[Template], csv_problems: list[str],
                 review: dict[str, ReviewStatus] | None = None, review_problems: list[str] | None = None,
                 decisions: list[Decision] | None = None) -> tuple[str, int, list[Proposal], list[Flag]]:
    """Markdown review report, the number of blocking problems, proposals
    (always empty: portion changes are never proposed from calorie ranges)
    and review flags."""
    review = review or {t.slug: ReviewStatus() for t in templates}
    decisions = decisions or []

    def key(ref: str) -> tuple[str, str]:     # "INDBCODE" (INDB) or "source:ref", e.g. "usda_fdc:173944"
        source, _, code = ref.rpartition(":")
        return (source or "indb", code)

    keys = sorted({key(c.source_ref) for t in templates for c in t.components})
    rows = conn.execute("""
        select f.source, f.source_ref, f.id::text as food_id, f.name, f.is_active, f.is_matchable, f.quality_flags,
               s.label as serving_label, s.grams as serving_grams,
               a.diet_class, a.diet_status, a.vegan_compatible, a.jain_compatible, a.allergens, a.allergen_status
        from public.foods f
        left join public.food_servings s on s.food_id = f.id and s.is_default
        left join public.food_attributes a on a.food_id = f.id
        where (f.source, f.source_ref) in (select * from unnest(%s::text[], %s::text[]))""",
        ([k[0] for k in keys], [k[1] for k in keys])).fetchall()
    foods = {("" if r["source"] == "indb" else r["source"] + ":") + r["source_ref"]: r for r in rows}

    def price(food_id: str, grams: float) -> dict[str, Any] | None:
        n = conn.execute("select calories, protein_g, carbs_g, fat_g from public.food_portion(%s::uuid, %s::numeric)",
                         (food_id, grams)).fetchone()
        return None if n is None or n["calories"] is None else n

    problems = list(csv_problems) + list(review_problems or [])
    all_flags: list[Flag] = []
    all_props: list[Proposal] = []
    sections: list[str] = []
    summary: list[str] = []
    for t in templates:
        priced: list[Priced] = []
        warnings: list[tuple[bool, str]] = []
        for c in sorted(t.components, key=lambda c: c.position):
            f = foods.get(c.source_ref)
            if f is None:
                problems.append(f"{t.slug}: {c.source_ref} not in the catalogue")
                continue
            if f["name"] != c.name_check:
                problems.append(f"{t.slug}: {c.source_ref} is {f['name']!r}, CSV says {c.name_check!r}")
            if not f["is_active"] or not f["is_matchable"] or f["serving_grams"] is None:
                problems.append(f"{t.slug}: {c.source_ref} is inactive, incomplete or has no default serving")
                continue
            grams = float(f["serving_grams"]) * c.default
            n = price(f["food_id"], grams)
            if n is None:
                problems.append(f"{t.slug}: {c.source_ref} can't be priced")
                continue
            priced.append(Priced(c, f, grams, float(n["calories"]), float(n["protein_g"]), float(n["carbs_g"]),
                                 float(n["fat_g"])))
            for flag in f["quality_flags"] or []:
                if flag in FLAG_WARNINGS:
                    warnings.append((c.optional, f"{f['name']}: {FLAG_WARNINGS[flag]}"))
                    if flag in ("energy_mismatch", "cooking_oil_uncertain"):
                        problems.append(f"{t.slug}: {c.source_ref} has unreliable values ({flag})")

        base = [p for p in priced if not p.c.optional]
        optional = [p for p in priced if p.c.optional]
        flags = serving_flags(t, priced) + name_flags(t, priced)
        mflags, props = meal_flags(t, priced)
        flags += mflags
        all_flags += flags
        all_props += props
        suggestion = suggested_status(flags)
        status = review.get(t.slug, ReviewStatus())

        def total(items: list[Priced]) -> str:
            return (f"{sum(p.kcal for p in items):.0f} kcal · P {sum(p.protein_g for p in items):.1f} g · "
                    f"C {sum(p.carbs_g for p in items):.1f} g · F {sum(p.fat_g for p in items):.1f} g")

        def table(items: list[Priced]) -> list[str]:
            out = ["| # | Slot | Food | Servings (min–max, step) | Grams | kcal | P | C | F | Diet | Allergens |",
                   "|---|---|---|---|---|---|---|---|---|---|---|"]
            for p in items:
                f, c = p.food, p.c
                allergens = ", ".join(f["allergens"] or []) or "none detected"
                out.append(
                    f"| {c.position} | {c.slot} | {f['name']} ({c.source_ref}) | {c.default:g} × {f['serving_label']} "
                    f"({c.min:g}–{c.max:g}, {c.step:g}) | {p.grams:.0f} | {p.kcal:g} | {p.protein_g:g} | {p.carbs_g:g} | "
                    f"{p.fat_g:g} | {f['diet_class'] or 'unknown'} ({f['diet_status'] or 'unknown'}) | "
                    f"{allergens} ({f['allergen_status'] or 'unknown'}) |")
            return out

        lines = [f"### {t.name} (`{t.slug}`)", "",
                 f"Meals: {', '.join(t.meal_types)} · Regions: {', '.join(t.regions) or '-'} · "
                 f"**Review status: {STATUS_LABEL.get(status.status, status.status)}**"
                 + (f" ({status.reviewer}, {status.reviewed_at})" if status.reviewer else "")
                 + f" · Automated checks suggest: {suggestion.replace('_', ' ')}", ""]
        if status.notes:
            lines += [f"Reviewer notes: {status.notes}", ""]
        lines += ["**Base meal (required components)**", ""] + table(base)
        lines += ["", f"Base meal at default servings: {total(base)}",
                  f"Diet: {_diet_text([(p.food['diet_class'] or 'unknown', p.food['diet_status'] or 'unknown') for p in base])}"
                  f" · Vegan: {_yesno([p.food['vegan_compatible'] for p in base])}"
                  f" · Jain: {_yesno([p.food['jain_compatible'] for p in base])}",
                  f"Allergens: {_allergen_text(base)}", ""]
        if optional:
            lines += ["**Optional add-ons (not in the base meal; the user chooses)**", ""] + table(optional)
            lines += ["", f"With all optional add-ons at default servings: {total(base + optional)}",
                      f"Diet with add-ons: {_diet_text([(p.food['diet_class'] or 'unknown', p.food['diet_status'] or 'unknown') for p in base + optional])}",
                      f"Allergens with add-ons: {_allergen_text(base + optional)}", ""]
            added = sorted({a for p in optional for a in (p.food["allergens"] or [])}
                           - {a for p in base for a in (p.food["allergens"] or [])})
            if added:
                lines += [f"Add-ons bring in: {', '.join(added)}. For users with that allergy the add-on is not "
                          "offered; the base meal still is if it passes on its own.", ""]
        else:
            lines += ["No optional add-ons.", ""]
        if warnings:
            lines += ["**Data-quality warnings:** " + " ".join(
                f"{w}{' (optional add-on)' if opt else ''}" for opt, w in sorted(warnings, key=lambda x: x[1])), ""]
        if flags:
            lines += ["**Review flags**", ""] + [
                f"- [{f_.severity}] {'#' + str(f_.position) + ' ' if f_.position else ''}{f_.message}" for f_ in flags] + [""]
        mine = [d for d in decisions if d.slug == t.slug]
        if mine:
            lines += ["**Decisions**", "", "| Change | Component | Original | Proposed | Decision | Reason |",
                      "|---|---|---|---|---|---|"]
            lines += [f"| {d.change} | {d.component} | {d.original} | {d.proposed} | {d.status} ({d.decided_by}) | "
                      f"{d.reason} |" for d in mine]
            lines.append("")
        sections.append("\n".join(lines))
        n_corr = sum(1 for f_ in flags if f_.severity == "correction")
        n_rev = sum(1 for f_ in flags if f_.severity == "review")
        n_info = sum(1 for f_ in flags if f_.severity == "info")
        summary.append(
            f"| {t.name} (`{t.slug}`) | {','.join(t.meal_types)} | {len(base)} / {len(optional)} | "
            f"{sum(p.kcal for p in base):.0f} | {sum(p.protein_g for p in base):.1f} | "
            f"{sum(p.kcal for p in base + optional):.0f} | "
            f"{_diet_text([(p.food['diet_class'] or 'unknown', p.food['diet_status'] or 'unknown') for p in base])} | "
            f"{n_corr} / {n_rev} / {n_info} | {suggestion.replace('_', ' ')} | {status.status.replace('_', ' ')} |")

    counts = {s: sum(1 for t in templates if review.get(t.slug, ReviewStatus()).status == s) for s in REVIEW_STATUSES}
    head = ["# Meal templates: review", "",
            f"{len(templates)} draft templates, generated {dt.date.today().isoformat()}. Nutrition is computed by the "
            "database (`food_portion`, the same path as logging) at default servings; nothing was written by a model. "
            "Diet and allergen data are the classifier's **inferred** values unless marked reviewed; \"none detected\" "
            "never means allergen-free. Templates stay `draft` until approved; nothing here approves, loads or "
            "changes anything.", "",
            "Review status: " + ", ".join(f"{s.replace('_', ' ')} {n}" for s, n in counts.items()), ""]
    provisional = [t for t in templates if review.get(t.slug, ReviewStatus()).status == "approved_provisional"]
    if provisional:
        r0 = review[provisional[0].slug]
        head += [f"> **Provisional approval.** {len(provisional)} templates are approved for provisional use by the "
                 f"recommendation engine **without individual human verification** (reviewer: {r0.reviewer}, "
                 f"{r0.reviewed_at}). Their serving-weight warnings and inferred diet/allergen attributes stand; "
                 "nothing here makes any template allergy-safe. Calorie notes are informational. Loading or "
                 "publishing is a separate, explicitly instructed step.", ""]
    if problems:
        head += ["## Blocking problems", ""] + [f"- {p}" for p in problems] + [""]
    else:
        head += ["## Validation", "", "All components exist, match their names, are active and priceable, and have valid "
                 "serving ranges. No component has unreliable catalogue values.", ""]
    head += ["## Summary", "",
             "Base = required components; add-ons are optional and chosen by the user. Flags: correction / review / "
             "info.", "",
             "| Template | Meals | Required / optional | Base kcal | Base protein g | With add-ons kcal | Diet (base) | "
             "Flags | Checks suggest | Review status |",
             "|---|---|---|---|---|---|---|---|---|---|"] + summary
    head += ["", "## How the checks work", "",
             "- **Serving weight:** the catalogue's grams for one household unit, compared with typical ranges "
             f"(e.g. bowl {UNIT_GRAMS['bowl'][0]:.0f}–{UNIT_GRAMS['bowl'][1]:.0f} g, idli "
             f"{UNIT_GRAMS['idli'][0]:.0f}–{UNIT_GRAMS['idli'][1]:.0f} g). A generic range only raises a question: each "
             "flag carries the assessment from the serving-weight audit (`data/serving_weight_audit.md`), and a "
             "catalogue value changes only with a traceable source or explicit approval. Audited-plausible weights "
             "are *info*; the rest are *review*.",
             "- **Meal energy:** the base meal at default servings against typical ranges ("
             + ", ".join(f"{m} {lo:.0f}–{hi:.0f}" for m, (lo, hi) in MEAL_KCAL.items())
             + " kcal) is an *info* note only. Calorie ranges are soft recommendation targets, never a reason to "
             "change portions, so no portion change is proposed from them.",
             "- **Name:** a template name that mentions an optional component is flagged for review, because the "
             "base meal doesn't include it. (Recommendations match exclusions and dislikes against the required "
             "components, so such a name never removes the base meal.)",
             "- **Decisions** applied or rejected by the reviewer are recorded in `data/meal_templates_decisions.csv` "
             "and shown per template. Open flags and decisions together are in `data/meal_templates_corrections.csv`.", "",
             "## How to review", "",
             "1. For each template, decide in `data/meal_templates_review_status.csv`: `approved` (individually "
             "verified), `approved_provisional` (usable, not individually verified), `needs_correction` or "
             "`rejected`, with your name, a timestamp and (for all but `approved`) notes. `pending` means not "
             "reviewed.",
             "2. Changes to the draft are made by editing `data/meal_templates_draft.csv` and recording them in the "
             "decisions file.",
             "3. Rerun `python -m app.cli meal-templates-report`. Approval in the database is a separate step.", "",
             "## Templates", ""]
    return "\n".join(head + sections), len(problems), all_props, all_flags


def write_corrections(path: Path, proposals: list[Proposal], flags: list[Flag],
                      decisions: list[Decision] | None = None) -> None:
    """Decisions (applied / rejected), any proposals and every open flag, one row each."""
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["slug", "position", "component", "kind", "severity", "field", "original", "proposed", "status",
                    "reason"])
        for d in decisions or []:
            w.writerow([d.slug, d.position, d.component, "decision", "", d.change, d.original, d.proposed, d.status,
                        f"{d.reason} ({d.decided_by})"])
        for p in proposals:
            w.writerow([p.slug, p.position, p.component, "proposal", "correction", p.field, p.original, p.proposed,
                        "proposed", p.reason])
        for fl in flags:
            w.writerow([fl.slug, fl.position or "", "", fl.check, fl.severity, "", "", "", "open", fl.message])

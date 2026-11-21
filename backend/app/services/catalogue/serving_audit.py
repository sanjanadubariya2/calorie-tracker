"""Serving-weight audit for catalogue foods used by meal templates (read-only).

Catalogue serving weights are never changed here. For each food the audit
records the current serving label and weight, where it came from and how the
weight was derived, why it looks suspicious, any comparable reference data we
can trace, a proposed replacement ONLY when a traceable source supports one,
and a confidence / verification status. Changing a catalogue value needs a
traceable source or explicit human approval, and is a separate step.

INDB (Anuvaad 2024.11) gives nutrition per 100 g and per household serving;
the loader derives serving grams as per-serving energy / per-100 g energy. The
audit re-checks that ratio for every nutrient: when all agree, the weight is
INDB's own stated value (not a loading error), and a suspicious weight more
likely reflects the per-100 g basis (raw vs cooked, with/without water) or a
non-standard household unit. Generic unit ranges only raise a question; they
are never evidence for a replacement.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

AUDIT_VERSION = "serving-audit-1 (2026-11-21)"

# Comparable household measures from USDA FoodData Central SR Legacy (April 2018,
# public domain), food_portion.csv. Analogues inform plausibility; they are not
# replacements for an Indian dish's own serving.
USDA = {
    "tea_6floz": ("USDA SR Legacy 173227 'Beverages, tea, black, brewed, prepared with tap water'", "6 fl oz", 178.0),
    "tea_cup": ("USDA SR Legacy 173227 'Beverages, tea, black, brewed, prepared with tap water'", "1 cup (8 fl oz)", 237.0),
    "buttermilk_cup": ("USDA SR Legacy 170874 'Milk, buttermilk, fluid, cultured, lowfat'", "1 cup", 245.0),
    "rice_cup": ("USDA SR Legacy 168878 'Rice, white, long-grain, regular, enriched, cooked'", "1 cup", 158.0),
}


@dataclass(frozen=True)
class Evidence:
    """A person's assessment of one serving, with what supports it."""
    assessment: str                 # suspicious | plausible
    why: str
    references: tuple[str, ...] = ()
    proposed_grams: float | None = None      # only with a traceable source
    proposed_source: str = ""
    confidence: str = "low"         # confidence in the CURRENT value: low | medium | high
    verification: str = "unverified: needs a traceable source or a weighed serving"
    to_verify: str = ""


def _ref(key: str, current: float) -> str:
    source, measure, grams = USDA[key]
    return f"{source}: {measure} = {grams:g} g (current {current:g} g is {current / grams:.2f}x)"


# The foods the reviewer asked about, assessed individually.
EVIDENCE: dict[str, Evidence] = {
    "BFP044": Evidence(
        "suspicious",
        "55 g for '1 bowl' is light for a bowl of cooked poha, and INDB's 294.5 kcal/100 g is high for cooked poha, "
        "so the per-100 g basis may be a drier preparation than what is served. The 161 kcal per bowl is INDB's "
        "own stated value.",
        to_verify="INDB/Anuvaad recipe basis for BFP044 (cooked vs ingredient weight) or a weighed household bowl."),
    "ASC144": Evidence(
        "suspicious",
        "25 g per idli is light for a standard idli. Energy density (137.5 kcal/100 g) is that of a steamed batter "
        "product, so the per-piece weight itself is the question. 34.5 kcal per idli is INDB's stated value.",
        to_verify="INDB recipe yield for ASC144 or weighed idlis of the intended size."),
    "BFP148": Evidence(
        "suspicious",
        "36 g per plain dosa with 381 kcal/100 g: the density is far above a cooked dosa, which points to an "
        "ingredient/batter-solids basis rather than the cooked dosa. 138 kcal per dosa is INDB's stated value.",
        to_verify="INDB recipe basis for BFP148; the per-dosa energy may be right even if the gram weight is not."),
    "ASC146": Evidence(
        "plausible",
        "210 g per masala dosa includes the potato filling; a filled dosa is heavier than a plain one, so the "
        "generic dosa range does not apply. 165 kcal/100 g is consistent with a filled dosa.",
        confidence="medium", verification="plausible on internal consistency; not independently verified"),
    "BFP046": Evidence(
        "suspicious",
        "227 g for one stuffed moong cheela is heavy for a single piece (352 kcal). It may describe a large stuffed "
        "cheela or a plate of them.",
        to_verify="INDB recipe yield for BFP046 (pieces per batch) or a weighed cheela."),
    "BFP144": Evidence(
        "suspicious",
        "574 g for '1 small bowl' is very heavy, and 57 kcal/100 g is unusually dilute for khichdi, which suggests a "
        "very watery preparation or that the household unit is mislabelled. 327 kcal per serving is INDB's value.",
        to_verify="INDB recipe for BFP144 (water ratio, yield) or a weighed small bowl."),
    "ASC115": Evidence(
        "suspicious",
        "438 g for '1 plate' of pulao is a large plate.",
        references=("rice_cup",),
        to_verify="INDB recipe yield for ASC115 or a weighed plate. Templates use 0.5 plate (219 g)."),
    "ASC022": Evidence(
        "plausible",
        "423 g for a 'tall glass' is large, but a tall glass is not a standard measure, and 18.8 kcal/100 g is a "
        "dilute salted lassi, so a large volume is consistent.",
        references=("buttermilk_cup",), confidence="medium",
        verification="plausible; no standard 'tall glass' to verify against"),
    "ASC001": Evidence(
        "plausible",
        "210 g for a tea cup lies between USDA's 6 fl oz and 8 fl oz servings of brewed tea. The report's generic "
        "tea-cup range (100–200 g) was too narrow; the catalogue value is not the problem.",
        references=("tea_6floz", "tea_cup"), confidence="high",
        verification="supported by a comparable USDA household measure"),
}


@dataclass
class AuditRow:
    source_ref: str
    name: str
    serving_label: str
    serving_grams: float
    source: str
    source_version: str
    serving_source: str
    derivation: str
    kcal_per_100: float | None
    kcal_per_serving: float | None
    used_by: list[str] = field(default_factory=list)
    generic_check: str = ""
    evidence: Evidence | None = None
    indb_check: str = ""

    def as_csv(self) -> dict[str, Any]:
        e = self.evidence
        refs = "; ".join(_ref(k, self.serving_grams) for k in (e.references if e else ()))
        return {
            "food_ref": self.source_ref, "name": self.name, "serving_label": self.serving_label,
            "serving_grams": f"{self.serving_grams:g}", "kcal_per_100g": f"{self.kcal_per_100:g}" if self.kcal_per_100 else "",
            "kcal_per_serving": f"{self.kcal_per_serving:.0f}" if self.kcal_per_serving else "",
            "original_source": f"{self.source} {self.source_version}".strip(), "serving_source": self.serving_source,
            "derivation": self.derivation, "indb_consistency": self.indb_check,
            "used_by_templates": "|".join(self.used_by), "generic_check": self.generic_check,
            "assessment": e.assessment if e else "not assessed",
            "why_suspicious": e.why if e else "Only the generic household-unit range flags it; no individual review yet.",
            "reference_data": refs,
            "proposed_grams": f"{e.proposed_grams:g}" if e and e.proposed_grams else "",
            "proposed_source": e.proposed_source if e else "",
            "confidence_in_current": e.confidence if e else "unknown",
            "verification_status": e.verification if e else "unverified",
            "to_verify": e.to_verify if e else "",
            "catalogue_changed": "no",
        }


CSV_FIELDS = ["food_ref", "name", "serving_label", "serving_grams", "kcal_per_100g", "kcal_per_serving",
              "original_source", "serving_source", "derivation", "indb_consistency", "used_by_templates",
              "generic_check", "assessment", "why_suspicious", "reference_data", "proposed_grams", "proposed_source",
              "confidence_in_current", "verification_status", "to_verify", "catalogue_changed"]


def indb_consistency(workbook: Path | None, codes: set[str]) -> dict[str, str]:
    """For each INDB code: do energy, protein, carbs and fat imply the same serving grams?"""
    if workbook is None or not workbook.exists():
        return {}
    import openpyxl
    wb = openpyxl.load_workbook(workbook, read_only=True)
    rows = wb[wb.sheetnames[0]].iter_rows(values_only=True)
    header = next(rows)
    i = {h: n for n, h in enumerate(header)}
    out: dict[str, str] = {}
    for r in rows:
        if r[0] not in codes:
            continue
        grams = [r[i[f"unit_serving_{k}"]] / r[i[k]] * 100 for k in ("energy_kcal", "protein_g", "carb_g", "fat_g")
                 if r[i[k]] and r[i[f"unit_serving_{k}"]] is not None]
        if not grams:
            out[r[0]] = "no per-serving values"
            continue
        spread = max(grams) - min(grams)
        verdict = "consistent" if spread <= max(1.0, 0.01 * max(grams)) else "INCONSISTENT"
        out[r[0]] = (f"{verdict}: energy/protein/carbs/fat imply {', '.join(f'{g:.1f}' for g in grams)} g "
                     f"(INDB primarysource {r[i['primarysource']]})")
    return out


def build_audit(conn: Any, template_foods: dict[str, list[str]], generic: dict[str, str],
                workbook: Path | None = None) -> list[AuditRow]:
    """Rows for every food used by a template that is individually assessed or
    flagged by the generic check. `template_foods`: food ref -> template slugs."""
    refs = sorted(set(EVIDENCE) | set(generic))
    rows = conn.execute("""
        select f.source, f.source_ref, f.source_version, f.name, f.kcal_per_100, s.label, s.grams, s.source as serving_source
        from public.foods f join public.food_servings s on s.food_id = f.id and s.is_default
        where f.source = 'indb' and f.source_ref = any(%s)""", (refs,)).fetchall()
    consistency = indb_consistency(workbook, {r["source_ref"] for r in rows})
    out = []
    for r in sorted(rows, key=lambda x: (x["source_ref"] not in EVIDENCE, x["name"])):
        kcal100 = float(r["kcal_per_100"]) if r["kcal_per_100"] is not None else None
        grams = float(r["grams"])
        out.append(AuditRow(
            source_ref=r["source_ref"], name=r["name"], serving_label=r["label"], serving_grams=grams,
            source=r["source"], source_version=r["source_version"] or "", serving_source=r["serving_source"] or "",
            derivation="INDB per-serving energy / per-100 g energy x 100 (catalogue loader)",
            kcal_per_100=kcal100, kcal_per_serving=kcal100 * grams / 100 if kcal100 else None,
            used_by=sorted(template_foods.get(r["source_ref"], [])), generic_check=generic.get(r["source_ref"], ""),
            evidence=EVIDENCE.get(r["source_ref"]), indb_check=consistency.get(r["source_ref"], "not checked")))
    return out


def write_audit(csv_path: Path, md_path: Path, rows: list[AuditRow]) -> None:
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow(r.as_csv())
    lines = ["# Serving-weight audit", "",
             f"{AUDIT_VERSION}. Read-only: **no catalogue value was changed.** A replacement is proposed only with a "
             "traceable source; none of the foods below has one yet. Generic household-unit ranges only raise "
             "questions.", "",
             "INDB serving weights are derived (per-serving ÷ per-100 g energy). Where every nutrient implies the "
             "same weight, the value is INDB's own, and an odd weight more likely reflects the per-100 g basis or "
             "the household unit than a loading error. Per-serving nutrition (what templates use) is INDB's stated "
             "value either way; the gram weight matters when someone logs by grams.", "",
             "| Food | Serving | kcal/100 g | kcal/serving | Assessment | Confidence in current | Proposed | Status |",
             "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        c = r.as_csv()
        lines.append(f"| {r.name} ({r.source_ref}) | {r.serving_label} = {r.serving_grams:g} g | {c['kcal_per_100g']} | "
                     f"{c['kcal_per_serving']} | {c['assessment']} | {c['confidence_in_current']} | "
                     f"{c['proposed_grams'] or 'none'} | {c['verification_status']} |")
    lines += ["", "## Details", ""]
    for r in rows:
        c = r.as_csv()
        lines += [f"### {r.name} ({r.source_ref})", "",
                  f"- Current: {r.serving_label} = {r.serving_grams:g} g; source {c['original_source']} "
                  f"(serving: {c['serving_source']}); {c['derivation']}.",
                  f"- INDB check: {c['indb_consistency']}.",
                  f"- Used by: {', '.join(r.used_by) or '-'}.",
                  f"- Why it was flagged: {c['why_suspicious']}"]
        if r.generic_check:
            lines.append(f"- Generic check: {r.generic_check}")
        if c["reference_data"]:
            lines.append(f"- Reference data: {c['reference_data']}")
        lines += [f"- Proposed replacement: {c['proposed_grams'] or 'none (no traceable source)'}",
                  f"- Confidence in the current value: {c['confidence_in_current']}; status: {c['verification_status']}"]
        if c["to_verify"]:
            lines.append(f"- To verify: {c['to_verify']}")
        lines.append("")
    md_path.write_text("\n".join(lines), encoding="utf-8")

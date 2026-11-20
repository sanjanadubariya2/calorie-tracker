"""Name tooling for catalogue imports: alias extraction and categorisation.

These run only when data is loaded. Matching itself normalises in SQL
(public.normalize_food_name), so queries and stored names always use the same
rules.
"""

from __future__ import annotations

import difflib
import re

_WS = re.compile(r"\s+")
_PAREN = re.compile(r"\(([^)]*)\)")


def _clean(text: str) -> str:
    return _WS.sub(" ", text).strip(" ,;-")


def _key(text: str) -> str:
    """Rough normalisation for de-duplication only (the DB does the real one)."""
    return _WS.sub(" ", re.sub(r"[^a-z0-9]+", " ", text.lower().replace("'", ""))).strip()


def _similar(a: str, b: str) -> bool:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio() >= 0.5


def expand_slashes(segment: str) -> list[str]:
    """Expands INDB's slash alternatives into whole names.

    "Plain parantha/paratha"        -> plain parantha, plain paratha   (last word varies)
    "Chapati/Roti"                  -> chapati, roti                   (whole name varies)
    "Suji/Rava idli"                -> rava idli, suji idli            (first word varies)
    "Ghiya/Lauki ka raita"          -> lauki ka raita, ghiya ka raita
    "Dahi bhaat/Dahi chawal"        -> dahi bhaat, dahi chawal         (whole name varies)
    "Bhindi sabzi/sabji/subji"      -> bhindi sabzi, bhindi sabji, bhindi subji
    """
    segment = _clean(segment)
    if "/" not in segment:
        return [segment] if segment else []
    parts = [_clean(p) for p in segment.split("/") if _clean(p)]
    if not parts:
        return []
    first = parts[0]
    first_words = first.split()
    out: list[str] = []
    first_is_fragment = len(first_words) == 1 and any(len(p.split()) > 1 for p in parts[1:])
    if not first_is_fragment:
        out.append(first)
    for part in parts[1:]:
        words = part.split()
        if len(first_words) > 1 and len(words) == 1 and _similar(words[0], first_words[-1]):
            # spelling variant of the last word: "plain parantha/paratha"
            out.append(" ".join(first_words[:-1] + words))
        elif len(first_words) == 1 and len(words) > 1:
            # variant of the first word, shared tail: "suji/rava idli"
            out.append(part)
            out.append(" ".join([first_words[0]] + words[1:]))
        else:
            out.append(part)
    return out


def name_variants(name: str) -> list[tuple[str, str]]:
    """All alternative names embedded in an INDB-style name, with their kind:
    ('name_variant' for the main name's spellings, 'regional' for the names in
    parentheses). The original full name itself is not included."""
    outer = _PAREN.sub(" ", name)
    groups = _PAREN.findall(name)
    found: list[tuple[str, str]] = [(v, "name_variant") for v in expand_slashes(outer)]
    for group in groups:
        for piece in group.split(","):
            found.extend((v, "regional") for v in expand_slashes(piece))

    seen = {_key(name)}
    result: list[tuple[str, str]] = []
    for alias, kind in found:
        k = _key(alias)
        if len(k) < 3 or k in seen:
            continue
        seen.add(k)
        result.append((alias, kind))
    return result


# --------------------------------------------------------------------------- #
# Categories
#
# Ordered: the first family whose keyword appears wins ("paneer paratha" is a
# bread, "chicken biryani" a rice dish, "masala chai" a beverage). Matched on
# whole words of the normalised name and aliases. Unknown -> None (left blank
# rather than guessed).
# --------------------------------------------------------------------------- #
_CATEGORY_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("beverage", ("tea", "chai", "coffee", "lassi", "milkshake", "shake", "juice", "drink", "punch",
                  "lemonade", "smoothie", "sherbet", "sharbat", "panna", "jaljeera", "jal jeera",
                  "buttermilk", "chaas", "thandai", "cooler", "mocktail")),
    ("soup", ("soup", "consomme", "stock", "shorba", "broth")),
    ("sweet", ("halwa", "ladoo", "laddoo", "laddu", "kheer", "jamun", "barfi", "burfi", "pudding", "cake",
               "cookie", "cookies", "biscuit", "custard", "payasam", "chikki", "ice cream", "kulfi", "souffle",
               "mousse", "sandesh", "rasgulla", "jalebi", "peda", "gajak", "tart", "pie", "brownie", "muffin")),
    ("south_indian", ("idli", "dosa", "dosai", "uttapam", "vada", "upma", "appam", "pesarattu", "pongal")),
    ("bread", ("roti", "chapati", "paratha", "parantha", "naan", "poori", "puri", "kulcha", "bhatura",
               "thepla", "phulka", "bhakri", "puranpoli")),
    ("rice_dish", ("rice", "pulao", "biryani", "biriyani", "khichdi", "khichri", "khitchdi", "bhaat",
                   "bhat", "chawal", "pongal")),
    ("egg_dish", ("egg", "eggs", "omelette", "omlet", "anda", "ande")),
    ("non_veg", ("chicken", "mutton", "fish", "prawn", "prawns", "keema", "lamb", "meat", "machli")),
    ("dal", ("dal", "daal", "sambar", "rasam", "kadhi", "rajmah", "rajma", "channa", "chana", "chole")),
    ("paneer_dish", ("paneer",)),
    ("snack", ("pakora", "pakoda", "pakode", "samosa", "cutlet", "chilla", "cheela", "dhokla", "chaat",
               "bhel", "tikki", "sandwich", "kachori", "khandvi", "poha", "chivda", "namkeen", "mathri")),
    ("side", ("raita", "chutney", "pickle", "achaar", "dip", "dressing", "sauce", "baghar", "tadka", "masala")),
    ("salad", ("salad",)),
    ("sabzi", ("sabzi", "sabji", "subji", "bhartha", "bharta", "curry", "korma", "kofta", "aloo", "bhindi",
               "gobhi", "gobi", "baingan", "palak", "saag")),
]


def categorize(texts: list[str]) -> str | None:
    words = " " + " ".join(_key(t) for t in texts) + " "
    for category, keywords in _CATEGORY_RULES:
        if any(f" {kw} " in words for kw in keywords):
            return category
    return None

"""Food attribute classifier (Phase 3): diet, allergens, Jain, region, meal type.

Deterministic and keyword/category based. It only ever produces INFERRED or
UNKNOWN attributes: a person must review a food before anything is 'reviewed'
(migration 013 enforces that). It can only rule things OUT:
  * vegan_compatible / jain_compatible are set to False on evidence, else None
    (unknown); never True.
  * allergens lists allergens DETECTED in the name/aliases; finding none means
    "unknown", not "allergen-free".
Every decision carries a reason so a reviewer can check it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

CLASSIFIER_VERSION = "attr-v1"

MEAT = ("chicken", "mutton", "lamb", "goat", "beef", "pork", "bacon", "ham", "sausage", "salami", "keema", "kheema",
        "kima", "meat", "gosht", "murg", "murgh", "liver", "kebab", "kabab", "nihari", "haleem", "turkey", "duck")
FISH = ("fish", "machli", "machhi", "machher", "tuna", "salmon", "sardine", "pomfret", "rohu", "hilsa", "ilish",
        "mackerel", "surmai", "bangda", "katla", "bhetki", "anchovy", "tilapia", "basa", "seer", "kingfish",
        "catfish", "trout", "cod", "sole", "rawas", "singhara", "mahseer", "karimeen", "bombil", "bombay duck")
SHELLFISH = ("prawn", "shrimp", "jhinga", "chingri", "crab", "lobster", "mussel", "oyster", "squid", "clam")
EGG = ("egg", "eggs", "anda", "ande", "omelette", "omelet", "bhurji")
EGG_LIKELY = ("cake", "muffin", "brownie", "mayonnaise", "custard", "meringue", "french toast", "souffle", "eggnog",
              "pudding", "pancake", "cookie", "cookies", "mousse", "flan", "caramel custard")
# Dishes commonly made with meat/fish stock or meat fillings even when the name doesn't say so.
MEAT_LIKELY = ("stock", "broth", "consomme", "bouillon", "mulligatawny", "club sandwich", "luncheon", "frankie",
               "shami", "seekh", "nugget", "nuggets", "gelatin", "jelly")
NOT_EGG = ("eggless", "egg-free", "eggplant", "egg plant")
DAIRY = ("paneer", "milk", "curd", "dahi", "ghee", "butter", "cheese", "cream", "lassi", "raita", "kheer", "yogurt",
         "yoghurt", "khoa", "khoya", "malai", "buttermilk", "chaas", "chhena", "chenna", "rabri", "rabdi", "kulfi",
         "shrikhand", "basundi", "rasgulla", "rasmalai", "sandesh", "makhani", "kadhi", "payasam", "mawa", "coffee",
         "tea", "chai", "custard", "ice cream", "milkshake", "shake", "smoothie", "barfi", "burfi", "peda")
JAIN_EXCLUDED = ("onion", "pyaz", "pyaaz", "garlic", "lehsun", "potato", "aloo", "alu", "carrot", "gajar", "beetroot",
                 "radish", "mooli", "ginger", "adrak", "sweet potato", "shakarkandi", "mushroom", "yam", "arbi",
                 "colocasia", "turnip", "shalgam")
ALLERGENS: dict[str, tuple[str, ...]] = {
    "peanut": ("peanut", "groundnut", "moongphali", "mungfali", "moongfali", "chikki"),
    "tree_nut": ("almond", "badam", "cashew", "kaju", "pista", "pistachio", "walnut", "akhrot", "nut", "nuts", "dry fruit"),
    "milk": DAIRY,
    "egg": EGG,
    "wheat_gluten": ("wheat", "atta", "maida", "roti", "chapati", "chapatti", "naan", "paratha", "parantha", "bread",
                     "puri", "poori", "kulcha", "bhatura", "suji", "sooji", "semolina", "rava", "rawa", "upma",
                     "dalia", "daliya", "pasta", "noodle", "noodles", "biscuit", "cake", "samosa", "kachori",
                     "mathri", "thepla", "phulka", "pav", "sandwich", "pizza", "burger", "seviyan", "vermicelli",
                     "barley", "jau", "litti", "halwa", "malpua", "jalebi", "khakhra", "toast"),
    "soy": ("soy", "soya", "soyabean", "soybean", "tofu", "nutrela"),
    "fish": FISH,
    "shellfish": SHELLFISH,
    "sesame": ("sesame", "til", "gingelly"),
    "mustard": ("mustard", "sarson", "rai"),
}
REGIONS: dict[str, tuple[str, ...]] = {
    "south_indian": ("idli", "dosa", "sambar", "rasam", "uttapam", "uthappam", "vada", "upma", "pongal", "appam",
                     "puttu", "avial", "aviyal", "payasam", "kootu", "poriyal", "bisi bele", "lemon rice", "curd rice",
                     "tamarind rice", "puliyogare", "pesarattu", "thoran", "kozhukattai", "medu"),
    "north_indian": ("paratha", "parantha", "naan", "chole", "chhole", "rajma", "kulcha", "dal makhani", "kadhi",
                     "sarson", "makki", "bhatura", "tandoori", "lassi", "paneer", "aloo gobi", "baingan bharta",
                     "dum aloo", "pulao", "phulka", "chapati", "roti"),
    "west_indian": ("dhokla", "thepla", "khakhra", "poha", "pav bhaji", "vada pav", "misal", "khandvi", "undhiyu",
                    "puran poli", "sabudana", "handvo", "sheera", "zunka", "kokum"),
    "east_indian": ("luchi", "machher", "litti", "chokha", "pitha", "rasgulla", "sandesh", "ghugni", "dalma",
                    "pakhala", "momo", "thukpa", "mishti"),
}
CATEGORY_MEALS: dict[str | None, tuple[str, ...]] = {
    "south_indian": ("breakfast", "lunch", "dinner"),
    "bread": ("breakfast", "lunch", "dinner"),
    "rice_dish": ("lunch", "dinner"),
    "dal": ("lunch", "dinner"),
    "sabzi": ("lunch", "dinner"),
    "paneer_dish": ("lunch", "dinner"),
    "non_veg": ("lunch", "dinner"),
    "egg_dish": ("breakfast", "lunch", "dinner"),
    "snack": ("snack",),
    "sweet": ("snack",),
    "beverage": ("breakfast", "snack"),
    "soup": ("dinner", "snack"),
    "salad": ("lunch", "dinner", "snack"),
    "side": ("lunch", "dinner"),
    # Staples (migration 014). 'other' (ghee, sesame) gets no meal types: ingredients, never recommended alone.
    "fruit": ("breakfast", "snack"),
    "dairy": ("breakfast", "lunch", "dinner", "snack"),
    "nuts_seeds": ("snack",),
    "vegetable": ("lunch", "dinner"),
    "legume": ("lunch", "dinner", "snack"),
    "grain": ("breakfast",),
}
BREAKFAST_WORDS = ("poha", "upma", "paratha", "parantha", "idli", "dosa", "cheela", "chilla", "oats", "porridge",
                   "toast", "sandwich", "omelette", "dalia", "daliya", "uttapam", "thepla", "sheera", "pongal")
CONTAINER_WORDS = ("bowl", "katori", "cup", "glass", "plate", "tablespoon", "teaspoon", "serving", "tbsp", "tsp",
                   "ladle", "portion", "slice")


def _pattern(words: tuple[str, ...]) -> re.Pattern[str]:
    # Plurals count too ("peanuts", "almonds", "eggs"): a missed allergen is the costly error.
    return re.compile(r"\b(?:" + "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True)) + r")(?:e?s)?\b")


_P: dict[tuple[str, ...], re.Pattern[str]] = {}


def _find(text: str, words: tuple[str, ...]) -> str | None:
    p = _P.get(words)
    if p is None:
        p = _P[words] = _pattern(words)
    m = p.search(text)
    return m.group(0) if m else None


@dataclass
class FoodInput:
    food_id: str
    source_ref: str | None
    name: str
    category: str | None
    aliases: list[str] = field(default_factory=list)
    serving_label: str | None = None


@dataclass
class Attributes:
    diet_class: str
    diet_status: str
    vegan_compatible: bool | None
    jain_compatible: bool | None
    allergens: list[str]
    allergen_status: str
    regions: list[str]
    meal_types: list[str]
    countable: bool | None
    reasons: list[str]
    review_priority: str          # high | medium | low


def classify(food: FoodInput) -> Attributes:
    text = " ".join([food.name, *food.aliases]).lower()
    text_no_egg_neg = text
    for neg in NOT_EGG:
        text_no_egg_neg = text_no_egg_neg.replace(neg, " ")
    reasons: list[str] = []

    # ---- diet: the most restrictive evidence wins; absence of evidence is only "vegetarian (inferred)"
    meat = _find(text, MEAT)
    fish = _find(text, FISH) or _find(text, SHELLFISH)
    egg = _find(text_no_egg_neg, EGG)
    explicitly_eggless = "eggless" in text or "egg-free" in text
    egg_likely = None if explicitly_eggless else _find(text_no_egg_neg, EGG_LIKELY)
    if meat:
        diet = "meat"
        reasons.append(f"diet: name contains {meat!r}")
    elif fish:
        diet = "fish"
        reasons.append(f"diet: name contains {fish!r}")
    elif food.category == "non_veg":
        diet = "meat"
        reasons.append("diet: category non_veg")
    elif food.category == "egg_dish" or egg:
        diet = "egg"
        reasons.append(f"diet: {'name contains ' + repr(egg) if egg else 'category egg_dish'}")
    elif egg_likely:
        diet = "unknown"
        reasons.append(f"diet: {egg_likely!r} often contains egg")
    elif (meat_likely := _find(text, MEAT_LIKELY)):
        diet = "unknown"
        reasons.append(f"diet: {meat_likely!r} often contains meat or fish")
    elif food.category == "soup":
        diet = "unknown"
        reasons.append("diet: soups are often made with meat stock (needs review)")
    elif food.category is None:
        # Uncategorised and no animal words: a missing word list entry must not make a dish "vegetarian".
        diet = "unknown"
        reasons.append("diet: uncategorised, no meat/fish/egg words found (needs review)")
    else:
        diet = "vegetarian"
        reasons.append(f"diet: category {food.category}, no meat/fish/egg words found (not verified)")

    dairy = _find(text, DAIRY)
    if diet != "vegetarian" or dairy:
        vegan: bool | None = False
        if dairy and diet == "vegetarian":
            reasons.append(f"not vegan: {dairy!r}")
    else:
        vegan = None

    jain_word = _find(text, JAIN_EXCLUDED)
    if diet in ("meat", "fish", "egg"):
        jain: bool | None = False
    elif jain_word:
        jain = False
        reasons.append(f"not Jain: {jain_word!r}")
    else:
        jain = None

    # ---- allergens: detected presence only
    found: list[str] = []
    for allergen, words in ALLERGENS.items():
        hit = _find(text_no_egg_neg if allergen == "egg" else text, words)
        if hit:
            found.append(allergen)
            reasons.append(f"allergen {allergen}: {hit!r}")
    if diet == "egg" and "egg" not in found:
        found.append("egg")
    if diet == "fish" and not ({"fish", "shellfish"} & set(found)):
        found.append("fish")
    allergen_status = "inferred" if found else "unknown"

    # ---- region, meal type, countable
    regions = [r for r, words in REGIONS.items() if _find(text, words)]
    if food.category == "south_indian" and "south_indian" not in regions:
        regions.append("south_indian")
    meals = list(CATEGORY_MEALS.get(food.category, ()))
    if _find(text, BREAKFAST_WORDS) and "breakfast" not in meals:
        meals.insert(0, "breakfast")
    countable = None
    if food.serving_label:
        label = food.serving_label.lower()
        countable = not any(w in label for w in CONTAINER_WORDS)

    if diet == "unknown" or (food.category is None and not meals):
        priority = "high"
    elif diet == "vegetarian" or allergen_status == "unknown":
        priority = "medium"
    else:
        priority = "low"
    return Attributes(
        diet_class=diet, diet_status="unknown" if diet == "unknown" else "inferred", vegan_compatible=vegan,
        jain_compatible=jain, allergens=sorted(set(found)), allergen_status=allergen_status, regions=regions,
        meal_types=meals, countable=countable, reasons=reasons[:12], review_priority=priority,
    )

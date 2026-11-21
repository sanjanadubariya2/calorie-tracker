# Recommendation scoring (engine `rec-v2`)

How the app's meal recommendations are chosen and ranked. Both interfaces call the same service, `app/recommendations/service.py`:
- the app, through `GET /v1/me/recommendations`;
- the assistant's `recommend_meals` tool.

The engine is deterministic: the same catalogue, user context and request always give the same result. No LLM is involved at any step. It never estimates or generates nutrition.

| Layer | Code |
|---|---|
| Candidate functions (SQL) | `supabase/migrations/017_recommendation_candidates.sql`, `018_recommendation_personalization.sql` |
| Settings (every number on this page) | `app/recommendations/config.py` |
| Pipeline (pure functions) | `app/recommendations/engine.py` |
| Database rows to candidates, user context | `app/recommendations/repository.py` |
| Pricing, history, feedback, proposals | `app/recommendations/service.py` |
| HTTP API | `app/api/routes/recommendations.py` |
| Assistant tool (read-only) | `app/assistant/tools/recommend.py` |

If you change a number in `config.py`, change this page too.

## 1. Pipeline

1. **Candidates.** The engine reads candidates through PostgREST as the signed-in user, so RLS applies.
   - **Recipes:** published, current catalogue recipes only. Nutrition comes from `recipe_nutrition` (ingredient grams × catalogue per-100 g values).
   - **Combos:** a published main recipe (dal, curry, sabzi or egg dish) paired with a published rice or bread recipe. The two must share a meal type and a region; pan-Indian goes with anything.
   - **Meal templates:** approved templates only. Required components are included; optional ones never are.
   - **Single dishes:** active foods with a default serving and complete nutrition. Excluded: packaged products, recipe-only ingredients (`raw_ingredient`) and uncategorised foods.

   Diet and allergen attributes cover every ingredient or component (see §3).
2. **Hard constraints** (§3), then **request filters** (§3.1). A candidate that breaks one is excluded before scoring. No score or preference can bring it back.
3. **Meal budget** (§2).
4. **Portion.** The engine picks the servings that best fit the budget (§4).
5. **Gates.** A candidate is excluded when its best portion is still:
   - outside the calorie tolerance band;
   - above the requested maximum;
   - or not high in protein when high protein was asked for.
6. **Score.** Nine weighted components, each 0–1, minus **adjustments** (§5): novelty, dislike, rejection, going over what's left today, and a meal-type mismatch. Candidates below **0.65** are not recommendations.
7. **Diversity re-rank** (§6).
8. **Exact pricing.** Each pick is priced again by the database for its exact portions, with `food_portion` and `recipe_portion`, the same functions logging uses. A pick the database cannot price is dropped and the next-ranked pick takes its place. Nothing is ever estimated. Three spares are ranked for this.
9. **History.** The app records the request in the user's own `recommendation_sets` / `recommendation_items` (90-day retention).
   - The assistant tool records nothing (`persist=False`).
   - **Nothing is ever logged as food here.** Logging goes through a pending proposal the user must confirm (§10).

## 2. Meal budget

```
planned   = daily_kcal × share     share: breakfast 0.25, lunch 0.35, dinner 0.30, snack 0.10
remaining = daily_kcal − eaten today

budget =  requested kcal            if the request gives target_kcal          (mode "requested")
          150 kcal                  if remaining ≤ 100, including over target (mode "light")
          remaining                 if remaining < planned                    (mode "capped")
          planned                   otherwise                                 (mode "planned")
budget = min(budget, max_kcal)      if the request gives max_kcal

macro target (protein, carbs, fat) = max(0, remaining_macro) × budget / remaining_kcal
                                     (light mode: the daily split scaled to 150 kcal)
protein target ≥ budget × 0.30 / 4   if protein=high
protein target ≤ budget × 0.40 / 4   (if capped, the cap is stated in the notes)
```

- **No targets yet:** the engine assumes a 2,000 kcal day with a 50/30/20 carb/fat/protein split and says so in `notes`. The response reports `basis: "assumed"`.
- **Macro targets follow what is left, not the plan.** If the user's breakfast was carb-heavy, lunch is scored against fewer carbs.
- **The protein cap** keeps one meal from being judged against protein it cannot realistically provide.

## 3. Hard constraints

These are applied in order. The first one broken is the reason recorded.

| Reason | Rule |
|---|---|
| `never_feedback` | The user chose "never" for this food, template or recipe family (every version). It lasts until the user deletes that feedback. |
| `diet_conflict` | A known diet class falls outside the declared diet. The diets allow these classes:<ul><li>vegetarian: vegan, vegetarian</li><li>eggetarian: adds egg</li><li>pescatarian: adds egg and fish</li><li>vegan: vegan only</li><li>Jain: vegan, vegetarian</li></ul> |
| `allergen_present` | A declared allergen was detected in any ingredient. |
| `excluded_ingredient` | An excluded ingredient matches the name, variant or any ingredient or component name. Matching uses whole words, plural forms, the user's term singularised, and common Indian names ("onion" also matches "pyaz" and "kanda"). |
| `equipment_missing` | The user listed their equipment, and the recipe records needs outside that list. A recipe that records nothing, and a user who listed nothing, are not filtered. |
| `diet_unknown` | A diet is declared and any ingredient's classification is unknown. |
| `diet_unverified` | Vegan or Jain is declared and the ingredients are not all reviewed as `vegan_compatible` / `jain_compatible` = true. |
| `allergen_unverified` | Allergies are declared and the allergen data is not `reviewed`. |
| `incomplete_nutrition` | Nutrition is missing, or a component or ingredient cannot be priced. |
| `unreliable_nutrition` | Flagged `energy_mismatch`: the stated kcal disagrees with the macros. |

- **Attributes combine strictly.** Over a recipe's ingredients or a template's components:
  - status is `reviewed` only if every item is reviewed;
  - one unknown item makes the whole candidate unknown;
  - vegan and Jain are true only if every item is true;
  - detected allergens are united.

  An ingredient the user cannot see (deactivated) counts as unknown, and it makes the recipe incomplete.
- **Inferred allergen data never counts as safe.** The classifier records detected allergens only. A user with any allergy only gets candidates whose allergen data has been reviewed. Until reviews exist, those users get `status: "insufficient_data"`, never a guess.
- **An inferred diet classification is allowed but labelled.** An unknown classification is excluded whenever a diet is declared.

### 3.1 Request filters

These are not safety rules, and they are reported separately.

| Reason | Rule |
|---|---|
| `shown_already` | The candidate key is in `exclude` (the "show alternatives" button). |
| `other_cuisine` | A `cuisine` was requested and the candidate's region doesn't match. |
| `over_max_kcal` | Every allowed portion is above `max_kcal`. |
| `low_protein` | `protein=high` was asked for and protein supplies less than 20% of the portion's energy. |
| `too_small`, `too_large` | The best portion is outside the calorie band (§5). |
| `low_score` | The score is below 0.65. |

## 4. Portions

- **Recipes and single dishes:**
  - Countable servings ("1 phulka", "1 idli", foods marked `countable`) use 1, 2, 3 or 4 pieces.
  - Everything else uses 0.5, 1, 1.5 or 2 servings.
- **Templates:** each component may range from its `min_servings` to its `max_servings` in steps of `servings_step`. The search tries every combination up to 4,096. Above that, it scales all components together.
- **Combos:** every combination of the two recipes' portion options.

The chosen portion is the best by these keys, in order:
1. inside the calorie band and under `max_kcal`;
2. highest nutrition score;
3. closest to the default servings;
4. fewest servings.

The detail endpoint lets the user change servings, from half the smallest option to twice the largest. Each change is re-priced by the database.

## 5. Score

```
score = Σ wᵢ · sᵢ / Σ wᵢ  −  (novelty + dislike + rejected + overshoot + meal_type)    each sᵢ ∈ [0, 1]; Σ wᵢ = 1.00
```

### Components

| Component | sᵢ |
|---|---|
| **calories** | r = kcal / budget. sᵢ = 1 inside [full_low, full_high]. It falls linearly to 0 at zero_low and zero_high; beyond those points the candidate is excluded. The bands are listed below. |
| **protein** (floor) | min(1, protein / (0.9 × target)). It is 1 when the target is 0. Extra protein is never penalised. |
| **carbs, fat** (ceilings) | 1 up to target × 1.15 + 3 g. It falls linearly to 0 at target × 2 + 15 g. |
| **meal_type** | 1 if the dish is listed for this meal, 0.5 if its meal types are unknown, 0 otherwise. |
| **preference** | The mean of the signals the user has set. With none set it is 0.6 for every candidate, so it cannot reorder anything.<ul><li>**Cuisine:** region match 1; pan-Indian 0.7; region unknown 0.5; another region 0.3.</li><li>**Preferred meal style:** 1 if it matches, else 0.4. "thali" matches templates and combos.</li><li>**Preparation time:** 1 up to the user's maximum, falling linearly to 0 at twice that. Recipes without recorded times are not penalised.</li></ul> |
| **variety** | 0 if eaten today (same food or same name). 0.5 if eaten yesterday. 0.6 if it shares a component dish with something eaten today. Otherwise 1. |
| **history** (positive affinity only) | Starts at 0.7. Saved or liked: 1. +0.15 for each time it was selected, planned or logged in the last 30 days (at most 2). **Viewed is ignored:** viewing is never treated as liking. |
| **quality** | The verification level sets the base (§7). Subtract:<ul><li>0.15 for typical, not measured, recipe quantities;</li><li>0.25 for `cooking_oil_uncertain`;</li><li>0.10 for `density_assumed`;</li><li>0.05 if diet or allergen data is inferred, or 0.10 if unknown.</li></ul> |

**Calorie bands** (ratio of the budget):

| Tolerance | full_low | full_high | zero_low | zero_high |
|---|---|---|---|---|
| strict | 0.95 | 1.05 | 0.80 | 1.15 |
| standard (default) | 0.90 | 1.10 | 0.70 | 1.30 |
| flexible | 0.85 | 1.15 | 0.50 | 1.50 |

The user's goal makes the band asymmetric:
- **Lose:** going over is penalised sooner.
- **Gain:** falling short is.

### Adjustments (subtracted after weighting)

| Adjustment | Value | When |
|---|---|---|
| `novelty` | Σ 0.04 × 0.5^(age_days / 2), at most 0.15 | Each time shown, selected or logged in the last 7 days |
| `dislike` | 0.15 | A dislike matches the name or an ingredient |
| `rejected` | 0.15 while "not interested" / "less often" lasts (180 days); otherwise 0.10 × 0.5^(age_days / 7) | A rejection within the last 30 days |
| `overshoot` | 0.0005 × (kcal of carbs and fat above what is left **today** − 45), at most 0.15 | Normal mode with real targets only |
| `meal_type` | 0.10 | The dish has known meal types and the requested one isn't among them |

**Why adjustments rather than components.** A negative signal inside a 5%-weight component moved a disliked or rejected item by about 0.03. In testing, that wasn't enough for "not interested" to move the top item down. A fixed subtraction:
- always moves the item below options of similar fit;
- can still be outweighed by a clearly better nutritional fit, so a disliked food ranks lower but is not hidden;
- never touches a hard exclusion, because exclusions happen before scoring.

**Why `overshoot` and `meal_type` are adjustments.** The evaluation found two cases the weighted components handled poorly:
- **No fat left today.** The top lunch had 36 g of fat. The fat ceiling is only a 7% component, so a fully used macro barely registered.
- **A lunch-and-dinner-only fish curry was a top breakfast pick** at 0.82.

The overshoot penalty is measured in the energy of the excess: 9 kcal per gram of fat, 4 per gram of carbs. Carbs and fat are therefore treated alike, and a small slack (about 5 g of fat) avoids penalising trivial overshoots. In light mode the whole day is already over, so this penalty is off; otherwise every option would be penalised alike and light options would vanish. The meal-type mismatch is still not a hard rule, because meal types are inferred.

**Novelty never lasts.**
- After one showing, an item loses 0.04, halving every 2 days.
- Showings older than 7 days don't count.
- Three showings today cost 0.12. A week later the item is back where its fit puts it.

### Weights

| Component | maintain | lose | gain |
|---|---|---|---|
| calories | 0.30 | 0.30 | 0.32 |
| protein | 0.20 | 0.25 | 0.20 |
| carbs | 0.06 | 0.05 | 0.06 |
| fat | 0.07 | 0.06 | 0.05 |
| meal_type | 0.10 | 0.10 | 0.10 |
| preference | 0.10 | 0.09 | 0.10 |
| variety | 0.07 | 0.06 | 0.07 |
| history | 0.05 | 0.05 | 0.05 |
| quality | 0.05 | 0.04 | 0.05 |

`protein=high` adds 0.10 to protein, taken from calories (−0.05), carbs (−0.025) and fat (−0.025).

### Why these weights

- **Calories (0.30): the largest weight.** Staying within the day's energy target is the app's purpose. Together with the hard calorie gate, it means a poor energy fit can never rank well.
  - Gaining raises it to 0.32, because falling short is the failure that matters there.
  - It is not higher, because then two options of equal energy would be separated only by noise.
- **Protein (0.20): the second-largest.** Protein is the macro most often short in Indian vegetarian diets, and it matters for satiety and lean mass.
  - It is a floor, so more is never penalised.
  - Losing raises it to 0.25, because a calorie deficit makes satiety and lean mass more important.
- **Carbs (0.06) and fat (0.07): small ceilings.** Once calories and protein fit, carbs and fat are largely determined: kcal ≈ 4P + 4C + 9F. Large weights would count the same error twice.
  - Fat is slightly higher because it is the more energy-dense way to overshoot.
- **Meal type (0.10).** Suggesting biryani for breakfast is the error users notice first. It is not a hard rule, because meal types come from an inferred classifier, and some people eat dal-chawal for breakfast.
- **Preference (0.10).** It is large enough to reorder options of similar fit: a full match beats a full mismatch by about 0.07. It is small enough that a clearly better nutritional fit still wins.
  - It was raised from 0.08 after a South Indian preference surfaced no South Indian dish on the local catalogue.
- **Variety (0.07).** It discourages repeating what was eaten today. It is soft, because some users deliberately eat the same breakfast every day.
- **History (0.05).** It covers positive signals only (saved, chosen). It is small, because these are weak evidence of taste; negative signals are adjustments.
- **Quality (0.05).** It favours measured or reviewed data when the fit is otherwise similar. The cards show the detail as warnings.

### Thresholds

| Threshold | Value | Reason |
|---|---|---|
| Minimum score | 0.65 | A dish that fits only on calories, with no protein and a meal-type score of 0, scores about 0.64 before adjustments (0.54 after the meal-type adjustment): 0.30 calories + 0.13 carbs and fat + 0.06 neutral preference + 0.07 variety + 0.035 history + 0.04 quality. A recommendation must earn something on protein or meal type. Below the threshold nothing is shown, and the list is never padded. |
| Strong fit | ≥ 0.85 | |
| Good fit | ≥ 0.72 | |
| Fair fit | ≥ 0.65 | |

## 6. Diversity

A greedy re-rank repeatedly takes the candidate with the best score after penalties for traits it shares with the picks already chosen:

| Shared trait | Penalty for each earlier pick that shares it |
|---|---|
| main ingredient (canonical: "lentil", "paneer", "rice"…) | 0.12 |
| dish type | 0.06 |
| preparation style | 0.04 |
| region (only when the user has no cuisine preference) | 0.03 |

There are also two hard caps: at most 2 results share a main ingredient, and at most 1 result per group (recipe family, template or food). The displayed score stays the item's own score; `diversity_penalty` is reported separately.

## 7. Data-quality warnings

The base quality score by verification level:

| Verification | Base score |
|---|---|
| expert_reviewed | 1.0 |
| curated | 0.9 |
| auto_checked | 0.7 |
| unverified | 0.5 |

Every card lists:
- unverified nutrition;
- approximate recipe quantities;
- uncertain cooking oil;
- assumed density;
- an inferred diet classification (when a diet is declared);
- detected allergens, shown as "May contain … (not a reviewed allergen list)" unless reviewed.

`image_url` is always null: there are no verified meal images, and none are invented.

## 8. Personalization and what is never inferred

| Preference (user-entered only) | Effect |
|---|---|
| diet, allergies | Hard filters (§3) |
| excluded_ingredients | Hard filter |
| equipment (null = not provided) | Hard filter for recipes that record their needs |
| dislikes | −0.15 adjustment |
| cuisines, preferred_meal_styles, max_prep_minutes | Preference component |
| budget | **Stored, never used.** The catalogue has no cost data; the response says so |
| meal_preferences, notes | Stored for the assistant; not used for ranking |

Nothing is inferred from behaviour or conversation:
- **Allergies, diet and medical conditions** come only from what the user entered.
- **The assistant cannot write preferences.** Conversation summaries record only facts the user stated, never sensitive inferences.
- **Interactions only re-rank.** They never become preferences, and they never become exclusions, except "never", which the user chose explicitly.

| Interaction | Stored as | Used for |
|---|---|---|
| viewed | event | Nothing in ranking (viewing ≠ liking) |
| selected, planned | event | History bonus, novelty |
| logged (on proposal confirmation) | event (written by the backend) | History bonus, novelty |
| rejected | event | `rejected` adjustment, fading |
| not interested | event + `less_often` feedback (180 days) | `rejected` adjustment |
| never | event + `never` feedback (until deleted) | Hard exclusion |
| saved / unsaved | event + `saved` feedback (bookmark, no expiry) | History 1.0 |

Events belong to the user (RLS). Their foreign key requires the user's own set, so they cannot be attached to someone else's recommendation. They are deleted with their set after 90 days.

## 9. Precision

- Nutrition is shown in whole kcal and whole grams, priced by the database.
- Explanations round kcal to the nearest 10.
- The score has two decimals; components have one.
- Ingredient quantities are scaled arithmetically from the recipe (quantity × servings / yield). Nutrition never comes from that list.

## 10. API

| Endpoint | Purpose |
|---|---|
| `GET /v1/me/recommendations` | List. Parameters:<ul><li>`meal_type` (required);</li><li>`count` 1–10;</li><li>`mode` meals, foods or both;</li><li>`tolerance`;</li><li>`max_kcal`, `target_kcal`;</li><li>`protein` normal or high;</li><li>`cuisine`;</li><li>`exclude[]` candidate keys;</li><li>`date`.</li></ul>An unknown parameter (for example `user_id`) is a 422. Identity comes only from the JWT. |
| `GET /v1/me/recommendations/{id}?servings=…` | Recipe details, scaled ingredients, instructions and saved state, re-priced for the servings. 404 if it isn't yours; 410 if it is no longer available. |
| `POST /v1/me/recommendations/{id}/feedback` | `action`: viewed, selected, rejected, planned, saved, unsaved, not_interested or never. |
| `POST /v1/me/recommendations/{id}/log-proposal` | Creates a **pending** proposal through the existing proposal service. It is confirmed with `POST /v1/assistant/proposals/{id}/confirm`, the single path that writes food logs. Recipes are re-priced with `recipe_portion` at confirmation. |
| `GET` / `DELETE /v1/me/recommendation-feedback[/{id}]` | Review or undo feedback, including saved items. |
| `GET` / `PUT` / `PATCH` / `DELETE /v1/me/preferences` | Preference management. |

**Assistant parity.** `recommend_meals` calls `service.recommend(..., persist=False)` with the same repository and candidate cache. The meal recommendation card embeds the tool result directly, so the model cannot alter names, portions, numbers or scores. A test checks that the tool and the API return identical keys, nutrition and scores.

## 11. Performance (local stack, measured)

| Part of a request | Cost |
|---|---|
| Candidates | Three RPCs: about 771 single dishes, 22 recipes and 0 templates locally. Cached per process for 15 minutes; the rows are the same for every user. |
| User context | Daily status, then 6 parallel selects: preferences, profile, two days of logs, feedback, 7 days of items, 30 days of events. |
| Engine | About 53 ms median and 86 ms worst case for the 771 local candidates; 2.6 ms for the 32-item evaluation fixture. |
| Pricing | One RPC per part of each returned pick, run in parallel. |

Warm request median: **about 107 ms**; the first request after start-up also loads candidates. No Redis or background worker is needed at this scale: the cache is a few hundred kilobytes per process. Revisit if the catalogue grows past about 20k candidates, or if several API processes need to share a cache.

## 12. Statuses

| Status | Meaning |
|---|---|
| `ok` | `count` items fit well. |
| `partial` | Fewer fit well; the list is not padded. |
| `empty_catalogue` | Nothing to rank for this mode. |
| `insufficient_data` | Every option failed on data: unverified allergens, unknown or unreviewed diet, incomplete or unreliable nutrition, or unpriceable picks. |
| `excluded_by_constraints` | Diet, allergies, excluded ingredients, equipment or "never" choices exclude everything. |
| `no_fit` | Options passed the constraints, but none fits the budget, filters or minimum score. |

## 12a. Optional template components (add-ons)

- **Base meal:** a template's required components. Ranking, the calorie gate, scores and `nutrition` all use the base meal only.
- **Add-ons:** optional components, returned in `optional_components`. Each one is priced by the database at its default servings, and the list also returns `nutrition_with_optional` (base plus every offered add-on). Migration 019 gives each add-on its own diet, allergen and quality attributes.
- **The same hard rules apply to each add-on:**
  - diet, including unknown or unreviewed classifications;
  - allergies, which need reviewed data;
  - excluded ingredients;
  - incomplete nutrition.

  An add-on that fails is listed in `optional_withheld` with the reason, and it can never be selected. The base meal is still offered if it passes on its own. For example, tea with milk is withheld for a milk-allergic user even though the poha may still be shown.
- **Exclusions match required components, not the title.** For templates, excluded ingredients and dislikes are matched against the required component names, because titles such as "Poha with tea" name optional components. The template report flags such titles for review.
- **Detail endpoint:** `GET /v1/me/recommendations/{id}?optional=<food id>…` re-checks the add-ons against the user's current preferences and returns `total_nutrition`, re-priced for the chosen servings and add-ons. An add-on that isn't offered is rejected with a 422.
- **Logging:** `POST …/log-proposal` with `optional` puts exactly the chosen add-ons into the pending proposal.

## 13. Known limitations

- Meal types, regions and diet classes come from the attribute classifier and are `inferred` until reviewed. For example, "Egg nog" is classed as an egg dish and is suggested for dinner.
- The main ingredient for single INDB dishes comes from a name-keyword list. Unmatched dishes get no main-ingredient diversity penalty.
- Recipe equipment was curated for the 22 drafts. INDB dishes and templates record no equipment, so the equipment filter never applies to them.
- Budget preference is stored but cannot be applied (no cost data).
- Ingredient lists exist only for recipes. INDB single dishes and templates have none, so dislikes and excluded ingredients match their names (with common Indian synonyms) only. Their cards say so whenever an exclusion is set.
- Real selection and rejection rates aren't measurable yet: the local database has about 111 recommendations shown, all from tests. The evaluation reports the rates once at least 200 are shown.

## 14. Evaluation

```
python -m evals.run_recommendation_eval            # fixture catalogue, 30 cases
python -m evals.run_recommendation_eval --local    # + the real local catalogue (read-only) and interaction rates
```

`tests/test_recommendation_eval.py` runs the fixture evaluation in CI.

**Cases (10 categories, 30 cases).** High-protein goals; low remaining budgets; vegetarian, vegan and Jain; explicit ingredient, allergy and equipment exclusions; meal types; repeated recommendations (rotation, "not interested", "never"); missing catalogue information; no suitable recommendations; different macro distributions; diversity.

**Invariants checked on every case.** They are re-implemented in the runner rather than imported from the engine:
- **Hard constraints:** diet, allergies, excluded ingredients, equipment, "never" and the maximum calories.
- **Nutrition:** equals the sum of part per-serving values × servings, and the servings are allowed.
- **Consistency:** identical results on re-run and on three shuffled inputs.
- **Diversity:** caps on main ingredient and group.

| Metric (latest run) | Fixture | Local catalogue |
|---|---|---|
| Cases clean | 30 / 30 | 28 / 28 (invariants only) |
| Items checked | 121 | 122 |
| Hard constraint violation rate | **0.0** | **0.0** |
| Nutrition errors | 0 | 0 |
| Ranking inconsistencies | 0 | 0 |
| Distinct main ingredients / items | 0.89 | 0.78 |
| Engine latency p50 / max | 2.6 / 3.6 ms | 53 / 86 ms |

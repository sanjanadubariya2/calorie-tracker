# Serving-weight audit

serving-audit-1 (2026-11-21). Read-only: **no catalogue value was changed.** A replacement is proposed only with a traceable source; none of the foods below has one yet. Generic household-unit ranges only raise questions.

INDB serving weights are derived (per-serving ÷ per-100 g energy). Where every nutrient implies the same weight, the value is INDB's own, and an odd weight more likely reflects the per-100 g basis or the household unit than a loading error. Per-serving nutrition (what templates use) is INDB's stated value either way; the gram weight matters when someone logs by grams.

| Food | Serving | kcal/100 g | kcal/serving | Assessment | Confidence in current | Proposed | Status |
|---|---|---|---|---|---|---|---|
| Hot tea (Garam Chai) (ASC001) | 1 tea cup = 210.5 g | 16.1 | 34 | plausible | high | none | supported by a comparable USDA household measure |
| Idli (ASC144) | 1 idli = 25.1 g | 137.5 | 35 | suspicious | low | none | unverified: needs a traceable source or a weighed serving |
| Lassi (salted) (ASC022) | 1 tall glass = 423.2 g | 18.8 | 80 | plausible | medium | none | plausible; no standard 'tall glass' to verify against |
| Masala dosa (ASC146) | 1 dosa = 209.7 g | 164.6 | 345 | plausible | medium | none | plausible on internal consistency; not independently verified |
| Mixed vegetable pulao (ASC115) | 1 plate = 438.4 g | 113 | 495 | suspicious | low | none | unverified: needs a traceable source or a weighed serving |
| Moong dal stuffed cheela/chilla (Moong dal ka cheela/chilla) (BFP046) | 1 cheela = 227.3 g | 154.9 | 352 | suspicious | low | none | unverified: needs a traceable source or a weighed serving |
| Plain dosa (BFP148) | 1 dosa = 36.1 g | 380.9 | 138 | suspicious | low | none | unverified: needs a traceable source or a weighed serving |
| Plain khitchdi (Plain khichri/khichdi) (BFP144) | 1 small bowl = 574 g | 57 | 327 | suspicious | low | none | unverified: needs a traceable source or a weighed serving |
| Poha (BFP044) | 1 bowl = 54.6 g | 294.5 | 161 | suspicious | low | none | unverified: needs a traceable source or a weighed serving |
| Bengal fish curry (Bengali machli curry) (BFP223) | 1 bowl = 310.5 g | 109.4 | 340 | not assessed | unknown | none | unverified |
| Brinjal bhartha (Baingan ka bhartha) (ASC177) | 1 bowl = 325.8 g | 65.1 | 212 | not assessed | unknown | none | unverified |
| Chickpeas curry (Safed channa curry) (ASC162) | 1 bowl = 119.9 g | 163.4 | 196 | not assessed | unknown | none | unverified |
| Coconut chutney (Nariyal ki chutney) (ASC386) | 1 tablespoon = 25.3 g | 265.9 | 67 | not assessed | unknown | none | unverified |
| Dal makhani (OSR139) | 1 bowl = 353.4 g | 74 | 262 | not assessed | unknown | none | unverified |
| Dry potato (Sookhe aloo) (ASC178) | 1 bowl = 105.7 g | 103.1 | 109 | not assessed | unknown | none | unverified |
| Kidney bean curry (Rajmah curry) (ASC165) | 1 bowl = 119.9 g | 143.7 | 172 | not assessed | unknown | none | unverified |
| Mint and coriander chutney (Pudinay aur dhaniye ki chutney) (ASC387) | 1 tablespoon = 26.3 g | 102.6 | 27 | not assessed | unknown | none | unverified |
| Plain parantha/paratha (ASC097) | 1 parantha = 55.8 g | 298.3 | 166 | not assessed | unknown | none | unverified |
| Rasam with tamarind (Puli rasam/ Chintapandu rasam/ Charu/Saaru) (BFP176) | 1 curry bowl = 389.9 g | 26.7 | 104 | not assessed | unknown | none | unverified |
| Semolina idli (Suji/Rava idli) (BFP579) | 1 idli = 29.6 g | 206.4 | 61 | not assessed | unknown | none | unverified |
| Semolina upma (Suji/Rava upma) (BFP039) | 1 bowl = 106.3 g | 147.9 | 157 | not assessed | unknown | none | unverified |
| Tossed green salad (BFP301) | 1 small bowl = 218 g | 49.9 | 109 | not assessed | unknown | none | unverified |
| Uttapam (BFP152) | 1 uttapam = 68 g | 255.9 | 174 | not assessed | unknown | none | unverified |
| Vegetable poha (BFP045) | 1 bowl = 97.8 g | 180.5 | 177 | not assessed | unknown | none | unverified |
| Whole masoor (Masoor ki dal) (ASC157) | 1 bowl = 342.3 g | 54.1 | 185 | not assessed | unknown | none | unverified |

## Details

### Hot tea (Garam Chai) (ASC001)

- Current: 1 tea cup = 210.5 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 210.5, 210.5, 210.5, 210.5 g (INDB primarysource asc_manual).
- Used by: poha-with-tea, sprouted-moong-poha-tea, vegetable-poha-tea.
- Why it was flagged: 210 g for a tea cup lies between USDA's 6 fl oz and 8 fl oz servings of brewed tea. The report's generic tea-cup range (100–200 g) was too narrow; the catalogue value is not the problem.
- Generic check: Hot tea (Garam Chai): the catalogue's '1 tea cup' weighs 210 g; a tea cup is usually 100–200 g.
- Reference data: USDA SR Legacy 173227 'Beverages, tea, black, brewed, prepared with tap water': 6 fl oz = 178 g (current 210.5 g is 1.18x); USDA SR Legacy 173227 'Beverages, tea, black, brewed, prepared with tap water': 1 cup (8 fl oz) = 237 g (current 210.5 g is 0.89x)
- Proposed replacement: none (no traceable source)
- Confidence in the current value: high; status: supported by a comparable USDA household measure

### Idli (ASC144)

- Current: 1 idli = 25.1 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 25.1, 25.1, 25.1, 25.1 g (INDB primarysource asc_manual).
- Used by: idli-sambar-chutney.
- Why it was flagged: 25 g per idli is light for a standard idli. Energy density (137.5 kcal/100 g) is that of a steamed batter product, so the per-piece weight itself is the question. 34.5 kcal per idli is INDB's stated value.
- Generic check: Idli: the catalogue's '1 idli' weighs 25 g; a idli is usually 30–60 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: low; status: unverified: needs a traceable source or a weighed serving
- To verify: INDB recipe yield for ASC144 or weighed idlis of the intended size.

### Lassi (salted) (ASC022)

- Current: 1 tall glass = 423.2 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 423.2, 423.2, 423.3, 423.2 g (INDB primarysource asc_manual).
- Used by: sprouts-salad-lassi.
- Why it was flagged: 423 g for a 'tall glass' is large, but a tall glass is not a standard measure, and 18.8 kcal/100 g is a dilute salted lassi, so a large volume is consistent.
- Generic check: Lassi (salted): the catalogue's '1 tall glass' weighs 423 g; a tall glass is usually 200–350 g.
- Reference data: USDA SR Legacy 170874 'Milk, buttermilk, fluid, cultured, lowfat': 1 cup = 245 g (current 423.2 g is 1.73x)
- Proposed replacement: none (no traceable source)
- Confidence in the current value: medium; status: plausible; no standard 'tall glass' to verify against

### Masala dosa (ASC146)

- Current: 1 dosa = 209.7 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 209.7, 209.7, 209.7, 209.7 g (INDB primarysource asc_manual).
- Used by: masala-dosa-sambar.
- Why it was flagged: 210 g per masala dosa includes the potato filling; a filled dosa is heavier than a plain one, so the generic dosa range does not apply. 165 kcal/100 g is consistent with a filled dosa.
- Generic check: Masala dosa: the catalogue's '1 dosa' weighs 210 g; a dosa is usually 60–150 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: medium; status: plausible on internal consistency; not independently verified

### Mixed vegetable pulao (ASC115)

- Current: 1 plate = 438.4 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 438.4, 438.4, 438.4, 438.4 g (INDB primarysource asc_manual).
- Used by: veg-pulao-raita.
- Why it was flagged: 438 g for '1 plate' of pulao is a large plate.
- Generic check: Mixed vegetable pulao: the catalogue's '1 plate' weighs 438 g; a plate is usually 150–350 g.
- Reference data: USDA SR Legacy 168878 'Rice, white, long-grain, regular, enriched, cooked': 1 cup = 158 g (current 438.4 g is 2.77x)
- Proposed replacement: none (no traceable source)
- Confidence in the current value: low; status: unverified: needs a traceable source or a weighed serving
- To verify: INDB recipe yield for ASC115 or a weighed plate. Templates use 0.5 plate (219 g).

### Moong dal stuffed cheela/chilla (Moong dal ka cheela/chilla) (BFP046)

- Current: 1 cheela = 227.3 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 227.3, 227.3, 227.3, 227.3 g (INDB primarysource bfp_manual).
- Used by: moong-cheela-chutney.
- Why it was flagged: 227 g for one stuffed moong cheela is heavy for a single piece (352 kcal). It may describe a large stuffed cheela or a plate of them.
- Generic check: Moong dal stuffed cheela/chilla (Moong dal ka cheela/chilla): the catalogue's '1 cheela' weighs 227 g; a cheela is usually 40–120 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: low; status: unverified: needs a traceable source or a weighed serving
- To verify: INDB recipe yield for BFP046 (pieces per batch) or a weighed cheela.

### Plain dosa (BFP148)

- Current: 1 dosa = 36.1 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 36.1, 36.1, 36.1, 36.1 g (INDB primarysource bfp_manual).
- Used by: plain-dosa-sambar.
- Why it was flagged: 36 g per plain dosa with 381 kcal/100 g: the density is far above a cooked dosa, which points to an ingredient/batter-solids basis rather than the cooked dosa. 138 kcal per dosa is INDB's stated value.
- Generic check: Plain dosa: the catalogue's '1 dosa' weighs 36 g; a dosa is usually 60–150 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: low; status: unverified: needs a traceable source or a weighed serving
- To verify: INDB recipe basis for BFP148; the per-dosa energy may be right even if the gram weight is not.

### Plain khitchdi (Plain khichri/khichdi) (BFP144)

- Current: 1 small bowl = 574 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 574.0, 574.0, 574.0, 574.0 g (INDB primarysource bfp_manual).
- Used by: khichdi-raita.
- Why it was flagged: 574 g for '1 small bowl' is very heavy, and 57 kcal/100 g is unusually dilute for khichdi, which suggests a very watery preparation or that the household unit is mislabelled. 327 kcal per serving is INDB's value.
- Generic check: Plain khitchdi (Plain khichri/khichdi): the catalogue's '1 small bowl' weighs 574 g; a small bowl is usually 80–200 g (far outside).
- Proposed replacement: none (no traceable source)
- Confidence in the current value: low; status: unverified: needs a traceable source or a weighed serving
- To verify: INDB recipe for BFP144 (water ratio, yield) or a weighed small bowl.

### Poha (BFP044)

- Current: 1 bowl = 54.6 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 54.6, 54.6, 54.6, 54.6 g (INDB primarysource bfp_manual).
- Used by: poha-with-tea.
- Why it was flagged: 55 g for '1 bowl' is light for a bowl of cooked poha, and INDB's 294.5 kcal/100 g is high for cooked poha, so the per-100 g basis may be a drier preparation than what is served. The 161 kcal per bowl is INDB's own stated value.
- Generic check: Poha: the catalogue's '1 bowl' weighs 55 g; a bowl is usually 120–300 g (far outside).
- Proposed replacement: none (no traceable source)
- Confidence in the current value: low; status: unverified: needs a traceable source or a weighed serving
- To verify: INDB/Anuvaad recipe basis for BFP044 (cooked vs ingredient weight) or a weighed household bowl.

### Bengal fish curry (Bengali machli curry) (BFP223)

- Current: 1 bowl = 310.5 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 310.5, 310.5, 310.5, 310.5 g (INDB primarysource bfp_manual).
- Used by: bengali-fish-curry-rice.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Bengal fish curry (Bengali machli curry): the catalogue's '1 bowl' weighs 310 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Brinjal bhartha (Baingan ka bhartha) (ASC177)

- Current: 1 bowl = 325.8 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 325.8, 325.8, 325.8, 325.8 g (INDB primarysource asc_manual).
- Used by: baingan-bharta-chapati.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Brinjal bhartha (Baingan ka bhartha): the catalogue's '1 bowl' weighs 326 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Chickpeas curry (Safed channa curry) (ASC162)

- Current: 1 bowl = 119.9 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 119.9, 119.9, 119.9, 119.9 g (INDB primarysource asc_manual).
- Used by: chole-chapati-salad.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Chickpeas curry (Safed channa curry): the catalogue's '1 bowl' weighs 120 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Coconut chutney (Nariyal ki chutney) (ASC386)

- Current: 1 tablespoon = 25.3 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 25.3, 25.3, 25.3, 25.3 g (INDB primarysource asc_manual).
- Used by: idli-sambar-chutney, masala-dosa-sambar, plain-dosa-sambar, rava-upma-coconut-chutney, uttapam-chutney.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Coconut chutney (Nariyal ki chutney): the catalogue's '1 tablespoon' weighs 25 g; a tablespoon is usually 10–25 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Dal makhani (OSR139)

- Current: 1 bowl = 353.4 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 353.4, 353.4, 353.4, 353.4 g (INDB primarysource open_source_recipes).
- Used by: dal-makhani-chapati.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Dal makhani: the catalogue's '1 bowl' weighs 353 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Dry potato (Sookhe aloo) (ASC178)

- Current: 1 bowl = 105.7 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 105.7, 105.7, 105.7, 105.7 g (INDB primarysource asc_manual).
- Used by: paratha-dry-aloo.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Dry potato (Sookhe aloo): the catalogue's '1 bowl' weighs 106 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Kidney bean curry (Rajmah curry) (ASC165)

- Current: 1 bowl = 119.9 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 119.9, 119.9, 119.9, 119.9 g (INDB primarysource asc_manual).
- Used by: rajma-chawal.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Kidney bean curry (Rajmah curry): the catalogue's '1 bowl' weighs 120 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Mint and coriander chutney (Pudinay aur dhaniye ki chutney) (ASC387)

- Current: 1 tablespoon = 26.3 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 26.3, 26.3, 26.3, 26.3 g (INDB primarysource asc_manual).
- Used by: besan-cheela-chutney, dhokla-chutney, moong-cheela-chutney.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Mint and coriander chutney (Pudinay aur dhaniye ki chutney): the catalogue's '1 tablespoon' weighs 26 g; a tablespoon is usually 10–25 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Plain parantha/paratha (ASC097)

- Current: 1 parantha = 55.8 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 55.8, 55.8, 55.8, 55.8 g (INDB primarysource asc_manual).
- Used by: paratha-dry-aloo.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Plain parantha/paratha: the catalogue's '1 parantha' weighs 56 g; a parantha is usually 60–130 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Rasam with tamarind (Puli rasam/ Chintapandu rasam/ Charu/Saaru) (BFP176)

- Current: 1 curry bowl = 389.9 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 389.9, 389.9, 389.9, 389.9 g (INDB primarysource bfp_manual).
- Used by: rasam-rice-raita.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Rasam with tamarind (Puli rasam/ Chintapandu rasam/ Charu/Saaru): the catalogue's '1 curry bowl' weighs 390 g; a curry bowl is usually 150–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Semolina idli (Suji/Rava idli) (BFP579)

- Current: 1 idli = 29.6 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 29.6, 29.6, 29.6, 29.6 g (INDB primarysource bfp_manual).
- Used by: rava-idli-sambar.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Semolina idli (Suji/Rava idli): the catalogue's '1 idli' weighs 30 g; a idli is usually 30–60 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Semolina upma (Suji/Rava upma) (BFP039)

- Current: 1 bowl = 106.3 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 106.3, 106.3, 106.3, 106.3 g (INDB primarysource bfp_manual).
- Used by: rava-upma-coconut-chutney.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Semolina upma (Suji/Rava upma): the catalogue's '1 bowl' weighs 106 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Tossed green salad (BFP301)

- Current: 1 small bowl = 218 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 218.0, 218.0, 218.0, 218.0 g (INDB primarysource bfp_manual).
- Used by: chole-chapati-salad.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Tossed green salad: the catalogue's '1 small bowl' weighs 218 g; a small bowl is usually 80–200 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Uttapam (BFP152)

- Current: 1 uttapam = 68 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 68.0, 68.0, 68.0, 68.0 g (INDB primarysource bfp_manual).
- Used by: uttapam-chutney.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Uttapam: the catalogue's '1 uttapam' weighs 68 g; a uttapam is usually 80–160 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Vegetable poha (BFP045)

- Current: 1 bowl = 97.8 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 97.8, 97.8, 97.8, 97.8 g (INDB primarysource bfp_manual).
- Used by: vegetable-poha-tea.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Vegetable poha: the catalogue's '1 bowl' weighs 98 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

### Whole masoor (Masoor ki dal) (ASC157)

- Current: 1 bowl = 342.3 g; source indb 2024.11 (serving: indb); INDB per-serving energy / per-100 g energy x 100 (catalogue loader).
- INDB check: consistent: energy/protein/carbs/fat imply 342.3, 342.3, 342.3, 342.3 g (INDB primarysource asc_manual).
- Used by: masoor-dal-chapati-bhindi.
- Why it was flagged: Only the generic household-unit range flags it; no individual review yet.
- Generic check: Whole masoor (Masoor ki dal): the catalogue's '1 bowl' weighs 342 g; a bowl is usually 120–300 g.
- Proposed replacement: none (no traceable source)
- Confidence in the current value: unknown; status: unverified

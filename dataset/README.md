# Golden dataset — Halden Fabrications Ltd

A fictional 41-person UK sheet-metal fabricator with 12 months of energy documents, designed as a **test suite**: every document exists to exercise a specific schema field or trigger a specific failure mode. See `../docs/golden-dataset-design.md`.

**All data is fictional.** No real company, meter, account or personal data appears here.

## Contents

- `ground-truth.xlsx` — the source of truth. Hand-computed correct values and emissions, with pinned factor versions and per-field match rules. **The workbook generates the documents, never the reverse.**
- `templates/` — HTML/CSS bill templates per supplier layout, filled from the workbook.
- `documents/` — rendered documents (24 core). Degraded and hostile tiers are produced physically: printed and photographed badly, crumpled, or genuinely handwritten. Hostile realism cannot be CSS'd.

## Build order

1. Verify and pin DEFRA factors + CCL rates (`Factors` sheet) from published sources.
2. Fill the monthly consumption model; totals must check against design targets.
3. Fill per-document ground truth so arithmetic reconciles (consumption × rate + standing + CCL + VAT = total).
4. Compute emissions with factor lineage.
5. Only then fabricate documents.

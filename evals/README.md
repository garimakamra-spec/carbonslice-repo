# Eval harness

**Status: in progress (Module 1).**

Scores extraction output against hand-computed ground truth in `../dataset/ground-truth.xlsx`.

## Design

- **Answer key:** `Ground_Truth` sheet — one row per document per field: doc #, field path (schema v2), correct value, match rule.
- **Match rules:** `exact` · `normalised_string` · `date_normalised` · `tolerance_pct_0.5` (consumption) · `tolerance_abs_0.01` (money) · `exact_null` (hallucination test — any non-null value on a null field is a failure).
- **Reporting:** per field **and** per tier (clean / degraded / hostile). A single blended accuracy figure is misleading and is never the headline.
- **Versioning:** every run records the schema version scored against. Results are not comparable across schema versions.
- **Baseline:** the first honest run is preserved permanently. "Improved from X% to Y%" requires an X.

## To build

- [ ] Ground-truth loader (xlsx → normalised answer key)
- [ ] Match-rule implementations
- [ ] Runner: documents → extraction → scoring → results
- [ ] Per-field / per-tier accuracy report
- [ ] Confidence calibration table (accuracy bucketed by stated confidence)

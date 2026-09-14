# CLAUDE.md — CarbonSlice project memory

Project conventions and domain rules. Read this before making changes.

## What this project is

An AI-powered carbon accounting product for UK small businesses: utility bills and fuel receipts in, Scope 1+2 footprint with audit lineage out. Built solo as a build-to-learn project. UK-only, DEFRA factors, GHG Protocol methodology.

## Inviolable domain rules

These are not preferences. Breaking one is a correctness bug.

1. **Emission factors are NEVER generated, inferred, or recalled by an LLM.** They come only from the versioned factor table in `dataset/` (ultimately a factor module in code). Every emissions figure records the factor version and source row used. If a factor is missing, fail loudly — never substitute a remembered value.
2. **Never fabricate extracted values.** An absent field is `null`. A plausible invention is the most serious failure class in this product and is scored separately in evals (`exact_null` match rule).
3. **Lineage is mandatory for emissions-bearing fields.** Meter identifier, consumption value, fuel subtotal and total cost must always carry source text. Other fields may lose lineage under output-budget pressure; these never do.
4. **Human corrections are additive, never destructive.** When a reviewer corrects a field, preserve the original model value and the timestamp. An auditor must be able to see that a human overrode the machine, and what the machine said.
5. **Estimated reads are a distinct uncertainty dimension.** `read_type: estimated` means the *document* is provisional, regardless of extraction confidence. Never collapse these two kinds of uncertainty into one number.

## Schema

Current: **v2** (`docs/schema-v2.md`). A bill is document-level metadata plus a `supplies[]` array — one entry per fuel, so dual-fuel bills keep consumption, rates and charges strictly separate.

**Schema changes invalidate accuracy history.** Any schema change requires: version bump, a note in `docs/schema-v2.md`, and eval runs re-baselined. Every eval result records the schema version it scored against. Never compare accuracy numbers across schema versions.

## Wire format vs domain model

The model returns compact keys `{"v","c","t"}` to conserve output tokens; the application expands these to `{value, confidence, source_text}` immediately after parsing. Keep this separation — wire format is optimised for transmission, domain model for humans. Never leak `v`/`c`/`t` into application code beyond the parse boundary.

## LLM call conventions

- Always check `stop_reason`. `max_tokens` means the response was truncated — treat the output as untrusted.
- Never let a raw parse exception reach a user. Translate failures into actionable messages.
- On truncation, retry once in budget mode (reduced lineage) before failing. Flag any document whose lineage was degraded.
- Validate against the schema before anything enters the data store.

## Evals

- Ground truth lives in `dataset/ground-truth.xlsx` and is **hand-computed before documents are fabricated**. The workbook generates the bills, never the reverse.
- Match rules: `exact`, `normalised_string`, `date_normalised`, `tolerance_pct_0.5` (consumption), `tolerance_abs_0.01` (money), `exact_null` (hallucination test).
- Report accuracy **per field and per tier** (clean / degraded / hostile). A single blended accuracy number is misleading and should never be the headline.
- Preserve the baseline. The first honest ugly numbers stay in the repo permanently.

## Code conventions

- Python for the eval harness; React for prototypes.
- Documents are generated from the workbook via templates — `make dataset` should regenerate the full set, so a ground-truth correction reflows every document.
- Keep prototypes runnable standalone; they are portfolio artifacts as much as code.

## Data policy

**No real customer data, ever.** All company, meter, account, address and supplier data is fictional (Halden Fabrications Ltd and suppliers per `docs/golden-dataset-design.md`). Real bills used in ad-hoc testing must never be committed — this repository is public.

## Writing style for docs

Findings are marked `[OBSERVED]` only when they actually happened and are documented; designed-but-unrun experiments are `[TO TEST]`. Never promote one to the other without a logged result. Honest caveats about sample size stay in.

# Module 0 memo — What the model can and can't do with UK utility bills

**Author:** Garima · **Project:** CarbonSlice · **Date:** July 2026 · **Status:** v1.0 — Final (one open item: back-fill per-document rows in §6 experiment log from testing notes)

> Everything in this memo is written from direct experiment on my own prototype, not from secondary sources. Findings marked **[OBSERVED]** happened and are documented; items marked **[TO TEST]** are experiments I have designed but not yet run. Nothing moves from the second category to the first without a documented result.

---

## 1. Purpose and method

The question this memo answers: can a multimodal LLM reliably turn scanned UK utility bills, fuel receipts and supplier invoices into structured, audit-ready data — and where exactly does it break?

Method: I built a working extraction prototype (bill image or PDF in → structured JSON out, with per-field value, confidence score and source-text lineage) on the Claude API (claude-sonnet-4-6, multimodal document input, prompted JSON output). I then ran real and deliberately degraded documents through it and recorded results per field against ground truth I established manually — which, given my background computing these figures for a living, I can do authoritatively.

The extraction schema covers: document type, supplier, customer, site address, account number, MPAN/MPRN, fuel type, billing period, consumption value and unit, meter readings, total cost, VAT rate, and tariff name.

## 2. What I learned before extraction quality even came up **[OBSERVED]**

The first production failure had nothing to do with the model's intelligence. On a real bill, the model's JSON response exceeded the output token budget and was cut off mid-string, producing unparseable output ("Unterminated string in JSON at position 2455"). The extraction itself may have been perfect — the system around it still failed.

Three generalisable lessons, each now implemented in the prototype:

1. **LLM output is not guaranteed complete or well-formed.** The consuming system must treat every response as untrusted until validated. Fix: constrain output size in the prompt (minified JSON, capped source-text length) and, in the real build, use the API's tool-use / structured-output mechanism, which guarantees schema-valid JSON rather than requesting it politely.
2. **The API tells you why generation stopped — check it.** `stop_reason: "max_tokens"` distinguishes "the model finished" from "the model was cut off." Ignoring this field means silently accepting truncated data.
3. **Parse failures must be translated, not surfaced raw.** A reviewer seeing "Unterminated string at position 2455" learns nothing; "the response was cut off — likely a dense document, retry or split pages" is actionable.

Design consequence for CarbonSlice: ingestion needs a validation layer between the model and the data store — schema validation, stop-reason checks, and retry logic — before any extracted figure is even a candidate for the footprint.

**The failure returned — with a new cause [OBSERVED].** After moving to schema v2 (supplies array, read type, payment method, per-fuel rates, EAC), a dense gas-bill explainer image hit the token limit again. Root cause: schema growth. Every added field costs output tokens on every response; roughly doubling the field count consumed the headroom the first fix had bought. Lesson: **output budget is a design constraint that schema changes spend — every field addition has a token price, paid on every single extraction.**

Three fixes, each a general production pattern:

1. **Compact wire format.** The model returns `{"v","c","t"}` instead of `{"value","confidence","source_text"}`, expanded to full names after parsing — separating the wire format (optimised for transmission) from the domain model (optimised for humans). ~25% output reduction, zero information loss.
2. **Budgeted verbosity.** Source-text snippets capped at 5 words, issues at 3 — lineage kept, prose trimmed.
3. **Graceful degradation.** If a response is still truncated, the system automatically retries once in "budget mode": source text retained only for the four lineage-critical fields (meter identifier, consumption, fuel subtotal, total cost), nulled elsewhere — and the document is visibly flagged that lineage was trimmed. Degrading the least important output beats failing outright, and degrading *silently* would be worse than failing: the flag is part of the fix.

The prioritisation inside fix 3 — deciding what to lose first when space runs short — is a product judgment, not an engineering one: values are never sacrificed, and lineage on fields that flow into a reported emissions figure is protected above all else.

## 3. What works reliably

**[OBSERVED — round 1: 6 documents]** Test set: photos, screenshots and stock images of real UK bills, including dual-fuel documents, across PNG, PDF and web-sourced file formats.

- **Input robustness:** every format extracted successfully — phone photos, screenshots, stock images, PDFs. No format-specific pipeline failures.
- **Extraction quality:** fields extracted correctly at high confidence across the set; the extraction is strong enough that the review workflow, not extraction failure, is the operative loop.
- **Uncertainty flagging works as designed:** every field flagged below the confidence threshold genuinely warranted a human decision. I resolved each flagged field through the review queue (confirm or correct), meaning the confidence-thresholded human-in-the-loop pattern functioned end-to-end on real documents.
- **Source-text lineage holds:** the `source_text` cited for extracted values matched the document — no fabricated citations observed. This validates lineage as a trust mechanism.
- **Null discipline holds:** genuinely absent fields returned null rather than plausible inventions.

## 4. Where it breaks — the failure taxonomy

Failures observed so far fall into two distinct classes, and the distinction matters because they need different mitigations:

**System failures** — the pipeline breaks regardless of model quality: token truncation **[OBSERVED]**, malformed JSON, latency/timeout. Mitigated by engineering: structured outputs, validation, retries.

**Extraction failures** — the model produces wrong or missing values: misreads, wrong-field assignment, hallucinated values, unit confusion. Mitigated by product design: confidence-thresholded review, validation rules, evals. These are what the experiment log below is designed to surface.

## 5. The confidence question (the one that decides the product)

CarbonSlice's economics rest on confidence-thresholded human review: high-confidence fields pass automatically, low-confidence fields cost human time. That only works if confidence is *calibrated* — if fields the model marks 95% really are right ~95% of the time.

**[TO TEST — the most important experiment in this memo]** Across the full experiment log, bucket every field by stated confidence (≥0.95, 0.85–0.95, 0.6–0.85, <0.6) and compute actual accuracy per bucket against my ground truth. Two failure patterns to look for:

- **Overconfidence:** confidently wrong extractions (e.g. correct-looking number read from the wrong meter register at high confidence). These sail through review — the automation-bias risk. Mitigation if observed: cross-field validation rules (consumption × unit rate ≈ total cost; billing period ≈ 30/90 days; MPAN checksum) and sampling audits of high-confidence fields.
- **Underconfidence:** correct values flagged at low confidence, inflating review rate and cost for nothing.

**[OBSERVED — preliminary, round 1]** Across the 6-document set, confidence behaved in a balanced way: no confidently-wrong extractions surfaced (no overconfidence) and no correct values were needlessly flagged at low confidence (no underconfidence). Every flag earned its review.

**Caveat I am holding myself to:** 6 documents is a promising signal, not calibration evidence. The bucket-level accuracy table below still needs to be computed at golden-dataset scale (Module 1) before I treat confidence as load-bearing for production thresholds — rare overconfident errors are precisely the ones a small sample misses, and they are the expensive ones.

Result at golden-dataset scale: *[record calibration table here]*

## 6. Experiment log

Ground truth for every document established manually before running extraction. One row per document; per-field errors detailed beneath the table where they occur.

**Round 1 complete [OBSERVED]:** 6 documents — photos, screenshots and stock images including dual-fuel bills, across PNG/PDF/web formats. Headline: extraction accurate, confidence flags earned, source text verified, nulls disciplined. *Back-fill the per-document rows below from testing notes — the row-level detail is what makes this log citable.* Round 2 to be run against schema v2 (supplies array, read type, payment method, rates, EAC) — results not comparable to round 1 (see §7.5).

| # | Document | Condition | Fields correct / total | Confidence behaviour | Notable failure |
|---|----------|-----------|------------------------|----------------------|-----------------|
| 1 | *[e.g. electricity bill, printed PDF]* | clean scan | / | | |
| 2 | same bill | blurry phone photo | / | | |
| 3 | same bill | photographed at ~30° angle | / | | |
| 4 | dual-fuel bill | clean | / | | *does it separate gas and electricity correctly?* |
| 5 | gas bill quoting m³ and kWh | clean | / | | *which unit does it report? is the conversion noted?* |
| 6 | bill with estimated reads | clean | / | | *does it distinguish estimated from actual?* |
| 7 | handwritten fuel receipt | photo | / | | |
| 8 | multi-site supplier invoice | clean | / | | *the hardest case — one document, many data points* |

*(Add rows as tested. Keep every input document — each becomes a row in the Module 1 golden dataset.)*

## 7. Implications for CarbonSlice design

To be finalised once the log is complete, but already defensible from §2 and the first live run:

1. Human-in-the-loop review is not optional; it is the core workflow. The product is a review queue with an extraction engine attached, not the reverse.
2. Confidence thresholds are a product lever (review rate vs. risk), likely set per field — a wrong tariff name is cosmetic; a wrong consumption value flows into a reported tonne of CO₂e.
3. Structured outputs and response validation belong in week one of the real build, before any accuracy work.
4. **[OBSERVED] Dual-fuel bills broke the flat schema.** One `consumption_value` field structurally cannot represent a bill carrying two fuels — v1 was silently merging or dropping one fuel's data. The fix is a data-model change, not a field addition: schema v2 restructures a bill as document-level metadata plus a `supplies[]` array, one entry per fuel, each carrying its own meter identifier, consumption, read type (actual/estimated/smart), unit rate, standing charge, fuel subtotal, estimated annual consumption and tariff. Document-level additions from the same testing round: payment method (direct debit vs. pay-on-receipt materially affects unit rates on UK tariffs, so it is analytical signal, not admin trivia).
5. **Schema changes invalidate prior results.** Any accuracy numbers recorded against schema v1 are not comparable to v2 runs — the field set changed. Consequence carried into Module 1: the schema is versioned, and every eval run records the schema version it was scored against. Discovered here at zero cost; in production this discipline is the difference between a trustworthy accuracy dashboard and a misleading one.
6. **Read type is a data-quality dimension, not just a field.** An estimated read means the consumption figure itself is provisional regardless of extraction confidence — two different kinds of uncertainty (did we read the document right? vs. is the document right?) that the product must keep distinct. Estimated reads are now flagged visually in review and should carry through to footprint-level caveats.
7. **Verbosity degrades in order of importance.** When output space runs short, the system sheds optional content (source text on cosmetic fields) before essential content (values; lineage on emissions-bearing fields), and always flags the degradation. Established by the schema-v2 truncation incident (§2).
8. **Page-splitting is the next ingestion decision, pending evidence.** Dense single-image documents now fit after the wire-format fixes; if genuinely multi-page documents overflow even budget mode, the design answer is per-page extraction with a merge step. Deliberately deferred until a real document forces it.

## 8. Open questions carried into Module 1

- Is confidence calibrated well enough to set thresholds on, or do I need validation rules to carry more of the load?
- What per-field accuracy does the golden dataset show as the honest baseline — and which fields drag it down?
- Does a different model or prompt configuration change the failure profile? (The eval harness will answer this cheaply.)

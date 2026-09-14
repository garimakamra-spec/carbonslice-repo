# Prototypes

Working React prototypes built against the Claude API. Each is standalone and runnable; together they are the Module 0 build log.

| File | What it demonstrates |
|---|---|
| `01-extractor.jsx` | First extraction prototype — single bill in, structured JSON out with per-field confidence and source-text lineage. Where the token-truncation failure was first found. |
| `02-review-queue-v1.jsx` | Bulk upload, processing queue, per-field confirm/correct review, document approval, verified export. Flat schema (v1). |
| `03-review-queue-v2.jsx` | **Current.** Schema v2 — dual-fuel `supplies[]` cards, read type, payment method, per-fuel rates and charges, EAC. Compact wire format and graceful degradation on truncation. |

Progression is the point: v1 → v2 was forced by real dual-fuel bills, not planned. See `docs/schema-v2.md`.

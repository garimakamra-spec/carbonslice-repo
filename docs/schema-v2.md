# Schema v2 — canonical extraction model

**Status:** current · **Supersedes:** v1 · **Changed:** after dual-fuel testing, Module 0

## Why v1 broke

v1 was flat: one `consumption_value`, one `fuel_type`, one set of rates per document. That structure works for a single-fuel bill and is **structurally incapable** of representing a dual-fuel bill — two fuels, two meters, two consumption figures, two rate sets, two subtotals, one document. Testing on real dual-fuel bills exposed it immediately: the extraction wasn't wrong, the container was.

This is worth recording because it is the general case: real documents force data-model decisions that design sessions miss. The fix was not a field addition but a restructure.

## Structure

A document is **document-level metadata** plus a **`supplies[]` array** — one entry per fuel. A dual-fuel bill produces two supplies; a fuel receipt produces one; consumption, rates and charges never mix across fuels.

Every leaf field is an object:

```json
{ "value": <any|null>, "confidence": <0.0-1.0>, "source_text": <string|null> }
```

On the wire the model returns `{"v","c","t"}` to conserve output tokens; the application expands to the above immediately after parsing.

### `document`

| Field | Notes |
|---|---|
| `document_type` | `electricity_bill` · `gas_bill` · `dual_fuel_bill` · `fuel_receipt` · `supplier_invoice` · `other` |
| `supplier_name` | |
| `customer_name` | null on retail receipts |
| `site_address` | null on retail receipts |
| `account_number` | changes on supplier switch — a deliberate eval case |
| `billing_period_start` / `billing_period_end` | ISO dates; final bills carry truncated periods |
| `payment_method` | `direct_debit` · `pay_on_receipt` · `prepayment` · `cash_cheque` · `standing_order` · `other`. Materially affects UK tariff rates, so this is analytical signal, not admin trivia. |
| `total_cost_value` / `total_cost_currency` | |
| `vat_rate` | percent |

### `supplies[]` (one per fuel)

| Field | Notes |
|---|---|
| `fuel_type` | `electricity` · `natural_gas` · `petrol` · `diesel` · `lpg` · `other` |
| `meter_identifier` | MPAN (13-digit, electricity) or MPRN (6–10 digit, gas); null on receipts |
| `consumption_value` / `consumption_unit` | unit as printed; gas shown in m³ and kWh prefers kWh, conversion noted in `issues` |
| `read_type` | `actual` · `estimated` · `smart` · `customer` · `mixed` |
| `unit_rate` | as printed; day/night tariffs carry both |
| `standing_charge` | as printed |
| `charges_total` | this fuel's subtotal — the field that makes dual-fuel cost attribution possible |
| `estimated_annual_consumption` | printed on many bills; null elsewhere |
| `tariff_name` | changes on supplier switch |

Plus top-level `issues[]` and `overall_confidence`.

## Read type is not just a field

`read_type: estimated` means the **document itself** is provisional — the consumption figure is a supplier's guess regardless of how confidently it was extracted. Two distinct uncertainties:

- *Did we read the document correctly?* → extraction confidence
- *Is the document correct?* → read type

The product must keep these separate all the way through to footprint-level caveats. Collapsing them into one number would let an estimate masquerade as measured data.

## Versioning rule

**Accuracy results are only comparable within a schema version.** A schema change alters the field set, so prior eval numbers become invalid as a baseline. Every eval run records the schema version it scored against. Any future schema change requires a version bump, a note here, and a re-baseline.

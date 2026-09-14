# Golden Dataset Design — Halden Fabrications Ltd

**Project:** CarbonSlice · **Module:** 1 (golden dataset & eval harness) · **Schema under test:** v2 · **Status:** Design v1.0

> This dataset is a test suite, not sample data. Every document below exists to exercise a specific field or trigger a specific failure mode, and every figure is internally consistent (consumption × rate + standing charge ≈ subtotal; subtotals + CCL + VAT ≈ total), so cross-field validation rules can be tested against it. All names, meters, accounts and figures are fictional.

---

## 1. Design principles

1. **Coverage before volume.** Every schema v2 field and every known failure mode is exercised by at least one document (§7 proves it). Twenty well-designed documents beat eighty random ones.
2. **Internal arithmetic consistency.** Documents must add up, because the product's cross-field validation rules (the defence against confidently-wrong extractions identified in the Module 0 memo) can only be tested against data that adds up.
3. **Ground truth is hand-computed first.** No document is fabricated until its correct extraction values and emissions exist in the workbook. The workbook generates the bills, never the reverse.
4. **Everything is version-pinned.** The dataset records: schema version (v2), DEFRA factor set version and publication date, and CCL rates used — verified against current published rates at computation time, never from memory.
5. **Realistic difficulty, honestly labelled.** Documents are tiered: clean / degraded / hostile. Eval results will be reported per tier, because "94% accuracy" means nothing without knowing the mix.

## 2. The company

**Halden Fabrications Ltd** — precision sheet-metal fabrication. Founded 2011. 41 employees.

- **Site A (main works):** Unit 7, Deepmore Industrial Estate, Wolverhampton WV10 — 2,100 m² fabrication hall plus offices. Laser cutter, press brakes, MIG/TIG welding bays, powder-coating line with a **gas-fired curing oven**, gas space heating.
- **Site B (finishing & dispatch):** opened **January 2026** — Unit 3, Calder Park, Walsall WS2 — 640 m² warehouse with a small office. On a **dual-fuel contract** with a single supplier (this is what puts genuine dual-fuel bills in the dataset).
- **Vehicles:** three diesel vans (deliveries), one petrol car (sales), one **LPG forklift** (Site A).

Why a fabricator: energy-intensive enough for meaningful bills, gas + electricity + three transport fuels covers every `fuel_type` in schema v2, and the mid-year second site creates the supplier and multi-site complexity the dataset needs.

## 3. Reporting year and energy profile

**FY: 1 July 2025 – 30 June 2026.** Annual targets (finalised in the workbook, where arithmetic is enforced):

| Stream | Annual target | Shape |
|---|---|---|
| Electricity, Site A | ~112,000 kWh | Stable base (machinery) with modest summer dip |
| Gas, Site A | ~185,000 kWh | Heavily winter-weighted (heating) over a flat base (curing oven runs year-round) |
| Electricity, Site B (Jan–Jun) | ~14,500 kWh | Flat, small |
| Gas, Site B (Jan–Jun) | ~19,000 kWh | Winter-weighted, tapering to near-zero by June |
| Diesel (3 vans) | ~7,200 litres | Roughly even, slight December peak |
| Petrol (car) | ~1,400 litres | Even |
| LPG (forklift) | ~340 kg (cylinder deliveries) | Quarterly deliveries |

The winter-weighted gas shape is not decoration: it makes the estimated-read storyline (§4) *matter*, because the Q3 estimate lands on the highest-consumption months, so the March reconciliation produces a large, realistic correction.

## 4. The 12-month narrative (events that generate the traps)

**Jul–Dec 2025 — the stable half.** Site A only. Electricity from **Northgate Energy** (monthly bills, smart-metered actual reads, single rate, **pay on receipt** — exercises that payment-method variant). Gas from **Severn Gas Supply** (quarterly bills, manual reads, **direct debit**).

**December 2025 — the supplier switch begins.** Halden signs with **Brightcurrent Business Energy** for electricity. Northgate issues a **final bill** (period truncated at 19 Dec, closing actual read, account closure text — a known extraction trap: final bills carry odd period lengths and settlement lines).

**January 2026 — three things at once.**
- Brightcurrent's **opening bill**: new account number, new tariff, **day/night split rates** (two consumption lines for one fuel — tests whether extraction keeps registers straight), paid by **direct debit**.
- **Site B opens** on a dual-fuel contract with **Unify Utilities**: one bill, two supplies — the core dual-fuel test, monthly thereafter.
- Severn's winter quarter is running on **estimated reads** (nobody walked to the meter in December).

**March 2026 — the reconciliation.** Severn's Q3 bill (Dec–Feb) arrives fully **estimated**; an actual read in late March triggers a **reconciliation bill** correcting the winter estimate — one document containing both an estimated period and a correcting adjustment line. The single hardest gas document in the set.

**March 2026 — the dense document.** Brightcurrent's March bill runs to **4 pages**: half-hourly consumption summary, day/night breakdown, CCL line, VAT at 20%, a page of contract terms. This is the token-budget stressor — the successor to the truncation incidents in the Module 0 memo.

**Throughout — transport fuels.** Diesel receipts from two sources: **Roadway Fuels** (printed VAT receipts, clean) and **Millfield Service Station** (a small forecourt issuing **handwritten** receipts). Petrol receipts from a supermarket forecourt. **LPG cylinder invoices** from Caldon Gas Supplies, quarterly, priced per cylinder in kg (exercises non-kWh, non-litre quantities).

## 5. Entity bible (single source of truth for fabrication)

| Entity | Detail |
|---|---|
| Northgate Energy (elec, Site A, Jul–Dec) | Acct **NGE-447213** · MPAN **14 0812 3456 7890** · Tariff "Business Fixed 24" · single rate ~29.8 p/kWh · standing ~66 p/day · pay on receipt |
| Brightcurrent Business Energy (elec, Site A, from Jan) | Acct **BCB-90118-42** · same MPAN (meters don't change on switch — a deliberate check) · Tariff "FlexSecure Business v3" · day ~27.4 / night ~21.1 p/kWh · standing ~71 p/day · direct debit |
| Severn Gas Supply (gas, Site A) | Acct **SGS-2231907** · MPRN **88374412** · Tariff "SME Quarterly Standard" · ~7.2 p/kWh · standing ~89 p/day · direct debit · bills show m³ reads converted to kWh (calorific value + correction factor printed — the unit-conversion trap) |
| Unify Utilities (dual fuel, Site B, from Jan) | Acct **UU-3384726** · MPAN **14 0812 9876 543** · MPRN **88391265** · Tariff "Dual Advantage 12" · direct debit |
| Roadway Fuels / Millfield Service Station / Caldon Gas Supplies | Transport & LPG suppliers — receipts and invoices, no accounts |

All business bills carry **VAT at 20%** and a **Climate Change Levy** line on gas and electricity (rates verified at workbook time). Both are extraction content *and* validation anchors: subtotal + CCL + VAT must equal total.

## 6. Document inventory

**Core set — 24 documents** (fabricate first; the eval baseline runs on these):

| # | Document | Period | Tier | What it traps |
|---|---|---|---|---|
| 1–5 | Northgate elec bills | Jul–Nov | clean | baseline accuracy; pay-on-receipt; single rate |
| 6 | Northgate **final bill** | 1–19 Dec | clean | truncated period; closure/settlement lines; account end |
| 7 | Brightcurrent **opening bill** | 20 Dec–31 Jan | clean | new account + tariff; day/night dual rates for one fuel |
| 8–9 | Brightcurrent bills | Feb, Apr | clean | post-switch consistency |
| 10 | Brightcurrent **dense bill, 4pp** | Mar | hostile | token budget; HH summary; CCL; page-splitting decision |
| 11 | Severn gas Q1 | Jun–Aug | clean | quarterly period; m³→kWh conversion |
| 12 | Severn gas Q2 — **photographed skewed, low light** | Sep–Nov | degraded | poor-scan robustness on a real layout |
| 13 | Severn gas Q3 — **fully estimated reads** | Dec–Feb | clean | read_type=estimated on peak consumption |
| 14 | Severn **reconciliation bill** | Mar | hostile | estimate correction; negative adjustment line |
| 15 | Severn gas Q4 | Mar–May | clean | return to actual |
| 16–18 | Unify **dual-fuel bills** | Jan, Mar, Jun | clean | supplies[] separation; two meters one document; near-zero gas in Jun |
| 19–20 | Roadway diesel VAT receipts | Aug, Feb | clean | litres; fuel_type=diesel; VAT receipt layout |
| 21 | Millfield **handwritten** diesel receipt | Oct | hostile | handwriting; minimal structure |
| 22 | Roadway diesel receipt — **crumpled, blurry photo** | May | degraded | worst-case capture |
| 23 | Supermarket petrol receipt | Nov | clean | fuel_type=petrol |
| 24 | Caldon **LPG cylinder invoice** | Sep | clean | fuel_type=lpg; kg quantities; invoice-not-bill layout |

**Stretch set — +10** (after the baseline exists): remaining Brightcurrent and Unify months, remaining fuel receipts, second LPG invoice, and one **credit note** from Northgate (a February rebill correction — negative amounts, the nastiest arithmetic trap; deliberately deferred).

## 7. Coverage matrix (the proof)

**Every schema v2 field → exercised by:** document_type (all; five distinct types), supplier_name (five suppliers), customer_name/site_address (two sites — multi-site disambiguation via #16–18), account_number (**changes mid-year**: #6→#7), billing_period (monthly, quarterly, truncated #6, cross-month #7), payment_method (pay-on-receipt #1–6, direct debit #7+, none on receipts — null discipline), total_cost/VAT (all bills; VAT absent on handwritten #21), fuel_type (electricity, natural_gas, diesel, petrol, lpg), meter_identifier (MPAN #1–10, MPRN #11–15, both at once #16–18, none on receipts), consumption_value/unit (kWh, litres, kg, m³-converted #11–15), read_type (actual, **estimated #13**, mixed #14, smart #7+), unit_rate (single, **day/night pair #7+**), standing_charge (three suppliers' formats), charges_total (per-fuel subtotals #16–18), EAC (printed on #7+ and #16–18, absent elsewhere — null discipline), tariff_name (four tariffs, **changes at #7**).

**Every failure mode → triggered by:** dual-fuel merging (#16–18), estimated reads (#13–14), supplier switch (#6–7), payment variants (#1–6 vs #7+), token overflow (#10), poor scans (#12, #22), handwriting (#21), unit confusion (#11–15 m³/kWh, #24 kg), truncated periods (#6), correction arithmetic (#14, stretch credit note), plausible-value hallucination bait (receipts lacking most bill fields — the strongest null-discipline test).

## 8. Ground truth workbook (built before any document)

One row per document per field: document #, field path (schema v2), correct value, match rule for the eval harness (**exact** for identifiers/enums; **tolerance** ±0.5% for consumption, ±£0.01 for money; **normalised** for dates/units), tier, and notes. Plus an emissions sheet: per document, activity data × pinned DEFRA factor = kgCO₂e, with factor version, factor value and source row recorded — the lineage standard the product itself must meet. Natural home: Excel, built with Claude in Excel; it doubles as the harness's answer key (export to CSV/JSON).

## 9. Fabrication method

Documents are generated, not drawn: an HTML/CSS template per supplier layout, filled from the workbook, rendered to PDF — a perfect Claude Code task (and the repo's first real feature: `make dataset` regenerates every document from ground truth, so a workbook correction reflows the whole set). Degraded tier: print, photograph badly, crumple #22 by hand. Handwritten #21: actually handwrite it. Hostile realism cannot be CSS'd.

## 10. Definition of done

Module 1 dataset is done when: the workbook contains hand-computed ground truth and emissions for all 24 core documents with versions pinned; all 24 documents exist and their arithmetic reconciles to the workbook; the coverage matrix in §7 has no unexercised field or failure mode; and the eval harness produces its first per-field, per-tier accuracy table — **the honest ugly baseline, preserved forever.**

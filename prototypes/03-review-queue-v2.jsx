import { useState, useRef } from "react";

// ---------------------------------------------------------------
// CarbonSlice — review queue, schema v2
// Document-level fields + supplies[] (dual-fuel aware), read types,
// per-fuel rates & charges, payment method, EAC
// ---------------------------------------------------------------

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
`;

const T = {
  ink: "#17251F", inkSoft: "#43554C", paper: "#F2F4EF", card: "#FFFFFF",
  line: "#D8DED4", carbon: "#1E3A2F", current: "#0E7C5B", flame: "#B4560F",
  fail: "#A3252A", chip: "#E8EDE6", blue: "#1F5FA8",
};

const SCHEMA_VERSION = "v2";

const EXTRACTION_PROMPT = `You are the extraction engine for CarbonSlice, a UK carbon-accounting product. You will be given a scanned or photographed UK utility bill, fuel receipt, or supplier energy invoice.

Extract into JSON with this structure. Every leaf field is an object {"v": value, "c": confidence 0.0-1.0, "t": source_text} — v is null if absent/illegible (never guess; fabrication is failure), t is the exact document text v came from (null whenever v is null).

{
 "document": {
   "document_type": one of "electricity_bill","gas_bill","dual_fuel_bill","fuel_receipt","supplier_invoice","other",
   "supplier_name", "customer_name", "site_address", "account_number",
   "billing_period_start" (ISO date), "billing_period_end" (ISO date),
   "payment_method": one of "direct_debit","pay_on_receipt","prepayment","cash_cheque","standing_order","other",
   "total_cost_value" (number), "total_cost_currency", "vat_rate" (number, percent)
 },
 "supplies": [ one entry PER FUEL on the bill — a dual-fuel bill MUST have two entries, one electricity and one gas, with consumption, rates and charges kept strictly separate per fuel:
   {
     "fuel_type": "electricity"|"natural_gas"|"petrol"|"diesel"|"lpg"|"other",
     "meter_identifier": MPAN (13-digit, electricity) or MPRN (6-10 digit, gas),
     "consumption_value" (number), "consumption_unit" (as printed; if gas shows m3 and kWh prefer kWh, note conversion in issues),
     "read_type": "actual"|"estimated"|"smart"|"customer"|"mixed",
     "unit_rate": string as printed e.g. "27.45 p/kWh",
     "standing_charge": string as printed e.g. "53.35 p/day",
     "charges_total": number — this fuel's subtotal,
     "estimated_annual_consumption": string with unit e.g. "3,100 kWh",
     "tariff_name"
   }
 ],
 "issues": array of strings,
 "overall_confidence": 0.0-1.0
}

Output rules (strict): respond ONLY with MINIFIED single-line JSON — no fences, no preamble, no spaces after colons or commas. Every t at most 5 words. At most 3 issues, each under 10 words.`;

const LEAN_SUFFIX = `

BUDGET MODE — output space is critically limited: set "t" to null for ALL fields EXCEPT meter_identifier, consumption_value, charges_total and total_cost_value (keep t for those four, max 4 words). At most 2 issues.`;

const DOC_FIELDS = [
  ["document_type", "Document type"],
  ["supplier_name", "Supplier"],
  ["customer_name", "Customer"],
  ["site_address", "Site address"],
  ["account_number", "Account no."],
  ["billing_period_start", "Period start"],
  ["billing_period_end", "Period end"],
  ["payment_method", "Payment method"],
  ["total_cost_value", "Total cost"],
  ["total_cost_currency", "Currency"],
  ["vat_rate", "VAT %"],
];

const SUP_FIELDS = [
  ["fuel_type", "Fuel"],
  ["meter_identifier", "MPAN / MPRN"],
  ["consumption_value", "Consumption"],
  ["consumption_unit", "Unit"],
  ["read_type", "Read type"],
  ["unit_rate", "Unit rate"],
  ["standing_charge", "Standing charge"],
  ["charges_total", "Fuel subtotal"],
  ["estimated_annual_consumption", "Est. annual use"],
  ["tariff_name", "Tariff"],
];

const FUEL_ICON = { electricity: "⚡", natural_gas: "🔥", petrol: "⛽", diesel: "⛽", lpg: "🔥" };

function confColor(c) {
  if (c == null) return T.line;
  if (c >= 0.85) return T.current;
  if (c >= 0.6) return T.flame;
  return T.fail;
}

function Gauge({ c }) {
  const pct = c == null ? 0 : Math.round(c * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 92 }}>
      <div style={{ flex: 1, height: 5, background: T.chip, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: confColor(c) }} />
      </div>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: confColor(c), width: 38, fontWeight: 600 }}>
        {c == null ? "—" : `${pct}%`}
      </span>
    </div>
  );
}

function StatusChip({ status, count }) {
  const map = {
    queued: { bg: T.chip, fg: T.inkSoft, label: "queued" },
    extracting: { bg: "#E3ECF7", fg: T.blue, label: "extracting…" },
    needs_review: { bg: "#FBF3E8", fg: T.flame, label: `review (${count})` },
    clear: { bg: "#E6F2ED", fg: T.current, label: "clear" },
    approved: { bg: T.carbon, fg: "#fff", label: "approved ✓" },
    error: { bg: "#FBEBEC", fg: T.fail, label: "failed" },
  };
  const s = map[status] || map.queued;
  return (
    <span style={{ background: s.bg, color: s.fg, borderRadius: 999, padding: "3px 10px", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

// path helpers: "d:<key>" for document fields, "s:<i>:<key>" for supply fields
const getFieldByPath = (result, path) => {
  const p = path.split(":");
  if (p[0] === "d") return result?.document?.[p[1]];
  return result?.supplies?.[Number(p[1])]?.[p[2]];
};

// wire format {v,c,t} → domain model {value, confidence, source_text}
const expandField = (f) =>
  f && typeof f === "object" && ("v" in f || "c" in f || "t" in f)
    ? { value: f.v ?? null, confidence: f.c ?? null, source_text: f.t ?? null }
    : f;
const expandResult = (parsed) => {
  const out = {
    document: {},
    supplies: [],
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    overall_confidence: parsed.overall_confidence ?? null,
  };
  for (const [k, val] of Object.entries(parsed.document || {})) out.document[k] = expandField(val);
  for (const s of parsed.supplies || []) {
    const e = {};
    for (const [k, val] of Object.entries(s || {})) e[k] = expandField(val);
    out.supplies.push(e);
  }
  return out;
};
const allPaths = (result) => {
  const paths = [];
  for (const [k] of DOC_FIELDS) if (result?.document?.[k]) paths.push(`d:${k}`);
  (result?.supplies || []).forEach((s, i) => {
    for (const [k] of SUP_FIELDS) if (s?.[k]) paths.push(`s:${i}:${k}`);
  });
  return paths;
};

let nextId = 1;

export default function CarbonSliceReviewQueueV2() {
  const [docs, setDocs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [threshold, setThreshold] = useState(0.85);
  const [editing, setEditing] = useState(null); // {docId, path, draft}
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);

  const updateDoc = (id, patch) =>
    setDocs(prev => prev.map(d => (d.id === id ? { ...d, ...(typeof patch === "function" ? patch(d) : patch) } : d)));

  const pathNeedsReview = (doc, path) => {
    const f = getFieldByPath(doc.result, path);
    if (!f) return false;
    if (doc.overrides?.[path]) return false;
    return f.confidence == null || f.confidence < threshold;
  };
  const pendingCount = (doc) => (doc.result ? allPaths(doc.result).filter(p => pathNeedsReview(doc, p)).length : 0);
  const docStatus = (doc) => {
    if (doc.status === "error" || doc.status === "extracting" || doc.status === "queued") return doc.status;
    if (doc.approved) return "approved";
    return pendingCount(doc) > 0 ? "needs_review" : "clear";
  };

  const onFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(f =>
      ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(f.type)
    );
    if (!files.length) return;
    const newDocs = [];
    for (const f of files) {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(new Error("read failed"));
        r.readAsDataURL(f);
      });
      newDocs.push({
        id: nextId++, name: f.name, mediaType: f.type, base64,
        status: "queued", result: null, overrides: {}, approved: false, error: null,
      });
    }
    setDocs(prev => [...prev, ...newDocs]);
    if (!selectedId && newDocs.length) setSelectedId(newDocs[0].id);
    processQueue(newDocs);
  };

  const callExtraction = async (doc, lean) => {
    const block = doc.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.base64 } }
      : { type: "image", source: { type: "base64", media_type: doc.mediaType, data: doc.base64 } };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: [block, { type: "text", text: EXTRACTION_PROMPT + (lean ? LEAN_SUFFIX : "") }] }],
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || "API error");

    const truncated = data.stop_reason === "max_tokens";
    const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const clean = text.replace(/```json|```/g, "").trim();

    let parsed = null;
    try { parsed = JSON.parse(clean); } catch { /* unparseable — caller decides */ }
    return { parsed, truncated };
  };

  const processQueue = async (queue) => {
    for (const doc of queue) {
      updateDoc(doc.id, { status: "extracting" });
      try {
        // attempt 1: full lineage
        let { parsed, truncated } = await callExtraction(doc, false);
        let leanUsed = false;

        // attempt 2: if the output was cut off (parseable or not), retry in budget mode
        if (truncated) {
          const retry = await callExtraction(doc, true);
          if (retry.parsed) { parsed = retry.parsed; truncated = retry.truncated; leanUsed = true; }
        }

        if (!parsed) {
          throw new Error(truncated
            ? "Output exceeded the token budget even in budget mode — likely a very dense multi-page document. Try cropping to the summary page."
            : "Model returned invalid JSON.");
        }

        const result = expandResult(parsed);
        if (leanUsed) result.issues = [...result.issues, "Dense document: source-text lineage limited to key fields."];
        if (truncated) result.issues = [...result.issues, "Token limit reached — some fields may be missing."];

        updateDoc(doc.id, { status: "done", result });
      } catch (e) {
        updateDoc(doc.id, { status: "error", error: e.message });
      }
    }
  };

  const confirmField = (docId, path) =>
    updateDoc(docId, d => ({ overrides: { ...d.overrides, [path]: { action: "human_confirmed", at: new Date().toISOString() } } }));

  const correctField = (docId, path, newValue) =>
    updateDoc(docId, d => ({
      overrides: {
        ...d.overrides,
        [path]: {
          action: "human_corrected", value: newValue,
          original_model_value: getFieldByPath(d.result, path)?.value ?? null,
          at: new Date().toISOString(),
        },
      },
    }));

  const reopenField = (docId, path) =>
    updateDoc(docId, d => { const o = { ...d.overrides }; delete o[path]; return { overrides: o, approved: false }; });

  const approveDoc = (docId) => updateDoc(docId, { approved: true });

  const verifiedField = (doc, path) => {
    const f = getFieldByPath(doc.result, path);
    if (!f) return null;
    const o = doc.overrides?.[path];
    return {
      value: o?.action === "human_corrected" ? o.value : f.value,
      model_confidence: f.confidence ?? null,
      source_text: f.source_text ?? null,
      verification: o ? o.action : (f.confidence != null && f.confidence >= threshold ? "auto_accepted" : "unresolved"),
      ...(o?.action === "human_corrected" ? { original_model_value: o.original_model_value, corrected_at: o.at } : {}),
      ...(o?.action === "human_confirmed" ? { confirmed_at: o.at } : {}),
    };
  };

  const buildVerifiedRecord = (doc) => {
    const rec = { document_file: doc.name, schema_version: SCHEMA_VERSION, review_threshold: threshold, approved: doc.approved, document: {}, supplies: [] };
    for (const [k] of DOC_FIELDS) { const v = verifiedField(doc, `d:${k}`); if (v) rec.document[k] = v; }
    (doc.result?.supplies || []).forEach((s, i) => {
      const sup = {};
      for (const [k] of SUP_FIELDS) { const v = verifiedField(doc, `s:${i}:${k}`); if (v) sup[k] = v; }
      rec.supplies.push(sup);
    });
    rec.issues = doc.result?.issues || [];
    return rec;
  };

  const exportApproved = async () => {
    const records = docs.filter(d => d.approved).map(buildVerifiedRecord);
    const json = JSON.stringify(records, null, 2);
    try {
      const ta = document.createElement("textarea");
      ta.value = json; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      setCopied(true); setTimeout(() => setCopied(false), 1600);
    } catch { /* no-op */ }
  };

  // metrics
  const doneDocs = docs.filter(d => d.result);
  const totalFields = doneDocs.reduce((n, d) => n + allPaths(d.result).length, 0);
  const flaggedFields = doneDocs.reduce((n, d) =>
    n + allPaths(d.result).filter(p => {
      const f = getFieldByPath(d.result, p);
      return f && (f.confidence == null || f.confidence < threshold);
    }).length, 0);
  const reviewRate = totalFields ? Math.round((flaggedFields / totalFields) * 100) : null;
  const approvedCount = docs.filter(d => d.approved).length;
  const selected = docs.find(d => d.id === selectedId) || null;

  const FieldRow = ({ doc, path, label }) => {
    const f = getFieldByPath(doc.result, path);
    if (!f) return null;
    const o = doc.overrides?.[path];
    const needs = pathNeedsReview(doc, path);
    const isEditing = editing && editing.docId === doc.id && editing.path === path;
    const displayValue = o?.action === "human_corrected" ? o.value : f.value;
    const isEstimated = path.endsWith(":read_type") && String(displayValue).toLowerCase() === "estimated";

    return (
      <div style={{
        display: "grid", gridTemplateColumns: "118px 1fr 104px 150px", gap: 10,
        padding: "9px 16px", borderBottom: `1px solid ${T.paper}`, alignItems: "center",
        background: needs ? "#FDF8F0" : "transparent",
      }}>
        <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500 }}>{label}</div>
        <div style={{ minWidth: 0 }}>
          {isEditing ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                autoFocus value={editing.draft}
                onChange={e => setEditing({ ...editing, draft: e.target.value })}
                onKeyDown={e => {
                  if (e.key === "Enter") { correctField(doc.id, path, editing.draft); setEditing(null); }
                  if (e.key === "Escape") setEditing(null);
                }}
                style={{ flex: 1, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, padding: "5px 8px", border: `1.5px solid ${T.blue}`, borderRadius: 6 }}
              />
              <button onClick={() => { correctField(doc.id, path, editing.draft); setEditing(null); }} style={{ border: "none", background: T.current, color: "#fff", borderRadius: 6, padding: "0 10px", fontSize: 12, cursor: "pointer" }}>save</button>
              <button onClick={() => setEditing(null)} style={{ border: `1px solid ${T.line}`, background: "transparent", borderRadius: 6, padding: "0 8px", fontSize: 12, cursor: "pointer" }}>esc</button>
            </div>
          ) : (
            <>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, color: displayValue == null ? T.line : (isEstimated ? T.flame : T.ink) }}>
                {displayValue == null ? "not found" : String(displayValue)}
                {isEstimated && <span style={{ marginLeft: 6, fontSize: 11 }} title="Estimated read — actual consumption may differ">⚠</span>}
                {o?.action === "human_corrected" && (
                  <span style={{ marginLeft: 8, color: T.inkSoft, fontWeight: 400, textDecoration: "line-through", fontSize: 12 }}>
                    {o.original_model_value == null ? "null" : String(o.original_model_value)}
                  </span>
                )}
              </div>
              {f.source_text && <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 1 }}>⌕ “{f.source_text}”</div>}
            </>
          )}
        </div>
        <Gauge c={f.confidence} />
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
          {needs && !isEditing && (
            <>
              <button onClick={() => confirmField(doc.id, path)} style={{ border: `1px solid ${T.current}`, color: T.current, background: "transparent", borderRadius: 6, padding: "4px 9px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>✓ confirm</button>
              <button onClick={() => setEditing({ docId: doc.id, path, draft: f.value == null ? "" : String(f.value) })} style={{ border: `1px solid ${T.blue}`, color: T.blue, background: "transparent", borderRadius: 6, padding: "4px 9px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>✎ correct</button>
            </>
          )}
          {o && !isEditing && (
            <button onClick={() => reopenField(doc.id, path)} style={{ border: "none", background: "transparent", color: o.action === "human_corrected" ? T.blue : T.current, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, cursor: "pointer" }}>
              {o.action === "human_corrected" ? "corrected ↺" : "confirmed ↺"}
            </button>
          )}
          {!needs && !o && <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: T.inkSoft }}>auto</span>}
        </div>
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: T.paper, color: T.ink, fontFamily: "'Inter', sans-serif" }}>
      <style>{FONT_CSS}</style>

      <header style={{ background: T.carbon, color: "#EDF3EE", padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em" }}>
            CarbonSlice<span style={{ color: "#7FC8A9" }}> /review</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, marginLeft: 10, background: "#274A3C", padding: "3px 8px", borderRadius: 999, verticalAlign: "middle" }}>schema {SCHEMA_VERSION}</span>
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, opacity: 0.75, marginTop: 3 }}>
            dual-fuel supplies · read types · per-fuel rates & charges · payment method · EAC
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          {reviewRate != null && (
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, textAlign: "right" }}>
              <div style={{ opacity: 0.7 }}>review rate</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: reviewRate > 25 ? "#F2B270" : "#7FC8A9" }}>{reviewRate}%</div>
            </div>
          )}
          <label style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ opacity: 0.7 }}>review threshold</span>
            <select value={threshold} onChange={e => setThreshold(Number(e.target.value))}
              style={{ background: "#274A3C", color: "#EDF3EE", border: "1px solid #3C6553", borderRadius: 6, padding: "4px 8px", fontFamily: "inherit", fontSize: 12 }}>
              <option value={0.7}>0.70 — lean</option>
              <option value={0.85}>0.85 — balanced</option>
              <option value={0.95}>0.95 — cautious</option>
            </select>
          </label>
        </div>
      </header>

      <main className="cs-main" style={{ maxWidth: 1100, margin: "0 auto", padding: "22px 18px 60px", display: "grid", gridTemplateColumns: "minmax(280px, 370px) 1fr", gap: 20 }}>

        {/* LEFT: queue */}
        <section>
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); onFiles(e.dataTransfer.files); }}
            style={{ border: `2px dashed ${T.line}`, borderRadius: 10, background: T.card, padding: 16, textAlign: "center", cursor: "pointer" }}
          >
            <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 15 }}>Drop bills here — batches welcome</div>
            <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 4 }}>Photos, screenshots, scans, PDFs. Dual-fuel bills split into separate supplies automatically.</div>
          </div>
          <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" style={{ display: "none" }} onChange={e => { onFiles(e.target.files); e.target.value = ""; }} />

          {docs.length > 0 && (
            <div style={{ marginTop: 14, border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 13 }}>Queue · {docs.length}</span>
                <button onClick={exportApproved} disabled={!approvedCount}
                  style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: approvedCount ? T.carbon : T.line, color: "#fff", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", cursor: approvedCount ? "pointer" : "default" }}>
                  {copied ? "copied ✓" : `export ${approvedCount} approved`}
                </button>
              </div>
              {docs.slice().sort((a, b) => {
                const rank = s => ({ needs_review: 0, clear: 1, extracting: 2, queued: 3, error: 4, approved: 5 }[s] ?? 6);
                return rank(docStatus(a)) - rank(docStatus(b));
              }).map(d => {
                const st = docStatus(d);
                const supplySummary = (d.result?.supplies || [])
                  .map(s => `${FUEL_ICON[s.fuel_type?.value] || ""}${s.consumption_value?.value ?? "?"} ${s.consumption_unit?.value || ""}`)
                  .join(" · ");
                return (
                  <div key={d.id} onClick={() => setSelectedId(d.id)}
                    style={{ padding: "10px 14px", borderBottom: `1px solid ${T.paper}`, cursor: "pointer", background: d.id === selectedId ? "#EDF2EA" : "transparent", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: T.inkSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {supplySummary || "—"}
                      </div>
                    </div>
                    <StatusChip status={st} count={pendingCount(d)} />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* RIGHT: review panel */}
        <section>
          {!selected && (
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, padding: 26, color: T.inkSoft, fontSize: 14, lineHeight: 1.6 }}>
              Schema v2: each bill is document-level metadata plus one card per fuel supply. A dual-fuel bill produces two supply cards — electricity and gas consumption, rates and charges never mix. Estimated reads are marked ⚠ wherever they appear.
            </div>
          )}

          {selected && selected.status === "error" && (
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: "#FBEBEC", padding: 20, color: T.fail, fontSize: 13 }}>
              {selected.name}: {selected.error}
            </div>
          )}

          {selected && (selected.status === "queued" || selected.status === "extracting") && (
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, padding: 24, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: T.inkSoft }}>
              {selected.status === "queued" ? "waiting in queue…" : "extracting fields…"}
            </div>
          )}

          {selected && selected.result && (
            <>
              {/* Document card */}
              <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, overflow: "hidden", marginBottom: 16 }}>
                <div style={{ padding: "13px 16px", borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 15, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{selected.name}</div>
                  {docStatus(selected) === "approved" ? (
                    <StatusChip status="approved" />
                  ) : (
                    <button onClick={() => approveDoc(selected.id)} disabled={pendingCount(selected) > 0}
                      style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: pendingCount(selected) > 0 ? T.line : T.current, color: "#fff", fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 13, cursor: pendingCount(selected) > 0 ? "default" : "pointer" }}>
                      {pendingCount(selected) > 0 ? `${pendingCount(selected)} to resolve` : "Approve document"}
                    </button>
                  )}
                </div>
                <div style={{ padding: "7px 16px", background: T.chip, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: T.inkSoft }}>DOCUMENT</div>
                {DOC_FIELDS.map(([k, label]) => <FieldRow key={k} doc={selected} path={`d:${k}`} label={label} />)}
              </div>

              {/* Supply cards */}
              {(selected.result.supplies || []).map((s, i) => (
                <div key={i} style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, overflow: "hidden", marginBottom: 16 }}>
                  <div style={{ padding: "9px 16px", background: s.fuel_type?.value === "natural_gas" ? "#F7EDE2" : "#E6F2ED", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, fontWeight: 600, color: s.fuel_type?.value === "natural_gas" ? T.flame : T.current }}>
                    SUPPLY {i + 1} · {FUEL_ICON[s.fuel_type?.value] || ""} {(s.fuel_type?.value || "unknown").replace("_", " ").toUpperCase()}
                  </div>
                  {SUP_FIELDS.map(([k, label]) => <FieldRow key={k} doc={selected} path={`s:${i}:${k}`} label={label} />)}
                </div>
              ))}

              {Array.isArray(selected.result.issues) && selected.result.issues.length > 0 && (
                <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, padding: "12px 16px" }}>
                  <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500, marginBottom: 5 }}>Issues flagged by the model</div>
                  {selected.result.issues.map((iss, i) => (
                    <div key={i} style={{ fontSize: 13, color: T.flame, padding: "2px 0" }}>• {iss}</div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <style>{`
        @media (max-width: 840px) { .cs-main { grid-template-columns: 1fr !important; } }
        button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid ${T.current}; outline-offset: 2px; }
      `}</style>
    </div>
  );
}

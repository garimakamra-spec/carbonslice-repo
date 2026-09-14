import { useState, useRef } from "react";

// ---------------------------------------------------------------
// CarbonSlice — Module 2 prototype
// Bulk ingestion → extraction queue → human review → verified data
// ---------------------------------------------------------------

const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
`;

const T = {
  ink: "#17251F",
  inkSoft: "#43554C",
  paper: "#F2F4EF",
  card: "#FFFFFF",
  line: "#D8DED4",
  carbon: "#1E3A2F",
  current: "#0E7C5B",
  flame: "#B4560F",
  fail: "#A3252A",
  chip: "#E8EDE6",
  blue: "#1F5FA8",
};

const EXTRACTION_PROMPT = `You are the extraction engine for CarbonSlice, a UK carbon-accounting product. You will be given a scanned or photographed UK utility bill, fuel receipt, or supplier energy invoice.

Extract the following into JSON. For EVERY field provide: "value" (null if not present/legible), "confidence" (0.0-1.0, your honest confidence that the value is correct), and "source_text" (the exact text on the document you derived it from, or null). Never guess values that are not on the document — a null with low confidence is correct behaviour; a fabricated value is a failure.

Fields:
- document_type: one of "electricity_bill", "gas_bill", "dual_fuel_bill", "fuel_receipt", "supplier_invoice", "other"
- supplier_name
- customer_name
- site_address
- account_number
- mpan: 13-digit electricity Meter Point Administration Number
- mprn: gas Meter Point Reference Number (6-10 digits)
- fuel_type: "electricity", "natural_gas", "petrol", "diesel", "lpg", "other"
- billing_period_start: ISO date
- billing_period_end: ISO date
- consumption_value: number
- consumption_unit: unit AS PRINTED (kWh, litres, m3); if gas shows both m3 and kWh, prefer kWh and note conversion in issues
- total_cost_value: number
- total_cost_currency: e.g. "GBP"
- vat_rate: number (percent)
- tariff_name

Also return:
- issues: array of strings
- overall_confidence: 0.0-1.0

Output rules (strict): respond ONLY with MINIFIED single-line JSON, no fences, no preamble. Every source_text at most 8 words. At most 5 issues, each under 12 words.`;

const FIELD_ORDER = [
  ["document_type", "Document type"],
  ["supplier_name", "Supplier"],
  ["customer_name", "Customer"],
  ["site_address", "Site address"],
  ["account_number", "Account no."],
  ["mpan", "MPAN"],
  ["mprn", "MPRN"],
  ["fuel_type", "Fuel type"],
  ["billing_period_start", "Period start"],
  ["billing_period_end", "Period end"],
  ["consumption_value", "Consumption"],
  ["consumption_unit", "Unit"],
  ["total_cost_value", "Total cost"],
  ["total_cost_currency", "Currency"],
  ["vat_rate", "VAT %"],
  ["tariff_name", "Tariff"],
];

function confColor(c) {
  if (c == null) return T.line;
  if (c >= 0.85) return T.current;
  if (c >= 0.6) return T.flame;
  return T.fail;
}

function Gauge({ c }) {
  const pct = c == null ? 0 : Math.round(c * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 96 }}>
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
    queued:       { bg: T.chip,      fg: T.inkSoft, label: "queued" },
    extracting:   { bg: "#E3ECF7",   fg: T.blue,    label: "extracting…" },
    needs_review: { bg: "#FBF3E8",   fg: T.flame,   label: `review (${count})` },
    clear:        { bg: "#E6F2ED",   fg: T.current, label: "clear" },
    approved:     { bg: T.carbon,    fg: "#fff",    label: "approved ✓" },
    error:        { bg: "#FBEBEC",   fg: T.fail,    label: "failed" },
  };
  const s = map[status] || map.queued;
  return (
    <span style={{ background: s.bg, color: s.fg, borderRadius: 999, padding: "3px 10px", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

let nextId = 1;

export default function CarbonSliceReviewQueue() {
  const [docs, setDocs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [threshold, setThreshold] = useState(0.85);
  const [editing, setEditing] = useState(null); // {docId, field, draft}
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);

  const updateDoc = (id, patch) =>
    setDocs(prev => prev.map(d => (d.id === id ? { ...d, ...(typeof patch === "function" ? patch(d) : patch) } : d)));

  // ---- field helpers -------------------------------------------------
  const fieldNeedsReview = (doc, key) => {
    const f = doc.result?.[key];
    if (!f) return false;
    if (doc.overrides?.[key]) return false; // already resolved by a human
    return f.confidence == null || f.confidence < threshold;
  };
  const pendingCount = (doc) =>
    doc.result ? FIELD_ORDER.filter(([k]) => fieldNeedsReview(doc, k)).length : 0;
  const docStatus = (doc) => {
    if (doc.status === "error" || doc.status === "extracting" || doc.status === "queued") return doc.status;
    if (doc.approved) return "approved";
    return pendingCount(doc) > 0 ? "needs_review" : "clear";
  };

  // ---- ingestion -----------------------------------------------------
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
        id: nextId++,
        name: f.name,
        mediaType: f.type,
        base64,
        status: "queued",
        result: null,
        overrides: {},
        approved: false,
        error: null,
      });
    }
    setDocs(prev => [...prev, ...newDocs]);
    if (!selectedId && newDocs.length) setSelectedId(newDocs[0].id);
    processQueue(newDocs);
  };

  // ---- extraction pipeline (sequential to respect rate limits) -------
  const processQueue = async (queue) => {
    for (const doc of queue) {
      updateDoc(doc.id, { status: "extracting" });
      try {
        const block = doc.mediaType === "application/pdf"
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: doc.base64 } }
          : { type: "image", source: { type: "base64", media_type: doc.mediaType, data: doc.base64 } };

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1000,
            messages: [{ role: "user", content: [block, { type: "text", text: EXTRACTION_PROMPT }] }],
          }),
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error.message || "API error");

        const truncated = data.stop_reason === "max_tokens";
        const text = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        const clean = text.replace(/```json|```/g, "").trim();

        let parsed;
        try {
          parsed = JSON.parse(clean);
        } catch (pe) {
          throw new Error(truncated
            ? "Output hit the token limit and was cut off mid-JSON."
            : "Model returned invalid JSON: " + pe.message);
        }
        if (truncated) parsed.issues = [...(parsed.issues || []), "Token limit reached — some fields may be missing."];

        updateDoc(doc.id, { status: "done", result: parsed });
      } catch (e) {
        updateDoc(doc.id, { status: "error", error: e.message });
      }
    }
  };

  // ---- review actions ------------------------------------------------
  const confirmField = (docId, key) =>
    updateDoc(docId, d => ({
      overrides: { ...d.overrides, [key]: { action: "human_confirmed", at: new Date().toISOString() } },
    }));

  const correctField = (docId, key, newValue) =>
    updateDoc(docId, d => ({
      overrides: {
        ...d.overrides,
        [key]: {
          action: "human_corrected",
          value: newValue,
          original_model_value: d.result?.[key]?.value ?? null,
          at: new Date().toISOString(),
        },
      },
    }));

  const reopenField = (docId, key) =>
    updateDoc(docId, d => {
      const o = { ...d.overrides }; delete o[key];
      return { overrides: o, approved: false };
    });

  const approveDoc = (docId) => updateDoc(docId, { approved: true });

  // ---- export --------------------------------------------------------
  const buildVerifiedRecord = (doc) => {
    const out = { document: doc.name, review_threshold: threshold, approved: doc.approved, fields: {} };
    for (const [key] of FIELD_ORDER) {
      const f = doc.result?.[key];
      if (!f) continue;
      const o = doc.overrides?.[key];
      out.fields[key] = {
        value: o?.action === "human_corrected" ? o.value : f.value,
        model_confidence: f.confidence ?? null,
        source_text: f.source_text ?? null,
        verification: o ? o.action : (f.confidence != null && f.confidence >= threshold ? "auto_accepted" : "unresolved"),
        ...(o?.action === "human_corrected" ? { original_model_value: o.original_model_value, corrected_at: o.at } : {}),
        ...(o?.action === "human_confirmed" ? { confirmed_at: o.at } : {}),
      };
    }
    out.issues = doc.result?.issues || [];
    return out;
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

  // ---- metrics -------------------------------------------------------
  const doneDocs = docs.filter(d => d.result);
  const totalFields = doneDocs.reduce((n, d) => n + FIELD_ORDER.filter(([k]) => d.result[k]).length, 0);
  const flaggedFields = doneDocs.reduce((n, d) =>
    n + FIELD_ORDER.filter(([k]) => {
      const f = d.result[k];
      return f && (f.confidence == null || f.confidence < threshold);
    }).length, 0);
  const reviewRate = totalFields ? Math.round((flaggedFields / totalFields) * 100) : null;
  const approvedCount = docs.filter(d => d.approved).length;

  const selected = docs.find(d => d.id === selectedId) || null;

  // ---- render --------------------------------------------------------
  return (
    <div style={{ minHeight: "100vh", background: T.paper, color: T.ink, fontFamily: "'Inter', sans-serif" }}>
      <style>{FONT_CSS}</style>

      <header style={{ background: T.carbon, color: "#EDF3EE", padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em" }}>
            CarbonSlice<span style={{ color: "#7FC8A9" }}> /review</span>
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, opacity: 0.75, marginTop: 3 }}>
            module 2 · bulk ingestion → extraction → human review → verified data
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
            <select
              value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              style={{ background: "#274A3C", color: "#EDF3EE", border: "1px solid #3C6553", borderRadius: 6, padding: "4px 8px", fontFamily: "inherit", fontSize: 12 }}
            >
              <option value={0.7}>0.70 — lean (less review, more risk)</option>
              <option value={0.85}>0.85 — balanced</option>
              <option value={0.95}>0.95 — cautious (more review)</option>
            </select>
          </label>
        </div>
      </header>

      <main style={{ maxWidth: 1080, margin: "0 auto", padding: "22px 18px 60px", display: "grid", gridTemplateColumns: "minmax(280px, 380px) 1fr", gap: 20 }} className="cs-main">

        {/* LEFT: queue */}
        <section>
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); onFiles(e.dataTransfer.files); }}
            style={{ border: `2px dashed ${T.line}`, borderRadius: 10, background: T.card, padding: 16, textAlign: "center", cursor: "pointer" }}
          >
            <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 15 }}>Drop bills here — as many as you like</div>
            <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 4 }}>JPG, PNG or PDF. Each document is extracted in turn and triaged automatically.</div>
          </div>
          <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" style={{ display: "none" }} onChange={e => { onFiles(e.target.files); e.target.value = ""; }} />

          {docs.length > 0 && (
            <div style={{ marginTop: 14, border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 13 }}>Queue · {docs.length} document{docs.length > 1 ? "s" : ""}</span>
                <button
                  onClick={exportApproved}
                  disabled={!approvedCount}
                  style={{ padding: "5px 10px", borderRadius: 6, border: "none", background: approvedCount ? T.carbon : T.line, color: "#fff", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", cursor: approvedCount ? "pointer" : "default" }}
                >
                  {copied ? "copied ✓" : `export ${approvedCount} approved`}
                </button>
              </div>
              {docs
                .slice()
                .sort((a, b) => {
                  const rank = s => ({ needs_review: 0, clear: 1, extracting: 2, queued: 3, error: 4, approved: 5 }[s] ?? 6);
                  return rank(docStatus(a)) - rank(docStatus(b));
                })
                .map(d => {
                  const st = docStatus(d);
                  return (
                    <div
                      key={d.id}
                      onClick={() => setSelectedId(d.id)}
                      style={{
                        padding: "10px 14px", borderBottom: `1px solid ${T.paper}`, cursor: "pointer",
                        background: d.id === selectedId ? "#EDF2EA" : "transparent",
                        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
                        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: T.inkSoft }}>
                          {d.result?.fuel_type?.value || "—"}{d.result?.consumption_value?.value != null ? ` · ${d.result.consumption_value.value} ${d.result?.consumption_unit?.value || ""}` : ""}
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
              Upload a batch of bills. Clean documents pass straight through; anything with a field below the threshold lands in review, sorted to the top of the queue. Select a document to work its flagged fields — confirm the model, or correct it. Every human action is recorded in the lineage.
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
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, overflow: "hidden" }}>
              <div style={{ padding: "13px 18px", borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 15, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{selected.name}</div>
                {docStatus(selected) === "approved" ? (
                  <StatusChip status="approved" />
                ) : (
                  <button
                    onClick={() => approveDoc(selected.id)}
                    disabled={pendingCount(selected) > 0}
                    title={pendingCount(selected) > 0 ? "Resolve all flagged fields first" : "Mark verified and footprint-eligible"}
                    style={{
                      padding: "7px 14px", borderRadius: 7, border: "none",
                      background: pendingCount(selected) > 0 ? T.line : T.current, color: "#fff",
                      fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 13,
                      cursor: pendingCount(selected) > 0 ? "default" : "pointer",
                    }}
                  >
                    {pendingCount(selected) > 0 ? `${pendingCount(selected)} to resolve` : "Approve document"}
                  </button>
                )}
              </div>

              {FIELD_ORDER.map(([key, label]) => {
                const f = selected.result[key];
                if (!f) return null;
                const o = selected.overrides?.[key];
                const needs = fieldNeedsReview(selected, key);
                const isEditing = editing && editing.docId === selected.id && editing.field === key;
                const displayValue = o?.action === "human_corrected" ? o.value : f.value;

                return (
                  <div
                    key={key}
                    style={{
                      display: "grid", gridTemplateColumns: "120px 1fr 110px 150px", gap: 10,
                      padding: "10px 18px", borderBottom: `1px solid ${T.paper}`, alignItems: "center",
                      background: needs ? "#FDF8F0" : "transparent",
                    }}
                  >
                    <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500 }}>{label}</div>

                    <div style={{ minWidth: 0 }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            autoFocus
                            value={editing.draft}
                            onChange={e => setEditing({ ...editing, draft: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === "Enter") { correctField(selected.id, key, editing.draft); setEditing(null); }
                              if (e.key === "Escape") setEditing(null);
                            }}
                            style={{ flex: 1, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, padding: "5px 8px", border: `1.5px solid ${T.blue}`, borderRadius: 6 }}
                          />
                          <button onClick={() => { correctField(selected.id, key, editing.draft); setEditing(null); }} style={{ border: "none", background: T.current, color: "#fff", borderRadius: 6, padding: "0 10px", fontSize: 12, cursor: "pointer" }}>save</button>
                          <button onClick={() => setEditing(null)} style={{ border: `1px solid ${T.line}`, background: "transparent", borderRadius: 6, padding: "0 8px", fontSize: 12, cursor: "pointer" }}>esc</button>
                        </div>
                      ) : (
                        <>
                          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, color: displayValue == null ? T.line : T.ink }}>
                            {displayValue == null ? "not found" : String(displayValue)}
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
                          <button onClick={() => confirmField(selected.id, key)} title="The model got it right" style={{ border: `1px solid ${T.current}`, color: T.current, background: "transparent", borderRadius: 6, padding: "4px 9px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>✓ confirm</button>
                          <button onClick={() => setEditing({ docId: selected.id, field: key, draft: f.value == null ? "" : String(f.value) })} title="Type the correct value" style={{ border: `1px solid ${T.blue}`, color: T.blue, background: "transparent", borderRadius: 6, padding: "4px 9px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>✎ correct</button>
                        </>
                      )}
                      {o && !isEditing && (
                        <button onClick={() => reopenField(selected.id, key)} title="Undo and reopen for review" style={{ border: "none", background: "transparent", color: o.action === "human_corrected" ? T.blue : T.current, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, cursor: "pointer" }}>
                          {o.action === "human_corrected" ? "corrected ↺" : "confirmed ↺"}
                        </button>
                      )}
                      {!needs && !o && (
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: T.inkSoft }}>auto</span>
                      )}
                    </div>
                  </div>
                );
              })}

              {Array.isArray(selected.result.issues) && selected.result.issues.length > 0 && (
                <div style={{ padding: "12px 18px" }}>
                  <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500, marginBottom: 5 }}>Issues flagged by the model</div>
                  {selected.result.issues.map((iss, i) => (
                    <div key={i} style={{ fontSize: 13, color: T.flame, padding: "2px 0" }}>• {iss}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <style>{`
        @media (max-width: 820px) {
          .cs-main { grid-template-columns: 1fr !important; }
        }
        button:focus-visible, select:focus-visible, input:focus-visible { outline: 3px solid ${T.current}; outline-offset: 2px; }
      `}</style>
    </div>
  );
}

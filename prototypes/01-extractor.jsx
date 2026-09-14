import { useState, useRef, useCallback } from "react";

// ---------------------------------------------------------------
// CarbonSlice — Module 0 extraction prototype
// Bill in → structured JSON out, with per-field confidence + lineage
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
  current: "#0E7C5B",       // electricity / success
  flame: "#B4560F",         // gas / warning
  review: "#B4560F",
  fail: "#A3252A",
  chip: "#E8EDE6",
};

const EXTRACTION_PROMPT = `You are the extraction engine for CarbonSlice, a UK carbon-accounting product. You will be given a scanned or photographed UK utility bill, fuel receipt, or supplier energy invoice.

Extract the following into JSON. For EVERY field provide: "value" (null if not present/legible), "confidence" (0.0–1.0, your honest confidence that the value is correct), and "source_text" (the exact text on the document you derived it from, or null). Never guess values that are not on the document — a null with low confidence is correct behaviour; a fabricated value is a failure.

Fields:
- document_type: one of "electricity_bill", "gas_bill", "dual_fuel_bill", "fuel_receipt", "supplier_invoice", "other"
- supplier_name
- customer_name
- site_address
- account_number
- mpan: 13-digit electricity Meter Point Administration Number (often in a bordered "S" grid; may be split across two lines)
- mprn: gas Meter Point Reference Number (6–10 digits)
- fuel_type: "electricity", "natural_gas", "petrol", "diesel", "lpg", "other"
- billing_period_start: ISO date
- billing_period_end: ISO date
- consumption_value: number
- consumption_unit: e.g. "kWh", "litres", "m3" — report the unit AS PRINTED; if gas is shown in m3 and converted to kWh on the bill, prefer kWh but note the conversion in issues
- meter_readings: array of {register, previous, current, read_type ("actual"|"estimated"|"customer"), confidence}
- total_cost_value: number
- total_cost_currency: e.g. "GBP"
- vat_rate: number (percent)
- tariff_name

Also return:
- issues: array of strings — anything ambiguous, estimated reads, poor scan regions, unusual tariff structures, multi-site bills, conversions applied on the bill
- overall_confidence: 0.0–1.0

Output rules (strict, to keep the response within budget):
- Respond ONLY with the JSON object — no preamble, no markdown fences.
- Output MINIFIED JSON on a single line, no indentation or line breaks.
- Every "source_text" must be at most 8 words; truncate longer snippets.
- Include at most 4 meter_readings and at most 5 issues; keep each issue under 12 words.`;

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
  if (c === null || c === undefined) return T.line;
  if (c >= 0.85) return T.current;
  if (c >= 0.6) return T.flame;
  return T.fail;
}
function confLabel(c) {
  if (c === null || c === undefined) return "—";
  if (c >= 0.85) return "high";
  if (c >= 0.6) return "review";
  return "low";
}

function ConfidenceGauge({ c }) {
  const pct = c == null ? 0 : Math.round(c * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, background: T.chip, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: confColor(c), transition: "width .5s ease" }} />
      </div>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: confColor(c), width: 44, fontWeight: 600 }}>
        {c == null ? "—" : `${pct}%`}
      </span>
    </div>
  );
}

export default function CarbonSliceExtractor() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | working | done | error
  const [result, setResult] = useState(null);
  const [rawJson, setRawJson] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [elapsed, setElapsed] = useState(null);
  const [usage, setUsage] = useState(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);

  const onFile = useCallback((f) => {
    if (!f) return;
    const ok = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(f.type);
    if (!ok) { setErrMsg("Use a JPG, PNG, WebP or PDF of the bill."); setStatus("error"); return; }
    setFile(f);
    setResult(null); setRawJson(""); setErrMsg(""); setStatus("idle"); setElapsed(null); setUsage(null);
    if (f.type.startsWith("image/")) {
      const r = new FileReader();
      r.onload = () => setPreview(r.result);
      r.readAsDataURL(f);
    } else {
      setPreview(null);
    }
  }, []);

  const extract = async () => {
    if (!file) return;
    setStatus("working"); setErrMsg(""); setResult(null); setCopied(false);
    const t0 = performance.now();
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(new Error("Could not read the file."));
        r.readAsDataURL(file);
      });

      const block = file.type === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
        : { type: "image", source: { type: "base64", media_type: file.type, data: base64 } };

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
      } catch (parseErr) {
        if (truncated) {
          throw new Error(
            "The model's response hit the output token limit and was cut off mid-JSON, so it can't be parsed. This usually happens with dense bills (many meter readings or line items). Try again — the compact output format should now fit — or crop the image to the key page."
          );
        }
        throw new Error("The model returned something that isn't valid JSON: " + parseErr.message);
      }

      if (truncated) {
        parsed.issues = [...(parsed.issues || []), "Response reached the token limit — some fields may be missing."];
      }

      setResult(parsed);
      setRawJson(JSON.stringify(parsed, null, 2));
      setUsage(data.usage || null);
      setElapsed(((performance.now() - t0) / 1000).toFixed(1));
      setStatus("done");
    } catch (e) {
      setErrMsg(e.message || "Extraction failed — try again or use a clearer scan.");
      setStatus("error");
    }
  };

  const copyJson = async () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = rawJson;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* no-op */ }
  };

  const flagged = result
    ? FIELD_ORDER.filter(([k]) => {
        const f = result[k];
        return f && f.value != null && f.confidence != null && f.confidence < 0.85;
      }).length
    : 0;

  return (
    <div style={{ minHeight: "100vh", background: T.paper, color: T.ink, fontFamily: "'Inter', sans-serif" }}>
      <style>{FONT_CSS}</style>

      {/* Header */}
      <header style={{ background: T.carbon, color: "#EDF3EE", padding: "22px 28px", display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 800, fontSize: 24, letterSpacing: "-0.02em" }}>
            CarbonSlice<span style={{ color: "#7FC8A9" }}> /extract</span>
          </div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, opacity: 0.75, marginTop: 4 }}>
            module 0 · bill → structured JSON · every figure carries confidence + source lineage
          </div>
        </div>
        {elapsed && (
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, opacity: 0.8 }}>
            {elapsed}s{usage ? ` · ${usage.input_tokens} in / ${usage.output_tokens} out tokens` : ""}
          </div>
        )}
      </header>

      <main style={{ maxWidth: 980, margin: "0 auto", padding: "28px 20px 60px", display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr", gap: 24 }}>

        {/* Left: upload */}
        <section>
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}
            style={{
              border: `2px dashed ${T.line}`, borderRadius: 10, background: T.card,
              padding: 20, textAlign: "center", cursor: "pointer", minHeight: 180,
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
            }}
          >
            {preview
              ? <img src={preview} alt="Bill preview" style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 6, border: `1px solid ${T.line}` }} />
              : (
                <>
                  <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 16 }}>Drop a bill here</div>
                  <div style={{ fontSize: 13, color: T.inkSoft }}>Photo or scan of a UK electricity or gas bill, fuel receipt, or supplier invoice. JPG, PNG or PDF.</div>
                </>
              )}
            {file && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: T.inkSoft }}>{file.name}</div>}
          </div>
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf" style={{ display: "none" }} onChange={(e) => onFile(e.target.files?.[0])} />

          <button
            onClick={extract}
            disabled={!file || status === "working"}
            style={{
              marginTop: 14, width: "100%", padding: "12px 16px", borderRadius: 8, border: "none",
              background: !file || status === "working" ? T.line : T.current, color: "#fff",
              fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 15, cursor: !file ? "default" : "pointer",
            }}
          >
            {status === "working" ? "Reading the bill…" : "Extract fields"}
          </button>

          {status === "error" && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "#FBEBEC", color: T.fail, fontSize: 13 }}>
              {errMsg}
            </div>
          )}

          {/* Break-it checklist */}
          <div style={{ marginTop: 22, padding: 16, borderRadius: 10, background: T.card, border: `1px solid ${T.line}` }}>
            <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.04em", textTransform: "uppercase", color: T.inkSoft, marginBottom: 10 }}>
              Now break it
            </div>
            <div style={{ fontSize: 13, color: T.inkSoft, lineHeight: 1.6 }}>
              Module 0 isn't done until you've seen it fail. Feed it a blurry phone photo, a bill photographed at an angle, an estimated-read bill, a dual-fuel bill, a multi-site invoice, a handwritten fuel receipt, and a gas bill quoting m³. Save every failure — each one is a row in your Module 1 golden dataset.
            </div>
          </div>
        </section>

        {/* Right: results ledger */}
        <section>
          {!result && status !== "working" && (
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, padding: 28, color: T.inkSoft, fontSize: 14, lineHeight: 1.6 }}>
              The extraction ledger appears here. Each field shows the value, the model's confidence, and the exact source text on the bill it came from — the beginning of the audit lineage that will run all the way to a reported tonne of CO₂e.
            </div>
          )}

          {status === "working" && (
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, padding: 28, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: T.inkSoft }}>
              multimodal pass → field extraction → confidence scoring…
            </div>
          )}

          {result && (
            <div style={{ border: `1px solid ${T.line}`, borderRadius: 10, background: T.card, overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 700, fontSize: 15 }}>
                  Extraction ledger
                  {result.overall_confidence != null && (
                    <span style={{ marginLeft: 10, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: confColor(result.overall_confidence) }}>
                      overall {Math.round(result.overall_confidence * 100)}%
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setShowRaw(!showRaw)} style={{ padding: "6px 12px", borderRadius: 6, border: `1px solid ${T.line}`, background: "transparent", fontSize: 12, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace" }}>
                    {showRaw ? "ledger view" : "raw JSON"}
                  </button>
                  <button onClick={copyJson} style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: T.carbon, color: "#fff", fontSize: 12, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace" }}>
                    {copied ? "copied ✓" : "copy JSON"}
                  </button>
                </div>
              </div>

              {flagged > 0 && !showRaw && (
                <div style={{ padding: "10px 18px", background: "#FBF3E8", color: T.flame, fontSize: 13, borderBottom: `1px solid ${T.line}` }}>
                  {flagged} field{flagged > 1 ? "s" : ""} below 85% confidence — in production these route to the human review queue, not to the footprint.
                </div>
              )}

              {showRaw ? (
                <pre style={{ margin: 0, padding: 18, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", overflowX: "auto", lineHeight: 1.55 }}>{rawJson}</pre>
              ) : (
                <div>
                  {FIELD_ORDER.map(([key, label]) => {
                    const f = result[key];
                    if (!f) return null;
                    const val = f.value;
                    return (
                      <div key={key} style={{ display: "grid", gridTemplateColumns: "130px 1fr 160px", gap: 12, padding: "11px 18px", borderBottom: `1px solid ${T.paper}`, alignItems: "center" }}>
                        <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500 }}>{label}</div>
                        <div>
                          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, color: val == null ? T.line : T.ink }}>
                            {val == null ? "not found" : String(val)}
                          </div>
                          {f.source_text && (
                            <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 2 }} title="Source text on the document">
                              ⌕ “{f.source_text}”
                            </div>
                          )}
                        </div>
                        <ConfidenceGauge c={f.confidence} />
                      </div>
                    );
                  })}

                  {Array.isArray(result.meter_readings?.value ?? result.meter_readings) && (
                    (result.meter_readings?.value ?? result.meter_readings).length > 0 && (
                      <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.paper}` }}>
                        <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500, marginBottom: 6 }}>Meter readings</div>
                        {(result.meter_readings?.value ?? result.meter_readings).map((m, i) => (
                          <div key={i} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, padding: "3px 0" }}>
                            {m.register ? `${m.register}: ` : ""}{m.previous ?? "?"} → {m.current ?? "?"}
                            {m.read_type ? <span style={{ color: m.read_type === "estimated" ? T.flame : T.inkSoft }}> ({m.read_type})</span> : ""}
                          </div>
                        ))}
                      </div>
                    )
                  )}

                  {Array.isArray(result.issues) && result.issues.length > 0 && (
                    <div style={{ padding: "12px 18px" }}>
                      <div style={{ fontSize: 12, color: T.inkSoft, fontWeight: 500, marginBottom: 6 }}>Issues flagged by the model</div>
                      {result.issues.map((iss, i) => (
                        <div key={i} style={{ fontSize: 13, color: T.flame, padding: "2px 0" }}>• {iss}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <style>{`
        @media (max-width: 760px) {
          main { grid-template-columns: 1fr !important; }
        }
        button:focus-visible { outline: 3px solid ${T.current}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
      `}</style>
    </div>
  );
}

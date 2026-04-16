import { useState, useRef, useEffect } from "react";


// ───────────────────────────────────────────────────────────────────────────

const NAMESPACES = [
  { id: "podcast_newsletter_growth_metrics",          label: "Growth & Metrics",   color: { bg: "#E1F5EE", fg: "#0F6E56" } },
  { id: "podcast_newsletter_product_strategy",        label: "Product Strategy",   color: { bg: "#EEEDFE", fg: "#3C3489" } },
  { id: "podcast_newsletter_ai_and_engineering",      label: "AI & Engineering",   color: { bg: "#EAF3DE", fg: "#27500A" } },
  { id: "podcast_newsletter_leadership",              label: "Leadership",          color: { bg: "#FAECE7", fg: "#993C1D" } },
  { id: "podcast_newsletter_startups_entrepreneurship", label: "Startups",         color: { bg: "#FAEEDA", fg: "#633806" } },
  { id: "podcast_newsletter_gotomarket",              label: "Go-to-Market",        color: { bg: "#E6F1FB", fg: "#0C447C" } },
  { id: "podcast_newsletter_career",                  label: "Career",              color: { bg: "#FBEAF0", fg: "#72243E" } },
];
const SYSTEM_BASE = `You are Product Guru, an expert AI assistant specializing in product management, powered by Lenny Rachitsky's newsletters and podcasts.

Guidelines:
- Answer in 2–3 concise paragraphs. Be practical and actionable.
- Always cite the specific newsletter issue or podcast episode title/guest when referencing retrieved content.
- If retrieved context is insufficient, acknowledge it and offer related help.
- End every response with a section formatted exactly like this (with real follow-up questions):

---
**Want to go deeper?**
- [follow-up question 1]
- [follow-up question 2]
- [longer version: ask for a more detailed breakdown of this topic]`;

const STARTERS = [
  "How do I find product-market fit?",
  "What retention metrics should I track?",
  "How do I build a strong product roadmap?",
  "What makes a great product manager?",
];

// ── Embed via OpenAI ────────────────────────────────────────────────────────
async function embed(text) {
  const res = await fetch("/api/openai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text, dimensions: 512 }),
  });
  const data = await res.json();
  if (!data.data?.[0]?.embedding) throw new Error("Embedding failed: " + JSON.stringify(data));
  return data.data[0].embedding;
}

// ── Query one Pinecone namespace ────────────────────────────────────────────
async function queryNamespace(vector, namespace) {
  const res = await fetch("/api/pinecone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector, namespace}),
  });
  const data = await res.json();
  console.log(`${namespace}:`, data);
  return (data.matches || []).map(m => ({
    namespace,
    score: m.score,
    text: m.metadata?.text || m.metadata?.content || "",
    source: m.metadata?.source || m.metadata?.title || m.metadata?.episode || "Lenny's Newsletter/Podcast",
  }));
}

// ── Classify query to determine relevant namespaces ─────
async function classifyQuery(query) {
  const res = await fetch("/api/anthropic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Which of these knowledge bases are most relevant to this question: "${query}"?

Knowledge bases:
- podcast_newsletter_growth_metrics: Growth tactics, retention, activation, experimentation, benchmarks
- podcast_newsletter_product_strategy: Product vision, roadmaps, frameworks, PM craft, decision-making
- podcast_newsletter_ai_and_engineering: AI products, engineering practices, technical tools, web3
- podcast_newsletter_leadership: Hiring, team building, influence, culture, org design, feedback
- podcast_newsletter_startups_entrepreneurship: Founding, fundraising, product-market fit, pivots, early-stage
- podcast_newsletter_gotomarket: Pricing, positioning, marketplaces, sales motions, distribution
- podcast_newsletter_career: Interviews, salary negotiation, PM careers, personal growth

Reply with ONLY a JSON array of the most relevant namespace IDs, e.g. ["podcast_newsletter_growth_metrics"]. Max 3 namespaces.`
      }]
    }),
  });
  const data = await res.json();
  try {
    const text = data.content[0].text.trim();
    return JSON.parse(text);
  } catch {
    return null;
  }
}


// ── Query only relevant namespaces ────────────────────────────────────────
async function retrieveContext(query) {
  const vector = await embed(query);

  // Step 1: classify query into relevant namespaces
  let targetNamespaces = await classifyQuery(query);

  // Step 2: query only relevant namespaces
  if (targetNamespaces?.length) {
    const results = await Promise.all(
      targetNamespaces.map(ns => queryNamespace(vector, ns))
    );
    const chunks = results.flat().filter(r => r.score > 0.3 && r.text);

    // Step 3: if enough results found, return early
    if (chunks.length >= 3) {
      console.log("Targeted namespaces used:", targetNamespaces);
      return chunks.sort((a, b) => b.score - a.score);
    }
  }

  // Step 4: fallback — search all namespaces
  console.log("Falling back to all namespaces");
  const allResults = await Promise.all(
    NAMESPACES.map(ns => queryNamespace(vector, ns.id))
  );
  return allResults.flat().filter(r => r.score > 0.3 && r.text)
  .sort((a, b) => b.score - a.score);
}

// ── Build context block for Claude ─────────────────────────────────────────
function buildContextPrompt(chunks) {
  if (!chunks.length) return "";
  const grouped = {};
  chunks.forEach(c => {
    if (!grouped[c.namespace]) grouped[c.namespace] = [];
    grouped[c.namespace].push(c);
  });
  let ctx = "### Retrieved Knowledge Base Context\n\n";
  for (const [ns, items] of Object.entries(grouped)) {
    const nsLabel = NAMESPACES.find(n => n.id === ns)?.label || ns;
    ctx += `**${nsLabel}:**\n`;
    let block = "";
    items.forEach((item, i) => {
      block += `[${i + 1}] Source: ${item.source}\n${item.text.slice(0, 600)}\n\n`;
    });
    ctx += block + "\n\n";
  }
  return ctx;
}

// ── UI helpers ──────────────────────────────────────────────────────────────
const KBTag = ({ nsId }) => {
  const ns = NAMESPACES.find(n => n.id === nsId);
  if (!ns) return null;
  return (
    <span style={{
      fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 20,
      background: ns.color.bg, color: ns.color.fg, display: "inline-block", marginRight: 4, marginBottom: 4,
    }}>{ns.label}</span>
  );
};

const ThinkingDots = () => (
  <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "4px 0" }}>
    {[0,1,2].map(i => (
      <div key={i} style={{
        width: 7, height: 7, borderRadius: "50%", background: "var(--color-text-tertiary)",
        animation: "bounce 1.2s infinite", animationDelay: `${i*0.2}s`,
      }}/>
    ))}
    <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-5px)}}`}</style>
  </div>
);

const StatusLine = ({ text, color = "#1D9E75" }) => (
  <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
    <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, animation: "pulse 1s infinite" }}/>
    {text}
    <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
  </div>
);

const formatMessage = (text, onFollowUp) => {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    if (line.startsWith("---")) return <hr key={i} style={{ border: "none", borderTop: "0.5px solid var(--color-border-tertiary)", margin: "12px 0" }}/>;
    if (/^\*\*.*\*\*$/.test(line)) return <p key={i} style={{ fontWeight: 500, margin: "8px 0 4px", fontSize: 14 }}>{line.replace(/\*\*/g,"")}</p>;
    if (/^\- \[/.test(line) || /^\* \[/.test(line)) {
      const txt = line.replace(/^[-*] \[/,"").replace(/\]$/,"");
      return (
        <button key={i} onClick={() => onFollowUp(txt)} style={{
          display: "block", width: "100%", textAlign: "left", background: "var(--color-background-secondary)",
          border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "7px 12px",
          fontSize: 13, color: "var(--color-text-primary)", cursor: "pointer", marginBottom: 6, lineHeight: 1.4,
        }}
          onMouseEnter={e => e.currentTarget.style.background="var(--color-background-tertiary)"}
          onMouseLeave={e => e.currentTarget.style.background="var(--color-background-secondary)"}
        >{txt} ↗</button>
      );
    }
    if (/^[-*] /.test(line)) return <p key={i} style={{ margin: "3px 0", fontSize: 14, lineHeight: 1.6, paddingLeft: 12 }}>• {line.slice(2)}</p>;
    if (!line.trim()) return <div key={i} style={{ height: 6 }}/>;
    const html = line
      .replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>")
      .replace(/\*(.*?)\*/g,"<em>$1</em>")
      .replace(/`(.*?)`/g,'<code style="background:var(--color-background-secondary);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>');
    return <p key={i} style={{ margin: "4px 0", fontSize: 14, lineHeight: 1.7 }} dangerouslySetInnerHTML={{ __html: html }}/>;
  });
};

// ── Main component ──────────────────────────────────────────────────────────
export default function ProductGuru() {
  const [messages, setMessages] = useState([]);   // {role, content, nsHits}
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(null);     // null | "embedding" | "retrieving" | "thinking"
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, status]);

  const send = async (text) => {
    const q = (text || input).trim();
    if (!q || status) return;
    setInput("");

    const userMsg = { role: "user", content: q, nsHits: [] };
    setMessages(prev => [...prev, userMsg]);

    let chunks = [];
    try {
      setStatus("embedding");
      chunks = await retrieveContext(q);
      console.log("Chunks retrieved:", chunks.length, chunks);
      setStatus("retrieving");
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error("Retrieval error:", e);
    }

    const nsHits = [...new Set(chunks.map(c => c.namespace))];
    setMessages(prev => prev.map((m, i) => i === prev.length - 1 ? { ...m, nsHits } : m));

    const contextBlock = buildContextPrompt(chunks);
    const systemPrompt = contextBlock
      ? `${SYSTEM_BASE}\n\n${contextBlock}`
      : SYSTEM_BASE;

    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

    setStatus("thinking");
    console.log("Calling Claude with context:", systemPrompt.slice(0, 200));
    try {
      const res = await fetch("/api/anthropic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: systemPrompt,
          messages: history,
        }),
      });
      const data = await res.json();
      console.log("Claude Response", data);
      const reply = data.content?.find(b => b.type === "text")?.text || "Sorry, I couldn't generate a response.";
      setMessages(prev => [...prev, { role: "assistant", content: reply, nsHits }]);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong. Please try again.", nsHits: [] }]);
    }
    setStatus(null);
  };

  const isEmpty = messages.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", maxHeight: 680, fontFamily: "var(--font-sans)", background: "var(--color-background-primary)" }}>
      {/* Header */}
      <div style={{ padding: "14px 20px 10px", borderBottom: "0.5px solid var(--color-border-tertiary)", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#EEEDFE", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#534AB7" strokeWidth="1.2"/><path d="M5 8h6M8 5v6" stroke="#534AB7" strokeWidth="1.2" strokeLinecap="round"/></svg>
        </div>
        <div>
          <div style={{ fontWeight: 500, fontSize: 15, color: "var(--color-text-primary)" }}>Product Guru</div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>Lenny's Newsletter & Podcast · 7 knowledge bases</div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        {isEmpty && (
          <div style={{ textAlign: "center", paddingTop: 32 }}>
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" style={{ display: "block", margin: "0 auto 12px" }}>
              <circle cx="22" cy="22" r="21" stroke="#534AB7" strokeWidth="1.5" fill="#EEEDFE"/>
              <path d="M22 12v10l6 6" stroke="#534AB7" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <div style={{ fontWeight: 500, fontSize: 17, color: "var(--color-text-primary)", marginBottom: 6 }}>Ask Product Guru anything</div>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 24 }}>Retrieves from 7 knowledge bases, grounded in Lenny's content</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420, margin: "0 auto" }}>
              {STARTERS.map(s => (
                <button key={s} onClick={() => send(s)} style={{
                  background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)",
                  borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "var(--color-text-primary)",
                  cursor: "pointer", textAlign: "left", lineHeight: 1.4,
                }}
                  onMouseEnter={e => e.currentTarget.style.background="var(--color-background-tertiary)"}
                  onMouseLeave={e => e.currentTarget.style.background="var(--color-background-secondary)"}
                >{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 20, display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
            {msg.role === "user" ? (
              <div style={{
                background: "#534AB7", color: "#fff", borderRadius: "16px 16px 4px 16px",
                padding: "9px 14px", fontSize: 14, maxWidth: "75%", lineHeight: 1.5,
              }}>{msg.content}</div>
            ) : (
              <div style={{ maxWidth: "92%", width: "100%" }}>
                {msg.nsHits?.length > 0 && (
                  <div style={{ marginBottom: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginRight: 2 }}>Retrieved from:</span>
                    {msg.nsHits.map(ns => <KBTag key={ns} nsId={ns}/>)}
                  </div>
                )}
                <div style={{ fontSize: 14, color: "var(--color-text-primary)", lineHeight: 1.7 }}>
                  {formatMessage(msg.content, send)}
                </div>
              </div>
            )}
          </div>
        ))}

        {status && (
          <div style={{ marginBottom: 12 }}>
            {status === "embedding"  && <StatusLine text="Generating query embedding…" color="#1D9E75"/>}
            {status === "retrieving" && <StatusLine text="Searching 7 knowledge bases…" color="#534AB7"/>}
            {status === "thinking"   && <ThinkingDots/>}
          </div>
        )}
        <div ref={bottomRef}/>
      </div>

      {/* Input */}
      <div style={{ padding: "12px 16px", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask about product management, growth, strategy…"
            rows={1}
            style={{
              flex: 1, resize: "none", border: "0.5px solid var(--color-border-secondary)",
              borderRadius: 12, padding: "9px 12px", fontSize: 14, fontFamily: "var(--font-sans)",
              background: "var(--color-background-secondary)", color: "var(--color-text-primary)",
              outline: "none", lineHeight: 1.5, maxHeight: 100, overflowY: "auto",
            }}
          />
          <button onClick={() => send()} disabled={!input.trim() || !!status} style={{
            width: 36, height: 36, borderRadius: "50%", border: "none", flexShrink: 0,
            background: (!input.trim() || !!status) ? "var(--color-background-secondary)" : "#534AB7",
            color: (!input.trim() || !!status) ? "var(--color-text-tertiary)" : "#fff",
            cursor: (!input.trim() || !!status) ? "default" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", transition: "background 0.15s",
          }}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M13 7.5L2 2l2.5 5.5L2 13l11-5.5z" fill="currentColor"/></svg>
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 6, textAlign: "center" }}>Enter to send · Shift+Enter for new line</div>
      </div>
    </div>
  );
}

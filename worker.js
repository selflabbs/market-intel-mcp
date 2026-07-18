/**
 * Market Intel MCP — SelfLabbs
 * Keyless Model Context Protocol server giving AI agents live and historical
 * foreign-exchange rates: latest rates, currency conversion, historical rates,
 * time-series, and the list of supported currencies.
 *
 * Data source: European Central Bank reference rates, via the free, open-source
 * Frankfurter API (https://frankfurter.dev). ECB reference rates are published for
 * information and are not intended for use as transaction benchmarks.
 *
 * (Crypto and equity tools were removed: their upstream providers — Coinbase and
 * Yahoo Finance — prohibit commercial redistribution of their market data.)
 *
 * Cloudflare Worker (module). Bindings: KV namespace "RL" (rate-limit day counter).
 */

const POLAR_ORG = "7f455043-0b15-4a1c-b7a0-9c06c9f3b95e";
const CHECKOUT = "https://buy.polar.sh/polar_cl_Q9y3qLrNbtsssN3w5m8SK56oNcruwrmxLEPnd34oAZf";
const FREE_LIMIT = 100;
const UA = "SelfLabbs-Market-Intel/1.0 (+https://selflabbs.com; contact@selflabbs.com)";
const SERVER = { name: "market-intel", version: "2.0.0" };
const FRANK = "https://api.frankfurter.dev/v1";
const ATTRIB = "ECB reference rates via Frankfurter (information only; not a transaction benchmark)";

/* ------------------------------------------------------------------ helpers */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

async function getJSON(url, { ttl = 1800 } = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (r.status === 404) return { _notfound: true };
  if (!r.ok) return { _error: `upstream ${r.status}` };
  try { return await r.json(); } catch { return { _error: "bad json from upstream" }; }
}
const cur = (s) => String(s || "").trim().toUpperCase();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const symbolsParam = (s) => {
  if (!s) return "";
  const arr = Array.isArray(s) ? s : String(s).split(",");
  const clean = arr.map(cur).filter(Boolean);
  return clean.length ? `&symbols=${clean.join(",")}` : "";
};

/* --------------------------------------------------------------- paywall */
async function checkAccess(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (key && env.RL) {
    try {
      if (await env.RL.get("pk:" + key)) return { ok: true, pro: true, remaining: null };
      const v = await fetch("https://api.polar.sh/v1/customer-portal/license-keys/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, organization_id: POLAR_ORG }),
      });
      if (v.ok) {
        const d = await v.json().catch(() => ({}));
        if (d && (d.status === "granted" || d.valid || d.id)) {
          await env.RL.put("pk:" + key, "1", { expirationTtl: 86400 });
          return { ok: true, pro: true, remaining: null };
        }
      }
    } catch { /* fall through */ }
  }
  if (!env.RL) return { ok: true, pro: false, remaining: null };
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const day = new Date().toISOString().slice(0, 10);
  const rk = `rl:${day}:${ip}`;
  const used = parseInt((await env.RL.get(rk)) || "0", 10);
  if (used >= FREE_LIMIT) return { ok: false, pro: false, remaining: 0, reason: "free_limit" };
  await env.RL.put(rk, String(used + 1), { expirationTtl: 90000 });
  return { ok: true, pro: false, remaining: FREE_LIMIT - used - 1 };
}

/* ------------------------------------------------------------------- tools */
const TOOLS = [
  {
    name: "fx_rates",
    description: "Get the latest foreign-exchange rates for a base currency (default USD), optionally limited to specific target currencies. Source: European Central Bank reference rates.",
    inputSchema: { type: "object", properties: { base: { type: "string", description: "3-letter base currency, e.g. USD, EUR (default USD)" }, symbols: { type: "string", description: "Optional comma-separated targets, e.g. EUR,GBP,JPY" } }, required: [] },
  },
  {
    name: "fx_convert",
    description: "Convert an amount from one currency to another at the latest ECB reference rate. Returns the rate, the converted result, and the rate date.",
    inputSchema: { type: "object", properties: { amount: { type: "number" }, from: { type: "string", description: "Source 3-letter currency" }, to: { type: "string", description: "Target 3-letter currency" } }, required: ["amount", "from", "to"] },
  },
  {
    name: "fx_historical",
    description: "Get foreign-exchange rates for a base currency on a specific past date (YYYY-MM-DD). ECB publishes rates on business days; a weekend/holiday date returns the most recent prior business day.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, base: { type: "string", description: "3-letter base (default USD)" }, symbols: { type: "string", description: "Optional comma-separated targets" } }, required: ["date"] },
  },
  {
    name: "fx_timeseries",
    description: "Get a time series of exchange rates for a base currency over a date range (max ~1 year), useful for trend analysis. Provide start and end as YYYY-MM-DD and one or more target currencies.",
    inputSchema: { type: "object", properties: { start: { type: "string", description: "YYYY-MM-DD" }, end: { type: "string", description: "YYYY-MM-DD" }, base: { type: "string", description: "3-letter base (default USD)" }, symbols: { type: "string", description: "Comma-separated targets, e.g. EUR,GBP" } }, required: ["start", "end", "symbols"] },
  },
  {
    name: "fx_currencies",
    description: "List the currencies supported for exchange-rate lookups, with their full names.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

async function runTool(name, args) {
  if (name === "fx_currencies") {
    const d = await getJSON(`${FRANK}/currencies`, { ttl: 86400 });
    if (d._error) return { error: "currency list unavailable" };
    return { count: Object.keys(d).length, currencies: d, source: ATTRIB };
  }
  if (name === "fx_rates") {
    const base = cur(args.base) || "USD";
    const d = await getJSON(`${FRANK}/latest?base=${base}${symbolsParam(args.symbols)}`);
    if (d._error || !d.rates) return { error: `Could not get rates for base '${base}'. Use a valid 3-letter currency (see fx_currencies).` };
    return { base: d.base, date: d.date, rates: d.rates, source: ATTRIB };
  }
  if (name === "fx_convert") {
    const from = cur(args.from), to = cur(args.to);
    const amount = Number(args.amount);
    if (!from || !to) return { error: "Provide 'from' and 'to' 3-letter currencies." };
    if (!isFinite(amount)) return { error: "'amount' must be a number." };
    if (from === to) return { amount, from, to, rate: 1, result: amount, note: "same currency" };
    const d = await getJSON(`${FRANK}/latest?base=${from}&symbols=${to}`);
    if (d._error || !d.rates || d.rates[to] == null) return { error: `Could not convert ${from}->${to}. Check the currency codes (see fx_currencies).` };
    const rate = d.rates[to];
    return { amount, from, to, rate, result: Math.round(amount * rate * 1e6) / 1e6, date: d.date, source: ATTRIB };
  }
  if (name === "fx_historical") {
    if (!isDate(args.date)) return { error: "Provide 'date' as YYYY-MM-DD." };
    const base = cur(args.base) || "USD";
    const d = await getJSON(`${FRANK}/${args.date}?base=${base}${symbolsParam(args.symbols)}`);
    if (d._error || !d.rates) return { error: `No rates for ${base} on ${args.date}. ECB data starts in 1999; use a business day.` };
    return { base: d.base, date: d.date, requested_date: args.date, rates: d.rates, source: ATTRIB };
  }
  if (name === "fx_timeseries") {
    if (!isDate(args.start) || !isDate(args.end)) return { error: "Provide 'start' and 'end' as YYYY-MM-DD." };
    const base = cur(args.base) || "USD";
    const syms = symbolsParam(args.symbols);
    if (!syms) return { error: "Provide one or more target 'symbols', e.g. EUR,GBP." };
    const d = await getJSON(`${FRANK}/${args.start}..${args.end}?base=${base}${syms}`);
    if (d._error || !d.rates) return { error: `No time-series data for that range/currency. Keep the range within ~1 year and use valid currencies.` };
    return { base: d.base, start_date: d.start_date, end_date: d.end_date, rates: d.rates, source: ATTRIB };
  }
  return { error: "unknown tool" };
}

/* --------------------------------------------------------------- MCP core */
function rpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMCP(request, env) {
  let body;
  try { body = await request.json(); } catch { return json(rpcErr(null, -32700, "Parse error")); }
  const { id, method, params } = body || {};
  if (method === "initialize") {
    return json(rpc(id, {
      protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER,
      instructions: "Market Intel: live and historical foreign-exchange rates for AI agents (latest, convert, historical, time-series, currency list), sourced from European Central Bank reference rates. For crypto prices see Base Intel; for company financials see Filings Intel.",
    }));
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return new Response(null, { status: 202, headers: CORS });
  if (method === "ping") return json(rpc(id, {}));
  if (method === "tools/list") return json(rpc(id, { tools: TOOLS }));
  if (method === "tools/call") {
    const access = await checkAccess(request, env);
    if (!access.ok) return json(rpc(id, { content: [{ type: "text", text: `Free tier limit reached (${FREE_LIMIT} calls/day). Upgrade to Pro for unlimited access with one key across all SelfLabbs servers: ${CHECKOUT}` }], isError: true }));
    const tname = params && params.name;
    const args = (params && params.arguments) || {};
    if (!TOOLS.find((t) => t.name === tname)) return json(rpcErr(id, -32602, `Unknown tool: ${tname}`));
    try {
      const out = await runTool(tname, args);
      const meta = access.pro ? "" : `\n\n(${access.remaining} free calls left today)`;
      return json(rpc(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) + meta }], isError: !!(out && out.error) }));
    } catch (e) {
      return json(rpc(id, { content: [{ type: "text", text: "Error: " + (e && e.message || String(e)) }], isError: true }));
    }
  }
  return json(rpcErr(id, -32601, `Method not found: ${method}`));
}

/* ----------------------------------------------------------------- landing */
const CSS = `:root{--bg:#0b0e14;--panel:#111725;--border:#1e2636;--text:#e6edf3;--muted:#8b98a9;--accent:#4ade80;--accent2:#22d3ee}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.6}
a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px}
header{position:sticky;top:0;z-index:50;background:#0b0e14;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:18px;padding:12px 20px}
.logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:19px}.logo svg{display:block}
nav{display:flex;gap:16px;margin-left:auto;flex-wrap:wrap;font-size:14px}nav a{color:var(--muted)}nav a:hover{color:var(--text)}
.hero{padding:64px 0 32px}.hero h1{font-size:44px;line-height:1.1;margin:0 0 14px}.hero .accent{color:var(--accent)}
.sub{font-size:19px;color:var(--muted);max-width:640px}
.section{padding:28px 0;border-top:1px solid var(--border)}
.grid{display:grid;grid-template-columns:1fr;gap:16px}@media(min-width:760px){.grid{grid-template-columns:1fr 1fr}}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;min-width:0}
.card h3{margin:0 0 6px;font-size:16px}.card code{color:var(--accent);font-size:13px}.card p{margin:6px 0 0;color:var(--muted);font-size:14px}
.cmd{display:flex;align-items:center;gap:8px;background:#0a0d13;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:14px 0;overflow-x:auto}
.cmd code{font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--text);white-space:nowrap}
.tiers{display:grid;grid-template-columns:1fr;gap:14px}@media(min-width:760px){.tiers{grid-template-columns:1fr 1fr 1fr}}
.tier{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px}.tier b{font-size:18px}.tier span{display:block;color:var(--muted);font-size:14px;margin-top:4px}
.btn{display:inline-block;background:var(--accent);color:#06210f;font-weight:700;padding:10px 18px;border-radius:8px;margin-top:8px}
footer{border-top:1px solid var(--border);padding:32px 20px;color:var(--muted);font-size:14px;text-align:center}`;
const MARK = `<svg width="26" height="26" viewBox="-34 -34 68 68" style="vertical-align:-4px"><g stroke="#4ade80" stroke-width="5" fill="none" stroke-linejoin="round"><polygon points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15"/></g><g fill="#4ade80"><circle cx="0" cy="-12" r="6"/><circle cx="-11" cy="8" r="6"/><circle cx="11" cy="8" r="6"/></g></svg>`;

function landing(host) {
  const ep = `https://${host}/mcp`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market Intel MCP — Live FX &amp; currency rates for your AI agent | SelfLabbs</title>
<meta name="description" content="Keyless MCP server giving AI agents live and historical foreign-exchange rates and currency conversion for 30+ currencies, sourced from European Central Bank reference data.">
<style>${CSS}</style></head><body>
<header><a href="https://selflabbs.com/" style="color:inherit"><div class="logo">${MARK}Self<span style="color:var(--accent)">Labbs</span></div></a>
<nav><a href="https://selflabbs.com/">SelfLabbs</a><a href="#tools">Tools</a><a href="#start">Quick start</a><a href="#pricing">Pricing</a><a href="https://github.com/selflabbs">GitHub</a></nav></header>
<div class="wrap">
<section class="hero"><h1>Live <span class="accent">exchange rates</span> for your agent.</h1>
<p class="sub">Market Intel serves real-time and historical foreign-exchange rates, conversion, and time-series for 30+ currencies — straight from European Central Bank reference data. No API keys. (For crypto prices see Base Intel; for company financials see Filings Intel.)</p></section>

<section class="section" id="tools"><h2>Tools</h2><div class="grid">
<div class="card"><h3><code>fx_rates</code></h3><p>Latest rates for a base currency.</p></div>
<div class="card"><h3><code>fx_convert</code></h3><p>Convert an amount between two currencies.</p></div>
<div class="card"><h3><code>fx_historical</code></h3><p>Rates on a specific past date.</p></div>
<div class="card"><h3><code>fx_timeseries</code></h3><p>Rate history over a date range, for trends.</p></div>
<div class="card"><h3><code>fx_currencies</code></h3><p>All supported currencies and names.</p></div>
</div></section>

<section class="section" id="start"><h2>Quick start</h2>
<p class="sub">One line, no key. Works with Claude, Cursor, and any MCP client.</p>
<div class="cmd"><code>claude mcp add --transport http market-intel ${ep}</code></div>
<p style="color:var(--muted);font-size:14px">Or point any MCP client at <code>${ep}</code></p></section>

<section class="section" id="pricing"><h2>Pricing</h2><div class="tiers">
<div class="tier"><b>Free</b><span>100 calls / day</span><span>Every tool, no key.</span></div>
<div class="tier"><b>$19/mo · Pro</b><span>Unlimited calls</span><span>1 seat · one key unlocks all SelfLabbs servers.</span><a class="btn" href="${CHECKOUT}">Upgrade</a></div>
<div class="tier"><b>$49/mo · Team</b><span>Unlimited calls</span><span>Up to 5 seats.</span><a class="btn" href="${CHECKOUT}">Upgrade</a></div>
</div></section>
</div>
<footer><a href="https://selflabbs.com/" style="color:inherit">SelfLabbs</a> — infrastructure for the agent economy · <a href="https://github.com/selflabbs">GitHub</a> · Data: European Central Bank reference rates via Frankfurter (information only)</footer>
</body></html>`;
}

/* ------------------------------------------------------------------ router */
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname === "/sse") {
      if (request.method === "POST") return handleMCP(request, env);
      return json({ error: "POST JSON-RPC to this endpoint (MCP streamable HTTP)" }, 405);
    }
    if (url.pathname === "/health") return json({ ok: true, server: SERVER });
    if (url.pathname === "/" || url.pathname === "") return new Response(landing(url.host), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    return new Response("Not found", { status: 404, headers: CORS });
  },
};

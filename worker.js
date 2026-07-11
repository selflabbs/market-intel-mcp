/**
 * SelfLabbs Market Intel MCP Server
 * Remote MCP server (Streamable HTTP, stateless) for Cloudflare Workers.
 * Zero dependencies, zero API keys. Real-time crypto, FX, and stock data for AI agents.
 * Data: CoinGecko (crypto), Frankfurter/ECB (FX), Stooq (stocks).
 */

const SERVER_INFO = { name: "selflabbs-market-intel", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ---- Polar pay gating (public org id; receive-only, no secret) ------------
const POLAR_ORG_ID = "1604c206-d89e-4d81-ba2d-71d8f9ff9b3b";
const UPGRADE_URL = "https://buy.polar.sh/polar_cl_FHUG28jft1HVLlBa1LtTco5bY5mT8yuY4uC6P2ImBAT";
async function validatePolarKey(key) {
  if (!key) return { tier: "free", key_status: "none" };
  if (!/^SELFLABBS-[A-Za-z0-9-]{6,120}$/.test(key)) return { tier: "free", key_status: "malformed" };
  const cache = caches.default;
  const ck = new Request("https://polar-validate.selflabbs.internal/" + encodeURIComponent(key));
  const hit = await cache.match(ck);
  if (hit) { try { return await hit.json(); } catch (e) {} }
  let result = { tier: "free", key_status: "invalid" };
  try {
    const r = await fetch("https://api.polar.sh/v1/customer-portal/license-keys/validate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key, organization_id: POLAR_ORG_ID }),
    });
    if (r.ok) {
      const d = await r.json();
      const active = d.status === "granted" && (!d.expires_at || new Date(d.expires_at).getTime() > Date.now());
      result = active ? { tier: "pro", key_status: "granted" } : { tier: "free", key_status: d.status || "inactive" };
    }
  } catch (e) {}
  await cache.put(ck, new Response(JSON.stringify(result), { headers: { "Cache-Control": "s-maxage=300" } }));
  return result;
}
function capForFree(out) {
  try {
    const o = JSON.parse(JSON.stringify(out));
    let truncated = false;
    const walk = (v) => { if (Array.isArray(v)) { if (v.length > 10) { truncated = true; v.length = 10; } v.forEach(walk); } else if (v && typeof v === "object") { for (const k in v) walk(v[k]); } };
    walk(o);
    if (truncated && o && typeof o === "object" && !Array.isArray(o)) o._selflabbs_note = "Free tier: results capped at 10 items. Upgrade for full results at https://selflabbs.com";
    return o;
  } catch (e) { return out; }
}

class UserError extends Error {}

const TOOLS = [
  {
    name: "crypto_price",
    description: "Current price for one or more cryptocurrencies via CoinGecko. Returns price, 24h change, and market cap in the chosen fiat currency. Use for crypto research, portfolio checks, or answering 'what's X trading at?'.",
    inputSchema: { type: "object", properties: {
      ids: { type: "string", description: "Comma-separated CoinGecko coin IDs, e.g. bitcoin,ethereum,solana" },
      vs_currency: { type: "string", description: "Fiat currency code (default usd), e.g. usd, eur, gbp" },
    }, required: ["ids"] },
  },
  {
    name: "crypto_market",
    description: "Top cryptocurrencies by market capitalization via CoinGecko. Returns rank, symbol, name, price, market cap, and 24h change. Use for market overviews and screening.",
    inputSchema: { type: "object", properties: {
      limit: { type: "integer", description: "How many coins to return (default 20, max 100)" },
      vs_currency: { type: "string", description: "Fiat currency (default usd)" },
    }, required: [] },
  },
  {
    name: "fx_convert",
    description: "Convert an amount between two currencies at the latest ECB reference rate via Frankfurter. Use for currency conversion and pricing.",
    inputSchema: { type: "object", properties: {
      from: { type: "string", description: "Source currency code, e.g. USD" },
      to: { type: "string", description: "Target currency code, e.g. EUR" },
      amount: { type: "number", description: "Amount to convert (default 1)" },
    }, required: ["from", "to"] },
  },
  {
    name: "fx_rates",
    description: "Latest foreign-exchange rates for a base currency (ECB data via Frankfurter). Returns rates for all or selected target currencies.",
    inputSchema: { type: "object", properties: {
      base: { type: "string", description: "Base currency code (default USD)" },
      symbols: { type: "string", description: "Optional comma-separated target codes, e.g. EUR,GBP,JPY. Omit for all." },
    }, required: [] },
  },
  {
    name: "stock_quote",
    description: "Latest quote for a stock, ETF, or index via Stooq. Returns date, open, high, low, close, and volume. Symbols: US tickers like AAPL, MSFT; indices like ^SPX. Use for equity research.",
    inputSchema: { type: "object", properties: {
      symbol: { type: "string", description: "Ticker, e.g. AAPL, TSLA, or an index like ^SPX" },
    }, required: ["symbol"] },
  },
];

async function cryptoPrice(args) {
  const ids = String(args.ids || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!ids) throw new UserError("Provide one or more CoinGecko coin IDs, e.g. bitcoin,ethereum");
  const vs = String(args.vs_currency || "usd").trim().toLowerCase();
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(ids) +
    "&vs_currencies=" + encodeURIComponent(vs) + "&include_24hr_change=true&include_market_cap=true";
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new UserError("CoinGecko error (HTTP " + res.status + "). Rate-limited? Try again shortly.");
  const data = await res.json();
  if (!data || Object.keys(data).length === 0) throw new UserError("No results. Use CoinGecko coin IDs (e.g. 'bitcoin', not 'btc').");
  const out = {};
  for (const id of Object.keys(data)) {
    const d = data[id];
    out[id] = { price: d[vs], "market_cap": d[vs + "_market_cap"], "change_24h_pct": d[vs + "_24h_change"] };
  }
  return { vs_currency: vs, prices: out };
}

async function cryptoMarket(args) {
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
  const vs = String(args.vs_currency || "usd").trim().toLowerCase();
  const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=" + encodeURIComponent(vs) +
    "&order=market_cap_desc&per_page=" + limit + "&page=1&price_change_percentage=24h";
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new UserError("CoinGecko error (HTTP " + res.status + ")");
  const data = await res.json();
  return { vs_currency: vs, count: data.length, coins: data.map(function (c) {
    return { rank: c.market_cap_rank, symbol: (c.symbol || "").toUpperCase(), name: c.name, price: c.current_price, market_cap: c.market_cap, change_24h_pct: c.price_change_percentage_24h };
  }) };
}

async function fxConvert(args) {
  const from = String(args.from || "").trim().toUpperCase();
  const to = String(args.to || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw new UserError("Use 3-letter currency codes, e.g. USD and EUR.");
  const amount = Number(args.amount != null ? args.amount : 1);
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=" + from + "&symbols=" + to);
  if (!res.ok) throw new UserError("Frankfurter FX error (HTTP " + res.status + "). Check the currency codes.");
  const data = await res.json();
  const rate = data.rates && data.rates[to];
  if (rate == null) throw new UserError("No rate for " + from + "->" + to + ".");
  return { from: from, to: to, amount: amount, rate: rate, converted: Math.round(amount * rate * 1e6) / 1e6, date: data.date };
}

async function fxRates(args) {
  const base = String(args.base || "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) throw new UserError("Base must be a 3-letter code, e.g. USD.");
  let url = "https://api.frankfurter.dev/v1/latest?base=" + base;
  if (args.symbols) url += "&symbols=" + encodeURIComponent(String(args.symbols).trim().toUpperCase().replace(/\s+/g, ""));
  const res = await fetch(url);
  if (!res.ok) throw new UserError("Frankfurter FX error (HTTP " + res.status + ")");
  const data = await res.json();
  return { base: base, date: data.date, rates: data.rates };
}

async function stockQuote(args) {
  let symbol = String(args.symbol || "").trim();
  if (!symbol) throw new UserError("Provide a ticker, e.g. AAPL");
  let s = symbol.toLowerCase();
  if (!s.includes(".") && !s.startsWith("^")) s = s + ".us";
  const url = "https://stooq.com/q/l/?s=" + encodeURIComponent(s) + "&f=sd2t2ohlcvn&h&e=csv";
  const res = await fetch(url);
  if (!res.ok) throw new UserError("Stooq error (HTTP " + res.status + ")");
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new UserError("No data for symbol '" + symbol + "'.");
  const cols = lines[0].split(",");
  const vals = lines[1].split(",");
  const row = {};
  cols.forEach(function (c, i) { row[c.trim().toLowerCase()] = (vals[i] || "").trim(); });
  if (row.close === "N/D" || !row.close) return { symbol: symbol, found: false, note: "No quote found. Check the ticker (US stocks work as-is; try suffixes like .uk for others)." };
  return {
    symbol: (row.symbol || symbol).toUpperCase(), name: row.name || null, date: row.date, time: row.time,
    open: parseFloat(row.open), high: parseFloat(row.high), low: parseFloat(row.low), close: parseFloat(row.close),
    volume: row.volume ? parseInt(row.volume, 10) : null,
  };
}

const TOOL_IMPLS = { crypto_price: cryptoPrice, crypto_market: cryptoMarket, fx_convert: fxConvert, fx_rates: fxRates, stock_quote: stockQuote };

function rpcResult(id, result) { return { jsonrpc: "2.0", id: id, result: result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id: id, error: { code: code, message: message } }; }

async function handleRpc(msg, env, tier) {
  const id = msg.id, method = msg.method, params = msg.params;
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize": {
      const requested = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.indexOf(requested) !== -1 ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} }, serverInfo: SERVER_INFO,
        instructions: "Market data tools for AI agents: cryptocurrency prices and market overview, FX conversion and rates, and stock/ETF/index quotes. Data from CoinGecko, ECB (Frankfurter), and Stooq.",
      });
    }
    case "ping": return rpcResult(id, {});
    case "tools/list": return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params && params.name;
      const impl = TOOL_IMPLS[name];
      if (!impl) return rpcError(id, -32602, "Unknown tool: " + name);
      try { console.log(JSON.stringify({ selflabbs_metric: "tool_call", tool: String(name), tier: String(tier || "free"), ts: Date.now() })); } catch (e) {}
      try {
        const out = await impl((params && params.arguments) || {}, env);
        const shaped = tier === "pro" ? out : capForFree(out);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }] });
      } catch (e) {
        const message = e instanceof UserError ? e.message : "Internal error: " + e.message;
        return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    case "resources/list": return rpcResult(id, { resources: [] });
    case "prompts/list": return rpcResult(id, { prompts: [] });
    default: return rpcError(id, -32601, "Method not found: " + method);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const CSS = ':root{--bg:#0b0e14;--panel:#131722;--border:#232936;--text:#e6e9ef;--muted:#9aa3b2;--accent:#4ade80;--accent2:#22d3ee}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.6}.wrap{max-width:960px;margin:0 auto;padding:0 24px}header{padding:28px 0;display:flex;justify-content:space-between;align-items:center}.logo{font-weight:800;font-size:1.15rem}.logo span{color:var(--accent)}nav a{color:var(--muted);text-decoration:none;margin-left:22px;font-size:.95rem}.hero{padding:72px 0 48px;text-align:center}.hero h1{font-size:clamp(2rem,5vw,3.2rem);line-height:1.15;font-weight:800}.hero h1 em{font-style:normal;color:var(--accent)}.hero p.sub{color:var(--muted);font-size:1.15rem;max-width:640px;margin:20px auto 0}.badges{margin-top:18px;color:var(--muted);font-size:.9rem}.cta{margin-top:32px;display:flex;gap:14px;justify-content:center;flex-wrap:wrap}.btn{padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;font-size:.98rem}.btn.primary{background:var(--accent);color:#06220f}.btn.ghost{border:1px solid var(--border);color:var(--text)}.section{padding:48px 0;border-top:1px solid var(--border)}.section h2{font-size:1.5rem;margin-bottom:8px}.section p.lead{color:var(--muted);margin-bottom:28px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px}.card h3{font-size:1rem;margin-bottom:6px}.card h3 code{color:var(--accent2);font-size:.95rem}.card p{color:var(--muted);font-size:.9rem}.card .src{margin-top:10px;font-size:.78rem;color:var(--muted);opacity:.8}pre{background:#0a0d13;border:1px solid var(--border);border-radius:10px;padding:16px;overflow-x:auto;font-size:.85rem;line-height:1.5}pre code{color:#c8d3e8;font-family:ui-monospace,Menlo,Consolas,monospace}.steps h3{margin:26px 0 10px;font-size:1.02rem}.pricing .card.featured{border-color:var(--accent)}.pricing .price{font-size:1.7rem;font-weight:800;margin:8px 0}.pricing .price small{font-size:.85rem;color:var(--muted);font-weight:400}.pricing ul{list-style:none;margin-top:10px}.pricing li{color:var(--muted);font-size:.9rem;padding:3px 0}.pricing li:before{content:"\\2713 ";color:var(--accent)}.note{background:var(--panel);border:1px solid var(--accent);border-radius:10px;padding:14px 18px;margin-top:22px;font-size:.92rem;color:var(--muted)}.note strong{color:var(--accent)}footer{border-top:1px solid var(--border);padding:36px 0;color:var(--muted);font-size:.88rem;text-align:center}footer a{color:var(--muted)}';
const HEADER_ICON = '<svg width="20" height="20" viewBox="-34 -34 68 68" style="vertical-align:-3px;margin-right:7px"><g stroke="#4ade80" stroke-width="5" fill="none" stroke-linejoin="round"><polygon points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15"/></g><g fill="#4ade80"><circle cx="0" cy="-12" r="6"/><circle cx="-11" cy="8" r="6"/><circle cx="11" cy="8" r="6"/></g></svg>';
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -40 80 80"><rect x="-40" y="-40" width="80" height="80" rx="18" fill="#0b0e14"/><g stroke="#4ade80" stroke-width="4" fill="none" stroke-linejoin="round"><polygon points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15"/></g><g fill="#4ade80"><circle cx="0" cy="-12" r="5"/><circle cx="-11" cy="8" r="5"/><circle cx="11" cy="8" r="5"/></g><g stroke="#22d3ee" stroke-width="2.5"><line x1="0" y1="-12" x2="-11" y2="8"/><line x1="0" y1="-12" x2="11" y2="8"/><line x1="-11" y1="8" x2="11" y2="8"/></g></svg>';
const BASE = "https://market-intel-mcp.greenfield1775.workers.dev";
const EP = BASE + "/mcp";
let OG_PNG_B64 = "";

const LANDING_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Market Intel MCP — Real-time market data for your AI agent | SelfLabbs</title><meta name="description" content="Crypto prices, FX rates, and stock quotes as MCP tools your AI agent can call. One endpoint, no API keys."><link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta property="og:type" content="website"><meta property="og:site_name" content="SelfLabbs"><meta property="og:title" content="Market Intel MCP — SelfLabbs"><meta property="og:description" content="Real-time crypto, FX, and stock data for AI agents."><meta property="og:image" content="' + BASE + '/og.png"><meta property="og:url" content="' + BASE + '/"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="' + BASE + '/og.png"><style>' + CSS + '</style></head><body><div class="wrap"><header><div class="logo">' + HEADER_ICON + 'Self<span>Labbs</span></div><nav><a href="#tools">Tools</a><a href="#start">Quick start</a><a href="#pricing">Pricing</a><a href="https://github.com/selflabbs/market-intel-mcp">GitHub</a></nav></header><section class="hero"><h1>Real-time market data<br><em>for your AI agent</em></h1><p class="sub">Crypto prices, foreign-exchange rates, and stock quotes your agent can pull mid-task — one MCP endpoint, no API keys.</p><div class="badges">Listed in the Official MCP Registry · Open source (MIT) · No install</div><div class="cta"><a class="btn primary" href="#start">Add to your agent →</a><a class="btn ghost" href="https://github.com/selflabbs/market-intel-mcp">View source</a></div></section><section class="section" id="tools"><h2>Five feeds, one endpoint</h2><p class="lead">Live market data from trusted free sources.</p><div class="grid"><div class="card"><h3><code>crypto_price</code></h3><p>Current price, 24h change, and market cap for any coins.</p><div class="src">Source: CoinGecko</div></div><div class="card"><h3><code>crypto_market</code></h3><p>Top cryptocurrencies by market cap, ranked.</p><div class="src">Source: CoinGecko</div></div><div class="card"><h3><code>fx_convert</code></h3><p>Convert an amount between any two currencies at ECB rates.</p><div class="src">Source: Frankfurter / ECB</div></div><div class="card"><h3><code>fx_rates</code></h3><p>Latest exchange rates for any base currency.</p><div class="src">Source: Frankfurter / ECB</div></div><div class="card"><h3><code>stock_quote</code></h3><p>Latest OHLC + volume for a stock, ETF, or index.</p><div class="src">Source: Stooq</div></div></div></section><section class="section steps" id="start"><h2>Quick start</h2><p class="lead">Hosted endpoint, nothing to install.</p><h3>Claude Code</h3><pre><code>claude mcp add --transport http market-intel ' + EP + '</code></pre><h3>Then try</h3><pre><code>"What is bitcoin trading at, and how much is 500 USD in EUR?"\n"Give me the top 10 coins by market cap."\n"Latest quote for AAPL and TSLA."</code></pre></section><section class="section pricing" id="pricing"><h2>Pricing</h2><p class="lead">Free tier fully functional with fair-use caps. Upgrade for uncapped results across the SelfLabbs suite.</p><div class="grid"><div class="card featured"><h3>Free</h3><div class="price">$0<small>/mo</small></div><ul><li>All five feeds</li><li>Results capped at 10 items</li><li>Hosted endpoint</li><li>Community support</li></ul></div><div class="card"><h3>Builder</h3><div class="price">$19<small>/mo</small></div><ul><li>Uncapped results</li><li>5,000 tool calls/mo</li><li>Priority endpoint</li><li>Email support</li><a class="btn primary" href="' + UPGRADE_URL + '" style="display:inline-block;margin-top:14px">Subscribe →</a></ul></div><div class="card"><h3>Team</h3><div class="price">$49<small>/mo</small></div><ul><li>Uncapped results</li><li>25,000 tool calls/mo</li><li>Usage dashboard</li><li>SLA</li><a class="btn primary" href="' + UPGRADE_URL + '" style="display:inline-block;margin-top:14px">Subscribe →</a></ul></div></div><div class="note"><strong>One key, every server.</strong> A SelfLabbs subscription unlocks pro here and on <a href="https://security-intel-mcp.greenfield1775.workers.dev" style="color:var(--accent2)">Security Intel</a> and <a href="https://domain-intel-mcp.greenfield1775.workers.dev" style="color:var(--accent2)">Domain Intel</a>. Self-host free on Cloudflare — <a href="https://github.com/selflabbs/market-intel-mcp" style="color:var(--accent2)">GitHub</a>.</div></section><footer>SelfLabbs — infrastructure for the agent economy · <a href="https://github.com/selflabbs">GitHub</a> · Data: CoinGecko, ECB, Stooq</footer></div></body></html>';

const LLMS_TXT = "# SelfLabbs Market Intel MCP\n\n> Real-time market data for AI agents: crypto prices, FX rates, and stock quotes. No API keys.\n\n## Add to your agent\nclaude mcp add --transport http market-intel " + EP + "\n\n## Tools\n- crypto_price: current price, 24h change, market cap for coins (CoinGecko)\n- crypto_market: top cryptocurrencies by market cap (CoinGecko)\n- fx_convert: convert an amount between two currencies at ECB rates (Frankfurter)\n- fx_rates: latest FX rates for a base currency (Frankfurter)\n- stock_quote: latest OHLC + volume for a stock/ETF/index (Stooq)\n\n## Pricing\nFree tier (results capped). Builder $19/mo and Team $49/mo unlock full results.\nSubscribe: " + UPGRADE_URL + "\n\n## Source\nhttps://github.com/selflabbs/market-intel-mcp (MIT)\n";
const ROBOTS_TXT = "User-agent: *\nAllow: /\nSitemap: " + BASE + "/sitemap.xml\n";
const SITEMAP_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + BASE + '/</loc></url></urlset>\n';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/" && request.method === "GET") return new Response(LANDING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/favicon.svg") return new Response(FAVICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname === "/og.png" && OG_PNG_B64) return new Response(Uint8Array.from(atob(OG_PNG_B64), function (c) { return c.charCodeAt(0); }), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    if (url.pathname === "/llms.txt") return new Response(LLMS_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/robots.txt") return new Response(ROBOTS_TXT, { headers: { "Content-Type": "text/plain" } });
    if (url.pathname === "/sitemap.xml") return new Response(SITEMAP_XML, { headers: { "Content-Type": "application/xml" } });
    if (url.pathname === "/health" && request.method === "GET") return new Response(JSON.stringify({ service: SERVER_INFO.name, version: SERVER_INFO.version, mcp_endpoint: "/mcp", tools: TOOLS.map(function (t) { return t.name; }) }, null, 2), { headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404, headers: CORS });
    if (request.method === "GET") return new Response(null, { status: 405, headers: Object.assign({ Allow: "POST" }, CORS) });
    if (request.method === "DELETE") return new Response(null, { status: 200, headers: CORS });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: Object.assign({ Allow: "POST" }, CORS) });
    let body;
    try { body = await request.json(); } catch (e) { return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers: Object.assign({ "Content-Type": "application/json" }, CORS) }); }
    const auth = request.headers.get("Authorization") || "";
    const key = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : "";
    const tierInfo = await validatePolarKey(key);
    const tier = tierInfo.tier;
    const messages = Array.isArray(body) ? body : [body];
    const settled = await Promise.all(messages.map(function (m) { return handleRpc(m, env, tier); }));
    const responses = settled.filter(function (r) { return r !== null; });
    if (responses.length === 0) return new Response(null, { status: 202, headers: CORS });
    const payload = Array.isArray(body) ? responses : responses[0];
    const th = { "Content-Type": "application/json", "X-SelfLabbs-Tier": tier, "X-SelfLabbs-Upgrade": tier === "pro" ? "" : UPGRADE_URL };
    return new Response(JSON.stringify(payload), { headers: Object.assign(th, CORS) });
  },
};

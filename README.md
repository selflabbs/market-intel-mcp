# Market Intel MCP — by SelfLabbs

Real-time market data for AI agents: cryptocurrency prices, foreign-exchange rates, and stock quotes — as MCP tools your agent can call mid-task. No API keys.

## Tools

| Tool | What it does | Source |
|---|---|---|
| `crypto_price` | Current USD price for one or more coins by symbol (BTC, ETH, SOL…) | Coinbase |
| `crypto_market` | Snapshot of major cryptocurrencies with current USD prices | Coinbase |
| `fx_convert` | Convert an amount between two currencies at the latest ECB rate | Frankfurter / ECB |
| `fx_rates` | Latest exchange rates for a base currency | Frankfurter / ECB |
| `stock_quote` | Latest price, previous close, day high/low, and volume for a stock, ETF, or index | Yahoo Finance |

No API keys required for any tool.

## Quick start (hosted)

**Claude Code**
```bash
claude mcp add --transport http market-intel https://market-intel-mcp.greenfield1775.workers.dev/mcp
```

**Claude Desktop / other clients**
```json
{
  "mcpServers": {
    "market-intel": {
      "command": "npx",
      "args": ["mcp-remote", "https://market-intel-mcp.greenfield1775.workers.dev/mcp"]
    }
  }
}
```

## Example agent workflows

- *"What's bitcoin trading at, and how much is 500 USD in EUR?"* → `crypto_price` + `fx_convert`
- *"Give me a snapshot of the major coins right now."* → `crypto_market`
- *"Latest quote for AAPL and TSLA."* → `stock_quote`

## Pricing

The hosted endpoint is **freemium**:

- **Free** — all five feeds, results capped at 10 items per call. No key required.
- **Builder — $19/mo** — uncapped results, 5,000 tool calls/mo, priority endpoint.
- **Team — $49/mo** — uncapped results, 25,000 tool calls/mo, usage dashboard.

**[Subscribe →](https://buy.polar.sh/polar_cl_Q9y3qLrNbtsssN3w5m8SK56oNcruwrmxLEPnd34oAZf)** — one subscription unlocks Pro on every SelfLabbs server.

### Using your Pro key

After subscribing you receive a license key beginning with `SELFLABBS-`. Pass it as a Bearer token to remove the free-tier caps:

```bash
claude mcp add --transport http --header "Authorization: Bearer SELFLABBS-XXXX-XXXX" market-intel https://market-intel-mcp.greenfield1775.workers.dev/mcp
```

## Self-host (Cloudflare Workers, free tier)

Create a Worker, paste `worker.js`, deploy. No configuration or API keys needed.

## License

MIT. Data from Coinbase, the European Central Bank (via Frankfurter), and Yahoo Finance under their respective terms. Market data is provided as-is for informational purposes and is not financial advice.

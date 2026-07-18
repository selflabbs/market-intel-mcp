# Market Intel MCP — by SelfLabbs

Live and historical foreign-exchange rates for AI agents — as MCP tools your agent can call mid-task. No API keys.

## Tools

| Tool | What it does | Source |
|---|---|---|
| `fx_rates` | Latest exchange rates for a base currency | ECB via Frankfurter |
| `fx_convert` | Convert an amount between two currencies at the latest ECB reference rate | ECB via Frankfurter |
| `fx_historical` | Exchange rates for a base currency on a specific past date | ECB via Frankfurter |
| `fx_timeseries` | Exchange-rate history over a date range, for trend analysis | ECB via Frankfurter |
| `fx_currencies` | Supported currencies and their names | ECB via Frankfurter |

No API keys required for any tool.

## Quick start

```
claude mcp add --transport http market-intel https://market.selflabbs.com/mcp
```

Or point any MCP client at `https://market.selflabbs.com/mcp`.

## Data & attribution

Rates are European Central Bank reference rates, served via the free, open-source [Frankfurter](https://frankfurter.dev) API. ECB reference rates are published for information and are not intended for use as transaction benchmarks.

Looking for other data? For cryptocurrency prices see **Base Intel**, and for company financials and SEC filings see **Filings Intel** — both at [selflabbs.com](https://selflabbs.com).

## Pricing

- **Free** — 100 calls/day, every tool, no key.
- **Pro ($19/mo)** — unlimited calls; one key unlocks every SelfLabbs server.
- **Team ($49/mo)** — unlimited calls, up to 5 seats.

Part of [SelfLabbs](https://selflabbs.com) — keyless intelligence APIs for AI agents.

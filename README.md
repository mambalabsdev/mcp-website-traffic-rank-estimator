# Website Traffic Rank Estimator MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-website-traffic-rank-estimator)](https://smithery.ai/servers/mambabuilt/mcp-website-traffic-rank-estimator) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-website-traffic-rank-estimator/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-website-traffic-rank-estimator) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-website-traffic-rank-estimator%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-website-traffic-rank-estimator&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-website-traffic-rank-estimator)](https://www.npmjs.com/package/@mambalabsdev/mcp-website-traffic-rank-estimator) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-website-traffic-rank-estimator)](https://www.npmjs.com/package/@mambalabsdev/mcp-website-traffic-rank-estimator) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-website-traffic-rank-estimator)](https://github.com/mambalabsdev/mcp-website-traffic-rank-estimator/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-website-traffic-rank-estimator)

An MCP server that returns a research grade Tranco popularity rank and trend for any company domain. It wraps the Mamba Labs Website Traffic Rank Estimator actor on Apify and returns a Clay-ready flat JSON row to any MCP client.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Inputs](#inputs)
- [Output](#output)
- [Example output](#example-output)
- [Features](#features)
- [Full actor documentation](#full-actor-documentation)
- [Mamba Labs GTM Suite](#mamba-labs-gtm-suite)
- [License](#license)

## What it does

Give it a company domain and it returns that domain's position on the public Tranco list, the date of that position, a band from `top_1k` through `beyond_1m`, and whether the domain has been rising, falling or stable over roughly forty daily observations. One flat row per company.

These are ranks, not traffic. A Tranco rank does not convert to visits, sessions or a monthly number, and this tool will never return a visit count. A lower rank number is better, so the trend is given in words rather than as a signed number. Most B2B domains are not on the list at all and return `not_found`, which is normal rather than disqualifying. Cloudflare Radar and Chrome UX Report are available as extra sources with your own free keys, and a source you did not supply a key for reports `skipped` rather than `not_found`, because nobody looked.

All of the lookup runs on Apify. This package is a thin client that calls the actor and hands back the result unchanged.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mamba-website-traffic-rank-estimator": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-website-traffic-rank-estimator"],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Get your token at https://console.apify.com/account/integrations, paste it in, and restart Claude Desktop. The `estimate_website_traffic_rank` tool will be available.

## Prerequisites

- Node.js 18 or newer
- An Apify account with an API token
- Optional: your own Cloudflare API token, free at dash.cloudflare.com, if you want the Radar source
- Optional: your own Google API key with the Chrome UX Report API enabled, free at console.cloud.google.com, if you want the CrUX source

## Example prompts

- "What is the Tranco rank for stripe.com, and is it rising or falling?"
- "Give me the popularity band for this domain and skip the trend."
- "Rank these domains and flag the ones inside the top 100,000."
- "Look up figma.com on Tranco and Cloudflare Radar. Here is my Cloudflare token."

## Inputs

- `company_domain` (optional): bare company domain, for example `stripe.com`. This is the lookup key and the join key for every other actor in the fleet.
- `company_name` (optional): carried through to the output row for joining. Rank lookup is keyed on the domain alone, so the name does not change the answer.
- `sources` (optional): which rank sources to query. One of `tranco`, `tranco_radar`, `tranco_crux` or `all`. Tranco is free and needs no key. Cloudflare Radar and Chrome UX Report each need your own free key, and a source you did not supply a key for reports `skipped` rather than `not found`.
- `includeTrend` (optional): when true (the default) the rank history Tranco already returns is used to say whether the domain is rising, falling or stable. It costs nothing extra, because the history arrives in the same response.
- `minRank` (optional): one of `none`, `1000`, `10000`, `100000` or `1000000`. It sets `rank_meets_threshold` on the row, so you can filter a list to established sites without writing the comparison yourself. It never drops a row and never changes the rank returned.
- `cloudflareApiToken` (optional): your own Cloudflare API token, free to create at dash.cloudflare.com. Used only when `sources` includes Radar.
- `cruxApiKey` (optional): your own Google API key with the Chrome UX Report API enabled, free at console.cloud.google.com. Used only when `sources` includes CrUX.
- `skipCache` (optional): when false (the default) a successful lookup is cached for seven days and reused. Set true to force a fresh fetch.

## Output

The tool returns the actor's flat JSON row for the company, with 20 snake_case fields and no nested objects. `tranco_rank` comes with `tranco_rank_date`, because a rank without a date has no shelf life. `rank_band` gives an honest band rather than false precision, `rank_trend` is a word, and `radar_status` and `crux_status` say whether those sources ran. See the Apify Store page for the full output schema.

## Example output

```json
{
  "degraded": false,
  "degradation_reason": null,
  "company_domain": "stripe.com",
  "company_name": "Stripe",
  "tranco_rank": 238,
  "tranco_rank_date": "2026-08-21",
  "rank_band": "top_1k",
  "rank_trend": "stable",
  "rank_change": 1,
  "rank_observations": 40,
  "rank_meets_threshold": null,
  "radar_rank": null,
  "radar_bucket": null,
  "radar_status": "skipped",
  "crux_has_data": null,
  "crux_lcp_p75_ms": null,
  "crux_status": "skipped",
  "coverage": 0.67,
  "fetch_status": "ok",
  "run_date": "2026-08-22T19:23:52.998Z"
}
```

## Features

- Tranco popularity rank for any company domain, with the date of that rank
- Trend over roughly forty daily observations, given as rising, falling or stable
- An honest band such as `top_1k`, rather than false precision
- Optional Cloudflare Radar and Chrome UX Report sources with your own keys
- Never returns a visit count, because a rank is not traffic
- 20 flat snake_case fields, one row per company

## Full actor documentation

This server is a thin client and holds no lookup logic. For the complete input and output reference, pricing, and run history, see the Apify Store page:

https://apify.com/mambalabs/website-traffic-rank-estimator

---

## Mamba Labs GTM Suite

This server is one of the Mamba Labs GTM Suite MCP servers. Every actor in the suite takes a domain or a company and returns one flat row, so they stack in the same Clay table without reshaping anything. The actor behind this server is the Website Traffic Rank Estimator, immutable Apify actor ID `GnOFUzlNVIoXgeJjH`.

> Built by [Mamba Labs](https://github.com/mambalabsdev) | [npm](https://www.npmjs.com/org/mambalabsdev) | [Apify Store](https://apify.com/mambalabs)

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs

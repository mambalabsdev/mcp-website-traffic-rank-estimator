#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

const APIFY_TOKEN = process.env.APIFY_TOKEN;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor at all.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// The actor types its switches as strings ("true"/"false") for Clay
// compatibility, because Clay sends every input as a string and a boolean typed
// field silently receives "false" and reads it as truthy. The model gets a real
// boolean and the actor gets the string it validates.
function boolToString(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? "true" : "false";
}

// actorPath is the actor's IMMUTABLE Apify actor id, not its slug, so a Store
// rename never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  // memory=256 is deliberate and matches the actor's declared
  // defaultRunOptions.memoryMbytes. run-sync-get-dataset-items runs at 2048 MB
  // unless told otherwise, and `apify-actor-start` bills once per GB with a
  // minimum of one, so leaving the default in place would charge the caller
  // more start events per run than the actor asks for. Keep this in step with
  // the actor's defaultRunOptions.
  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300&memory=256`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message = "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try again, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  // A 2xx normally carries the dataset array. Pass actor output through
  // unchanged: the wrapper must never reinterpret a status field, because
  // not_extractable, blocked and not_found are different answers and collapsing
  // them is exactly the defect the actor was built to avoid.
  const items = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-website-traffic-rank-estimator",
  version: pkg.version,
});

// Website Traffic Rank Estimator (immutable actor ID GnOFUzlNVIoXgeJjH)
server.registerTool(
  "estimate_website_traffic_rank",
  {
    title: "Estimate Website Traffic Rank",
    description:
      "Return a research grade popularity RANK for a company domain from the public Tranco list, with the date of that rank, an honest band (top_1k through beyond_1m) and a rising, falling or stable trend over roughly forty daily observations. Returns one flat Clay ready row. THESE ARE RANKS, NOT TRAFFIC: a rank does not convert to visits and this tool will never return a visit count. A lower rank number is better, so the trend is given in words rather than as a signed number. Most B2B domains are not on the list at all and return not_found, which is normal rather than disqualifying. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Estimate Website Traffic Rank",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      company_domain: z.string()
        .optional()
        .describe("Bare company domain, for example stripe.com. This is the only required input and it is the join key for every other actor in the fleet."),
      company_name: z.string()
        .optional()
        .describe("Optional. Carried through to the output row for joining. Rank lookup is keyed on the domain alone, so the name does not change the answer."),
      sources: z.enum(["tranco", "tranco_radar", "tranco_crux", "all"])
        .optional()
        .describe("Which rank sources to query. Tranco is free and needs no key. Cloudflare Radar and Chrome UX Report each need your own free key, and a source you did not supply a key for reports \"skipped\" rather than \"not found\", because we did not look. Sent as a string for Clay compatibility."),
      includeTrend: z.boolean()
        .optional()
        .describe("When \"true\" (default) the rank history Tranco already returns is used to say whether the domain is rising, falling or stable. It costs nothing extra: the history arrives in the same response. Sent as a string for Clay compatibility."),
      minRank: z.enum(["none", "1000", "10000", "100000", "1000000"])
        .optional()
        .describe("Sets rank_meets_threshold on the row, so you can filter a list to established sites without writing the comparison yourself. It never drops a row and never changes the rank returned. Sent as a string for Clay compatibility."),
      cloudflareApiToken: z.string()
        .optional()
        .describe("YOUR OWN Cloudflare API token, free to create at dash.cloudflare.com. OPTIONAL and only used when sources includes Radar. Marked secret, so the value never renders on this page."),
      cruxApiKey: z.string()
        .optional()
        .describe("YOUR OWN Google API key with the Chrome UX Report API enabled, free at console.cloud.google.com. OPTIONAL and only used when sources includes CrUX. Marked secret, so the value never renders on this page."),
      skipCache: z.boolean()
        .optional()
        .describe("When \"false\" (default) a successful lookup is cached for seven days and reused, which costs you nothing on a repeated run. Set \"true\" to force a fresh fetch. Sent as a string for Clay compatibility."),
    },
  },
  async ({ company_domain, company_name, sources, includeTrend, minRank, cloudflareApiToken, cruxApiKey, skipCache }) => {
    return runActor(
      "GnOFUzlNVIoXgeJjH",
      "Website Traffic Rank Estimator",
      compact({
        company_domain,
        company_name,
        sources,
        includeTrend: boolToString(includeTrend),
        minRank,
        cloudflareApiToken,
        cruxApiKey,
        skipCache: boolToString(skipCache),
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

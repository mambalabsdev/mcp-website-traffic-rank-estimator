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

// How long the actor run itself is allowed to take, in seconds. One value for
// every Mamba Labs wrapper, set 2026-10-05: start and poll exists so a long run
// survives, and a shorter limit would end the long runs it was built for. Past
// this limit the run ends TIMED-OUT and the caller is told so, with the run id.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

// memory=256 matches the actor's declared defaultRunOptions.memoryMbytes.
// `apify-actor-start` bills once per GB with a minimum of one, so an explicit
// value keeps the caller from paying for more memory than the actor asks for.
// Keep this in step with the actor's defaultRunOptions.
const RUN_QUERY = `timeout=${ACTOR_RUN_TIMEOUT_SECS}&memory=256`;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames).
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it, so a
// long run reads as a timeout even though the actor goes on and bills. Starting
// the run, polling it to a terminal status and then reading the dataset waits
// as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities.
//
// The wrapper never reinterprets a row's status field: not_extractable,
// blocked and not_found are different answers and are passed through unchanged.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?${RUN_QUERY}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success.
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}). Read it at https://console.apify.com/actors/runs/${runId}` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message ? `${asObj.error.message}` : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

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

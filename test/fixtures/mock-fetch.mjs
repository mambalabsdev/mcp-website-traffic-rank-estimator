// Preloaded into the server under test (NODE_OPTIONS=--import). Replaces fetch
// with a recorder that plays the Apify start, poll, and dataset routes, so the
// start and poll path runs offline. MOCK_RUN_STATUS sets the terminal status.
import { appendFileSync } from "node:fs";
const log = process.env.MOCK_FETCH_LOG;
const finalStatus = process.env.MOCK_RUN_STATUS || "SUCCEEDED";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (log) appendFileSync(log, JSON.stringify({ method: init.method || "GET", url: u }) + "\n");
  if (/\/v2\/acts\/[^/]+\/runs\?/.test(u) && init.method === "POST") {
    return json({ data: { id: "mockrun", status: "RUNNING", defaultDatasetId: "mockds" } }, 201);
  }
  if (u.includes("/v2/actor-runs/mockrun")) {
    return json({ data: { id: "mockrun", status: finalStatus, defaultDatasetId: "mockds" } });
  }
  if (u.includes("/v2/datasets/mockds/items")) {
    return json([{ row_status: "ok", mock: true }]);
  }
  return json({ error: { message: `unexpected ${u}` } }, 500);
};

import fs from "node:fs/promises";
import path from "node:path";

const API_BASE = String(process.env.API_BASE ?? "").trim().replace(/\/$/, "");
const EXPECTED_COMMIT = String(process.env.EXPECTED_COMMIT ?? "").trim();
const REQUESTED_DATE = String(process.env.MLB_DATE ?? "").trim();
const OUTPUT_DIR = path.resolve(process.env.V19_OUTPUT_DIR ?? "artifacts/p0-v19-real-e2e");

if (!API_BASE) throw new Error("P0_V19_API_BASE_REQUIRED");

function floridaDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function assertIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`P0_V19_DATE_INVALID:${value}`);
}

async function writeJson(name, value) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUTPUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`P0_V19_${label}_NON_JSON:${response.status}:${text.slice(0, 240)}`);
  }
}

async function waitForDeployment() {
  let last = null;
  for (let attempt = 1; attempt <= 36; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/health`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await readJsonResponse(response, "HEALTH");
      last = { attempt, httpStatus: response.status, body };
      await writeJson("health.json", last);
      const healthy = response.status === 200 && body?.status === "healthy";
      const commitMatches = !EXPECTED_COMMIT || body?.commit === EXPECTED_COMMIT;
      if (healthy && commitMatches) return last;
    } catch (error) {
      last = { attempt, error: error instanceof Error ? error.message : String(error) };
      await writeJson("health.json", last);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`P0_V19_DEPLOYMENT_NOT_READY:${JSON.stringify(last)}`);
}

function requireFalse(value, code) {
  if (value !== false) throw new Error(`${code}:${String(value)}`);
}

function requireZero(value, code) {
  if (value !== 0) throw new Error(`${code}:${String(value)}`);
}

function validateSafetyPolicy(policy, prefix) {
  if (!policy || typeof policy !== "object") throw new Error(`${prefix}_POLICY_REQUIRED`);
  requireFalse(policy.automaticPolling, `${prefix}_AUTOMATIC_POLLING_FORBIDDEN`);
  requireFalse(policy.automaticBetPlacement, `${prefix}_AUTOMATIC_BET_FORBIDDEN`);
  requireZero(policy.realFinancialExposure, `${prefix}_FINANCIAL_EXPOSURE_FORBIDDEN`);
}

async function runRealUiCommand(date) {
  const response = await fetch(`${API_BASE}/api/mlb/unified-v16/ui-run`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ date }),
    signal: AbortSignal.timeout(12 * 60_000),
  });
  const body = await readJsonResponse(response, "UI_RUN");
  const capture = { httpStatus: response.status, body };
  await writeJson("ui-run-response.json", capture);
  return capture;
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const date = REQUESTED_DATE || floridaDate();
assertIsoDate(date);

const deployment = await waitForDeployment();
const run = await runRealUiCommand(date);
const status = String(run.body?.status ?? "");
const policy = run.body?.policy;

const summary = {
  schemaVersion: "courtedge-p0-v19-postmerge-real-e2e.v1",
  date,
  apiBase: API_BASE,
  expectedCommit: EXPECTED_COMMIT || null,
  deployedCommit: deployment.body?.commit ?? null,
  httpStatus: run.httpStatus,
  status,
  fullChainCompleted: false,
  paidOddsBoundaryCrossed: false,
  classification: "UNKNOWN",
  blockers: Array.isArray(run.body?.blockers) ? run.body.blockers : [],
  policy: policy ?? null,
};

if (status === "WAITING_FOR_FINAL_INPUTS") {
  if (run.httpStatus !== 200) throw new Error(`P0_V19_WAITING_HTTP_STATUS:${run.httpStatus}`);
  validateSafetyPolicy(policy, "P0_V19_WAITING");
  requireFalse(policy.pricedRunnerCalled, "P0_V19_WAITING_PRICED_RUNNER_FORBIDDEN");
  requireFalse(policy.paidOddsCalled, "P0_V19_WAITING_PAID_ODDS_FORBIDDEN");
  summary.classification = "REAL_SLATE_VALIDATED_WAITING_FOR_FINAL_INPUTS";
} else if (status === "CERTIFIED_INPUT_ASSEMBLY_BLOCKED") {
  validateSafetyPolicy(policy, "P0_V19_BLOCKED");
  requireFalse(policy.pricedRunnerCalled, "P0_V19_BLOCKED_PRICED_RUNNER_FORBIDDEN");
  requireFalse(policy.paidOddsCalled, "P0_V19_BLOCKED_PAID_ODDS_FORBIDDEN");
  requireZero(policy.theOddsApiCreditsConsumed, "P0_V19_BLOCKED_ODDS_CREDITS_FORBIDDEN");
  summary.classification = "REAL_CERTIFIED_ASSEMBLY_BLOCKER";
  await writeJson("summary.json", summary);
  throw new Error(`P0_V19_CERTIFIED_ASSEMBLY_BLOCKED:${JSON.stringify(summary.blockers)}`);
} else if (status === "RUN_COMPLETED") {
  if (run.httpStatus !== 200) throw new Error(`P0_V19_COMPLETED_HTTP_STATUS:${run.httpStatus}`);
  validateSafetyPolicy(policy, "P0_V19_COMPLETED");
  if (policy.certifiedServerAssemblyComplete !== true) throw new Error("P0_V19_CERTIFIED_ASSEMBLY_NOT_COMPLETE");
  if (policy.pricedRunnerCalled !== true) throw new Error("P0_V19_PRICED_RUNNER_NOT_CALLED");
  requireFalse(policy.finalBetRecommendationProduced, "P0_V19_FINAL_BET_RECOMMENDATION_FORBIDDEN");
  requireFalse(policy.stakeCalculated, "P0_V19_STAKE_CALCULATION_FORBIDDEN");
  if (!run.body?.result?.summary || !run.body?.result?.prepriceSummary) {
    throw new Error("P0_V19_RUN_SUMMARIES_REQUIRED");
  }
  summary.fullChainCompleted = true;
  summary.paidOddsBoundaryCrossed = true;
  summary.classification = "REAL_POSTMERGE_FULL_CHAIN_PASS";
  summary.runnerSummary = run.body.result.summary;
  summary.prepriceSummary = run.body.result.prepriceSummary;
} else {
  await writeJson("summary.json", summary);
  throw new Error(`P0_V19_UNEXPECTED_STATUS:${run.httpStatus}:${status || "missing"}:${JSON.stringify(run.body)}`);
}

await writeJson("summary.json", summary);
console.log(JSON.stringify(summary, null, 2));

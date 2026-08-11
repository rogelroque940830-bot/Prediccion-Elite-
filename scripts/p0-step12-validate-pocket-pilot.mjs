#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { validateMlbStep12PilotEvidence } from "../server/mlb-step12-pocket-validation.ts";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const input = arg("--input", "evidence/p0-step12/2025-pocket-pilot.json");
const output = arg("--out", "artifacts/p0-step12-pocket-validation/validation-report.json");
const pilot = JSON.parse(await fs.readFile(input, "utf8"));
const results = validateMlbStep12PilotEvidence(pilot);

const counts = Object.fromEntries(
  [...new Set(results.map((row) => row.status))]
    .sort()
    .map((status) => [status, results.filter((row) => row.status === status).length]),
);
const byHorizon = Object.fromEntries(
  [...new Set(results.map((row) => row.horizon))]
    .sort()
    .map((horizon) => [horizon, {
      total: results.filter((row) => row.horizon === horizon).length,
      oosSupported: results.filter((row) => row.horizon === horizon && row.status === "OOS_SUPPORTED_HYPOTHESIS").length,
      exceptional80Plus: results.filter((row) => row.horizon === horizon && row.descriptiveHitRateBand === "EXCEPTIONAL_80_PLUS").length,
    }]),
);

const report = {
  schemaVersion: "courtedge-p0-step12-pocket-validation-report.v1",
  generatedAt: new Date().toISOString(),
  sourcePilotSchemaVersion: pilot.schemaVersion,
  sourceEvidenceStatus: pilot.evidenceStatus,
  sourceSplit: pilot.split,
  policy: {
    researchOnly: true,
    noHistoricalEvClaim: true,
    noBetElitePromotion: true,
    noLiveFilterMutation: true,
    validationCriteriaWerePredeclaredBeforeThisReport: true,
  },
  summary: {
    rulesValidated: results.length,
    counts,
    byHorizon,
  },
  results,
};

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.summary, null, 2));

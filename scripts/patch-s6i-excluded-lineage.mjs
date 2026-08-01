import fs from "node:fs";

const servicePath = "server/mlb-s6i-postfix-certification.ts";
const testPath = "server/mlb-s6i-postfix-certification.test.ts";
let service = fs.readFileSync(servicePath, "utf8");
let tests = fs.readFileSync(testPath, "utf8");

function replaceExact(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

service = replaceExact(
  service,
  '    allCleanRowsHaveProvenance: cleanUniqueRows.length > 0 && completeProvenance === cleanUniqueRows.length,',
  '    allCleanRowsHaveProvenance: cleanUniqueRows.length === 0 || completeProvenance === cleanUniqueRows.length,',
  "empty-cohort provenance check",
);

service = replaceExact(
  service,
  '  const criticalOrActionable = issues.some((entry) => entry.severity === "CRITICAL" || entry.code === "FINAL_MISSED_AFTER_START" || entry.code === "SETTLEMENT_OVERDUE");',
  '  const cleanPredictionIds = new Set(cleanUniqueRows.map((row) => row.predictionId));\n  const criticalOrActionable = issues.some((entry) => {\n    const appliesToPureCohort = entry.predictionId == null || cleanPredictionIds.has(entry.predictionId);\n    return appliesToPureCohort\n      && (entry.severity === "CRITICAL" || entry.code === "FINAL_MISSED_AFTER_START" || entry.code === "SETTLEMENT_OVERDUE");\n  });',
  "pure-cohort actionable issue filter",
);

service = replaceExact(
  service,
  '      invalidAmericanOdds: rows.filter((row) => row.issueCodes.includes("INVALID_AMERICAN_ODDS")).length,',
  '      invalidAmericanOdds: cleanUniqueRows.filter((row) => row.issueCodes.includes("INVALID_AMERICAN_ODDS")).length,',
  "clean-cohort invalid price count",
);

service = replaceExact(
  service,
  '    zeroInvalidAmericanOdds: rows.every((row) => !row.issueCodes.includes("INVALID_AMERICAN_ODDS")),',
  '    zeroInvalidAmericanOdds: cleanUniqueRows.every((row) => !row.issueCodes.includes("INVALID_AMERICAN_ODDS")),',
  "clean-cohort zero-invalid check",
);

const marker = 'test("detects missing FINAL snapshots, overdue settlement and persistence count regression", () => {';
if (!tests.includes(marker)) throw new Error("Missing test insertion marker");
const addedTest = `test("excluded cross-cutoff lineage does not block the pure clean cohort", () => {\n  const oldInvalid = record({\n    id: "old-invalid-provisional",\n    recordedAtMs: cutoffMs - 60_000,\n    stage: "PROVISIONAL",\n    odds: -4,\n    fingerprint: "old-invalid-stage",\n  });\n  const transitionFinal = record({\n    id: "transition-final",\n    recordedAtMs: cutoffMs + 60_000,\n    stage: "FINAL",\n    odds: -110,\n    supersedesId: "old-invalid-provisional",\n    fingerprint: "transition-final-stage",\n  });\n  const pureClean = record({\n    id: "pure-clean",\n    recordedAtMs: cutoffMs + 120_000,\n    odds: -115,\n    fingerprint: "pure-clean-stage",\n  });\n  const report = buildMlbS6iPostfixCertification([oldInvalid, transitionFinal, pureClean], {\n    now: new Date("2026-08-01T12:00:00.000Z"),\n  });\n\n  assert.equal(report.state, "COLLECTING");\n  assert.equal(report.summary.postCutoffTerminalDecisions, 2);\n  assert.equal(report.summary.cleanUniqueDecisions, 1);\n  assert.equal(report.summary.excludedDecisions, 1);\n  assert.equal(report.summary.invalidAmericanOdds, 0);\n  assert.equal(report.readiness.checks.zeroInvalidAmericanOdds, true);\n  assert.ok(report.issues.some((entry) => entry.predictionId === "transition-final" && entry.code === "INVALID_AMERICAN_ODDS"));\n});\n\n`;
tests = tests.replace(marker, addedTest + marker);

fs.writeFileSync(servicePath, service);
fs.writeFileSync(testPath, tests);
console.log("Applied S6I pure-cohort readiness patch.");

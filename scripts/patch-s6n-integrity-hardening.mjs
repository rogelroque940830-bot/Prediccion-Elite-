import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const sourcePath = "server/mlb-s6n-first-real-settlement-monitor.ts";
let source = fs.readFileSync(sourcePath, "utf8");

source = source.replace('  computeMlbS6mIndependentMetrics,\n', '');

source = replaceOnce(
  source,
  `function canonicalDigest(value: unknown): string {\n  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");\n}\n`,
  `function canonicalDigest(value: unknown): string {\n  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");\n}\n\nfunction round(value: number, digits = 6): number {\n  const factor = 10 ** digits;\n  return Math.round(value * factor) / factor;\n}\n\nfunction wilson95(wins: number, total: number): { low: number; high: number } | null {\n  if (total <= 0) return null;\n  const z = 1.959963984540054;\n  const p = wins / total;\n  const denominator = 1 + (z * z) / total;\n  const center = (p + (z * z) / (2 * total)) / denominator;\n  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denominator;\n  return {\n    low: round(Math.max(0, center - margin)),\n    high: round(Math.min(1, center + margin)),\n  };\n}\n\nfunction americanWinProfit(odds: number): number {\n  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);\n}\n\nfunction computeFirstDecisionMetrics(entry: S6mManifestEntry): S6mMilestoneCertificate["metrics"] | null {\n  if (entry.outcome !== 0 && entry.outcome !== 1) return null;\n  const probability = entry.modelProbability;\n  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;\n  const wins = entry.outcome;\n  const losses = 1 - entry.outcome;\n  const bounded = Math.min(1 - 1e-15, Math.max(1e-15, probability));\n  const brier = (probability - entry.outcome) ** 2;\n  const logLoss = -(entry.outcome * Math.log(bounded) + (1 - entry.outcome) * Math.log(1 - bounded));\n  const calibrationGap = Math.abs(entry.outcome - probability);\n  const profit = entry.result === "WIN" ? americanWinProfit(entry.oddsAmerican) : -1;\n  const clvAvailable = entry.clvPp == null ? 0 : 1;\n  return {\n    observations: 1,\n    binaryDecisions: 1,\n    wins,\n    losses,\n    pushes: 0,\n    voids: 0,\n    meanModelProbability: round(probability),\n    observedWinRate: entry.outcome,\n    winRateWilson95: wilson95(wins, 1),\n    brierScore: round(brier),\n    logLoss: round(logLoss),\n    expectedCalibrationError: round(calibrationGap),\n    maximumCalibrationError: round(calibrationGap),\n    flatStakeExposureUnits: 1,\n    flatStakeProfitUnits: round(profit, 4),\n    flatStakeRoiPct: round(profit * 100, 4),\n    clvAvailable,\n    clvCoveragePct: clvAvailable ? 100 : 0,\n    meanClvPp: entry.clvPp == null ? null : round(entry.clvPp, 4),\n    medianClvPp: entry.clvPp == null ? null : round(entry.clvPp, 4),\n  };\n}\n`,
  "independent first-decision metrics",
);

source = replaceOnce(
  source,
  `    if (certificate.manifest.length !== 1 || certificate.metrics.binaryDecisions !== 1) {\n      certificateIntegrity = false;\n      pushIssue(issues, "CERTIFICATE_SAMPLE_SIZE_INVALID", "CRITICAL", "Milestone 1 certificate must contain exactly one binary decision.");\n    }`,
  `    if (certificate.manifest.length !== 1 || certificate.metrics.binaryDecisions !== 1) {\n      certificateIntegrity = false;\n      pushIssue(issues, "CERTIFICATE_SAMPLE_SIZE_INVALID", "CRITICAL", "Milestone 1 certificate must contain exactly one binary decision.");\n    }\n    if (!Object.values(certificate.checks).every((value) => value === true)) {\n      certificateIntegrity = false;\n      pushIssue(issues, "CERTIFICATE_CHECK_FLAGS_INVALID", "CRITICAL", "Milestone 1 certificate contains a failed or missing integrity assertion.");\n    }`,
  "certificate check flags",
);

source = replaceOnce(
  source,
  `    const expectedMetrics = sample.binaryObservations[0]\n      ? computeMlbS6mIndependentMetrics([sample.binaryObservations[0]])\n      : null;`,
  `    const expectedMetrics = certificate.manifest[0]\n      ? computeFirstDecisionMetrics(certificate.manifest[0])\n      : null;`,
  "first decision metric recomputation",
);

source = replaceOnce(
  source,
  `  if (stored.baseline) {\n    if (stored.baseline.schemaVersion !== MLB_S6N_BASELINE_VERSION\n      || sha256(baselineCore(stored.baseline)) !== stored.baseline.baselineDigestSha256) {\n      pushIssue(issues, "BASELINE_DIGEST_INVALID", "CRITICAL", "The append-only first-observation baseline failed integrity validation.");\n    }\n  }\n  if (stored.evidence) {\n    if (stored.evidence.schemaVersion !== MLB_S6N_EVIDENCE_VERSION\n      || sha256(evidenceCore(stored.evidence)) !== stored.evidence.evidenceDigestSha256) {\n      pushIssue(issues, "EVIDENCE_DIGEST_INVALID", "CRITICAL", "The append-only certification evidence failed integrity validation.");\n    }\n  }`,
  `  if (stored.baseline) {\n    if (stored.baseline.schemaVersion !== MLB_S6N_BASELINE_VERSION\n      || sha256(baselineCore(stored.baseline)) !== stored.baseline.baselineDigestSha256) {\n      pushIssue(issues, "BASELINE_DIGEST_INVALID", "CRITICAL", "The append-only first-observation baseline failed integrity validation.");\n    }\n    if (!Number.isFinite(Date.parse(stored.baseline.firstObservedAt))\n      || stored.baseline.result !== "WIN" && stored.baseline.result !== "LOSS"\n      || stored.baseline.ownedLedgerRecordsAtFirstObservation < 1) {\n      pushIssue(issues, "BASELINE_SEMANTICS_INVALID", "CRITICAL", "The append-only baseline contains invalid observation metadata.");\n    }\n  }\n  if (stored.evidence) {\n    if (stored.evidence.schemaVersion !== MLB_S6N_EVIDENCE_VERSION\n      || sha256(evidenceCore(stored.evidence)) !== stored.evidence.evidenceDigestSha256) {\n      pushIssue(issues, "EVIDENCE_DIGEST_INVALID", "CRITICAL", "The append-only certification evidence failed integrity validation.");\n    }\n    if (!stored.baseline) {\n      pushIssue(issues, "EVIDENCE_WITHOUT_BASELINE", "CRITICAL", "S6N evidence exists without its append-only first-observation baseline.");\n    } else {\n      const firstObservedMs = Date.parse(stored.evidence.stability.firstObservedAt);\n      const confirmedMs = Date.parse(stored.evidence.stability.confirmedAt);\n      const measuredStableMs = confirmedMs - firstObservedMs;\n      const evidenceLinksMatch = stored.evidence.baselineDigestSha256 === stored.baseline.baselineDigestSha256\n        && stored.evidence.stability.firstObservedAt === stored.baseline.firstObservedAt\n        && Number.isFinite(firstObservedMs)\n        && Number.isFinite(confirmedMs)\n        && measuredStableMs >= 0\n        && stored.evidence.stability.stableForMs === measuredStableMs\n        && stored.evidence.stability.minimumRequiredMs > 0\n        && measuredStableMs >= stored.evidence.stability.minimumRequiredMs;\n      if (!evidenceLinksMatch) {\n        pushIssue(issues, "EVIDENCE_BASELINE_LINK_INVALID", "CRITICAL", "S6N evidence does not preserve a valid stability link to its append-only baseline.");\n      }\n    }\n    if (!Object.values(stored.evidence.checks).every((value) => value === true)) {\n      pushIssue(issues, "EVIDENCE_CHECK_FLAGS_INVALID", "CRITICAL", "S6N evidence contains a failed or missing verification assertion.");\n    }\n    if (certificate && (\n      canonicalDigest(stored.evidence.firstDecision) !== canonicalDigest(certificate.manifest[0])\n      || canonicalDigest(stored.evidence.metrics) !== canonicalDigest(certificate.metrics)\n      || stored.evidence.certificateDigestSha256 !== certificate.certificateDigestSha256\n      || stored.evidence.manifestDigestSha256 !== certificate.manifestDigestSha256\n    )) {\n      pushIssue(issues, "EVIDENCE_CERTIFICATE_LINK_INVALID", "CRITICAL", "S6N evidence no longer matches the immutable milestone 1 certificate and metrics.");\n    }\n  }`,
  "baseline and evidence semantic integrity",
);

fs.writeFileSync(sourcePath, source);

const testPath = "server/mlb-s6n-first-real-settlement-monitor.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
if (!tests.includes('import crypto from "node:crypto";')) {
  tests = tests.replace('import assert from "node:assert/strict";', 'import assert from "node:assert/strict";\nimport crypto from "node:crypto";');
}
const additions = `\n\nfunction recomputeDigest<T extends Record<string, any>>(value: T, digestKey: string): string {\n  const core = Object.fromEntries(Object.entries(value).filter(([key]) => key !== digestKey));\n  return crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");\n}\n\ntest("rejects false certificate checks even when the certificate digest is recomputed", () => {\n  const records = pairedDecision(0, "WIN");\n  const { report, certificates } = buildS6m(records, ["final-0"]);\n  const changed = structuredClone(certificates);\n  if (!changed["1"]) throw new Error("fixture certificate missing");\n  (changed["1"].checks as any).allSettled = false;\n  changed["1"].certificateDigestSha256 = recomputeDigest(changed["1"] as any, "certificateDigestSha256");\n  const result = evaluate(records, report, changed);\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_CHECK_FLAGS_INVALID"), true);\n});\n\ntest("rejects evidence with a broken baseline link even when its digest is recomputed", () => {\n  const records = pairedDecision(0, "WIN");\n  const { report, certificates } = buildS6m(records, ["final-0"]);\n  const first = evaluate(records, report, certificates, {}, "2026-08-01T20:02:00.000Z");\n  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T20:03:00.000Z");\n  const changed = structuredClone(second.evidenceToPersist);\n  if (!changed) throw new Error("fixture evidence missing");\n  changed.baselineDigestSha256 = "f".repeat(64);\n  changed.evidenceDigestSha256 = recomputeDigest(changed as any, "evidenceDigestSha256");\n  const result = evaluate(\n    records,\n    report,\n    certificates,\n    { baseline: first.baselineToPersist, evidence: changed },\n    "2026-08-01T20:04:00.000Z",\n  );\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_BASELINE_LINK_INVALID"), true);\n});\n`;
if (!tests.includes('test("rejects false certificate checks even when the certificate digest is recomputed"')) {
  tests += additions;
}
fs.writeFileSync(testPath, tests);

console.log("Applied S6N integrity hardening.");

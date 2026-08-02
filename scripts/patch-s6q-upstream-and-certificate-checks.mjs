import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6q-fifty-settlement-human-review.ts";
let service = fs.readFileSync(servicePath, "utf8");

const helperAnchor = `function isS6mManifestEntryShape(value: unknown): value is S6mManifestEntry {\n`;
const helpers = `function hasAllS6mCertificateChecks(value: unknown): boolean {\n  if (!isObjectRecord(value)) return false;\n  return value.exactSampleSize === true\n    && value.duplicateFree === true\n    && value.allPostFix === true\n    && value.allTerminalFinal === true\n    && value.allSettled === true\n    && value.allStandardAmericanOdds === true\n    && value.allPriceProvenanceComplete === true;\n}\n\nfunction isS6mReportArtifactShape(value: unknown): value is S6mMilestoneReport {\n  if (!isObjectRecord(value)) return false;\n  const parity = value.metricParity;\n  const readiness = value.readiness;\n  return typeof value.generatedAt === "string"\n    && typeof value.state === "string"\n    && Array.isArray(value.issues)\n    && isObjectRecord(parity)\n    && typeof parity.checked === "boolean"\n    && typeof parity.passed === "boolean"\n    && Array.isArray(parity.mismatches)\n    && parity.mismatches.every((entry) => typeof entry === "string")\n    && Array.isArray(value.milestones)\n    && typeof value.highestCertifiedMilestone === "number"\n    && isObjectRecord(readiness)\n    && typeof readiness.tenCertifiedCyclesReached === "boolean";\n}\n\nfunction isS6pReportArtifactShape(value: unknown): value is S6pReport {\n  if (!isObjectRecord(value)) return false;\n  const readiness = value.readiness;\n  return typeof value.generatedAt === "string"\n    && typeof value.state === "string"\n    && Array.isArray(value.issues)\n    && isObjectRecord(readiness)\n    && typeof readiness.minimumSample20Certified === "boolean";\n}\n\n`;
service = replaceOnce(service, helperAnchor, helpers + helperAnchor, "upstream report helper anchor");

service = replaceOnce(
  service,
  `    && isObjectRecord(value.checks)\n    && typeof value.certificateDigestSha256 === "string";`,
  `    && hasAllS6mCertificateChecks(value.checks)\n    && typeof value.certificateDigestSha256 === "string";`,
  "certificate required checks shape",
);

service = replaceOnce(
  service,
  `  s6mReport: S6mMilestoneReport | null,\n  certificates: S6mCertificateMap,\n  s6pReport: S6pReport | null,`,
  `  s6mReportInput: S6mMilestoneReport | null,\n  certificates: S6mCertificateMap,\n  s6pReportInput: S6pReport | null,`,
  "evaluation upstream input names",
);

service = replaceOnce(
  service,
  `  const currentOwnedLedgerRecords = options.currentOwnedLedgerRecords ?? records.length;\n  const countMonotonic = previousCount == null || currentOwnedLedgerRecords >= previousCount;\n  const sample = extractMlbS6mIndependentSample(records, certifiedTerminalPredictionIds);`,
  `  const currentOwnedLedgerRecords = options.currentOwnedLedgerRecords ?? records.length;\n  const countMonotonic = previousCount == null || currentOwnedLedgerRecords >= previousCount;\n  const s6mReportShapeValid = s6mReportInput == null ? null : isS6mReportArtifactShape(s6mReportInput);\n  const s6pReportShapeValid = s6pReportInput == null ? null : isS6pReportArtifactShape(s6pReportInput);\n  const s6mReport = s6mReportShapeValid ? s6mReportInput : null;\n  const s6pReport = s6pReportShapeValid ? s6pReportInput : null;\n  const sample = extractMlbS6mIndependentSample(records, certifiedTerminalPredictionIds);`,
  "validated upstream locals",
);

service = replaceOnce(
  service,
  `  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);\n  if (stored.baselineReadError)`,
  `  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);\n  if (s6mReportInput && !s6mReportShapeValid) {\n    pushIssue(issues, "S6M_REPORT_SHAPE_INVALID", "CRITICAL", "The persisted S6M report has an incomplete or incompatible structure.");\n  }\n  if (s6pReportInput && !s6pReportShapeValid) {\n    pushIssue(issues, "S6P_REPORT_SHAPE_INVALID", "CRITICAL", "The persisted S6P report has an incomplete or incompatible structure.");\n  }\n  if (stored.baselineReadError)`,
  "upstream shape issues",
);

service = replaceOnce(
  service,
  `    if (!Object.values(certificate.checks).every((value) => value === true)) {`,
  `    if (!hasAllS6mCertificateChecks(certificate.checks)) {`,
  "explicit certificate checks runtime",
);

if (!service.includes("S6M_REPORT_SHAPE_INVALID") || !service.includes("S6P_REPORT_SHAPE_INVALID")) {
  throw new Error("S6Q upstream report guards were not applied");
}
if (!service.includes("hasAllS6mCertificateChecks(certificate.checks)")) {
  throw new Error("S6Q named certificate check validation was not applied");
}
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
const additions = `

test("turns a malformed S6M upstream report into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    {} as S6mMilestoneReport,
    certificates,
    certifiedS6pReport(),
    terminalIds(10),
    { baseline: null, evidence: null },
    { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_REPORT_SHAPE_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
});

test("turns a malformed S6P upstream report into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    {} as S6pReport,
    terminalIds(10),
    { baseline: null, evidence: null },
    { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6P_REPORT_SHAPE_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
});

test("rejects a self-consistent milestone certificate with missing named checks", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const changed = structuredClone(certificates);
  if (!changed["50"]) throw new Error("fixture milestone-50 certificate missing");
  changed["50"].checks = {} as any;
  const { certificateDigestSha256: _ignored, ...core } = changed["50"];
  changed["50"].certificateDigestSha256 = digest(core);
  const result = evaluate(records, report, changed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_SHAPE_INVALID" || entry.code === "CERTIFICATE_CHECK_FLAGS_INVALID"), true);
});
`;
if (!tests.includes("turns a malformed S6M upstream report into ACTION_REQUIRED")) tests += additions;
fs.writeFileSync(testPath, tests);
console.log("Applied S6Q upstream report and named certificate-check hardening.");

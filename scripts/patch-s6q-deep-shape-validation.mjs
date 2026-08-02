import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6q-fifty-settlement-human-review.ts";
let service = fs.readFileSync(servicePath, "utf8");

service = replaceOnce(
  service,
  `function hasAllS6mCertificateChecks(value: unknown): boolean {\n  if (!isObjectRecord(value)) return false;\n  return value.exactSampleSize === true\n    && value.duplicateFree === true\n    && value.allPostFix === true\n    && value.allTerminalFinal === true\n    && value.allSettled === true\n    && value.allStandardAmericanOdds === true\n    && value.allPriceProvenanceComplete === true;\n}\n`,
  `function hasAllS6mCertificateChecks(value: unknown): boolean {\n  if (!isObjectRecord(value)) return false;\n  return value.exactSampleSize === true\n    && value.duplicateFree === true\n    && value.allPostFix === true\n    && value.allTerminalFinal === true\n    && value.allSettled === true\n    && value.allStandardAmericanOdds === true\n    && value.allPriceProvenanceComplete === true;\n}\n\nfunction hasAllS6qEvidenceChecks(value: unknown): boolean {\n  if (!isObjectRecord(value)) return false;\n  return value.milestoneFiftyCertificatePresent === true\n    && value.prerequisiteMinimumSample20Certified === true\n    && value.tenCertifiedCyclesReached === true\n    && value.exactFiftyDecisionSample === true\n    && value.duplicateFree === true\n    && value.certificateDigestValid === true\n    && value.manifestDigestValid === true\n    && value.currentLedgerManifestMatches === true\n    && value.terminalRecordsPresent === true\n    && value.terminalStagesFinal === true\n    && value.settlementsPresent === true\n    && value.settlementIdentitiesMatch === true\n    && value.settlementResultsBinary === true\n    && value.standardAmericanOdds === true\n    && value.postFixCohort === true\n    && value.s6mMetricParityPassed === true\n    && value.independentFiftyDecisionMetricsMatch === true\n    && value.noCriticalS6mIssues === true\n    && value.ledgerCountMonotonic === true\n    && value.certificateStableAcrossRuns === true;\n}\n\nfunction isIssueArray(value: unknown): value is Array<{ code: string; severity: string; message: string }> {\n  return Array.isArray(value)\n    && value.every((entry) => isObjectRecord(entry)\n      && typeof entry.code === \"string\"\n      && typeof entry.severity === \"string\"\n      && typeof entry.message === \"string\");\n}\n\nfunction isS6mMilestoneRows(value: unknown): boolean {\n  return Array.isArray(value)\n    && value.every((entry) => isObjectRecord(entry)\n      && typeof entry.milestone === \"number\"\n      && typeof entry.status === \"string\");\n}\n`,
  "deep validation helpers",
);

service = replaceOnce(
  service,
  `    && Array.isArray(value.issues)\n    && isObjectRecord(parity)`,
  `    && isIssueArray(value.issues)\n    && isObjectRecord(parity)`,
  "S6M issue validation",
);
service = replaceOnce(
  service,
  `    && Array.isArray(value.milestones)\n    && typeof value.highestCertifiedMilestone === \"number\"`,
  `    && isS6mMilestoneRows(value.milestones)\n    && typeof value.highestCertifiedMilestone === \"number\"`,
  "S6M milestone validation",
);
service = replaceOnce(
  service,
  `    && Array.isArray(value.issues)\n    && isObjectRecord(readiness)\n    && typeof readiness.minimumSample20Certified === \"boolean\";`,
  `    && isIssueArray(value.issues)\n    && isObjectRecord(readiness)\n    && typeof readiness.minimumSample20Certified === \"boolean\";`,
  "S6P issue validation",
);
service = replaceOnce(
  service,
  `    && typeof value.sampleAdequacy === \"string\"\n    && isObjectRecord(checks)\n    && typeof value.evidenceDigestSha256 === \"string\";`,
  `    && typeof value.sampleAdequacy === \"string\"\n    && hasAllS6qEvidenceChecks(checks)\n    && typeof value.evidenceDigestSha256 === \"string\";`,
  "S6Q evidence named checks shape",
);
service = replaceOnce(
  service,
  `    if (!Object.values(validStoredEvidence.checks).every((value) => value === true)) {\n      pushIssue(issues, \"EVIDENCE_CHECK_FLAGS_INVALID\", \"CRITICAL\", \"S6Q evidence contains a failed or missing verification assertion.\");\n    }`,
  `    if (!hasAllS6qEvidenceChecks(validStoredEvidence.checks)) {\n      pushIssue(issues, \"EVIDENCE_CHECK_FLAGS_INVALID\", \"CRITICAL\", \"S6Q evidence contains a failed or missing named verification assertion.\");\n    }`,
  "S6Q evidence named checks validation",
);
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
const additions = `

test("rejects malformed S6M issue entries before filtering", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(report) as any;
  malformed.issues = [null];
  const result = evaluate(records, malformed, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_REPORT_SHAPE_INVALID"), true);
});

test("rejects malformed S6M milestone rows before searching them", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(report) as any;
  malformed.milestones = [null];
  const result = evaluate(records, malformed, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_REPORT_SHAPE_INVALID"), true);
});

test("rejects malformed S6P issue entries before filtering", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(certifiedS6pReport()) as any;
  malformed.issues = [null];
  const result = evaluate(records, report, certificates, {}, undefined, malformed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6P_REPORT_SHAPE_INVALID"), true);
});

test("rejects self-consistent evidence with missing named checks", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !second.evidenceToPersist) throw new Error("fixture artifacts missing");
  const tampered = structuredClone(second.evidenceToPersist) as any;
  tampered.checks = {};
  const { evidenceDigestSha256: _ignored, ...core } = tampered;
  tampered.evidenceDigestSha256 = digest(core);
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_SHAPE_INVALID" || entry.code === "EVIDENCE_CHECK_FLAGS_INVALID"), true);
});

test("rejects a milestone certificate when any required named check is false", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const changed = structuredClone(certificates);
  if (!changed["50"]) throw new Error("fixture milestone-50 certificate missing");
  (changed["50"].checks as any).allSettled = false;
  const { certificateDigestSha256: _ignored, ...core } = changed["50"];
  changed["50"].certificateDigestSha256 = digest(core);
  const result = evaluate(records, report, changed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_SHAPE_INVALID" || entry.code === "CERTIFICATE_CHECK_FLAGS_INVALID"), true);
});
`;
if (!tests.includes("rejects malformed S6M issue entries before filtering")) tests += additions;
fs.writeFileSync(testPath, tests);
console.log("Applied S6Q deep shape validation hardening.");

import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6q-fifty-settlement-human-review.ts";
let service = fs.readFileSync(servicePath, "utf8");

service = replaceOnce(
  service,
  `  previousEvidencePresent?: boolean;\n};`,
  `  previousEvidencePresent?: boolean;\n  previousReportReadError?: string | null;\n};`,
  "previous report evaluation option",
);

service = replaceOnce(
  service,
  `  if (stored.baselineReadError) pushIssue(issues, "BASELINE_UNREADABLE", "CRITICAL", stored.baselineReadError);`,
  `  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);\n  if (stored.baselineReadError) pushIssue(issues, "BASELINE_UNREADABLE", "CRITICAL", stored.baselineReadError);`,
  "previous report issue propagation",
);

const helperAnchor = `export function buildMlbS6qStoredArtifacts(\n`;
const previousReportHelper = `function isS6qReportArtifactShape(value: unknown): value is S6qReport {\n  if (!isObjectRecord(value)) return false;\n  const stateValues: S6qState[] = [\n    "ARMED_AND_WAITING_FOR_50",\n    "WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION",\n    "WAITING_FOR_TEN_CERTIFIED_CYCLES",\n    "OBSERVING_FIFTY_RESULT_STABILITY",\n    "READY_FOR_HUMAN_REVIEW",\n    "ACTION_REQUIRED",\n  ];\n  return value.schemaVersion === MLB_S6Q_FIFTY_REVIEW_VERSION\n    && typeof value.generatedAt === "string"\n    && typeof value.trigger === "string"\n    && typeof value.deploymentCommit === "string"\n    && typeof value.environment === "string"\n    && stateValues.includes(value.state as S6qState)\n    && isObjectRecord(value.sourceS6m)\n    && isObjectRecord(value.sourceS6p)\n    && isObjectRecord(value.sample)\n    && isObjectRecord(value.target)\n    && isObjectRecord(value.stability)\n    && typeof value.stability.baselinePresent === "boolean"\n    && typeof value.stability.evidencePresent === "boolean"\n    && isObjectRecord(value.checks)\n    && isObjectRecord(value.readiness)\n    && isObjectRecord(value.persistence)\n    && typeof value.persistence.currentOwnedLedgerRecords === "number"\n    && typeof value.persistence.countMonotonic === "boolean"\n    && Array.isArray(value.issues)\n    && isObjectRecord(value.safety);\n}\n\nexport function buildMlbS6qPreviousReportArtifact(\n  artifact: { value: unknown; error: string | null; present: boolean },\n): { value: S6qReport | null; error: string | null; present: boolean } {\n  if (artifact.error) return { value: null, error: artifact.error, present: artifact.present };\n  if (!artifact.present) return { value: null, error: null, present: false };\n  if (!isS6qReportArtifactShape(artifact.value)) {\n    return {\n      value: null,\n      error: "latest.json is syntactically valid but has an incomplete or incompatible S6Q report structure.",\n      present: true,\n    };\n  }\n  return { value: artifact.value, error: null, present: true };\n}\n\n`;
service = replaceOnce(service, helperAnchor, previousReportHelper + helperAnchor, "previous report helper anchor");

service = replaceOnce(
  service,
  `    this.lastSuccessAt = this.readLatest()?.generatedAt ?? null;`,
  `    this.lastSuccessAt = this.readLatestArtifact().value?.generatedAt ?? null;`,
  "constructor safe latest read",
);

service = replaceOnce(
  service,
  `  readLatest(): S6qReport | null {\n    return readJson<S6qReport>(path.join(this.root, "latest.json"));\n  }`,
  `  private readLatestArtifact() {\n    return buildMlbS6qPreviousReportArtifact(\n      readJsonArtifact<unknown>(path.join(this.root, "latest.json")),\n    );\n  }\n  readLatest(): S6qReport | null {\n    return this.readLatestArtifact().value;\n  }`,
  "safe readLatest implementation",
);

service = replaceOnce(
  service,
  `      const previous = this.readLatest();\n      const currentOwnedLedgerRecords`,
  `      const previousArtifact = this.readLatestArtifact();\n      const previous = previousArtifact.value;\n      const currentOwnedLedgerRecords`,
  "worker previous report artifact",
);

const initialOptions = `          currentOwnedLedgerRecords,\n          previousBaselinePresent: previous?.stability.baselinePresent ?? false,\n          previousEvidencePresent: previous?.stability.evidencePresent ?? false,`;
const initialExpanded = `          currentOwnedLedgerRecords,\n          previousBaselinePresent: previous?.stability.baselinePresent ?? false,\n          previousEvidencePresent: previous?.stability.evidencePresent ?? false,\n          previousReportReadError: previousArtifact.error,`;
service = replaceOnce(service, initialOptions, initialExpanded, "initial previous report error wiring");

service = replaceOnce(
  service,
  `            minimumStabilityMs: this.minimumStabilityMs,\n            previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,\n          },`,
  `            minimumStabilityMs: this.minimumStabilityMs,\n            previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,\n            currentOwnedLedgerRecords,\n            previousBaselinePresent: previous?.stability.baselinePresent ?? false,\n            previousEvidencePresent: previous?.stability.evidencePresent ?? false,\n            previousReportReadError: previousArtifact.error,\n          },`,
  "refreshed evaluation complete options",
);

if (!service.includes("PREVIOUS_REPORT_INVALID") || !service.includes("previousReportReadError: previousArtifact.error")) {
  throw new Error("S6Q previous report hardening was not applied");
}
const currentCountOccurrences = (service.match(/currentOwnedLedgerRecords,/g) ?? []).length;
if (currentCountOccurrences < 3) throw new Error("Uncapped count is not passed through both evaluation paths");
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  buildMlbS6qStoredArtifacts,\n  evaluateMlbS6qFiftySettlementHumanReview,`,
  `  buildMlbS6qPreviousReportArtifact,\n  buildMlbS6qStoredArtifacts,\n  evaluateMlbS6qFiftySettlementHumanReview,`,
  "previous report helper test import",
);

const additions = `

test("rejects a syntactically valid but malformed previous S6Q report", () => {
  const artifact = buildMlbS6qPreviousReportArtifact({ value: {}, error: null, present: true });
  assert.equal(artifact.value, null);
  assert.equal(artifact.present, true);
  assert.match(artifact.error ?? "", /incomplete or incompatible/);
});

test("converts a malformed previous report into ACTION_REQUIRED", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(10),
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T21:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      currentOwnedLedgerRecords: records.length,
      previousReportReadError: "latest.json fixture is malformed",
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "PREVIOUS_REPORT_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});
`;
if (!tests.includes("rejects a syntactically valid but malformed previous S6Q report")) tests += additions;
fs.writeFileSync(testPath, tests);
console.log("Applied S6Q previous-report and refreshed-count hardening.");

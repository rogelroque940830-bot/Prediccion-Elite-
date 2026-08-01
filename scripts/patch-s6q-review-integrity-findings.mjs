import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6q-fifty-settlement-human-review.ts";
let service = fs.readFileSync(servicePath, "utf8");

service = replaceOnce(
  service,
  `type EvaluationOptions = {\n  generatedAt?: string;\n  trigger?: string;\n  deploymentCommit?: string;\n  environment?: string;\n  minimumStabilityMs?: number;\n  previousOwnedLedgerRecords?: number | null;\n};`,
  `type EvaluationOptions = {\n  generatedAt?: string;\n  trigger?: string;\n  deploymentCommit?: string;\n  environment?: string;\n  minimumStabilityMs?: number;\n  previousOwnedLedgerRecords?: number | null;\n  currentOwnedLedgerRecords?: number;\n  previousBaselinePresent?: boolean;\n  previousEvidencePresent?: boolean;\n};`,
  "evaluation options",
);

service = replaceOnce(
  service,
  `  const previousCount = options.previousOwnedLedgerRecords ?? null;\n  const countMonotonic = previousCount == null || records.length >= previousCount;`,
  `  const previousCount = options.previousOwnedLedgerRecords ?? null;\n  const currentOwnedLedgerRecords = options.currentOwnedLedgerRecords ?? records.length;\n  const countMonotonic = previousCount == null || currentOwnedLedgerRecords >= previousCount;`,
  "full owned-ledger count",
);

service = replaceOnce(
  service,
  `      \`Owned ledger count decreased from \${previousCount} to \${records.length}.\`,`,
  `      \`Owned ledger count decreased from \${previousCount} to \${currentOwnedLedgerRecords}.\`,`,
  "count regression message",
);

service = replaceOnce(
  service,
  `  const issues: S6qReport["issues"] = [];\n  let baselineToPersist: S6qBaseline | null = null;`,
  `  const issues: S6qReport["issues"] = [];\n  let baselineToPersist: S6qBaseline | null = null;`,
  "issues anchor",
);

service = replaceOnce(
  service,
  `  if (stored.baselineReadError) pushIssue(issues, "BASELINE_UNREADABLE", "CRITICAL", stored.baselineReadError);\n  if (stored.evidenceReadError) pushIssue(issues, "EVIDENCE_UNREADABLE", "CRITICAL", stored.evidenceReadError);`,
  `  if (stored.baselineReadError) pushIssue(issues, "BASELINE_UNREADABLE", "CRITICAL", stored.baselineReadError);\n  if (stored.evidenceReadError) pushIssue(issues, "EVIDENCE_UNREADABLE", "CRITICAL", stored.evidenceReadError);\n  if (options.previousBaselinePresent && !baselinePresent) {\n    pushIssue(issues, "BASELINE_DISAPPEARED_AFTER_OBSERVATION", "CRITICAL", "The append-only S6Q baseline existed in the previous successful report but is now absent.");\n  }\n  if (options.previousEvidencePresent && !evidencePresent) {\n    pushIssue(issues, "EVIDENCE_DISAPPEARED_AFTER_CERTIFICATION", "CRITICAL", "The append-only S6Q review evidence existed in the previous successful report but is now absent.");\n  }`,
  "artifact disappearance checks",
);

service = service.replaceAll(
  `        records.length,\n        generatedAt,`,
  `        currentOwnedLedgerRecords,\n        generatedAt,`,
);
service = service.replaceAll(
  `      ownedLedgerRecords: records.length,`,
  `      ownedLedgerRecords: currentOwnedLedgerRecords,`,
);
service = service.replaceAll(
  `      currentOwnedLedgerRecords: records.length,`,
  `      currentOwnedLedgerRecords,`,
);

service = replaceOnce(
  service,
  `      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });\n      const s6mReport = this.s6mMilestones.readLatest();`,
  `      const currentOwnedLedgerRecords = this.ownershipStore.listPredictionIds(this.ownerUserId).length;\n      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });\n      const s6mReport = this.s6mMilestones.readLatest();`,
  "worker full count",
);

const optionsBlock = `          minimumStabilityMs: this.minimumStabilityMs,\n          previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,`;
const expandedOptionsBlock = `          minimumStabilityMs: this.minimumStabilityMs,\n          previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,\n          currentOwnedLedgerRecords,\n          previousBaselinePresent: previous?.stability.baselinePresent ?? false,\n          previousEvidencePresent: previous?.stability.evidencePresent ?? false,`;
service = service.replaceAll(optionsBlock, expandedOptionsBlock);

if (!service.includes("EVIDENCE_DISAPPEARED_AFTER_CERTIFICATION")) throw new Error("Evidence disappearance check missing");
if (!service.includes("currentOwnedLedgerRecords = this.ownershipStore.listPredictionIds")) throw new Error("Full count query missing");
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
const testsToAdd = `

test("treats disappearance of previously certified evidence as an integrity failure", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const certified = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !certified.evidenceToPersist) throw new Error("fixture artifacts missing");
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(10),
    { baseline: first.baselineToPersist, evidence: null, baselinePresent: true, evidencePresent: false },
    {
      generatedAt: "2026-08-01T21:04:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousOwnedLedgerRecords: records.length,
      currentOwnedLedgerRecords: records.length,
      previousBaselinePresent: true,
      previousEvidencePresent: true,
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_DISAPPEARED_AFTER_CERTIFICATION"), true);
  assert.equal(result.evidenceToPersist, null);
});

test("uses the uncapped owned-ledger count for monotonicity", () => {
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
      previousOwnedLedgerRecords: 12_000,
      currentOwnedLedgerRecords: 11_000,
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.persistence.currentOwnedLedgerRecords, 11_000);
  assert.equal(result.report.sample.ownedLedgerRecords, 11_000);
  assert.equal(result.report.issues.some((entry) => entry.code === "PERSISTENCE_COUNT_REGRESSION"), true);
});
`;
if (!tests.includes("treats disappearance of previously certified evidence as an integrity failure")) tests += testsToAdd;
fs.writeFileSync(testPath, tests);
console.log("Applied S6Q integrity review fixes.");

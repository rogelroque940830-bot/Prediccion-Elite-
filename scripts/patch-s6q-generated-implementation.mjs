import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6q-fifty-settlement-human-review.ts";
let service = fs.readFileSync(servicePath, "utf8");

service = service.replace(
  `  const tenCertifiedCyclesReached = independentlyCertifiedAmongFirstFifty >= 10\n    && Boolean(s6mReport?.readiness.tenCertifiedCyclesReached);\n  const tenCertifiedCyclesReached = independentlyCertifiedAmongFirstFifty >= 10\n    && Boolean(s6mReport?.readiness.tenCertifiedCyclesReached);`,
  `  const tenCertifiedCyclesReached = independentlyCertifiedAmongFirstFifty >= 10\n    && Boolean(s6mReport?.readiness.tenCertifiedCyclesReached);`,
);

service = replaceOnce(
  service,
  `  if (certificate && !prerequisiteMinimumSample20Certified) {\n    pushIssue(\n      issues,\n      "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING",\n      "CRITICAL",\n      "Milestone 50 exists before the S6O first-fifty-settlements chain is certified.",\n    );\n  }`,
  `  if (certificate && !prerequisiteMinimumSample20Certified) {\n    pushIssue(\n      issues,\n      "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING",\n      "INFO",\n      "Milestone 50 is available, but S6P has not yet certified the minimum sample of 20 settlements.",\n    );\n  }`,
  "S6P prerequisite waiting block",
);

if ((service.match(/const tenCertifiedCyclesReached =/g) ?? []).length !== 1) {
  throw new Error("S6Q must declare tenCertifiedCyclesReached exactly once");
}
if (service.includes('"MINIMUM_SAMPLE_20_PREREQUISITE_PENDING",\n      "CRITICAL"')) {
  throw new Error("S6Q still treats the pending S6P prerequisite as critical");
}
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");

tests = replaceOnce(
  tests,
  `  assert.equal(result.report.sample.binaryEligibleDecisions, 19);`,
  `  assert.equal(result.report.sample.binaryEligibleDecisions, 49);`,
  "below-fifty sample assertion",
);
tests = replaceOnce(
  tests,
  `  assert.equal(second.evidenceToPersist?.calibrationBuckets.reduce((sum, row) => sum + row.sampleSize, 0), 20);`,
  `  assert.equal(second.evidenceToPersist?.calibrationBuckets.reduce((sum, row) => sum + row.sampleSize, 0), 50);`,
  "fifty-result calibration coverage assertion",
);

tests = replaceOnce(
  tests,
  `test("blocks milestone 50 when the first-five prerequisite is not certified", () => {\n  const records = recordsFor(50);\n  const { report, certificates } = buildS6m(records, terminalIds(10));\n  const pending = { ...certifiedS6pReport(), state: "ARMED_AND_WAITING_FOR_5", readiness: { minimumSample20Certified: false }, issues: [] } as S6pReport;\n  const result = evaluate(records, report, certificates, {}, undefined, pending);\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.issues.some((entry) => entry.code === "FIRST_FIVE_PREREQUISITE_NOT_CERTIFIED"), true);\n});`,
  `test("waits for the S6P minimum-sample prerequisite without fabricating review evidence", () => {\n  const records = recordsFor(50);\n  const { report, certificates } = buildS6m(records, terminalIds(10));\n  const pending = { ...certifiedS6pReport(), state: "ARMED_AND_WAITING_FOR_20", readiness: { minimumSample20Certified: false }, issues: [] } as S6pReport;\n  const result = evaluate(records, report, certificates, {}, undefined, pending);\n  assert.equal(result.report.state, "WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION");\n  assert.equal(result.report.issues.some((entry) => entry.code === "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING"), true);\n  assert.equal(result.baselineToPersist, null);\n  assert.equal(result.evidenceToPersist, null);\n});`,
  "S6P prerequisite waiting test",
);

tests = tests.replaceAll(
  `assert.equal(result.report.readiness.minimumSample20Certified, false);`,
  `assert.equal(result.report.readiness.humanReviewReady, false);`,
);

tests = tests.replace(
  `test("certifies the minimum sample only after a second stable observation", () => {`,
  `test("marks the preferred sample ready for human review only after a second stable observation", () => {`,
);

const extraTests = `

test("enters ACTION_REQUIRED when the S6P prerequisite reports a critical integrity issue", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const brokenS6p = {
    ...certifiedS6pReport(),
    state: "ACTION_REQUIRED",
    issues: [{ code: "BROKEN_S6P", severity: "CRITICAL", message: "fixture" }],
  } as S6pReport;
  const result = evaluate(records, report, certificates, {}, undefined, brokenS6p);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6P_INTEGRITY_GATE_FAILED"), true);
});

test("treats independent-certification regression after baseline creation as critical", () => {
  const records = recordsFor(50);
  const mature = buildS6m(records, terminalIds(10));
  const first = evaluate(records, mature.report, mature.certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  const regressed = buildS6m(records, terminalIds(9));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    regressed.report,
    mature.certificates,
    certifiedS6pReport(),
    terminalIds(9),
    { baseline: first.baselineToPersist, evidence: null },
    { generatedAt: "2026-08-01T21:03:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "INDEPENDENT_CERTIFICATION_REGRESSION"), true);
});
`;
if (!tests.includes("enters ACTION_REQUIRED when the S6P prerequisite reports a critical integrity issue")) {
  tests += extraTests;
}

for (const forbidden of [
  "ARMED_AND_WAITING_FOR_5",
  "FIRST_FIVE_PREREQUISITE_NOT_CERTIFIED",
  "readiness.minimumSample20Certified",
  "binaryEligibleDecisions, 19",
]) {
  if (tests.includes(forbidden)) throw new Error(`S6Q tests still contain stale token: ${forbidden}`);
}
fs.writeFileSync(testPath, tests);
console.log("Patched S6Q generated implementation and focused tests.");

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
  `  stability: {\n    baselinePresent: boolean;\n    evidencePresent: boolean;\n    firstObservedAt: string | null;\n    stableForMs: number | null;\n    minimumRequiredMs: number;\n    stableAcrossRuns: boolean;\n  };`,
  `  stability: {\n    baselinePresent: boolean;\n    evidencePresent: boolean;\n    baselineEverObserved: boolean;\n    evidenceEverObserved: boolean;\n    baselineFirstObservedAtAnchor: string | null;\n    baselineDigestAnchorSha256: string | null;\n    evidenceDigestAnchorSha256: string | null;\n    firstObservedAt: string | null;\n    stableForMs: number | null;\n    minimumRequiredMs: number;\n    stableAcrossRuns: boolean;\n  };`,
  "report stability anchor type",
);

service = replaceOnce(
  service,
  `  previousBaselinePresent?: boolean;\n  previousEvidencePresent?: boolean;\n  previousReportReadError?: string | null;`,
  `  previousBaselinePresent?: boolean;\n  previousEvidencePresent?: boolean;\n  previousBaselineEverObserved?: boolean;\n  previousEvidenceEverObserved?: boolean;\n  previousBaselineFirstObservedAtAnchor?: string | null;\n  previousBaselineDigestAnchorSha256?: string | null;\n  previousEvidenceDigestAnchorSha256?: string | null;\n  previousReportReadError?: string | null;\n  s6kReportReadError?: string | null;`,
  "evaluation anchor options",
);

service = replaceOnce(
  service,
  `function isS6mManifestEntryShape(value: unknown): value is S6mManifestEntry {`,
  `function isS6kEvidenceEntryShape(value: unknown): boolean {\n  if (!isObjectRecord(value) || typeof value.state !== "string" || !isObjectRecord(value.target)) return false;\n  return value.target.terminalPredictionId === null\n    || typeof value.target.terminalPredictionId === "string";\n}\n\nexport function buildMlbS6qCertifiedTerminalPredictionIdsFromS6k(value: unknown): {\n  terminalPredictionIds: string[];\n  error: string | null;\n} {\n  if (value == null) return { terminalPredictionIds: [], error: null };\n  if (!isObjectRecord(value)\n    || !Array.isArray(value.evidence)\n    || !value.evidence.every(isS6kEvidenceEntryShape)) {\n    return {\n      terminalPredictionIds: [],\n      error: "The persisted S6K report has an incomplete or incompatible evidence structure.",\n    };\n  }\n  const terminalPredictionIds = [...new Set(value.evidence\n    .filter((entry) => entry.state === "CERTIFIED")\n    .map((entry) => entry.target.terminalPredictionId)\n    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];\n  return { terminalPredictionIds, error: null };\n}\n\nfunction isS6mManifestEntryShape(value: unknown): value is S6mManifestEntry {`,
  "S6K report shape helper",
);

service = replaceOnce(
  service,
  `  const previousCount = options.previousOwnedLedgerRecords ?? null;\n  const currentOwnedLedgerRecords = options.currentOwnedLedgerRecords ?? records.length;`,
  `  const previousCount = options.previousOwnedLedgerRecords ?? null;\n  const previousBaselineEverObserved = options.previousBaselineEverObserved\n    ?? options.previousBaselinePresent\n    ?? false;\n  const previousEvidenceEverObserved = options.previousEvidenceEverObserved\n    ?? options.previousEvidencePresent\n    ?? false;\n  const currentOwnedLedgerRecords = options.currentOwnedLedgerRecords ?? records.length;`,
  "previous irreversible anchor values",
);

service = replaceOnce(
  service,
  `  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);`,
  `  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);\n  if (options.s6kReportReadError) pushIssue(issues, "S6K_REPORT_SHAPE_INVALID", "CRITICAL", options.s6kReportReadError);`,
  "S6K evaluation issue",
);

service = replaceOnce(
  service,
  `  if (options.previousBaselinePresent && !baselinePresent) {`,
  `  if (previousBaselineEverObserved && !baselinePresent) {`,
  "irreversible baseline disappearance gate",
);
service = replaceOnce(
  service,
  `  if (options.previousEvidencePresent && !evidencePresent) {`,
  `  if (previousEvidenceEverObserved && !evidencePresent) {`,
  "irreversible evidence disappearance gate",
);

service = replaceOnce(
  service,
  `    if (validStoredBaseline.schemaVersion !== MLB_S6Q_BASELINE_VERSION\n      || sha256(baselineCore(validStoredBaseline)) !== validStoredBaseline.baselineDigestSha256\n      || !Number.isFinite(Date.parse(validStoredBaseline.firstObservedAt))\n      || validStoredBaseline.ownedLedgerRecordsAtFirstObservation < 1\n      || !baselineIdsValid) {\n      pushIssue(issues, "BASELINE_INTEGRITY_INVALID", "CRITICAL", "The append-only fifty-result baseline failed integrity or semantic validation.");\n    }`,
  `    if (validStoredBaseline.schemaVersion !== MLB_S6Q_BASELINE_VERSION\n      || sha256(baselineCore(validStoredBaseline)) !== validStoredBaseline.baselineDigestSha256\n      || !Number.isFinite(Date.parse(validStoredBaseline.firstObservedAt))\n      || validStoredBaseline.ownedLedgerRecordsAtFirstObservation < 1\n      || !baselineIdsValid) {\n      pushIssue(issues, "BASELINE_INTEGRITY_INVALID", "CRITICAL", "The append-only fifty-result baseline failed integrity or semantic validation.");\n    }\n    if (options.previousBaselineFirstObservedAtAnchor\n      && validStoredBaseline.firstObservedAt !== options.previousBaselineFirstObservedAtAnchor) {\n      pushIssue(issues, "BASELINE_FIRST_OBSERVATION_CHANGED", "CRITICAL", "The append-only baseline first-observation timestamp differs from its previously persisted anchor.");\n    }\n    if (options.previousBaselineDigestAnchorSha256\n      && validStoredBaseline.baselineDigestSha256 !== options.previousBaselineDigestAnchorSha256) {\n      pushIssue(issues, "BASELINE_DIGEST_ANCHOR_CHANGED", "CRITICAL", "The append-only baseline digest differs from its previously persisted anchor.");\n    }`,
  "baseline timestamp and digest anchors",
);

service = replaceOnce(
  service,
  `    if (!hasAllS6qEvidenceChecks(validStoredEvidence.checks)) {\n      pushIssue(issues, "EVIDENCE_CHECK_FLAGS_INVALID", "CRITICAL", "S6Q evidence contains a failed or missing named verification assertion.");\n    }`,
  `    const expectedMarketBreakdowns = groupedBreakdowns(selected, (entry) => entry.marketType);\n    const expectedSignalBreakdowns = groupedBreakdowns(selected, (entry) => entry.signal);\n    const expectedCalibrationBuckets = buildCalibrationBuckets(selected);\n    const expectedProvisionalFinalComparison = buildProvisionalFinalComparison(records, selected);\n    const expectedConcentration = buildConcentration(\n      expectedMarketBreakdowns,\n      expectedSignalBreakdowns,\n      selected.length,\n    );\n    const derivedEvidenceMatches = canonicalDigest(validStoredEvidence.marketBreakdowns) === canonicalDigest(expectedMarketBreakdowns)\n      && canonicalDigest(validStoredEvidence.signalBreakdowns) === canonicalDigest(expectedSignalBreakdowns)\n      && canonicalDigest(validStoredEvidence.calibrationBuckets) === canonicalDigest(expectedCalibrationBuckets)\n      && canonicalDigest(validStoredEvidence.provisionalFinalComparison) === canonicalDigest(expectedProvisionalFinalComparison)\n      && canonicalDigest(validStoredEvidence.concentration) === canonicalDigest(expectedConcentration);\n    if (!derivedEvidenceMatches) {\n      pushIssue(issues, "EVIDENCE_DERIVED_SECTIONS_MISMATCH", "CRITICAL", "S6Q evidence derived analyses do not match an independent reconstruction from the current immutable sample.");\n    }\n    if (options.previousEvidenceDigestAnchorSha256\n      && validStoredEvidence.evidenceDigestSha256 !== options.previousEvidenceDigestAnchorSha256) {\n      pushIssue(issues, "EVIDENCE_DIGEST_ANCHOR_CHANGED", "CRITICAL", "The append-only evidence digest differs from its previously persisted anchor.");\n    }\n    if (!hasAllS6qEvidenceChecks(validStoredEvidence.checks)) {\n      pushIssue(issues, "EVIDENCE_CHECK_FLAGS_INVALID", "CRITICAL", "S6Q evidence contains a failed or missing named verification assertion.");\n    }`,
  "derived evidence reconstruction and anchor",
);

service = replaceOnce(
  service,
  `  const stableAcrossRuns = Boolean(\n    effectiveBaseline\n      && certificate\n      && effectiveBaseline.certificateDigestSha256 === certificate.certificateDigestSha256\n      && stableForMs != null\n      && stableForMs >= minimumStabilityMs,\n  );`,
  `  const stableAcrossRuns = Boolean(\n    effectiveBaseline\n      && certificate\n      && effectiveBaseline.certificateDigestSha256 === certificate.certificateDigestSha256\n      && stableForMs != null\n      && stableForMs >= minimumStabilityMs,\n  );\n  const baselineEverObserved = previousBaselineEverObserved || Boolean(effectiveBaseline);\n  const evidenceEverObserved = previousEvidenceEverObserved || Boolean(effectiveEvidence);\n  const baselineFirstObservedAtAnchor = options.previousBaselineFirstObservedAtAnchor\n    ?? effectiveBaseline?.firstObservedAt\n    ?? null;\n  const baselineDigestAnchorSha256 = options.previousBaselineDigestAnchorSha256\n    ?? effectiveBaseline?.baselineDigestSha256\n    ?? null;\n  const evidenceDigestAnchorSha256 = options.previousEvidenceDigestAnchorSha256\n    ?? effectiveEvidence?.evidenceDigestSha256\n    ?? null;`,
  "report anchor derivation",
);

service = replaceOnce(
  service,
  `    stability: {\n      baselinePresent: Boolean(effectiveBaseline),\n      evidencePresent: Boolean(effectiveEvidence),\n      firstObservedAt: effectiveBaseline?.firstObservedAt ?? null,`,
  `    stability: {\n      baselinePresent: Boolean(effectiveBaseline),\n      evidencePresent: Boolean(effectiveEvidence),\n      baselineEverObserved,\n      evidenceEverObserved,\n      baselineFirstObservedAtAnchor,\n      baselineDigestAnchorSha256,\n      evidenceDigestAnchorSha256,\n      firstObservedAt: effectiveBaseline?.firstObservedAt ?? null,`,
  "report stability anchors",
);

service = replaceOnce(
  service,
  `    && typeof value.stability.baselinePresent === "boolean"\n    && typeof value.stability.evidencePresent === "boolean"\n    && isObjectRecord(value.checks)`,
  `    && typeof value.stability.baselinePresent === "boolean"\n    && typeof value.stability.evidencePresent === "boolean"\n    && typeof value.stability.baselineEverObserved === "boolean"\n    && typeof value.stability.evidenceEverObserved === "boolean"\n    && (value.stability.baselineFirstObservedAtAnchor === null || typeof value.stability.baselineFirstObservedAtAnchor === "string")\n    && (value.stability.baselineDigestAnchorSha256 === null || typeof value.stability.baselineDigestAnchorSha256 === "string")\n    && (value.stability.evidenceDigestAnchorSha256 === null || typeof value.stability.evidenceDigestAnchorSha256 === "string")\n    && isObjectRecord(value.checks)`,
  "previous report anchor shape",
);

service = replaceOnce(
  service,
  `      const s6pReport = this.s6pMinimumSample.readLatest();\n      const certifiedTerminalPredictionIds = (this.s6kFirstTen.readLatest()?.evidence ?? [])\n        .filter((entry) => entry.state === "CERTIFIED")\n        .map((entry) => entry.target.terminalPredictionId)\n        .filter((entry): entry is string => Boolean(entry));`,
  `      const s6pReport = this.s6pMinimumSample.readLatest();\n      const s6kCertification = buildMlbS6qCertifiedTerminalPredictionIdsFromS6k(this.s6kFirstTen.readLatest());\n      const certifiedTerminalPredictionIds = s6kCertification.terminalPredictionIds;`,
  "S6K worker shape validation",
);

const workerOptionsBefore = `          previousBaselinePresent: previous?.stability.baselinePresent ?? false,\n          previousEvidencePresent: previous?.stability.evidencePresent ?? false,\n          previousReportReadError: previousArtifact.error,`;
const workerOptionsAfter = `          previousBaselinePresent: previous?.stability.baselinePresent ?? false,\n          previousEvidencePresent: previous?.stability.evidencePresent ?? false,\n          previousBaselineEverObserved: previous?.stability.baselineEverObserved ?? previous?.stability.baselinePresent ?? false,\n          previousEvidenceEverObserved: previous?.stability.evidenceEverObserved ?? previous?.stability.evidencePresent ?? false,\n          previousBaselineFirstObservedAtAnchor: previous?.stability.baselineFirstObservedAtAnchor ?? previous?.stability.firstObservedAt ?? null,\n          previousBaselineDigestAnchorSha256: previous?.stability.baselineDigestAnchorSha256 ?? null,\n          previousEvidenceDigestAnchorSha256: previous?.stability.evidenceDigestAnchorSha256 ?? null,\n          previousReportReadError: previousArtifact.error,\n          s6kReportReadError: s6kCertification.error,`;
if (!service.includes(workerOptionsBefore)) throw new Error("Missing initial worker options anchor");
service = service.replace(workerOptionsBefore, workerOptionsAfter);
if (!service.includes(workerOptionsBefore)) throw new Error("Missing refreshed worker options anchor");
service = service.replace(workerOptionsBefore, workerOptionsAfter);

fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  buildMlbS6qPreviousReportArtifact,\n  buildMlbS6qStoredArtifacts,`,
  `  buildMlbS6qCertifiedTerminalPredictionIdsFromS6k,\n  buildMlbS6qPreviousReportArtifact,\n  buildMlbS6qStoredArtifacts,`,
  "S6K helper test import",
);

const newTests = `

test("preserves irreversible artifact anchors across repeated disappearance runs", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  assert.ok(first.baselineToPersist);
  assert.equal(first.report.stability.baselineEverObserved, true);
  const disappearedOnce = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: null, evidence: null, baselinePresent: false, evidencePresent: false },
    {
      generatedAt: "2026-08-01T21:03:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousBaselineEverObserved: first.report.stability.baselineEverObserved,
      previousBaselineFirstObservedAtAnchor: first.report.stability.baselineFirstObservedAtAnchor,
      previousBaselineDigestAnchorSha256: first.report.stability.baselineDigestAnchorSha256,
    },
  );
  assert.equal(disappearedOnce.report.state, "ACTION_REQUIRED");
  assert.equal(disappearedOnce.report.stability.baselineEverObserved, true);
  const disappearedTwice = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: null, evidence: null, baselinePresent: false, evidencePresent: false },
    {
      generatedAt: "2026-08-01T21:04:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousBaselineEverObserved: disappearedOnce.report.stability.baselineEverObserved,
      previousBaselineFirstObservedAtAnchor: disappearedOnce.report.stability.baselineFirstObservedAtAnchor,
      previousBaselineDigestAnchorSha256: disappearedOnce.report.stability.baselineDigestAnchorSha256,
    },
  );
  assert.equal(disappearedTwice.report.state, "ACTION_REQUIRED");
  assert.equal(disappearedTwice.report.issues.some((entry) => entry.code === "BASELINE_DISAPPEARED_AFTER_OBSERVATION"), true);
  assert.equal(disappearedTwice.baselineToPersist, null);
});

test("rejects a baseline timestamp rewrite even with a recomputed digest", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  const tampered = structuredClone(first.baselineToPersist);
  tampered.firstObservedAt = "2020-01-01T00:00:00.000Z";
  const { baselineDigestSha256: _ignored, ...core } = tampered;
  tampered.baselineDigestSha256 = digest(core);
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: tampered, evidence: null },
    {
      generatedAt: "2026-08-01T21:03:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousBaselineEverObserved: true,
      previousBaselineFirstObservedAtAnchor: first.report.stability.baselineFirstObservedAtAnchor,
      previousBaselineDigestAnchorSha256: first.report.stability.baselineDigestAnchorSha256,
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_FIRST_OBSERVATION_CHANGED"), true);
  assert.equal(result.evidenceToPersist, null);
});

test("validates the S6K report before traversing its evidence", () => {
  for (const malformed of [{ evidence: {} }, { evidence: [null] }]) {
    const parsed = buildMlbS6qCertifiedTerminalPredictionIdsFromS6k(malformed);
    assert.deepEqual(parsed.terminalPredictionIds, []);
    assert.match(parsed.error ?? "", /incomplete or incompatible/);
  }
  const valid = buildMlbS6qCertifiedTerminalPredictionIdsFromS6k({
    evidence: [
      { state: "CERTIFIED", target: { terminalPredictionId: "final-1" } },
      { state: "WAITING_FOR_FINAL", target: { terminalPredictionId: "final-2" } },
    ],
  });
  assert.deepEqual(valid, { terminalPredictionIds: ["final-1"], error: null });
});

test("converts malformed S6K evidence into ACTION_REQUIRED", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    [],
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T21:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      s6kReportReadError: "fixture malformed S6K evidence",
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6K_REPORT_SHAPE_INVALID"), true);
});

test("reconstructs every derived evidence section independently", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !second.evidenceToPersist) throw new Error("fixture evidence missing");
  const tampered = structuredClone(second.evidenceToPersist);
  tampered.calibrationBuckets[0].sampleSize += 1;
  const { evidenceDigestSha256: _ignored, ...core } = tampered;
  tampered.evidenceDigestSha256 = digest(core);
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_DERIVED_SECTIONS_MISMATCH"), true);
});
`;
if (!tests.includes("preserves irreversible artifact anchors across repeated disappearance runs")) tests += newTests;
fs.writeFileSync(testPath, tests);

console.log("Applied S6Q final integrity anchors and reconstruction hardening.");

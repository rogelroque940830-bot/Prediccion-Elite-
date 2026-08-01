import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6p-first-twenty-settlements-certification.ts";
let service = fs.readFileSync(servicePath, "utf8");

const guardAnchor = `function exactStringArray(left: string[], right: string[]): boolean {\n`;
const guards = `function isObjectRecord(value: unknown): value is Record<string, unknown> {\n  return Boolean(value) && typeof value === "object" && !Array.isArray(value);\n}\n\nfunction isStringArray(value: unknown): value is string[] {\n  return Array.isArray(value) && value.every((entry) => typeof entry === "string");\n}\n\nfunction isS6pBaselineArtifactShape(value: unknown): value is S6pBaseline {\n  if (!isObjectRecord(value)) return false;\n  return typeof value.schemaVersion === "string"\n    && typeof value.firstObservedAt === "string"\n    && typeof value.firstObservedDeploymentCommit === "string"\n    && typeof value.sourceS6mGeneratedAt === "string"\n    && typeof value.sourceS6oGeneratedAt === "string"\n    && typeof value.certificateDigestSha256 === "string"\n    && typeof value.manifestDigestSha256 === "string"\n    && isStringArray(value.terminalPredictionIds)\n    && isStringArray(value.settlementEventIds)\n    && Array.isArray(value.results)\n    && value.results.every((entry) => entry === "WIN" || entry === "LOSS")\n    && typeof value.ownedLedgerRecordsAtFirstObservation === "number"\n    && typeof value.baselineDigestSha256 === "string";\n}\n\nfunction isS6pEvidenceArtifactShape(value: unknown): value is S6pEvidence {\n  if (!isObjectRecord(value)) return false;\n  const stability = value.stability;\n  const checks = value.checks;\n  return typeof value.schemaVersion === "string"\n    && typeof value.certifiedAt === "string"\n    && typeof value.deploymentCommit === "string"\n    && typeof value.environment === "string"\n    && typeof value.sourceS6mGeneratedAt === "string"\n    && typeof value.sourceS6mState === "string"\n    && typeof value.sourceS6oGeneratedAt === "string"\n    && typeof value.sourceS6oState === "string"\n    && typeof value.baselineDigestSha256 === "string"\n    && typeof value.certificateDigestSha256 === "string"\n    && typeof value.manifestDigestSha256 === "string"\n    && isObjectRecord(stability)\n    && typeof stability.firstObservedAt === "string"\n    && typeof stability.confirmedAt === "string"\n    && typeof stability.stableForMs === "number"\n    && typeof stability.minimumRequiredMs === "number"\n    && stability.distinctWorkerRuns === true\n    && Array.isArray(value.manifest)\n    && isObjectRecord(value.metrics)\n    && Array.isArray(value.marketBreakdowns)\n    && Array.isArray(value.signalBreakdowns)\n    && Array.isArray(value.calibrationBuckets)\n    && isObjectRecord(value.provisionalFinalComparison)\n    && typeof value.sampleAdequacy === "string"\n    && isObjectRecord(checks)\n    && typeof value.evidenceDigestSha256 === "string";\n}\n\n`;
service = replaceOnce(service, guardAnchor, guards + guardAnchor, "artifact shape guard anchor");

const validationStart = service.indexOf("\n  if (stored.baseline) {\n");
const validationEnd = service.indexOf("\n  const critical = issues.some", validationStart);
if (validationStart < 0 || validationEnd < 0) throw new Error("Unable to locate artifact validation section");
const robustValidation = `
  const validStoredBaseline = isS6pBaselineArtifactShape(stored.baseline) ? stored.baseline : null;
  const validStoredEvidence = isS6pEvidenceArtifactShape(stored.evidence) ? stored.evidence : null;

  if (stored.baseline && !validStoredBaseline) {
    pushIssue(
      issues,
      "BASELINE_SHAPE_INVALID",
      "CRITICAL",
      "The append-only twenty-result baseline is syntactically valid JSON but has an incomplete or incompatible shape.",
    );
  } else if (validStoredBaseline) {
    const baselineIdsValid = validStoredBaseline.terminalPredictionIds.length === MLB_S6P_TARGET_SIZE
      && validStoredBaseline.settlementEventIds.length === MLB_S6P_TARGET_SIZE
      && validStoredBaseline.results.length === MLB_S6P_TARGET_SIZE
      && new Set(validStoredBaseline.terminalPredictionIds).size === MLB_S6P_TARGET_SIZE
      && new Set(validStoredBaseline.settlementEventIds).size === MLB_S6P_TARGET_SIZE
      && validStoredBaseline.results.every((entry) => entry === "WIN" || entry === "LOSS");
    if (validStoredBaseline.schemaVersion !== MLB_S6P_BASELINE_VERSION
      || sha256(baselineCore(validStoredBaseline)) !== validStoredBaseline.baselineDigestSha256
      || !Number.isFinite(Date.parse(validStoredBaseline.firstObservedAt))
      || validStoredBaseline.ownedLedgerRecordsAtFirstObservation < 1
      || !baselineIdsValid) {
      pushIssue(issues, "BASELINE_INTEGRITY_INVALID", "CRITICAL", "The append-only twenty-result baseline failed integrity or semantic validation.");
    }
  }

  if (stored.evidence && !validStoredEvidence) {
    pushIssue(
      issues,
      "EVIDENCE_SHAPE_INVALID",
      "CRITICAL",
      "The append-only twenty-result evidence is syntactically valid JSON but has an incomplete or incompatible shape.",
    );
  } else if (validStoredEvidence) {
    if (validStoredEvidence.schemaVersion !== MLB_S6P_EVIDENCE_VERSION
      || sha256(evidenceCore(validStoredEvidence)) !== validStoredEvidence.evidenceDigestSha256) {
      pushIssue(issues, "EVIDENCE_DIGEST_INVALID", "CRITICAL", "The append-only twenty-result evidence failed integrity validation.");
    }
    if (!validStoredBaseline) {
      pushIssue(issues, "EVIDENCE_WITHOUT_BASELINE", "CRITICAL", "S6P evidence exists without a valid append-only baseline.");
    } else {
      const firstObservedMs = Date.parse(validStoredEvidence.stability.firstObservedAt);
      const confirmedMs = Date.parse(validStoredEvidence.stability.confirmedAt);
      const measuredStableMs = confirmedMs - firstObservedMs;
      const validLink = validStoredEvidence.baselineDigestSha256 === validStoredBaseline.baselineDigestSha256
        && validStoredEvidence.stability.firstObservedAt === validStoredBaseline.firstObservedAt
        && Number.isFinite(firstObservedMs)
        && Number.isFinite(confirmedMs)
        && measuredStableMs >= validStoredEvidence.stability.minimumRequiredMs
        && validStoredEvidence.stability.stableForMs === measuredStableMs;
      if (!validLink) {
        pushIssue(issues, "EVIDENCE_BASELINE_LINK_INVALID", "CRITICAL", "S6P evidence does not preserve a valid stability link to its baseline.");
      }
    }
    if (!Object.values(validStoredEvidence.checks).every((value) => value === true)) {
      pushIssue(issues, "EVIDENCE_CHECK_FLAGS_INVALID", "CRITICAL", "S6P evidence contains a failed or missing verification assertion.");
    }
    if (validStoredEvidence.sampleAdequacy !== "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS") {
      pushIssue(issues, "EVIDENCE_SAMPLE_ADEQUACY_INVALID", "CRITICAL", "S6P evidence overstates the scientific maturity of a twenty-result sample.");
    }
    if (certificate && (
      validStoredEvidence.certificateDigestSha256 !== certificate.certificateDigestSha256
      || validStoredEvidence.manifestDigestSha256 !== certificate.manifestDigestSha256
      || canonicalDigest(validStoredEvidence.manifest) !== canonicalDigest(certificate.manifest)
      || canonicalDigest(validStoredEvidence.metrics) !== canonicalDigest(certificate.metrics)
    )) {
      pushIssue(issues, "EVIDENCE_CERTIFICATE_LINK_INVALID", "CRITICAL", "S6P evidence no longer matches the immutable milestone 20 certificate.");
    }
  }

  if (certificate && validStoredBaseline) {
    const certificateTerminalIds = certificate.manifest.map((entry) => entry.terminalPredictionId);
    const certificateSettlementIds = certificate.manifest.map((entry) => entry.settlementEventId);
    if (validStoredBaseline.certificateDigestSha256 !== certificate.certificateDigestSha256
      || validStoredBaseline.manifestDigestSha256 !== certificate.manifestDigestSha256
      || !exactStringArray(validStoredBaseline.terminalPredictionIds, certificateTerminalIds)
      || !exactStringArray(validStoredBaseline.settlementEventIds, certificateSettlementIds)) {
      pushIssue(issues, "CERTIFICATE_CHANGED_AFTER_FIRST_OBSERVATION", "CRITICAL", "Milestone 20 identity changed after the append-only baseline was recorded.");
    }
  }
`;
service = service.slice(0, validationStart) + robustValidation + service.slice(validationEnd);

service = replaceOnce(
  service,
  `    if (!stored.baseline) {\n      baselineToPersist = makeBaseline(`,
  `    if (!validStoredBaseline) {\n      baselineToPersist = makeBaseline(`,
  "valid baseline creation gate",
);
service = replaceOnce(
  service,
  `    } else if (!stored.evidence) {\n      const stableForMs = Date.parse(generatedAt) - Date.parse(stored.baseline.firstObservedAt);`,
  `    } else if (!validStoredEvidence) {\n      const stableForMs = Date.parse(generatedAt) - Date.parse(validStoredBaseline.firstObservedAt);`,
  "valid evidence creation gate",
);
service = replaceOnce(
  service,
  `          stored.baseline,\n          s6mReport,`,
  `          validStoredBaseline,\n          s6mReport,`,
  "valid baseline evidence input",
);
service = replaceOnce(
  service,
  `  const effectiveBaseline = stored.baseline ?? baselineToPersist;\n  const effectiveEvidence = stored.evidence ?? evidenceToPersist;`,
  `  const effectiveBaseline = validStoredBaseline ?? baselineToPersist;\n  const effectiveEvidence = validStoredEvidence ?? evidenceToPersist;`,
  "valid effective artifacts",
);
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6p-first-twenty-settlements-certification.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
const newTests = `

test("turns a syntactically valid but malformed baseline into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const malformed = {} as S6pBaseline;
  const result = evaluate(records, report, certificates, { baseline: malformed });
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_SHAPE_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});

test("turns syntactically valid but malformed evidence into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  const malformed = {} as S6pEvidence;
  const result = evaluate(
    records,
    report,
    certificates,
    { baseline: first.baselineToPersist, evidence: malformed },
    "2026-08-01T21:03:00.000Z",
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_SHAPE_INVALID"), true);
  assert.equal(result.evidenceToPersist, null);
});
`;
if (!tests.includes('malformed baseline into ACTION_REQUIRED')) tests += newTests;
fs.writeFileSync(testPath, tests);
console.log("Applied S6P artifact shape validation hotfix.");

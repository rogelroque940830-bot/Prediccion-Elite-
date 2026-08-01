import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6p-first-twenty-settlements-certification.ts";
let service = fs.readFileSync(servicePath, "utf8");

service = replaceOnce(
  service,
  `type StoredArtifacts = {\n  baseline: S6pBaseline | null;\n  evidence: S6pEvidence | null;\n  baselineReadError?: string | null;\n  evidenceReadError?: string | null;\n};`,
  `type StoredArtifacts = {\n  baseline: S6pBaseline | null;\n  evidence: S6pEvidence | null;\n  baselinePresent?: boolean;\n  evidencePresent?: boolean;\n  baselineReadError?: string | null;\n  evidenceReadError?: string | null;\n};`,
  "stored artifact presence fields",
);

service = replaceOnce(
  service,
  `  const selected = sample.binaryObservations.slice(0, MLB_S6P_TARGET_SIZE);\n  const issues: S6pReport["issues"] = [];`,
  `  const selected = sample.binaryObservations.slice(0, MLB_S6P_TARGET_SIZE);\n  const baselinePresent = stored.baselinePresent\n    ?? (stored.baseline !== null && stored.baseline !== undefined);\n  const evidencePresent = stored.evidencePresent\n    ?? (stored.evidence !== null && stored.evidence !== undefined);\n  const issues: S6pReport["issues"] = [];`,
  "artifact presence evaluation",
);

service = replaceOnce(
  service,
  `  if (stored.baseline && !validStoredBaseline) {`,
  `  if (baselinePresent && !validStoredBaseline) {`,
  "baseline presence shape gate",
);
service = replaceOnce(
  service,
  `  if (stored.evidence && !validStoredEvidence) {`,
  `  if (evidencePresent && !validStoredEvidence) {`,
  "evidence presence shape gate",
);

service = replaceOnce(
  service,
  `function readJsonArtifact<T>(filePath: string): { value: T | null; error: string | null } {\n  if (!fs.existsSync(filePath)) return { value: null, error: null };\n  try {\n    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) as T, error: null };\n  } catch (error) {\n    return {\n      value: null,\n      error: \`Unable to read \${path.basename(filePath)}: \${error instanceof Error ? error.message : String(error)}\`,\n    };\n  }\n}`,
  `function readJsonArtifact<T>(filePath: string): { value: T | null; error: string | null; present: boolean } {\n  if (!fs.existsSync(filePath)) return { value: null, error: null, present: false };\n  try {\n    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) as T, error: null, present: true };\n  } catch (error) {\n    return {\n      value: null,\n      error: \`Unable to read \${path.basename(filePath)}: \${error instanceof Error ? error.message : String(error)}\`,\n      present: true,\n    };\n  }\n}`,
  "presence-aware artifact reader",
);

service = replaceOnce(
  service,
  `          baseline: baselineArtifact.value,\n          evidence: evidenceArtifact.value,\n          baselineReadError: baselineArtifact.error,\n          evidenceReadError: evidenceArtifact.error,`,
  `          baseline: baselineArtifact.value,\n          evidence: evidenceArtifact.value,\n          baselinePresent: baselineArtifact.present,\n          evidencePresent: evidenceArtifact.present,\n          baselineReadError: baselineArtifact.error,\n          evidenceReadError: evidenceArtifact.error,`,
  "service artifact presence wiring",
);
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6p-first-twenty-settlements-certification.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `function evaluate(records: LedgerRecord[], report: S6mMilestoneReport | null, certificates: S6mCertificateMap, stored: { baseline?: S6pBaseline | null; evidence?: S6pEvidence | null; baselineReadError?: string | null; evidenceReadError?: string | null } = {}, generatedAt = "2026-08-01T21:02:00.000Z", s6oReport: S6oReport | null = certifiedS6oReport(), previousOwnedLedgerRecords: number | null = null) {\n  return evaluateMlbS6pFirstTwentySettlements(records, report, certificates, s6oReport, terminalIds(20), { baseline: stored.baseline ?? null, evidence: stored.evidence ?? null, baselineReadError: stored.baselineReadError, evidenceReadError: stored.evidenceReadError }, { generatedAt, deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords });\n}`,
  `function evaluate(records: LedgerRecord[], report: S6mMilestoneReport | null, certificates: S6mCertificateMap, stored: { baseline?: S6pBaseline | null; evidence?: S6pEvidence | null; baselinePresent?: boolean; evidencePresent?: boolean; baselineReadError?: string | null; evidenceReadError?: string | null } = {}, generatedAt = "2026-08-01T21:02:00.000Z", s6oReport: S6oReport | null = certifiedS6oReport(), previousOwnedLedgerRecords: number | null = null) {\n  return evaluateMlbS6pFirstTwentySettlements(records, report, certificates, s6oReport, terminalIds(20), { baseline: stored.baseline ?? null, evidence: stored.evidence ?? null, baselinePresent: stored.baselinePresent, evidencePresent: stored.evidencePresent, baselineReadError: stored.baselineReadError, evidenceReadError: stored.evidenceReadError }, { generatedAt, deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords });\n}`,
  "test evaluation presence wiring",
);

const falsyTests = `

test("rejects every falsy but present baseline JSON artifact", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  for (const malformed of [false, 0, "", null]) {
    const result = evaluate(records, report, certificates, {
      baseline: malformed as unknown as S6pBaseline,
      baselinePresent: true,
    });
    assert.equal(result.report.state, "ACTION_REQUIRED");
    assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_SHAPE_INVALID"), true);
    assert.equal(result.baselineToPersist, null);
  }
});

test("rejects every falsy but present evidence JSON artifact without synthesizing certification", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  for (const malformed of [false, 0, "", null]) {
    const result = evaluate(
      records,
      report,
      certificates,
      {
        baseline: first.baselineToPersist,
        evidence: malformed as unknown as S6pEvidence,
        evidencePresent: true,
      },
      "2026-08-01T21:03:00.000Z",
    );
    assert.equal(result.report.state, "ACTION_REQUIRED");
    assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_SHAPE_INVALID"), true);
    assert.equal(result.report.readiness.minimumSample20Certified, false);
    assert.equal(result.evidenceToPersist, null);
  }
});
`;
if (!tests.includes("rejects every falsy but present baseline JSON artifact")) tests += falsyTests;
fs.writeFileSync(testPath, tests);
console.log("Applied S6P artifact presence validation patch.");

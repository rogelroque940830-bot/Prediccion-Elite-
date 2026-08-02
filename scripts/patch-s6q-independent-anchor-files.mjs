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
  `export const MLB_S6Q_EVIDENCE_VERSION = "mlb-s6q-fifty-settlement-human-review-evidence.v1" as const;\nexport const MLB_S6Q_TARGET_SIZE = 50 as const;`,
  `export const MLB_S6Q_EVIDENCE_VERSION = "mlb-s6q-fifty-settlement-human-review-evidence.v1" as const;\nexport const MLB_S6Q_BASELINE_ANCHOR_VERSION = "mlb-s6q-baseline-observation-anchor.v1" as const;\nexport const MLB_S6Q_EVIDENCE_ANCHOR_VERSION = "mlb-s6q-evidence-certification-anchor.v1" as const;\nexport const MLB_S6Q_TARGET_SIZE = 50 as const;`,
  "anchor schema constants",
);

service = replaceOnce(
  service,
  `export type S6qBreakdown = {`,
  `export type S6qBaselineAnchor = {\n  schemaVersion: typeof MLB_S6Q_BASELINE_ANCHOR_VERSION;\n  createdAt: string;\n  firstObservedAt: string;\n  baselineDigestSha256: string;\n  anchorDigestSha256: string;\n};\n\nexport type S6qEvidenceAnchor = {\n  schemaVersion: typeof MLB_S6Q_EVIDENCE_ANCHOR_VERSION;\n  createdAt: string;\n  certifiedAt: string;\n  evidenceDigestSha256: string;\n  anchorDigestSha256: string;\n};\n\nexport type S6qBreakdown = {`,
  "anchor types",
);

service = replaceOnce(
  service,
  `type StoredArtifacts = {\n  baseline: S6qBaseline | null;`,
  `type StoredAnchors = {\n  baseline: S6qBaselineAnchor | null;\n  evidence: S6qEvidenceAnchor | null;\n  baselinePresent?: boolean;\n  evidencePresent?: boolean;\n  baselineReadError?: string | null;\n  evidenceReadError?: string | null;\n};\n\ntype StoredArtifacts = {\n  baseline: S6qBaseline | null;`,
  "stored anchor type",
);

service = replaceOnce(
  service,
  `  evidenceDigestAnchorSha256?: string | null;\n  previousReportReadError?: string | null;`,
  `  evidenceDigestAnchorSha256?: string | null;\n  anchors?: StoredAnchors;\n  previousReportReadError?: string | null;`,
  "evaluation anchor input",
);

service = replaceOnce(
  service,
  `type EvaluationResult = {\n  report: S6qReport;\n  baselineToPersist: S6qBaseline | null;\n  evidenceToPersist: S6qEvidence | null;\n};`,
  `type EvaluationResult = {\n  report: S6qReport;\n  baselineToPersist: S6qBaseline | null;\n  evidenceToPersist: S6qEvidence | null;\n  baselineAnchorToPersist: S6qBaselineAnchor | null;\n  evidenceAnchorToPersist: S6qEvidenceAnchor | null;\n};`,
  "evaluation result anchors",
);

service = replaceOnce(
  service,
  `function evidenceCore(evidence: S6qEvidence): Omit<S6qEvidence, "evidenceDigestSha256"> {\n  const { evidenceDigestSha256: _ignored, ...core } = evidence;\n  return core;\n}`,
  `function evidenceCore(evidence: S6qEvidence): Omit<S6qEvidence, "evidenceDigestSha256"> {\n  const { evidenceDigestSha256: _ignored, ...core } = evidence;\n  return core;\n}\n\nfunction baselineAnchorCore(anchor: S6qBaselineAnchor): Omit<S6qBaselineAnchor, "anchorDigestSha256"> {\n  const { anchorDigestSha256: _ignored, ...core } = anchor;\n  return core;\n}\n\nfunction evidenceAnchorCore(anchor: S6qEvidenceAnchor): Omit<S6qEvidenceAnchor, "anchorDigestSha256"> {\n  const { anchorDigestSha256: _ignored, ...core } = anchor;\n  return core;\n}\n\nfunction makeBaselineAnchor(baseline: S6qBaseline, createdAt: string): S6qBaselineAnchor {\n  const core: Omit<S6qBaselineAnchor, "anchorDigestSha256"> = {\n    schemaVersion: MLB_S6Q_BASELINE_ANCHOR_VERSION,\n    createdAt,\n    firstObservedAt: baseline.firstObservedAt,\n    baselineDigestSha256: baseline.baselineDigestSha256,\n  };\n  return { ...core, anchorDigestSha256: sha256(core) };\n}\n\nfunction makeEvidenceAnchor(evidence: S6qEvidence, createdAt: string): S6qEvidenceAnchor {\n  const core: Omit<S6qEvidenceAnchor, "anchorDigestSha256"> = {\n    schemaVersion: MLB_S6Q_EVIDENCE_ANCHOR_VERSION,\n    createdAt,\n    certifiedAt: evidence.certifiedAt,\n    evidenceDigestSha256: evidence.evidenceDigestSha256,\n  };\n  return { ...core, anchorDigestSha256: sha256(core) };\n}\n\nfunction isS6qBaselineAnchorShape(value: unknown): value is S6qBaselineAnchor {\n  if (!isObjectRecord(value)) return false;\n  return value.schemaVersion === MLB_S6Q_BASELINE_ANCHOR_VERSION\n    && typeof value.createdAt === "string"\n    && typeof value.firstObservedAt === "string"\n    && typeof value.baselineDigestSha256 === "string"\n    && typeof value.anchorDigestSha256 === "string";\n}\n\nfunction isS6qEvidenceAnchorShape(value: unknown): value is S6qEvidenceAnchor {\n  if (!isObjectRecord(value)) return false;\n  return value.schemaVersion === MLB_S6Q_EVIDENCE_ANCHOR_VERSION\n    && typeof value.createdAt === "string"\n    && typeof value.certifiedAt === "string"\n    && typeof value.evidenceDigestSha256 === "string"\n    && typeof value.anchorDigestSha256 === "string";\n}`,
  "anchor helpers",
);

service = replaceOnce(
  service,
  `  const previousCount = options.previousOwnedLedgerRecords ?? null;\n  const previousBaselineEverObserved = options.previousBaselineEverObserved\n    ?? options.previousBaselinePresent\n    ?? false;\n  const previousEvidenceEverObserved = options.previousEvidenceEverObserved\n    ?? options.previousEvidencePresent\n    ?? false;`,
  `  const previousCount = options.previousOwnedLedgerRecords ?? null;\n  const storedAnchors = options.anchors ?? { baseline: null, evidence: null };\n  const baselineAnchorPresent = storedAnchors.baselinePresent\n    ?? (storedAnchors.baseline !== null && storedAnchors.baseline !== undefined);\n  const evidenceAnchorPresent = storedAnchors.evidencePresent\n    ?? (storedAnchors.evidence !== null && storedAnchors.evidence !== undefined);\n  const validBaselineAnchor = isS6qBaselineAnchorShape(storedAnchors.baseline)\n    && sha256(baselineAnchorCore(storedAnchors.baseline)) === storedAnchors.baseline.anchorDigestSha256\n    ? storedAnchors.baseline\n    : null;\n  const validEvidenceAnchor = isS6qEvidenceAnchorShape(storedAnchors.evidence)\n    && sha256(evidenceAnchorCore(storedAnchors.evidence)) === storedAnchors.evidence.anchorDigestSha256\n    ? storedAnchors.evidence\n    : null;\n  const previousBaselineEverObserved = Boolean(validBaselineAnchor)\n    || options.previousBaselineEverObserved\n    || options.previousBaselinePresent\n    || false;\n  const previousEvidenceEverObserved = Boolean(validEvidenceAnchor)\n    || options.previousEvidenceEverObserved\n    || options.previousEvidencePresent\n    || false;`,
  "independent anchor recovery",
);

service = replaceOnce(
  service,
  `  let baselineToPersist: S6qBaseline | null = null;\n  let evidenceToPersist: S6qEvidence | null = null;`,
  `  let baselineToPersist: S6qBaseline | null = null;\n  let evidenceToPersist: S6qEvidence | null = null;\n  let baselineAnchorToPersist: S6qBaselineAnchor | null = null;\n  let evidenceAnchorToPersist: S6qEvidenceAnchor | null = null;`,
  "anchor persistence variables",
);

service = replaceOnce(
  service,
  `  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);`,
  `  if (storedAnchors.baselineReadError) pushIssue(issues, "BASELINE_ANCHOR_UNREADABLE", "CRITICAL", storedAnchors.baselineReadError);\n  if (storedAnchors.evidenceReadError) pushIssue(issues, "EVIDENCE_ANCHOR_UNREADABLE", "CRITICAL", storedAnchors.evidenceReadError);\n  if (baselineAnchorPresent && !validBaselineAnchor) pushIssue(issues, "BASELINE_ANCHOR_INVALID", "CRITICAL", "The independent baseline observation anchor is malformed or failed its digest check.");\n  if (evidenceAnchorPresent && !validEvidenceAnchor) pushIssue(issues, "EVIDENCE_ANCHOR_INVALID", "CRITICAL", "The independent evidence certification anchor is malformed or failed its digest check.");\n  if (options.previousReportReadError) pushIssue(issues, "PREVIOUS_REPORT_INVALID", "CRITICAL", options.previousReportReadError);`,
  "anchor integrity issues",
);

service = replaceOnce(
  service,
  `    if (options.previousBaselineFirstObservedAtAnchor\n      && validStoredBaseline.firstObservedAt !== options.previousBaselineFirstObservedAtAnchor) {`,
  `    const expectedFirstObservedAtAnchor = validBaselineAnchor?.firstObservedAt\n      ?? options.previousBaselineFirstObservedAtAnchor\n      ?? null;\n    const expectedBaselineDigestAnchor = validBaselineAnchor?.baselineDigestSha256\n      ?? options.previousBaselineDigestAnchorSha256\n      ?? null;\n    if (expectedFirstObservedAtAnchor\n      && validStoredBaseline.firstObservedAt !== expectedFirstObservedAtAnchor) {`,
  "baseline anchor precedence",
);
service = service.replace(
  `    if (options.previousBaselineDigestAnchorSha256\n      && validStoredBaseline.baselineDigestSha256 !== options.previousBaselineDigestAnchorSha256) {`,
  `    if (expectedBaselineDigestAnchor\n      && validStoredBaseline.baselineDigestSha256 !== expectedBaselineDigestAnchor) {`,
);

service = replaceOnce(
  service,
  `    if (options.previousEvidenceDigestAnchorSha256\n      && validStoredEvidence.evidenceDigestSha256 !== options.previousEvidenceDigestAnchorSha256) {`,
  `    const expectedEvidenceDigestAnchor = validEvidenceAnchor?.evidenceDigestSha256\n      ?? options.previousEvidenceDigestAnchorSha256\n      ?? null;\n    if (expectedEvidenceDigestAnchor\n      && validStoredEvidence.evidenceDigestSha256 !== expectedEvidenceDigestAnchor) {`,
  "evidence anchor precedence",
);

service = replaceOnce(
  service,
  `      baselineToPersist = makeBaseline(\n        certificate,\n        currentOwnedLedgerRecords,\n        generatedAt,\n        deploymentCommit,\n        s6mReport.generatedAt,\n        s6pReport.generatedAt,\n      );`,
  `      baselineToPersist = makeBaseline(\n        certificate,\n        currentOwnedLedgerRecords,\n        generatedAt,\n        deploymentCommit,\n        s6mReport.generatedAt,\n        s6pReport.generatedAt,\n      );\n      if (!validBaselineAnchor && !baselineAnchorPresent) {\n        baselineAnchorToPersist = makeBaselineAnchor(baselineToPersist, generatedAt);\n      }`,
  "baseline anchor creation",
);
service = replaceOnce(
  service,
  `        evidenceToPersist = makeEvidence(\n          certificate,\n          validStoredBaseline,\n          s6mReport,\n          s6pReport,\n          selected,\n          records,\n          generatedAt,\n          deploymentCommit,\n          environment,\n          minimumStabilityMs,\n        );`,
  `        evidenceToPersist = makeEvidence(\n          certificate,\n          validStoredBaseline,\n          s6mReport,\n          s6pReport,\n          selected,\n          records,\n          generatedAt,\n          deploymentCommit,\n          environment,\n          minimumStabilityMs,\n        );\n        if (!validEvidenceAnchor && !evidenceAnchorPresent) {\n          evidenceAnchorToPersist = makeEvidenceAnchor(evidenceToPersist, generatedAt);\n        }`,
  "evidence anchor creation",
);

service = replaceOnce(
  service,
  `  const baselineFirstObservedAtAnchor = options.previousBaselineFirstObservedAtAnchor\n    ?? effectiveBaseline?.firstObservedAt\n    ?? null;\n  const baselineDigestAnchorSha256 = options.previousBaselineDigestAnchorSha256\n    ?? effectiveBaseline?.baselineDigestSha256\n    ?? null;\n  const evidenceDigestAnchorSha256 = options.previousEvidenceDigestAnchorSha256\n    ?? effectiveEvidence?.evidenceDigestSha256\n    ?? null;`,
  `  const baselineFirstObservedAtAnchor = validBaselineAnchor?.firstObservedAt\n    ?? baselineAnchorToPersist?.firstObservedAt\n    ?? options.previousBaselineFirstObservedAtAnchor\n    ?? effectiveBaseline?.firstObservedAt\n    ?? null;\n  const baselineDigestAnchorSha256 = validBaselineAnchor?.baselineDigestSha256\n    ?? baselineAnchorToPersist?.baselineDigestSha256\n    ?? options.previousBaselineDigestAnchorSha256\n    ?? effectiveBaseline?.baselineDigestSha256\n    ?? null;\n  const evidenceDigestAnchorSha256 = validEvidenceAnchor?.evidenceDigestSha256\n    ?? evidenceAnchorToPersist?.evidenceDigestSha256\n    ?? options.previousEvidenceDigestAnchorSha256\n    ?? effectiveEvidence?.evidenceDigestSha256\n    ?? null;`,
  "independent anchor report values",
);

service = replaceOnce(
  service,
  `  return { report, baselineToPersist, evidenceToPersist };`,
  `  return { report, baselineToPersist, evidenceToPersist, baselineAnchorToPersist, evidenceAnchorToPersist };`,
  "evaluation return anchors",
);

service = replaceOnce(
  service,
  `export function buildMlbS6qStoredArtifacts(\n  baselineArtifact: { value: S6qBaseline | null; error: string | null; present: boolean },`,
  `export function buildMlbS6qStoredAnchors(\n  baselineArtifact: { value: S6qBaselineAnchor | null; error: string | null; present: boolean },\n  evidenceArtifact: { value: S6qEvidenceAnchor | null; error: string | null; present: boolean },\n): StoredAnchors {\n  return {\n    baseline: baselineArtifact.value,\n    evidence: evidenceArtifact.value,\n    baselinePresent: baselineArtifact.present,\n    evidencePresent: evidenceArtifact.present,\n    baselineReadError: baselineArtifact.error,\n    evidenceReadError: evidenceArtifact.error,\n  };\n}\n\nexport function buildMlbS6qStoredArtifacts(\n  baselineArtifact: { value: S6qBaseline | null; error: string | null; present: boolean },`,
  "stored anchor adapter",
);

service = replaceOnce(
  service,
  `      const baselineArtifact = readJsonArtifact<S6qBaseline>(path.join(this.root, "baseline.json"));\n      const evidenceArtifact = readJsonArtifact<S6qEvidence>(path.join(this.root, "evidence.json"));`,
  `      const baselineArtifact = readJsonArtifact<S6qBaseline>(path.join(this.root, "baseline.json"));\n      const evidenceArtifact = readJsonArtifact<S6qEvidence>(path.join(this.root, "evidence.json"));\n      const baselineAnchorArtifact = readJsonArtifact<S6qBaselineAnchor>(path.join(this.root, "baseline-observation-anchor.json"));\n      const evidenceAnchorArtifact = readJsonArtifact<S6qEvidenceAnchor>(path.join(this.root, "evidence-certification-anchor.json"));\n      const storedAnchors = buildMlbS6qStoredAnchors(baselineAnchorArtifact, evidenceAnchorArtifact);`,
  "worker anchor reads",
);

const anchorOption = `          anchors: storedAnchors,\n`;
const initialOptionsAnchor = `          previousReportReadError: previousArtifact.error,\n          s6kReportReadError: s6kCertification.error,`;
if (!service.includes(initialOptionsAnchor)) throw new Error("Missing initial evaluation options anchor");
service = service.replace(initialOptionsAnchor, anchorOption + initialOptionsAnchor);
if (!service.includes(initialOptionsAnchor)) throw new Error("Missing refreshed evaluation options anchor");
service = service.replace(initialOptionsAnchor, anchorOption + initialOptionsAnchor);

service = replaceOnce(
  service,
  `      if (evaluation.baselineToPersist) {`,
  `      if (evaluation.baselineAnchorToPersist) {\n        try {\n          writeAppendOnlyJson(path.join(this.root, "baseline-observation-anchor.json"), evaluation.baselineAnchorToPersist);\n        } catch (error: any) {\n          if (error?.code !== "EEXIST") throw error;\n        }\n      }\n      if (evaluation.baselineToPersist) {`,
  "baseline anchor write",
);
service = replaceOnce(
  service,
  `      if (evaluation.evidenceToPersist) {`,
  `      if (evaluation.evidenceAnchorToPersist) {\n        try {\n          writeAppendOnlyJson(path.join(this.root, "evidence-certification-anchor.json"), evaluation.evidenceAnchorToPersist);\n        } catch (error: any) {\n          if (error?.code !== "EEXIST") throw error;\n        }\n      }\n      if (evaluation.evidenceToPersist) {`,
  "evidence anchor write",
);

service = replaceOnce(
  service,
  `      const refreshedBaseline = readJsonArtifact<S6qBaseline>(path.join(this.root, "baseline.json"));\n      const refreshedEvidence = readJsonArtifact<S6qEvidence>(path.join(this.root, "evidence.json"));\n      const finalEvaluation = evaluation.baselineToPersist || evaluation.evidenceToPersist`,
  `      const refreshedBaseline = readJsonArtifact<S6qBaseline>(path.join(this.root, "baseline.json"));\n      const refreshedEvidence = readJsonArtifact<S6qEvidence>(path.join(this.root, "evidence.json"));\n      const refreshedBaselineAnchor = readJsonArtifact<S6qBaselineAnchor>(path.join(this.root, "baseline-observation-anchor.json"));\n      const refreshedEvidenceAnchor = readJsonArtifact<S6qEvidenceAnchor>(path.join(this.root, "evidence-certification-anchor.json"));\n      const refreshedAnchors = buildMlbS6qStoredAnchors(refreshedBaselineAnchor, refreshedEvidenceAnchor);\n      const finalEvaluation = evaluation.baselineToPersist || evaluation.evidenceToPersist\n        || evaluation.baselineAnchorToPersist || evaluation.evidenceAnchorToPersist`,
  "refreshed anchor reads",
);

const secondAnchorOption = `            anchors: refreshedAnchors,\n`;
const refreshedOptionsAnchor = `            previousReportReadError: previousArtifact.error,\n            s6kReportReadError: s6kCertification.error,`;
if (!service.includes(refreshedOptionsAnchor)) throw new Error("Missing refreshed anchor options");
service = service.replace(refreshedOptionsAnchor, secondAnchorOption + refreshedOptionsAnchor);

fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  buildMlbS6qPreviousReportArtifact,\n  buildMlbS6qStoredArtifacts,`,
  `  buildMlbS6qPreviousReportArtifact,\n  buildMlbS6qStoredAnchors,\n  buildMlbS6qStoredArtifacts,`,
  "anchor test import",
);

const testsToAdd = `

test("recovers irreversible history from independent anchors when latest.json is invalid", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist || !first.baselineAnchorToPersist) throw new Error("fixture baseline anchor missing");
  const anchors = buildMlbS6qStoredAnchors(
    { value: first.baselineAnchorToPersist, error: null, present: true },
    { value: null, error: null, present: false },
  );
  const missing = evaluateMlbS6qFiftySettlementHumanReview(
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
      anchors,
      previousReportReadError: "latest.json malformed",
    },
  );
  assert.equal(missing.report.state, "ACTION_REQUIRED");
  assert.equal(missing.report.stability.baselineEverObserved, true);
  assert.equal(missing.report.stability.baselineDigestAnchorSha256, first.baselineAnchorToPersist.baselineDigestSha256);
  assert.equal(missing.report.issues.some((entry) => entry.code === "BASELINE_DISAPPEARED_AFTER_OBSERVATION"), true);
  assert.equal(missing.baselineToPersist, null);
});

test("rejects malformed independent anchor files", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T21:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      anchors: { baseline: {} as any, evidence: null, baselinePresent: true, evidencePresent: false },
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_ANCHOR_INVALID"), true);
});
`;
if (!tests.includes("recovers irreversible history from independent anchors")) tests += testsToAdd;
fs.writeFileSync(testPath, tests);
console.log("Applied independent S6Q append-only anchor files.");

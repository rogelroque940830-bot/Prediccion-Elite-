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
  `export const MLB_S6Q_EVIDENCE_ANCHOR_VERSION = "mlb-s6q-evidence-certification-anchor.v1" as const;\nexport const MLB_S6Q_TARGET_SIZE = 50 as const;`,
  `export const MLB_S6Q_EVIDENCE_ANCHOR_VERSION = "mlb-s6q-evidence-certification-anchor.v1" as const;\nexport const MLB_S6Q_LEDGER_COUNT_ANCHOR_VERSION = "mlb-s6q-ledger-count-anchor.v1" as const;\nexport const MLB_S6Q_TARGET_SIZE = 50 as const;`,
  "ledger count anchor schema",
);

service = replaceOnce(
  service,
  `export type S6qBreakdown = {`,
  `export type S6qLedgerCountAnchor = {\n  schemaVersion: typeof MLB_S6Q_LEDGER_COUNT_ANCHOR_VERSION;\n  createdAt: string;\n  ownedLedgerRecords: number;\n  previousOwnedLedgerRecords: number | null;\n  previousAnchorDigestSha256: string | null;\n  anchorDigestSha256: string;\n};\n\nexport type S6qBreakdown = {`,
  "ledger count anchor type",
);

service = replaceOnce(
  service,
  `    evidenceAppendOnly: true;\n  };`,
  `    evidenceAppendOnly: true;\n    ledgerCountJournalAppendOnly: true;\n    ledgerCountAnchorPresent: boolean;\n    ledgerCountAnchorRecords: number | null;\n    ledgerCountAnchorDigestSha256: string | null;\n  };`,
  "report persistence ledger anchor",
);

service = replaceOnce(
  service,
  `  anchors?: StoredAnchors;\n  previousReportReadError?: string | null;`,
  `  anchors?: StoredAnchors;\n  ledgerCountAnchor?: {\n    value: S6qLedgerCountAnchor | null;\n    present: boolean;\n    error: string | null;\n  };\n  previousReportReadError?: string | null;`,
  "evaluation ledger anchor input",
);

service = replaceOnce(
  service,
  `  evidenceAnchorToPersist: S6qEvidenceAnchor | null;\n};`,
  `  evidenceAnchorToPersist: S6qEvidenceAnchor | null;\n  ledgerCountAnchorToPersist: S6qLedgerCountAnchor | null;\n};`,
  "evaluation ledger anchor output",
);

service = replaceOnce(
  service,
  `function isS6qEvidenceAnchorShape(value: unknown): value is S6qEvidenceAnchor {\n  if (!isObjectRecord(value)) return false;\n  return value.schemaVersion === MLB_S6Q_EVIDENCE_ANCHOR_VERSION\n    && typeof value.createdAt === "string"\n    && typeof value.certifiedAt === "string"\n    && typeof value.evidenceDigestSha256 === "string"\n    && typeof value.anchorDigestSha256 === "string";\n}`,
  `function isS6qEvidenceAnchorShape(value: unknown): value is S6qEvidenceAnchor {\n  if (!isObjectRecord(value)) return false;\n  return value.schemaVersion === MLB_S6Q_EVIDENCE_ANCHOR_VERSION\n    && typeof value.createdAt === "string"\n    && typeof value.certifiedAt === "string"\n    && typeof value.evidenceDigestSha256 === "string"\n    && typeof value.anchorDigestSha256 === "string";\n}\n\nfunction ledgerCountAnchorCore(anchor: S6qLedgerCountAnchor): Omit<S6qLedgerCountAnchor, "anchorDigestSha256"> {\n  const { anchorDigestSha256: _ignored, ...core } = anchor;\n  return core;\n}\n\nfunction isS6qLedgerCountAnchorShape(value: unknown): value is S6qLedgerCountAnchor {\n  if (!isObjectRecord(value)) return false;\n  return value.schemaVersion === MLB_S6Q_LEDGER_COUNT_ANCHOR_VERSION\n    && typeof value.createdAt === "string"\n    && Number.isInteger(value.ownedLedgerRecords)\n    && Number(value.ownedLedgerRecords) >= 0\n    && (value.previousOwnedLedgerRecords === null || Number.isInteger(value.previousOwnedLedgerRecords))\n    && (value.previousAnchorDigestSha256 === null || typeof value.previousAnchorDigestSha256 === "string")\n    && typeof value.anchorDigestSha256 === "string";\n}\n\nfunction makeLedgerCountAnchor(\n  ownedLedgerRecords: number,\n  previous: S6qLedgerCountAnchor | null,\n  createdAt: string,\n): S6qLedgerCountAnchor {\n  const core: Omit<S6qLedgerCountAnchor, "anchorDigestSha256"> = {\n    schemaVersion: MLB_S6Q_LEDGER_COUNT_ANCHOR_VERSION,\n    createdAt,\n    ownedLedgerRecords,\n    previousOwnedLedgerRecords: previous?.ownedLedgerRecords ?? null,\n    previousAnchorDigestSha256: previous?.anchorDigestSha256 ?? null,\n  };\n  return { ...core, anchorDigestSha256: sha256(core) };\n}\n\nexport function buildMlbS6qLedgerCountAnchorArtifact(\n  value: unknown,\n  present: boolean,\n  error: string | null = null,\n): { value: S6qLedgerCountAnchor | null; present: boolean; error: string | null } {\n  if (error) return { value: null, present, error };\n  if (!present) return { value: null, present: false, error: null };\n  if (!isS6qLedgerCountAnchorShape(value)) {\n    return { value: null, present: true, error: "The independent ledger-count anchor is malformed." };\n  }\n  if (sha256(ledgerCountAnchorCore(value)) !== value.anchorDigestSha256) {\n    return { value: null, present: true, error: "The independent ledger-count anchor failed its digest check." };\n  }\n  return { value, present: true, error: null };\n}`,
  "ledger anchor helpers",
);

service = replaceOnce(
  service,
  `  const previousCount = options.previousOwnedLedgerRecords ?? null;\n  const storedAnchors = options.anchors ?? { baseline: null, evidence: null };`,
  `  const reportPreviousCount = options.previousOwnedLedgerRecords ?? null;\n  const ledgerCountAnchorArtifact = options.ledgerCountAnchor\n    ?? { value: null, present: false, error: null };\n  const validLedgerCountAnchor = buildMlbS6qLedgerCountAnchorArtifact(\n    ledgerCountAnchorArtifact.value,\n    ledgerCountAnchorArtifact.present,\n    ledgerCountAnchorArtifact.error,\n  );\n  const previousCount = Math.max(\n    reportPreviousCount ?? 0,\n    validLedgerCountAnchor.value?.ownedLedgerRecords ?? 0,\n  ) || null;\n  const storedAnchors = options.anchors ?? { baseline: null, evidence: null };`,
  "ledger anchor recovery count",
);

service = replaceOnce(
  service,
  `  let evidenceAnchorToPersist: S6qEvidenceAnchor | null = null;`,
  `  let evidenceAnchorToPersist: S6qEvidenceAnchor | null = null;\n  let ledgerCountAnchorToPersist: S6qLedgerCountAnchor | null = null;`,
  "ledger anchor persistence variable",
);

service = replaceOnce(
  service,
  `  if (storedAnchors.baselineReadError) pushIssue(issues, "BASELINE_ANCHOR_UNREADABLE", "CRITICAL", storedAnchors.baselineReadError);`,
  `  if (validLedgerCountAnchor.error) pushIssue(issues, "LEDGER_COUNT_ANCHOR_INVALID", "CRITICAL", validLedgerCountAnchor.error);\n  if (storedAnchors.baselineReadError) pushIssue(issues, "BASELINE_ANCHOR_UNREADABLE", "CRITICAL", storedAnchors.baselineReadError);`,
  "ledger anchor validation issue",
);

service = replaceOnce(
  service,
  `  if (!countMonotonic) {\n    pushIssue(`,
  `  if (!countMonotonic) {\n    pushIssue(`,
  "count regression anchor",
);

service = replaceOnce(
  service,
  `  const critical = issues.some((entry) => entry.severity === "CRITICAL");`,
  `  if (countMonotonic\n    && !validLedgerCountAnchor.error\n    && currentOwnedLedgerRecords > (validLedgerCountAnchor.value?.ownedLedgerRecords ?? -1)) {\n    ledgerCountAnchorToPersist = makeLedgerCountAnchor(\n      currentOwnedLedgerRecords,\n      validLedgerCountAnchor.value,\n      generatedAt,\n    );\n  }\n\n  const critical = issues.some((entry) => entry.severity === "CRITICAL");`,
  "ledger anchor creation before critical gate",
);

service = replaceOnce(
  service,
  `      evidenceAppendOnly: true,\n    },`,
  `      evidenceAppendOnly: true,\n      ledgerCountJournalAppendOnly: true,\n      ledgerCountAnchorPresent: Boolean(validLedgerCountAnchor.value || ledgerCountAnchorToPersist),\n      ledgerCountAnchorRecords: ledgerCountAnchorToPersist?.ownedLedgerRecords\n        ?? validLedgerCountAnchor.value?.ownedLedgerRecords\n        ?? null,\n      ledgerCountAnchorDigestSha256: ledgerCountAnchorToPersist?.anchorDigestSha256\n        ?? validLedgerCountAnchor.value?.anchorDigestSha256\n        ?? null,\n    },`,
  "report ledger anchor persistence",
);

service = replaceOnce(
  service,
  `  return { report, baselineToPersist, evidenceToPersist, baselineAnchorToPersist, evidenceAnchorToPersist };`,
  `  return {\n    report,\n    baselineToPersist,\n    evidenceToPersist,\n    baselineAnchorToPersist,\n    evidenceAnchorToPersist,\n    ledgerCountAnchorToPersist,\n  };`,
  "evaluation return ledger anchor",
);

service = replaceOnce(
  service,
  `    && typeof persistence.currentOwnedLedgerRecords === "number"\n    && isObjectRecord(value.stability)`,
  `    && typeof persistence.currentOwnedLedgerRecords === "number"\n    && persistence.ledgerCountJournalAppendOnly === true\n    && typeof persistence.ledgerCountAnchorPresent === "boolean"\n    && (persistence.ledgerCountAnchorRecords === null || typeof persistence.ledgerCountAnchorRecords === "number")\n    && (persistence.ledgerCountAnchorDigestSha256 === null || typeof persistence.ledgerCountAnchorDigestSha256 === "string")\n    && isObjectRecord(value.stability)`,
  "previous report ledger anchor shape",
);

service = replaceOnce(
  service,
  `function pruneSnapshots(directory: string, maxSnapshots: number): void {`,
  `function readLedgerCountAnchorJournal(directory: string): {\n  value: S6qLedgerCountAnchor | null;\n  present: boolean;\n  error: string | null;\n} {\n  if (!fs.existsSync(directory)) return { value: null, present: false, error: null };\n  try {\n    const files = fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort();\n    if (!files.length) return { value: null, present: false, error: null };\n    let previous: S6qLedgerCountAnchor | null = null;\n    for (const file of files) {\n      const parsed = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as unknown;\n      const artifact = buildMlbS6qLedgerCountAnchorArtifact(parsed, true);\n      if (!artifact.value || artifact.error) {\n        return { value: null, present: true, error: `Invalid ledger-count journal entry ${file}: ${artifact.error ?? "unknown error"}` };\n      }\n      if (previous) {\n        if (artifact.value.ownedLedgerRecords <= previous.ownedLedgerRecords\n          || artifact.value.previousOwnedLedgerRecords !== previous.ownedLedgerRecords\n          || artifact.value.previousAnchorDigestSha256 !== previous.anchorDigestSha256) {\n          return { value: null, present: true, error: `Broken ledger-count anchor chain at ${file}` };\n        }\n      } else if (artifact.value.previousOwnedLedgerRecords !== null\n        || artifact.value.previousAnchorDigestSha256 !== null) {\n        return { value: null, present: true, error: `Invalid first ledger-count anchor ${file}` };\n      }\n      previous = artifact.value;\n    }\n    return { value: previous, present: true, error: null };\n  } catch (error) {\n    return {\n      value: null,\n      present: true,\n      error: `Unable to read ledger-count anchor journal: ${error instanceof Error ? error.message : String(error)}`,\n    };\n  }\n}\n\nfunction ledgerCountAnchorFileName(anchor: S6qLedgerCountAnchor): string {\n  return `${String(anchor.ownedLedgerRecords).padStart(12, "0")}-${anchor.anchorDigestSha256.slice(0, 12)}.json`;\n}\n\nfunction pruneSnapshots(directory: string, maxSnapshots: number): void {`,
  "ledger journal reader",
);

service = replaceOnce(
  service,
  `      const storedAnchors = buildMlbS6qStoredAnchors(baselineAnchorArtifact, evidenceAnchorArtifact);`,
  `      const storedAnchors = buildMlbS6qStoredAnchors(baselineAnchorArtifact, evidenceAnchorArtifact);\n      const ledgerCountAnchorArtifact = readLedgerCountAnchorJournal(\n        path.join(this.root, "ledger-count-anchors"),\n      );`,
  "worker ledger journal read",
);

const optionsAnchor = `          anchors: storedAnchors,\n          previousReportReadError: previousArtifact.error,`;
service = replaceOnce(
  service,
  optionsAnchor,
  `          anchors: storedAnchors,\n          ledgerCountAnchor: ledgerCountAnchorArtifact,\n          previousReportReadError: previousArtifact.error,`,
  "initial ledger anchor option",
);

service = replaceOnce(
  service,
  `      if (evaluation.baselineAnchorToPersist) {`,
  `      if (evaluation.ledgerCountAnchorToPersist) {\n        try {\n          writeAppendOnlyJson(\n            path.join(\n              this.root,\n              "ledger-count-anchors",\n              ledgerCountAnchorFileName(evaluation.ledgerCountAnchorToPersist),\n            ),\n            evaluation.ledgerCountAnchorToPersist,\n          );\n        } catch (error: any) {\n          if (error?.code !== "EEXIST") throw error;\n        }\n      }\n      if (evaluation.baselineAnchorToPersist) {`,
  "worker ledger anchor write",
);

service = replaceOnce(
  service,
  `      const refreshedAnchors = buildMlbS6qStoredAnchors(refreshedBaselineAnchor, refreshedEvidenceAnchor);\n      const finalEvaluation = evaluation.baselineToPersist || evaluation.evidenceToPersist\n        || evaluation.baselineAnchorToPersist || evaluation.evidenceAnchorToPersist`,
  `      const refreshedAnchors = buildMlbS6qStoredAnchors(refreshedBaselineAnchor, refreshedEvidenceAnchor);\n      const refreshedLedgerCountAnchor = readLedgerCountAnchorJournal(\n        path.join(this.root, "ledger-count-anchors"),\n      );\n      const finalEvaluation = evaluation.baselineToPersist || evaluation.evidenceToPersist\n        || evaluation.baselineAnchorToPersist || evaluation.evidenceAnchorToPersist\n        || evaluation.ledgerCountAnchorToPersist`,
  "refreshed ledger anchor read",
);

const refreshedOptionsAnchor = `            anchors: refreshedAnchors,\n            previousReportReadError: previousArtifact.error,`;
service = replaceOnce(
  service,
  refreshedOptionsAnchor,
  `            anchors: refreshedAnchors,\n            ledgerCountAnchor: refreshedLedgerCountAnchor,\n            previousReportReadError: previousArtifact.error,`,
  "refreshed ledger anchor option",
);

fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  buildMlbS6qCertifiedTerminalPredictionIdsFromS6k,`,
  `  buildMlbS6qCertifiedTerminalPredictionIdsFromS6k,\n  buildMlbS6qLedgerCountAnchorArtifact,`,
  "ledger anchor test import",
);

const testsToAdd = `

test("recovers the ledger high-water mark when latest.json is invalid", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluateMlbS6qFiftySettlementHumanReview(
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
      currentOwnedLedgerRecords: 12_000,
    },
  );
  if (!first.ledgerCountAnchorToPersist) throw new Error("fixture ledger anchor missing");
  const artifact = buildMlbS6qLedgerCountAnchorArtifact(first.ledgerCountAnchorToPersist, true);
  const regressed = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T21:03:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      currentOwnedLedgerRecords: 11_000,
      previousReportReadError: "latest.json malformed",
      ledgerCountAnchor: artifact,
    },
  );
  assert.equal(regressed.report.state, "ACTION_REQUIRED");
  assert.equal(regressed.report.issues.some((entry) => entry.code === "PERSISTENCE_COUNT_REGRESSION"), true);
  assert.equal(regressed.report.persistence.ledgerCountAnchorRecords, 12_000);
  assert.equal(regressed.ledgerCountAnchorToPersist, null);
});

test("rejects malformed ledger-count anchors", () => {
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
      currentOwnedLedgerRecords: 100,
      ledgerCountAnchor: { value: {} as any, present: true, error: null },
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "LEDGER_COUNT_ANCHOR_INVALID"), true);
  assert.equal(result.ledgerCountAnchorToPersist, null);
});
`;
if (!tests.includes("recovers the ledger high-water mark when latest.json is invalid")) tests += testsToAdd;
fs.writeFileSync(testPath, tests);
console.log("Applied independent S6Q ledger-count anchor journal.");

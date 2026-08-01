import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

function replaceAllChecked(source, before, after) {
  if (!source.includes(before)) return source;
  return source.split(before).join(after);
}

const sourcePath = "server/mlb-s6o-first-five-settlements-certification.ts";
const targetPath = "server/mlb-s6p-first-twenty-settlements-certification.ts";
let service = fs.readFileSync(sourcePath, "utf8");

// Rename the target namespace first, before introducing the S6O prerequisite import.
service = replaceAllChecked(service, "S6o", "S6p");
service = replaceAllChecked(service, "s6o", "s6p");
service = replaceAllChecked(service, "S6O", "S6P");
service = replaceAllChecked(service, "FIRST_FIVE", "FIRST_TWENTY");
service = replaceAllChecked(service, "FirstFiveSettlements", "FirstTwentySettlements");
service = replaceAllChecked(service, "firstFiveSettlements", "firstTwentySettlements");

service = replaceOnce(
  service,
  `import type {\n  MlbS6nFirstRealSettlementMonitorService,\n  S6nReport,\n} from "./mlb-s6n-first-real-settlement-monitor";`,
  `import type {\n  MlbS6oFirstFiveSettlementsCertificationService,\n  S6oReport,\n} from "./mlb-s6o-first-five-settlements-certification";`,
  "S6O prerequisite import",
);

for (const [before, after] of [
  ["sourceS6n", "sourceS6o"],
  ["s6nReport", "s6oReport"],
  ["s6nCriticalIssues", "s6oCriticalIssues"],
  ["s6nFirstSettlement", "s6oFirstFive"],
  ["MlbS6nFirstRealSettlementMonitorService", "MlbS6oFirstFiveSettlementsCertificationService"],
  ["S6nReport", "S6oReport"],
  ["FIRST_REAL_SETTLEMENT_CERTIFIED", "FIRST_FIVE_SETTLEMENTS_CERTIFIED"],
  ["firstRealSettlementCertified", "firstFiveSettlementsCertified"],
  ["prerequisiteFirstSettlementCertified", "prerequisiteFirstFiveSettlementsCertified"],
  ["FIRST_SETTLEMENT_PREREQUISITE_NOT_CERTIFIED", "FIRST_FIVE_PREREQUISITE_NOT_CERTIFIED"],
  ["first-real-settlement", "first-five-settlements"],
  ["first-real-settlement chain", "first-five-settlement chain"],
  ["S6N", "S6O"],
]) service = replaceAllChecked(service, before, after);

for (const [before, after] of [
  ["mlb-s6p-first-five-settlements-certification.v1", "mlb-s6p-first-twenty-settlements-certification.v1"],
  ["mlb-s6p-first-five-settlements-baseline.v1", "mlb-s6p-first-twenty-settlements-baseline.v1"],
  ["mlb-s6p-first-five-settlements-evidence.v1", "mlb-s6p-first-twenty-settlements-evidence.v1"],
  ["MLB_S6P_TARGET_SIZE = 5 as const", "MLB_S6P_TARGET_SIZE = 20 as const"],
  ["ARMED_AND_WAITING_FOR_5", "ARMED_AND_WAITING_FOR_20"],
  ["OBSERVING_FIVE_RESULT_STABILITY", "OBSERVING_TWENTY_RESULT_STABILITY"],
  ["FIRST_TWENTY_SETTLEMENTS_CERTIFIED", "MINIMUM_SAMPLE_20_CERTIFIED"],
  ["milestoneFive", "milestoneTwenty"],
  ["Milestone 5", "Milestone 20"],
  ["milestone 5", "milestone 20"],
  ["MILESTONE_5", "MILESTONE_20"],
  ["certificates[\"5\"]", "certificates[\"20\"]"],
  ["entry.milestone === 5", "entry.milestone === 20"],
  [">= 5", ">= 20"],
  ["certificate.milestone !== 5", "certificate.milestone !== 20"],
  ["milestoneFiveCertificatePresent", "milestoneTwentyCertificatePresent"],
  ["exactFiveDecisionSample", "exactTwentyDecisionSample"],
  ["independentFiveDecisionMetricsMatch", "independentTwentyDecisionMetricsMatch"],
  ["independentlyCertifiedAmongFirstFive", "independentlyCertifiedAmongFirstTwenty"],
  ["firstTwentySettlementsCertified", "minimumSample20Certified"],
  ["technicalRepetitionValidated", "minimumSampleIntegrityValidated"],
  ["FIVE_RESULT_STABILITY_WINDOW_PENDING", "TWENTY_RESULT_STABILITY_WINDOW_PENDING"],
  ["five-result", "twenty-result"],
  ["five-decision", "twenty-decision"],
  ["five binary decisions", "twenty binary decisions"],
  ["exactly five", "exactly twenty"],
  ["five are required", "twenty are required"],
  ["first-five", "first-twenty"],
  ["First-five", "First-twenty"],
  ["five-result sample", "twenty-result sample"],
  ["TECHNICAL_REPETITION_CHECK_ONLY_TOO_SMALL_FOR_MODEL_CONCLUSIONS", "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS"],
  ["mlb-s6p-first-five-settlements-certification", "mlb-s6p-first-twenty-settlements-certification"],
  ["MLB_S6P_FIRST_FIVE_SETTLEMENTS", "MLB_S6P_FIRST_TWENTY_SETTLEMENTS"],
]) service = replaceAllChecked(service, before, after);

// Replace the prerequisite implementation with S6O semantics.
service = replaceAllChecked(service, "s6oReport.readiness.minimumSample20Certified", "s6oReport.readiness.firstFiveSettlementsCertified");
service = replaceAllChecked(service, "Milestone 20 exists before the S6O first-five-settlement chain is certified.", "Milestone 20 exists before the S6O first-five-settlement chain is certified.");
service = replaceAllChecked(service, "private readonly s6oFirstFive: MlbS6oFirstFiveSettlementsCertificationService", "private readonly s6oFirstFive: MlbS6oFirstFiveSettlementsCertificationService");

// Add preliminary-review evidence while preserving the no-conclusion boundary.
service = replaceOnce(
  service,
  `export type S6pBreakdown = {\n  key: string;\n  sampleSize: number;\n  metrics: S6mMilestoneCertificate["metrics"];\n};`,
  `export type S6pBreakdown = {\n  key: string;\n  sampleSize: number;\n  metrics: S6mMilestoneCertificate["metrics"];\n};\n\nexport type S6pCalibrationBucket = {\n  label: string;\n  minimumProbability: number;\n  maximumProbability: number;\n  sampleSize: number;\n  meanPredictedProbability: number | null;\n  observedWinRate: number | null;\n  calibrationGap: number | null;\n};\n\nexport type S6pProvisionalFinalComparison = {\n  comparableDecisions: number;\n  meanSignedProbabilityChangePp: number | null;\n  meanAbsoluteProbabilityChangePp: number | null;\n  signalChangedCount: number;\n  marketIdentityChangedCount: number;\n};`,
  "S6P evidence types",
);

service = replaceOnce(
  service,
  `  marketBreakdowns: S6pBreakdown[];\n  signalBreakdowns: S6pBreakdown[];\n  sampleAdequacy: "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS";`,
  `  marketBreakdowns: S6pBreakdown[];\n  signalBreakdowns: S6pBreakdown[];\n  calibrationBuckets: S6pCalibrationBucket[];\n  provisionalFinalComparison: S6pProvisionalFinalComparison;\n  sampleAdequacy: "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS";`,
  "S6P evidence fields",
);

service = replaceOnce(
  service,
  `    minimumSample20Certified: boolean;\n    minimumSampleIntegrityValidated: boolean;\n    sampleAdequateForModelConclusions: false;`,
  `    minimumSample20Certified: boolean;\n    minimumSampleIntegrityValidated: boolean;\n    preliminaryReviewAvailable: boolean;\n    sampleAdequateForModelConclusions: false;`,
  "S6P readiness type",
);

const helperAnchor = `function makeBaseline(\n`;
const helpers = `function roundS6p(value: number, digits = 6): number {\n  const factor = 10 ** digits;\n  return Math.round(value * factor) / factor;\n}\n\nconst S6P_CALIBRATION_BUCKETS = [\n  { label: "0.00-0.49", minimumProbability: 0, maximumProbability: 0.5 },\n  { label: "0.50-0.54", minimumProbability: 0.5, maximumProbability: 0.55 },\n  { label: "0.55-0.59", minimumProbability: 0.55, maximumProbability: 0.6 },\n  { label: "0.60-0.64", minimumProbability: 0.6, maximumProbability: 0.65 },\n  { label: "0.65-0.69", minimumProbability: 0.65, maximumProbability: 0.7 },\n  { label: "0.70-0.74", minimumProbability: 0.7, maximumProbability: 0.75 },\n  { label: "0.75-1.00", minimumProbability: 0.75, maximumProbability: 1.0000001 },\n] as const;\n\nfunction buildCalibrationBuckets(observations: S6mObservation[]): S6pCalibrationBucket[] {\n  return S6P_CALIBRATION_BUCKETS.map((bucket) => {\n    const entries = observations.filter((entry) =>\n      entry.modelProbability >= bucket.minimumProbability\n      && entry.modelProbability < bucket.maximumProbability\n      && (entry.outcome === 0 || entry.outcome === 1));\n    if (!entries.length) {\n      return { ...bucket, sampleSize: 0, meanPredictedProbability: null, observedWinRate: null, calibrationGap: null };\n    }\n    const meanPredictedProbability = entries.reduce((sum, entry) => sum + entry.modelProbability, 0) / entries.length;\n    const observedWinRate = entries.reduce((sum, entry) => sum + (entry.outcome ?? 0), 0) / entries.length;\n    return {\n      ...bucket,\n      sampleSize: entries.length,\n      meanPredictedProbability: roundS6p(meanPredictedProbability),\n      observedWinRate: roundS6p(observedWinRate),\n      calibrationGap: roundS6p(Math.abs(observedWinRate - meanPredictedProbability)),\n    };\n  });\n}\n\nfunction buildProvisionalFinalComparison(\n  records: LedgerRecord[],\n  observations: S6mObservation[],\n): S6pProvisionalFinalComparison {\n  const probabilityChanges: number[] = [];\n  let signalChangedCount = 0;\n  let marketIdentityChangedCount = 0;\n  for (const observation of observations) {\n    const provisional = records.find((record) => record.prediction.id === observation.rootPredictionId) ?? null;\n    const terminal = records.find((record) => record.prediction.id === observation.terminalPredictionId) ?? null;\n    if (!provisional || !terminal || provisional.prediction.analysisStage !== "PROVISIONAL") continue;\n    const provisionalProbability = provisional.prediction.probabilities.model;\n    const finalProbability = terminal.prediction.probabilities.model;\n    if (!Number.isFinite(provisionalProbability) || !Number.isFinite(finalProbability)) continue;\n    probabilityChanges.push((finalProbability - provisionalProbability) * 100);\n    if (provisional.prediction.decision.signal !== terminal.prediction.decision.signal) signalChangedCount += 1;\n    const provisionalIdentity = JSON.stringify([\n      provisional.prediction.market.type,\n      provisional.prediction.market.selection,\n      provisional.prediction.market.line ?? null,\n    ]);\n    const finalIdentity = JSON.stringify([\n      terminal.prediction.market.type,\n      terminal.prediction.market.selection,\n      terminal.prediction.market.line ?? null,\n    ]);\n    if (provisionalIdentity !== finalIdentity) marketIdentityChangedCount += 1;\n  }\n  return {\n    comparableDecisions: probabilityChanges.length,\n    meanSignedProbabilityChangePp: probabilityChanges.length\n      ? roundS6p(probabilityChanges.reduce((sum, value) => sum + value, 0) / probabilityChanges.length, 4)\n      : null,\n    meanAbsoluteProbabilityChangePp: probabilityChanges.length\n      ? roundS6p(probabilityChanges.reduce((sum, value) => sum + Math.abs(value), 0) / probabilityChanges.length, 4)\n      : null,\n    signalChangedCount,\n    marketIdentityChangedCount,\n  };\n}\n\n`;
service = replaceOnce(service, helperAnchor, helpers + helperAnchor, "S6P analytical helpers");

service = replaceOnce(
  service,
  `    marketBreakdowns: groupedBreakdowns(selected, (entry) => entry.marketType),\n    signalBreakdowns: groupedBreakdowns(selected, (entry) => entry.signal),\n    sampleAdequacy: "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS",`,
  `    marketBreakdowns: groupedBreakdowns(selected, (entry) => entry.marketType),\n    signalBreakdowns: groupedBreakdowns(selected, (entry) => entry.signal),\n    calibrationBuckets: buildCalibrationBuckets(selected),\n    provisionalFinalComparison: buildProvisionalFinalComparison(records, selected),\n    sampleAdequacy: "PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS",`,
  "S6P analytical evidence",
);

service = replaceOnce(
  service,
  `      minimumSample20Certified: state === "MINIMUM_SAMPLE_20_CERTIFIED",\n      minimumSampleIntegrityValidated: state === "MINIMUM_SAMPLE_20_CERTIFIED",\n      sampleAdequateForModelConclusions: false,`,
  `      minimumSample20Certified: state === "MINIMUM_SAMPLE_20_CERTIFIED",\n      minimumSampleIntegrityValidated: state === "MINIMUM_SAMPLE_20_CERTIFIED",\n      preliminaryReviewAvailable: state === "MINIMUM_SAMPLE_20_CERTIFIED",\n      sampleAdequateForModelConclusions: false,`,
  "S6P readiness values",
);

// Ensure source S6O readiness remains the five-settlement prerequisite.
service = replaceAllChecked(service, "s6oReport.readiness.minimumSample20Certified", "s6oReport.readiness.firstFiveSettlementsCertified");
service = replaceAllChecked(service, "sourceS6o: {\n    available: boolean;\n    generatedAt: string | null;\n    state: string | null;\n    minimumSample20Certified: boolean;", "sourceS6o: {\n    available: boolean;\n    generatedAt: string | null;\n    state: string | null;\n    firstFiveSettlementsCertified: boolean;");
service = replaceAllChecked(service, "minimumSample20Certified: prerequisiteFirstFiveSettlementsCertified,", "firstFiveSettlementsCertified: prerequisiteFirstFiveSettlementsCertified,");
service = replaceAllChecked(service, "private readonly s6oFirstFive: MlbS6oFirstFiveSettlementsCertificationService", "private readonly s6oFirstFive: MlbS6oFirstFiveSettlementsCertificationService");

if (service.includes("certificates[\"5\"]") || service.includes("milestone === 5") || service.includes("MLB_S6P_TARGET_SIZE = 5")) {
  throw new Error("S6P service still contains milestone-5 target logic.");
}
fs.writeFileSync(targetPath, service);

const tests = `import assert from "node:assert/strict";\nimport crypto from "node:crypto";\nimport test from "node:test";\nimport type { LedgerRecord } from "./mlb-ledger-store";\nimport { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";\nimport { buildMlbS6lScientificMetrics } from "./mlb-s6l-scientific-metrics";\nimport {\n  evaluateMlbS6mMilestones,\n  type S6mCertificateMap,\n  type S6mMilestoneReport,\n} from "./mlb-s6m-statistical-milestones";\nimport type { S6oReport } from "./mlb-s6o-first-five-settlements-certification";\nimport {\n  evaluateMlbS6pFirstTwentySettlements,\n  type S6pBaseline,\n  type S6pEvidence,\n} from "./mlb-s6p-first-twenty-settlements-certification";\n\nconst cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);\n\nfunction digest(value: unknown): string {\n  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");\n}\n\nfunction record(index: number, options: {\n  id?: string; supersedesId?: string | null; stage?: "PROVISIONAL" | "FINAL";\n  gamePk?: number; odds?: number; probability?: number; result?: "WIN" | "LOSS" | null; recordedOffset?: number;\n} = {}): LedgerRecord {\n  const id = options.id ?? \`prediction-\${index}\`;\n  const gamePk = options.gamePk ?? 880000 + index;\n  const recordedAtMs = cutoffMs + 60_000 + (options.recordedOffset ?? index) * 1_000;\n  const odds = options.odds ?? -110;\n  const probability = options.probability ?? 0.6;\n  const result = options.result === undefined ? (index % 2 === 0 ? "WIN" : "LOSS") : options.result;\n  return {\n    prediction: {\n      id, clientRequestId: \`s5c:\${id}\`, recordedAt: new Date(recordedAtMs).toISOString(), recordedAtMs,\n      game: { gamePk, gameDate: "2026-08-01", commenceTime: new Date(recordedAtMs + 3_600_000).toISOString(), homeTeam: \`Home \${gamePk}\`, awayTeam: \`Away \${gamePk}\` },\n      market: { type: "F5_TOTAL", selection: "OVER 4.5", line: 4.5, oddsAmerican: odds, book: "betmgm, draftkings, fanduel" },\n      probabilities: { model: probability, marketImplied: Math.abs(odds) / (Math.abs(odds) + 100), noVig: null, edgePp: 1 },\n      decision: { signal: index % 3 === 0 ? "BET_FUERTE" : "BET", confidenceLabel: "MODEL", confidencePct: probability * 100, stakeUnits: 0 },\n      analysisStage: options.stage ?? "FINAL",\n      model: { name: "CourtEdge MLB Early Markets", version: "s5c-shadow-v2-price-integrity", gitCommit: "fixture", environment: "test" },\n      supersedesId: options.supersedesId ?? null, source: "app", payloadSha256: \`${index}\`.padStart(64, "a").slice(-64),\n      payload: { market: { capturedAt: new Date(recordedAtMs - 30_000).toISOString() }, analysis: { layers: { s5c: { schemaVersion: "mlb-s5c-shadow-ingestion.v1" }, marketPriceIntegrity: { standardAmericanOddsValidated: true, consensusMethod: "median_implied_probability" } }, rawInputs: { priceCapture: { capturedAt: new Date(recordedAtMs - 30_000).toISOString(), consensusMethod: "median_implied_probability" }, marketProvenance: { consensusMethod: "median_implied_probability", contributingBooks: ["betmgm", "draftkings", "fanduel"] } } } },\n    },\n    settlement: result ? { eventId: \`settlement-\${id}\`, settledAt: new Date(recordedAtMs + 7_200_000).toISOString(), source: "correction", correctionOfEventId: \`official-\${id}\`, result, outcomeValue: result === "WIN" ? 6 : 2, finalScore: { home: 4, away: 2 }, profitUnits: 0, closingOddsAmerican: -108, closingLine: 4.5, clvPp: 1.2 } : null,\n  } as LedgerRecord;\n}\n\nfunction pairedDecision(index: number, result: "WIN" | "LOSS" | null = index % 2 === 0 ? "WIN" : "LOSS"): LedgerRecord[] {\n  const rootId = \`root-\${index}\`;\n  return [\n    record(index, { id: rootId, stage: "PROVISIONAL", result: null, probability: 0.54 + (index % 5) * 0.02, odds: -105, recordedOffset: index * 2 }),\n    record(index, { id: \`final-\${index}\`, supersedesId: rootId, stage: "FINAL", result, probability: 0.56 + (index % 5) * 0.02, recordedOffset: index * 2 + 1 }),\n  ];\n}\n\nfunction recordsFor(count: number): LedgerRecord[] {\n  return Array.from({ length: count }, (_, index) => pairedDecision(index)).flat();\n}\n\nfunction terminalIds(count: number): string[] {\n  return Array.from({ length: count }, (_, index) => \`final-\${index}\`);\n}\n\nfunction buildS6m(records: LedgerRecord[], certifiedIds: string[] = []): { report: S6mMilestoneReport; certificates: S6mCertificateMap } {\n  const s6l = buildMlbS6lScientificMetrics(records, { certifiedTerminalPredictionIds: certifiedIds, generatedAt: "2026-08-01T21:00:00.000Z" });\n  const evaluation = evaluateMlbS6mMilestones(records, s6l, certifiedIds, {}, { generatedAt: "2026-08-01T21:01:00.000Z", deploymentCommit: "fixture", environment: "test" });\n  const certificates: S6mCertificateMap = {};\n  for (const certificate of evaluation.newCertificates) certificates[\`${certificate.milestone}\`] = certificate;\n  return { report: evaluation.report, certificates };\n}\n\nfunction certifiedS6oReport(): S6oReport {\n  return {\n    generatedAt: "2026-08-01T21:00:30.000Z", state: "FIRST_FIVE_SETTLEMENTS_CERTIFIED", issues: [],\n    readiness: { firstFiveSettlementsCertified: true },\n  } as S6oReport;\n}\n\nfunction evaluate(records: LedgerRecord[], report: S6mMilestoneReport | null, certificates: S6mCertificateMap, stored: { baseline?: S6pBaseline | null; evidence?: S6pEvidence | null; baselineReadError?: string | null; evidenceReadError?: string | null } = {}, generatedAt = "2026-08-01T21:02:00.000Z", s6oReport: S6oReport | null = certifiedS6oReport(), previousOwnedLedgerRecords: number | null = null) {\n  return evaluateMlbS6pFirstTwentySettlements(records, report, certificates, s6oReport, terminalIds(20), { baseline: stored.baseline ?? null, evidence: stored.evidence ?? null, baselineReadError: stored.baselineReadError, evidenceReadError: stored.evidenceReadError }, { generatedAt, deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords });\n}\n\ntest("remains armed below twenty eligible settlements", () => {\n  const records = recordsFor(19);\n  const { report, certificates } = buildS6m(records, terminalIds(19));\n  const result = evaluate(records, report, certificates);\n  assert.equal(result.report.state, "ARMED_AND_WAITING_FOR_20");\n  assert.equal(result.report.sample.binaryEligibleDecisions, 19);\n  assert.equal(result.report.readiness.preliminaryReviewAvailable, false);\n});\n\ntest("records an append-only baseline for a valid milestone 20 certificate", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, terminalIds(20));\n  const result = evaluate(records, report, certificates);\n  assert.equal(result.report.state, "OBSERVING_TWENTY_RESULT_STABILITY");\n  assert.equal(result.report.checks.certificateIntegrity, true);\n  assert.ok(result.baselineToPersist);\n  assert.equal(result.baselineToPersist?.terminalPredictionIds.length, 20);\n});\n\ntest("certifies the minimum sample only after a second stable observation", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, terminalIds(20));\n  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");\n  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6oReport(), records.length);\n  assert.equal(second.report.state, "MINIMUM_SAMPLE_20_CERTIFIED");\n  assert.equal(second.report.readiness.preliminaryReviewAvailable, true);\n  assert.equal(second.report.readiness.sampleAdequateForModelConclusions, false);\n  assert.equal(second.report.readiness.conclusionsAllowed, false);\n  assert.equal(second.report.readiness.automaticModelChangesAllowed, false);\n  assert.ok(second.evidenceToPersist);\n  assert.equal(second.evidenceToPersist?.calibrationBuckets.reduce((sum, row) => sum + row.sampleSize, 0), 20);\n  assert.equal(second.evidenceToPersist?.provisionalFinalComparison.comparableDecisions, 20);\n});\n\ntest("blocks milestone 20 when the first-five prerequisite is not certified", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, terminalIds(20));\n  const pending = { ...certifiedS6oReport(), state: "ARMED_AND_WAITING_FOR_5", readiness: { firstFiveSettlementsCertified: false }, issues: [] } as S6oReport;\n  const result = evaluate(records, report, certificates, {}, undefined, pending);\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.issues.some((entry) => entry.code === "FIRST_FIVE_PREREQUISITE_NOT_CERTIFIED"), true);\n});\n\ntest("detects milestone 20 certificate tampering", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, terminalIds(20));\n  const changed = structuredClone(certificates);\n  if (!changed["20"]) throw new Error("fixture certificate missing");\n  changed["20"].certificateDigestSha256 = "0".repeat(64);\n  const result = evaluate(records, report, changed);\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_DIGEST_MISMATCH"), true);\n});\n\ntest("detects ledger settlement divergence", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, terminalIds(20));\n  const changed = structuredClone(records);\n  const terminal = changed.find((entry) => entry.prediction.id === "final-0");\n  if (!terminal?.settlement) throw new Error("fixture settlement missing");\n  terminal.settlement.eventId = "changed-event";\n  const result = evaluate(changed, report, certificates);\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.issues.some((entry) => entry.code === "SETTLEMENT_IDENTITY_MISMATCH"), true);\n});\n\ntest("rejects tampered append-only evidence", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, terminalIds(20));\n  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");\n  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6oReport(), records.length);\n  if (!second.evidenceToPersist) throw new Error("fixture evidence missing");\n  const tampered = structuredClone(second.evidenceToPersist);\n  tampered.metrics.wins += 1;\n  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_DIGEST_INVALID"), true);\n});\n\ntest("later independent-certification maturity does not alter immutable identity", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, []);\n  const first = evaluateMlbS6pFirstTwentySettlements(records, report, certificates, certifiedS6oReport(), [], { baseline: null, evidence: null }, { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 });\n  assert.ok(first.baselineToPersist);\n  const matured = buildS6m(records, terminalIds(20));\n  const second = evaluateMlbS6pFirstTwentySettlements(records, matured.report, certificates, certifiedS6oReport(), terminalIds(20), { baseline: first.baselineToPersist, evidence: null }, { generatedAt: "2026-08-01T21:03:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords: records.length });\n  assert.notEqual(second.report.state, "ACTION_REQUIRED");\n});\n\ntest("S6M critical issues block certification", () => {\n  const records = recordsFor(20);\n  const { report, certificates } = buildS6m(records, terminalIds(20));\n  const broken = structuredClone(report);\n  broken.issues.push({ code: "BROKEN", severity: "CRITICAL", message: "fixture" });\n  const result = evaluate(records, broken, certificates);\n  assert.equal(result.report.state, "ACTION_REQUIRED");\n  assert.equal(result.report.checks.s6mIntegrityGatePassed, false);\n});\n`;
fs.writeFileSync("server/mlb-s6p-first-twenty-settlements-certification.test.ts", tests);

const tsconfig = {
  extends: "./tsconfig.json",
  include: [
    "server/mlb-ledger-store.ts",
    "server/mlb-ledger-ownership-store.ts",
    "server/mlb-s5e-coverage-service.ts",
    "server/mlb-s5e-coverage-service.aliases.d.ts",
    "server/mlb-s6i-postfix-certification.ts",
    "server/mlb-s6j-first-cycle-certification.ts",
    "server/mlb-s6k-first-ten-cycles-certification.ts",
    "server/mlb-s6l-scientific-metrics.ts",
    "server/mlb-s6m-statistical-milestones.ts",
    "server/mlb-s6n-first-real-settlement-monitor.ts",
    "server/mlb-s6o-first-five-settlements-certification.ts",
    "server/mlb-s6p-first-twenty-settlements-certification.ts",
    "server/mlb-s6p-first-twenty-settlements-certification.test.ts",
    "server/mlb-settlement-worker.ts",
  ],
  exclude: ["node_modules", "dist"],
  compilerOptions: { target: "ES2022", noEmit: true },
};
fs.writeFileSync("tsconfig.s6p-first-twenty-settlements.json", `${JSON.stringify(tsconfig, null, 2)}\n`);

const docs = `# S6P / Phase 5C-5 — First 20 eligible MLB settlements\n\n## Objective\n\nCertify the deterministic first 20 clean post-fix binary MLB settlements as the minimum sample for a preliminary human review, while explicitly prohibiting model conclusions or automatic changes.\n\n## Prerequisites\n\n- S6M milestone 20 certificate exists and is valid.\n- S6O has certified the first five real settlements.\n- S6M/S6L metric parity passes with zero critical issues.\n- The owned ledger remains immutable and monotonic.\n\n## State machine\n\n\`ARMED_AND_WAITING_FOR_20 -> OBSERVING_TWENTY_RESULT_STABILITY -> MINIMUM_SAMPLE_20_CERTIFIED\`\n\nAny integrity failure enters \`ACTION_REQUIRED\`.\n\n## Evidence\n\nS6P verifies the immutable first-20 manifest, FINAL stages, unique analytical identities, standard American prices, settlement identities, binary outcomes, independent metric recomputation, market/signal breakdowns, deterministic calibration buckets, and PROVISIONAL-to-FINAL probability movement. Baseline and evidence files are append-only and must remain stable across separate worker executions.\n\n## Scientific boundary\n\nAt 20 results, \`preliminaryReviewAvailable=true\` only after certification. The sample remains insufficient for model conclusions: \`sampleAdequateForModelConclusions=false\`, \`conclusionsAllowed=false\`, \`automaticModelChangesAllowed=false\`, recommendation \`NO_AUTOMATIC_MODEL_CHANGE\`.\n\n## Runtime\n\nEnabled by default only in \`p0-integration\`, five-minute interval and stability window. Public health: \`GET /health/s6p-first-twenty-settlements\`. Protected status/evidence routes are under \`/api/mlb/ledger/v1/s6p-first-twenty-settlements\`.\n\n## Safety\n\nSHADOW mode, zero financial exposure, no sportsbook integration, no automatic betting, no production writes, no historical mutation, no automatic promotion, and no formula/probability/signal/market/threshold/settlement/stake changes.\n`;
fs.writeFileSync("docs/S6P_PHASE5C5_FIRST_TWENTY_SETTLEMENTS.md", docs);

const validationWorkflow = `name: Validate S6P First Twenty Settlements\n\non:\n  pull_request:\n    branches:\n      - integration/p0-staging-secure\n    paths:\n      - 'server/mlb-s6p-first-twenty-settlements-certification.ts'\n      - 'server/mlb-s6p-first-twenty-settlements-certification.test.ts'\n      - 'server/mlb-s6m-statistical-milestones.ts'\n      - 'server/mlb-s6o-first-five-settlements-certification.ts'\n      - 'server/s5b-staging-entry.ts'\n      - 'server/route-contract.extensions.json'\n      - 'tsconfig.s6p-first-twenty-settlements.json'\n      - 'tsconfig.s5b-shadow.json'\n      - 'package.json'\n      - 'docs/S6P_PHASE5C5_FIRST_TWENTY_SETTLEMENTS.md'\n      - '.github/workflows/validate-s6p-first-twenty-settlements.yml'\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\njobs:\n  validate-s6p:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v5\n        with:\n          node-version: '24'\n          cache: npm\n      - run: npm ci\n      - name: Run focused Phase 5C-5 tests\n        run: npm run test:s6p-first-twenty-settlements\n      - name: Type-check Phase 5C-5 surface\n        run: npm run typecheck:s6p-first-twenty-settlements\n      - name: Type-check complete shadow surface\n        run: npm run typecheck:s5b-shadow\n      - name: Preserve modular route contract\n        run: npm run test:s3-modularization\n      - name: Build production backend bundle\n        run: npm run build:backend\n      - name: Verify scientific and safety boundaries\n        shell: bash\n        run: |\n          set -euo pipefail\n          grep -q 'ARMED_AND_WAITING_FOR_20' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q 'OBSERVING_TWENTY_RESULT_STABILITY' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q 'MINIMUM_SAMPLE_20_CERTIFIED' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q 'PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q 'preliminaryReviewAvailable' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q 'sampleAdequateForModelConclusions: false' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q 'automaticModelChangesAllowed: false' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q 'realFinancialExposure: 0' server/mlb-s6p-first-twenty-settlements-certification.ts\n          grep -q '/health/s6p-first-twenty-settlements' server/s5b-staging-entry.ts\n`;
fs.writeFileSync(".github/workflows/validate-s6p-first-twenty-settlements.yml", validationWorkflow);

// Runtime wiring.
const stagingPath = "server/s5b-staging-entry.ts";
let staging = fs.readFileSync(stagingPath, "utf8");
staging = replaceOnce(
  staging,
  'import { startMlbS6oFirstFiveSettlementsCertificationWorker } from "./mlb-s6o-first-five-settlements-certification";',
  'import { startMlbS6oFirstFiveSettlementsCertificationWorker } from "./mlb-s6o-first-five-settlements-certification";\nimport { startMlbS6pFirstTwentySettlementsCertificationWorker } from "./mlb-s6p-first-twenty-settlements-certification";',
  "S6P import anchor",
);
staging = replaceOnce(
  staging,
  `const s6oFirstFiveSettlements = startMlbS6oFirstFiveSettlementsCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6nFirstRealSettlement.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);`,
  `const s6oFirstFiveSettlements = startMlbS6oFirstFiveSettlementsCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6nFirstRealSettlement.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);\nconst s6pFirstTwentySettlements = startMlbS6pFirstTwentySettlementsCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6oFirstFiveSettlements.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);`,
  "S6P worker anchor",
);

const healthAnchor = 'app.get("/health/s6o-first-five-settlements", (_req, res) => {';
const healthRoute = `app.get("/health/s6p-first-twenty-settlements", (_req, res) => {\n  const status = s6pFirstTwentySettlements.service.status();\n  const latest = status.latest;\n  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);\n  res.status(ready ? 200 : 503).json({\n    status: ready ? "healthy" : "pending",\n    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",\n    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",\n    schemaVersion: status.schemaVersion, enabled: status.enabled, intervalMs: status.intervalMs, initialDelayMs: status.initialDelayMs,\n    minimumStabilityMs: status.minimumStabilityMs, maxSnapshots: status.maxSnapshots, lastRunAt: status.lastRunAt, lastSuccessAt: status.lastSuccessAt, lastError: status.lastError,\n    latest: latest ? {\n      state: latest.state, sourceS6m: latest.sourceS6m, sourceS6o: latest.sourceS6o, sample: latest.sample,\n      target: { certificatePresent: latest.target.certificatePresent, manifestEntries: latest.target.manifestEntries, wins: latest.target.wins, losses: latest.target.losses, clvAvailable: latest.target.clvAvailable },\n      stability: latest.stability, checks: latest.checks, readiness: latest.readiness, persistence: latest.persistence,\n      issueCounts: latest.issues.reduce((counts, entry) => { counts[entry.severity] = (counts[entry.severity] ?? 0) + 1; return counts; }, { INFO: 0, WARNING: 0, CRITICAL: 0 }),\n    } : null,\n    safety: latest?.safety ?? { mode: "SHADOW", realFinancialExposure: 0, sportsbookIntegration: false, automaticBetPlacement: false, productionWrites: false, historicalLedgerMutation: false, automaticPromotion: false, formulasChanged: false, probabilitiesChanged: false, signalsChanged: false, marketsChanged: false, thresholdsChanged: false, settlementRulesChanged: false, stakePolicyChanged: false },\n  });\n});\n\n`;
if (!staging.includes('/health/s6p-first-twenty-settlements')) staging = replaceOnce(staging, healthAnchor, healthRoute + healthAnchor, "S6P health route");

const apiAnchor = 'app.get("/api/mlb/ledger/v1/s6o-first-five-settlements/status", (_req, res) => {';
const apiRoutes = `app.get("/api/mlb/ledger/v1/s6p-first-twenty-settlements/status", (_req, res) => {\n  const status = s6pFirstTwentySettlements.service.status();\n  res.json({ success: true, data: { schemaVersion: status.schemaVersion, enabled: status.enabled, intervalMs: status.intervalMs, initialDelayMs: status.initialDelayMs, minimumStabilityMs: status.minimumStabilityMs, maxSnapshots: status.maxSnapshots, lastRunAt: status.lastRunAt, lastSuccessAt: status.lastSuccessAt, lastError: status.lastError, latest: status.latest } });\n});\n\napp.get("/api/mlb/ledger/v1/s6p-first-twenty-settlements/evidence", (_req, res) => {\n  const latest = s6pFirstTwentySettlements.service.readLatest();\n  if (!latest) { res.status(404).json({ success: false, error: "No S6P first-twenty-settlement report has completed yet" }); return; }\n  res.json({ success: true, data: { latest, baseline: s6pFirstTwentySettlements.service.readBaseline(), evidence: s6pFirstTwentySettlements.service.readEvidence() } });\n});\n\n`;
if (!staging.includes('/api/mlb/ledger/v1/s6p-first-twenty-settlements/status')) staging = replaceOnce(staging, apiAnchor, apiRoutes + apiAnchor, "S6P API routes");
fs.writeFileSync(stagingPath, staging);

const contractPath = "server/route-contract.extensions.json";
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
for (const routePath of ["/api/mlb/ledger/v1/s6p-first-twenty-settlements/evidence", "/api/mlb/ledger/v1/s6p-first-twenty-settlements/status"]) {
  if (!contract.some((entry) => entry.method === "GET" && entry.path === routePath)) contract.push({ method: "GET", path: routePath, registrations: 1 });
}
contract.sort((left, right) => left.method.localeCompare(right.method) || left.path.localeCompare(right.path));
fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

const shadowPath = "tsconfig.s5b-shadow.json";
const shadow = JSON.parse(fs.readFileSync(shadowPath, "utf8"));
for (const file of [targetPath, "server/mlb-s6p-first-twenty-settlements-certification.test.ts"]) if (!shadow.include.includes(file)) shadow.include.push(file);
fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`);

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const testFile = "server/mlb-s6p-first-twenty-settlements-certification.test.ts";
if (!pkg.scripts["test:s5b-shadow"].includes(testFile)) pkg.scripts["test:s5b-shadow"] += ` ${testFile}`;
pkg.scripts["test:s6p-first-twenty-settlements"] = `tsx --test ${testFile}`;
pkg.scripts["typecheck:s6p-first-twenty-settlements"] = "tsc -p tsconfig.s6p-first-twenty-settlements.json";
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log("Generated and integrated S6P Phase 5C-5.");

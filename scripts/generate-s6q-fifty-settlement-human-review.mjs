import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

function replaceAll(source, before, after) {
  return source.split(before).join(after);
}

const serviceSourcePath = "server/mlb-s6p-first-twenty-settlements-certification.ts";
const serviceTargetPath = "server/mlb-s6q-fifty-settlement-human-review.ts";
let service = fs.readFileSync(serviceSourcePath, "utf8");

// Protect the prerequisite symbols while renaming the S6P implementation into S6Q.
service = replaceAll(service, "MlbS6oFirstFiveSettlementsCertificationService", "__PREREQ_SERVICE__");
service = replaceAll(service, "S6oReport", "__PREREQ_REPORT__");
service = replaceAll(service, "./mlb-s6o-first-five-settlements-certification", "__PREREQ_PATH__");
service = replaceAll(service, "s6oReport", "__prereqReport__");
service = replaceAll(service, "s6oCriticalIssues", "__prereqCriticalIssues__");
service = replaceAll(service, "s6oFirstFive", "__prereqService__");
service = replaceAll(service, "sourceS6oGeneratedAt", "__sourcePrereqGeneratedAt__");
service = replaceAll(service, "sourceS6oState", "__sourcePrereqState__");
service = replaceAll(service, "sourceS6o", "__sourcePrereq__");

service = replaceAll(service, "S6p", "S6q");
service = replaceAll(service, "s6p", "s6q");
service = replaceAll(service, "S6P", "S6Q");
service = replaceAll(service, "TWENTY", "FIFTY");
service = replaceAll(service, "Twenty", "Fifty");
service = replaceAll(service, "twenty", "fifty");

for (const [before, after] of [
  ["MlbS6qFirstFiftySettlementsCertificationService", "MlbS6qFiftySettlementHumanReviewService"],
  ["startMlbS6qFirstFiftySettlementsCertificationWorker", "startMlbS6qFiftySettlementHumanReviewWorker"],
  ["evaluateMlbS6qFirstFiftySettlements", "evaluateMlbS6qFiftySettlementHumanReview"],
  ["FirstFiftySettlementsCertification", "FiftySettlementHumanReview"],
  ["FirstFiftySettlements", "FiftySettlementHumanReview"],
  ["firstFiftySettlements", "fiftySettlementHumanReview"],
  ["MLB_S6Q_FIRST_FIFTY_VERSION", "MLB_S6Q_FIFTY_REVIEW_VERSION"],
  ["mlb-s6q-first-fifty-settlements-certification.v1", "mlb-s6q-fifty-settlement-human-review.v1"],
  ["mlb-s6q-first-fifty-settlements-baseline.v1", "mlb-s6q-fifty-settlement-human-review-baseline.v1"],
  ["mlb-s6q-first-fifty-settlements-evidence.v1", "mlb-s6q-fifty-settlement-human-review-evidence.v1"],
  ["mlb-s6q-first-fifty-settlements-certification", "mlb-s6q-fifty-settlement-human-review"],
  ["MLB_S6Q_FIRST_FIFTY_SETTLEMENTS", "MLB_S6Q_FIFTY_SETTLEMENT_HUMAN_REVIEW"],
  ["MLB_S6Q_TARGET_SIZE = 20 as const", "MLB_S6Q_TARGET_SIZE = 50 as const"],
  ["certificates[\"20\"]", "certificates[\"50\"]"],
  ["entry.milestone === 20", "entry.milestone === 50"],
  ["certificate.milestone !== 20", "certificate.milestone !== 50"],
  [">= 20", ">= 50"],
  ["MILESTONE_20", "MILESTONE_50"],
  ["Milestone 20", "Milestone 50"],
  ["milestone 20", "milestone 50"],
  ["MINIMUM_SAMPLE_20_CERTIFIED", "READY_FOR_HUMAN_REVIEW"],
  ["PRELIMINARY_REVIEW_ONLY_INSUFFICIENT_FOR_MODEL_CONCLUSIONS", "PREFERRED_SAMPLE_READY_FOR_HUMAN_REVIEW"],
]) service = replaceAll(service, before, after);

// Restore the S6P prerequisite after the target state and symbols have been renamed.
service = replaceAll(service, "__PREREQ_SERVICE__", "MlbS6pFirstTwentySettlementsCertificationService");
service = replaceAll(service, "__PREREQ_REPORT__", "S6pReport");
service = replaceAll(service, "__PREREQ_PATH__", "./mlb-s6p-first-twenty-settlements-certification");
service = replaceAll(service, "__prereqReport__", "s6pReport");
service = replaceAll(service, "__prereqCriticalIssues__", "s6pCriticalIssues");
service = replaceAll(service, "__prereqService__", "s6pMinimumSample");
service = replaceAll(service, "__sourcePrereqGeneratedAt__", "sourceS6pGeneratedAt");
service = replaceAll(service, "__sourcePrereqState__", "sourceS6pState");
service = replaceAll(service, "__sourcePrereq__", "sourceS6p");

for (const [before, after] of [
  ["sourceS6mGeneratedAt: string;\n  sourceS6pGeneratedAt: string;", "sourceS6mGeneratedAt: string;\n  sourceS6pGeneratedAt: string;"],
  ["firstFiveSettlementsCertified", "minimumSample20Certified"],
  ["prerequisiteFirstFiveSettlementsCertified", "prerequisiteMinimumSample20Certified"],
  ["FIRST_FIVE_PREREQUISITE_NOT_CERTIFIED", "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING"],
  ["first-five-settlement", "minimum-sample-20"],
  ["first five settlements", "minimum sample of 20 settlements"],
  ["first-five", "minimum-sample-20"],
]) service = replaceAll(service, before, after);

service = replaceOnce(
  service,
  `export type S6qState =\n  | "ARMED_AND_WAITING_FOR_50"\n  | "OBSERVING_FIFTY_RESULT_STABILITY"\n  | "READY_FOR_HUMAN_REVIEW"\n  | "ACTION_REQUIRED";`,
  `export type S6qState =\n  | "ARMED_AND_WAITING_FOR_50"\n  | "WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION"\n  | "WAITING_FOR_TEN_CERTIFIED_CYCLES"\n  | "OBSERVING_FIFTY_RESULT_STABILITY"\n  | "READY_FOR_HUMAN_REVIEW"\n  | "ACTION_REQUIRED";`,
  "S6Q state union",
);

service = replaceOnce(
  service,
  `export type S6qProvisionalFinalComparison = {\n  comparableDecisions: number;\n  meanSignedProbabilityChangePp: number | null;\n  meanAbsoluteProbabilityChangePp: number | null;\n  signalChangedCount: number;\n  marketIdentityChangedCount: number;\n};`,
  `export type S6qProvisionalFinalComparison = {\n  comparableDecisions: number;\n  meanSignedProbabilityChangePp: number | null;\n  meanAbsoluteProbabilityChangePp: number | null;\n  signalChangedCount: number;\n  marketIdentityChangedCount: number;\n};\n\nexport type S6qConcentration = {\n  largestMarket: { key: string; sampleSize: number; sharePct: number } | null;\n  largestSignal: { key: string; sampleSize: number; sharePct: number } | null;\n};`,
  "S6Q concentration type",
);

service = replaceOnce(
  service,
  `  provisionalFinalComparison: S6qProvisionalFinalComparison;\n  sampleAdequacy: "PREFERRED_SAMPLE_READY_FOR_HUMAN_REVIEW";`,
  `  provisionalFinalComparison: S6qProvisionalFinalComparison;\n  concentration: S6qConcentration;\n  sampleAdequacy: "PREFERRED_SAMPLE_READY_FOR_HUMAN_REVIEW";`,
  "S6Q evidence concentration field",
);

service = replaceOnce(
  service,
  `    prerequisiteMinimumSample20Certified: true;\n    exactFiftyDecisionSample: true;`,
  `    prerequisiteMinimumSample20Certified: true;\n    tenCertifiedCyclesReached: true;\n    exactFiftyDecisionSample: true;`,
  "S6Q evidence ten-certified check",
);

service = replaceOnce(
  service,
  `  sourceS6p: {\n    available: boolean;\n    generatedAt: string | null;\n    state: string | null;\n    minimumSample20Certified: boolean;\n    criticalIssues: number;\n  };`,
  `  sourceS6p: {\n    available: boolean;\n    generatedAt: string | null;\n    state: string | null;\n    minimumSample20Certified: boolean;\n    criticalIssues: number;\n  };`,
  "S6Q prerequisite report shape",
);

service = replaceOnce(
  service,
  `    independentlyCertifiedAmongFirstFifty: number;\n    certifiedTerminalPredictionIds: number;`,
  `    independentlyCertifiedAmongFirstFifty: number;\n    requiredIndependentCertifications: 10;\n    certifiedTerminalPredictionIds: number;`,
  "S6Q sample certification requirement",
);

service = replaceOnce(
  service,
  `    prerequisiteMinimumSample20Certified: boolean;\n    certificateIntegrity: boolean | null;`,
  `    prerequisiteMinimumSample20Certified: boolean;\n    tenCertifiedCyclesReached: boolean;\n    certificateIntegrity: boolean | null;`,
  "S6Q report check shape",
);

service = replaceOnce(
  service,
  `  readiness: {\n    armed: boolean;\n    minimumSample20Certified: boolean;\n    minimumSampleIntegrityValidated: boolean;\n    preliminaryReviewAvailable: boolean;\n    sampleAdequateForModelConclusions: false;\n    conclusionsAllowed: false;\n    automaticModelChangesAllowed: false;\n    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";\n  };`,
  `  readiness: {\n    armed: boolean;\n    preferredSample50Certified: boolean;\n    humanReviewReady: boolean;\n    sampleAdequateForHumanReview: boolean;\n    conclusionsAllowed: boolean;\n    automaticModelChangesAllowed: false;\n    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";\n  };`,
  "S6Q readiness type",
);

const concentrationAnchor = `function makeBaseline(\n`;
const concentrationHelper = `function buildConcentration(\n  marketBreakdowns: S6qBreakdown[],\n  signalBreakdowns: S6qBreakdown[],\n  sampleSize: number,\n): S6qConcentration {\n  const largest = (entries: S6qBreakdown[]) => {\n    const top = [...entries].sort((left, right) => right.sampleSize - left.sampleSize || left.key.localeCompare(right.key))[0];\n    return top && sampleSize > 0\n      ? { key: top.key, sampleSize: top.sampleSize, sharePct: roundS6q((top.sampleSize / sampleSize) * 100, 2) }\n      : null;\n  };\n  return { largestMarket: largest(marketBreakdowns), largestSignal: largest(signalBreakdowns) };\n}\n\n`;
service = replaceOnce(service, concentrationAnchor, concentrationHelper + concentrationAnchor, "S6Q concentration helper anchor");

service = replaceOnce(
  service,
  `    marketBreakdowns: groupedBreakdowns(selected, (entry) => entry.marketType),\n    signalBreakdowns: groupedBreakdowns(selected, (entry) => entry.signal),\n    calibrationBuckets: buildCalibrationBuckets(selected),`,
  `    marketBreakdowns: groupedBreakdowns(selected, (entry) => entry.marketType),\n    signalBreakdowns: groupedBreakdowns(selected, (entry) => entry.signal),\n    calibrationBuckets: buildCalibrationBuckets(selected),`,
  "S6Q breakdown anchor",
);
service = replaceOnce(
  service,
  `    provisionalFinalComparison: buildProvisionalFinalComparison(records, selected),\n    sampleAdequacy: "PREFERRED_SAMPLE_READY_FOR_HUMAN_REVIEW",`,
  `    provisionalFinalComparison: buildProvisionalFinalComparison(records, selected),\n    concentration: buildConcentration(\n      groupedBreakdowns(selected, (entry) => entry.marketType),\n      groupedBreakdowns(selected, (entry) => entry.signal),\n      selected.length,\n    ),\n    sampleAdequacy: "PREFERRED_SAMPLE_READY_FOR_HUMAN_REVIEW",`,
  "S6Q concentration evidence",
);
service = replaceOnce(
  service,
  `      milestoneFiftyCertificatePresent: true,\n      prerequisiteMinimumSample20Certified: true,\n      exactFiftyDecisionSample: true,`,
  `      milestoneFiftyCertificatePresent: true,\n      prerequisiteMinimumSample20Certified: true,\n      tenCertifiedCyclesReached: true,\n      exactFiftyDecisionSample: true,`,
  "S6Q evidence check values",
);
service = replaceOnce(
  service,
  `    && isObjectRecord(value.provisionalFinalComparison)\n    && typeof value.sampleAdequacy === "string"`,
  `    && isObjectRecord(value.provisionalFinalComparison)\n    && isObjectRecord(value.concentration)\n    && typeof value.sampleAdequacy === "string"`,
  "S6Q evidence shape concentration",
);

service = replaceOnce(
  service,
  `  const selected = sample.binaryObservations.slice(0, MLB_S6Q_TARGET_SIZE);\n  const baselinePresent = stored.baselinePresent`,
  `  const selected = sample.binaryObservations.slice(0, MLB_S6Q_TARGET_SIZE);\n  const independentlyCertifiedAmongFirstFifty = selected.filter((entry) => entry.independentlyCertified).length;\n  const tenCertifiedCyclesReached = independentlyCertifiedAmongFirstFifty >= 10\n    && Boolean(s6mReport?.readiness.tenCertifiedCyclesReached);\n  const baselinePresent = stored.baselinePresent`,
  "S6Q independent certification count",
);

const prereqBlockStart = service.indexOf("  const s6pCriticalIssues =");
const prereqBlockEnd = service.indexOf("\n\n  const certificate =", prereqBlockStart);
if (prereqBlockStart < 0 || prereqBlockEnd < 0) throw new Error("Unable to locate S6P prerequisite block");
const prereqBlock = `  const s6pCriticalIssues = s6pReport?.issues.filter((entry) => entry.severity === "CRITICAL").length ?? 0;\n  const s6pIntegrityGatePassed = Boolean(\n    s6pReport\n      && s6pReport.state !== "ACTION_REQUIRED"\n      && s6pCriticalIssues === 0,\n  );\n  if (s6pReport && !s6pIntegrityGatePassed) {\n    pushIssue(\n      issues,\n      "S6P_INTEGRITY_GATE_FAILED",\n      "CRITICAL",\n      \`S6P state=\${s6pReport.state}, criticalIssues=\${s6pCriticalIssues}.\`,\n    );\n  }\n  const prerequisiteMinimumSample20Certified = Boolean(\n    s6pReport\n      && s6pReport.state === "MINIMUM_SAMPLE_20_CERTIFIED"\n      && s6pReport.readiness.minimumSample20Certified\n      && s6pIntegrityGatePassed,\n  );`;
service = service.slice(0, prereqBlockStart) + prereqBlock + service.slice(prereqBlockEnd);

const obsoletePrereq = `  if (certificate && !prerequisiteMinimumSample20Certified) {\n    pushIssue(\n      issues,\n      "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING",\n      "CRITICAL",\n      "Milestone 50 exists before the S6P minimum-sample-20 chain is certified.",\n    );\n  }`;
if (service.includes(obsoletePrereq)) {
  service = service.replace(obsoletePrereq, `  if (certificate && !prerequisiteMinimumSample20Certified) {\n    pushIssue(\n      issues,\n      "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING",\n      "INFO",\n      "Milestone 50 is available, but S6P has not yet certified the minimum sample of 20 settlements.",\n    );\n  }`);
}

service = replaceAll(service, "if (stored.baseline || stored.evidence)", "if (baselinePresent || evidencePresent)");

const criticalStart = service.indexOf("  const critical = issues.some((entry) => entry.severity === \"CRITICAL\");");
const effectiveStart = service.indexOf("\n  const effectiveBaseline =", criticalStart);
if (criticalStart < 0 || effectiveStart < 0) throw new Error("Unable to locate S6Q certificate gate section");
const certificateGate = `  if ((baselinePresent || evidencePresent) && !prerequisiteMinimumSample20Certified) {\n    pushIssue(issues, "MINIMUM_SAMPLE_20_PREREQUISITE_REGRESSION", "CRITICAL", "Persisted S6Q review artifacts exist but the S6P prerequisite is no longer certified.");\n  }\n  if ((baselinePresent || evidencePresent) && !tenCertifiedCyclesReached) {\n    pushIssue(issues, "INDEPENDENT_CERTIFICATION_REGRESSION", "CRITICAL", "Persisted S6Q review artifacts exist but fewer than ten first-fifty decisions are independently certified.");\n  }\n\n  const critical = issues.some((entry) => entry.severity === "CRITICAL");\n  const certificateIntegrityValid = Boolean(\n    certificate\n      && certificateIntegrity\n      && currentLedgerManifestMatches\n      && settlementIdentitiesMatch\n      && s6mIntegrityGatePassed\n      && countMonotonic\n      && !critical,\n  );\n  const reviewInputsValid = Boolean(\n    certificateIntegrityValid\n      && prerequisiteMinimumSample20Certified\n      && tenCertifiedCyclesReached,\n  );\n\n  if (reviewInputsValid && certificate && s6mReport && s6pReport) {\n    if (!validStoredBaseline) {\n      baselineToPersist = makeBaseline(\n        certificate,\n        records.length,\n        generatedAt,\n        deploymentCommit,\n        s6mReport.generatedAt,\n        s6pReport.generatedAt,\n      );\n    } else if (!validStoredEvidence) {\n      const stableForMs = Date.parse(generatedAt) - Date.parse(validStoredBaseline.firstObservedAt);\n      if (stableForMs >= minimumStabilityMs) {\n        evidenceToPersist = makeEvidence(\n          certificate,\n          validStoredBaseline,\n          s6mReport,\n          s6pReport,\n          selected,\n          records,\n          generatedAt,\n          deploymentCommit,\n          environment,\n          minimumStabilityMs,\n        );\n      }\n    }\n  }\n`;
service = service.slice(0, criticalStart) + certificateGate + service.slice(effectiveStart);

const stateStart = service.indexOf("  let state: S6qState;");
const stateEnd = service.indexOf("\n\n  const report: S6qReport", stateStart);
if (stateStart < 0 || stateEnd < 0) throw new Error("Unable to locate S6Q state block");
const stateBlock = `  let state: S6qState;\n  if (critical) state = "ACTION_REQUIRED";\n  else if (effectiveEvidence) state = "READY_FOR_HUMAN_REVIEW";\n  else if (certificateIntegrityValid && !prerequisiteMinimumSample20Certified) state = "WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION";\n  else if (certificateIntegrityValid && !tenCertifiedCyclesReached) state = "WAITING_FOR_TEN_CERTIFIED_CYCLES";\n  else if (reviewInputsValid) state = "OBSERVING_FIFTY_RESULT_STABILITY";\n  else state = "ARMED_AND_WAITING_FOR_50";\n\n  if (!critical && state === "ARMED_AND_WAITING_FOR_50") {\n    pushIssue(issues, "MILESTONE_50_PENDING", "INFO", \`\${sample.binaryObservations.length} eligible binary decisions are available; fifty are required.\`);\n  } else if (!critical && state === "WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION") {\n    pushIssue(issues, "MINIMUM_SAMPLE_20_CERTIFICATION_PENDING", "INFO", "The milestone-50 certificate is valid, but the S6P minimum-sample certification is still pending.");\n  } else if (!critical && state === "WAITING_FOR_TEN_CERTIFIED_CYCLES") {\n    pushIssue(issues, "TEN_CERTIFIED_CYCLES_PENDING", "INFO", \`\${independentlyCertifiedAmongFirstFifty} of the required 10 first-fifty decisions are independently certified.\`);\n  } else if (!critical && state === "OBSERVING_FIFTY_RESULT_STABILITY") {\n    pushIssue(issues, "FIFTY_RESULT_STABILITY_WINDOW_PENDING", "INFO", \`Milestone 50 has remained stable for \${stableForMs ?? 0} ms; \${minimumStabilityMs} ms are required.\`);\n  }`;
service = service.slice(0, stateStart) + stateBlock + service.slice(stateEnd);

service = replaceAll(service, "  const independentlyCertifiedAmongFirstFifty = selected.filter((entry) => entry.independentlyCertified).length;\n", "");
// Reinsert the count once at the selected-sample declaration if the broad removal removed both copies.
if (!service.includes("const independentlyCertifiedAmongFirstFifty = selected.filter")) {
  service = replaceOnce(
    service,
    `  const selected = sample.binaryObservations.slice(0, MLB_S6Q_TARGET_SIZE);\n`,
    `  const selected = sample.binaryObservations.slice(0, MLB_S6Q_TARGET_SIZE);\n  const independentlyCertifiedAmongFirstFifty = selected.filter((entry) => entry.independentlyCertified).length;\n  const tenCertifiedCyclesReached = independentlyCertifiedAmongFirstFifty >= 10\n    && Boolean(s6mReport?.readiness.tenCertifiedCyclesReached);\n`,
    "S6Q independent count reinsertion",
  );
}
// Avoid duplicate ten-certified declaration if retained by transformations.
service = service.replace(/(const tenCertifiedCyclesReached = independentlyCertifiedAmongFirstFifty >= 10\n    && Boolean\(s6mReport\?\.readiness\.tenCertifiedCyclesReached\);\n){2}/, "$1");

service = replaceOnce(
  service,
  `      prerequisiteMinimumSample20Certified,\n      certificateIntegrity,`,
  `      prerequisiteMinimumSample20Certified,\n      tenCertifiedCyclesReached,\n      certificateIntegrity,`,
  "S6Q report check values",
);
service = replaceOnce(
  service,
  `      independentlyCertifiedAmongFirstFifty,\n      certifiedTerminalPredictionIds: certifiedTerminalPredictionIds.length,`,
  `      independentlyCertifiedAmongFirstFifty,\n      requiredIndependentCertifications: 10,\n      certifiedTerminalPredictionIds: certifiedTerminalPredictionIds.length,`,
  "S6Q sample report values",
);
service = replaceOnce(
  service,
  `    readiness: {\n      armed: state === "ARMED_AND_WAITING_FOR_50" || state === "OBSERVING_FIFTY_RESULT_STABILITY",\n      minimumSample20Certified: state === "READY_FOR_HUMAN_REVIEW",\n      minimumSampleIntegrityValidated: state === "READY_FOR_HUMAN_REVIEW",\n      preliminaryReviewAvailable: state === "READY_FOR_HUMAN_REVIEW",\n      sampleAdequateForModelConclusions: false,\n      conclusionsAllowed: false,\n      automaticModelChangesAllowed: false,\n      recommendation: "NO_AUTOMATIC_MODEL_CHANGE",\n    },`,
  `    readiness: {\n      armed: state !== "READY_FOR_HUMAN_REVIEW" && state !== "ACTION_REQUIRED",\n      preferredSample50Certified: state === "READY_FOR_HUMAN_REVIEW",\n      humanReviewReady: state === "READY_FOR_HUMAN_REVIEW",\n      sampleAdequateForHumanReview: state === "READY_FOR_HUMAN_REVIEW",\n      conclusionsAllowed: state === "READY_FOR_HUMAN_REVIEW",\n      automaticModelChangesAllowed: false,\n      recommendation: "NO_AUTOMATIC_MODEL_CHANGE",\n    },`,
  "S6Q readiness values",
);

service = replaceAll(service, "s6pReport.state === \"FIRST_FIVE_SETTLEMENTS_CERTIFIED\"", "s6pReport.state === \"MINIMUM_SAMPLE_20_CERTIFIED\"");
service = replaceAll(service, "private readonly s6pMinimumSample: MlbS6pFirstTwentySettlementsCertificationService", "private readonly s6pMinimumSample: MlbS6pFirstTwentySettlementsCertificationService");
service = replaceAll(service, "[s6q] first five settlements certification failed", "[s6q] fifty-settlement human review failed");
service = replaceAll(service, "MLB_S6Q_INITIAL_DELAY_MS, 330_000", "MLB_S6Q_INITIAL_DELAY_MS, 360_000");

if (!service.includes("WAITING_FOR_TEN_CERTIFIED_CYCLES") || !service.includes("READY_FOR_HUMAN_REVIEW")) {
  throw new Error("S6Q state machine was not generated correctly");
}
if (service.includes("certificates[\"20\"]") || service.includes("MLB_S6Q_TARGET_SIZE = 20")) {
  throw new Error("S6Q still contains milestone-20 target logic");
}
fs.writeFileSync(serviceTargetPath, service);

// Transform and extend the focused S6P test suite.
const testSourcePath = "server/mlb-s6p-first-twenty-settlements-certification.test.ts";
const testTargetPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testSourcePath, "utf8");
tests = replaceAll(tests, "S6oReport", "__PREREQ_REPORT__");
tests = replaceAll(tests, "./mlb-s6o-first-five-settlements-certification", "__PREREQ_PATH__");
tests = replaceAll(tests, "certifiedS6oReport", "__certifiedPrereqReport__");
tests = replaceAll(tests, "s6oReport", "__prereqReport__");
tests = replaceAll(tests, "S6p", "S6q");
tests = replaceAll(tests, "s6p", "s6q");
tests = replaceAll(tests, "S6P", "S6Q");
tests = replaceAll(tests, "TWENTY", "FIFTY");
tests = replaceAll(tests, "Twenty", "Fifty");
tests = replaceAll(tests, "twenty", "fifty");
for (const [before, after] of [
  ["buildMlbS6qStoredArtifacts", "buildMlbS6qStoredArtifacts"],
  ["evaluateMlbS6qFirstFiftySettlements", "evaluateMlbS6qFiftySettlementHumanReview"],
  ["./mlb-s6q-first-fifty-settlements-certification", "./mlb-s6q-fifty-settlement-human-review"],
  ["MINIMUM_SAMPLE_20_CERTIFIED", "READY_FOR_HUMAN_REVIEW"],
  ["ARMED_AND_WAITING_FOR_20", "ARMED_AND_WAITING_FOR_50"],
  ["OBSERVING_FIFTY_RESULT_STABILITY", "OBSERVING_FIFTY_RESULT_STABILITY"],
  ["recordsFor(20)", "recordsFor(50)"],
  ["terminalIds(20)", "terminalIds(50)"],
  ["recordsFor(19)", "recordsFor(49)"],
  ["terminalIds(19)", "terminalIds(49)"],
  ["changed[\"20\"]", "changed[\"50\"]"],
  ["milestone 20", "milestone 50"],
  ["Milestone 20", "Milestone 50"],
  ["20 certificate", "50 certificate"],
  ["length, 20", "length, 50"],
  ["sampleSize, 20", "sampleSize, 50"],
  ["comparableDecisions, 20", "comparableDecisions, 50"],
]) tests = replaceAll(tests, before, after);
tests = replaceAll(tests, "__PREREQ_REPORT__", "S6pReport");
tests = replaceAll(tests, "__PREREQ_PATH__", "./mlb-s6p-first-twenty-settlements-certification");
tests = replaceAll(tests, "__certifiedPrereqReport__", "certifiedS6pReport");
tests = replaceAll(tests, "__prereqReport__", "s6pReport");
tests = replaceAll(tests, "FIRST_FIVE_SETTLEMENTS_CERTIFIED", "MINIMUM_SAMPLE_20_CERTIFIED");
tests = replaceAll(tests, "firstFiveSettlementsCertified", "minimumSample20Certified");

tests = replaceOnce(
  tests,
  `function certifiedS6pReport(): S6pReport {\n  return {\n    generatedAt: "2026-08-01T21:00:30.000Z", state: "MINIMUM_SAMPLE_20_CERTIFIED", issues: [],\n    readiness: { minimumSample20Certified: true },\n  } as S6pReport;\n}`,
  `function certifiedS6pReport(): S6pReport {\n  return {\n    generatedAt: "2026-08-01T21:00:30.000Z", state: "MINIMUM_SAMPLE_20_CERTIFIED", issues: [],\n    readiness: { minimumSample20Certified: true },\n  } as S6pReport;\n}`,
  "S6P prerequisite fixture",
);

tests = replaceAll(tests, "terminalIds(50), { baseline:", "terminalIds(50), { baseline:");
tests = replaceAll(tests, "result.report.readiness.preliminaryReviewAvailable", "result.report.readiness.humanReviewReady");
tests = replaceAll(tests, "second.report.readiness.preliminaryReviewAvailable", "second.report.readiness.humanReviewReady");
tests = replaceAll(tests, "second.report.readiness.sampleAdequateForModelConclusions", "second.report.readiness.sampleAdequateForHumanReview");
tests = replaceAll(tests, "assert.equal(second.report.readiness.sampleAdequateForHumanReview, false);", "assert.equal(second.report.readiness.sampleAdequateForHumanReview, true);");
tests = replaceAll(tests, "assert.equal(second.report.readiness.conclusionsAllowed, false);", "assert.equal(second.report.readiness.conclusionsAllowed, true);");

// Replace the prerequisite test with a non-critical waiting state.
const prereqTestPattern = /test\("blocks milestone 50 when the minimum-sample-20 prerequisite is not certified"[\s\S]*?\n\}\);/;
if (prereqTestPattern.test(tests)) {
  tests = tests.replace(prereqTestPattern, `test("waits for the S6P minimum-sample prerequisite without fabricating review evidence", () => {\n  const records = recordsFor(50);\n  const { report, certificates } = buildS6m(records, terminalIds(50));\n  const pending = { ...certifiedS6pReport(), state: "ARMED_AND_WAITING_FOR_20", readiness: { minimumSample20Certified: false }, issues: [] } as S6pReport;\n  const result = evaluate(records, report, certificates, {}, undefined, pending);\n  assert.equal(result.report.state, "WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION");\n  assert.equal(result.report.issues.some((entry) => entry.code === "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING"), true);\n  assert.equal(result.baselineToPersist, null);\n});`);
}

// Replace the maturity test because S6Q intentionally waits for ten independently certified cycles.
const maturityPattern = /test\("later independent-certification maturity does not alter immutable identity"[\s\S]*?\n\}\);/;
if (maturityPattern.test(tests)) {
  tests = tests.replace(maturityPattern, `test("waits for ten independent certifications and then records the stable review baseline", () => {\n  const records = recordsFor(50);\n  const immature = buildS6m(records, terminalIds(9));\n  const waiting = evaluateMlbS6qFiftySettlementHumanReview(records, immature.report, immature.certificates, certifiedS6pReport(), terminalIds(9), { baseline: null, evidence: null }, { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 });\n  assert.equal(waiting.report.state, "WAITING_FOR_TEN_CERTIFIED_CYCLES");\n  assert.equal(waiting.baselineToPersist, null);\n  const mature = buildS6m(records, terminalIds(10));\n  const unlocked = evaluateMlbS6qFiftySettlementHumanReview(records, mature.report, immature.certificates, certifiedS6pReport(), terminalIds(10), { baseline: null, evidence: null }, { generatedAt: "2026-08-01T21:03:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords: records.length });\n  assert.equal(unlocked.report.state, "OBSERVING_FIFTY_RESULT_STABILITY");\n  assert.ok(unlocked.baselineToPersist);\n});`);
}

// Ensure the primary certification test uses ten or more independent certifications.
tests = replaceAll(tests, "buildS6m(records, terminalIds(50))", "buildS6m(records, terminalIds(10))");
// Certificate creation still needs all 50 records; the certificate is generated independently of certification coverage.

const extraTest = `\n\ntest("does not permit automatic model changes after human review becomes ready", () => {\n  const records = recordsFor(50);\n  const { report, certificates } = buildS6m(records, terminalIds(10));\n  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");\n  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);\n  assert.equal(second.report.state, "READY_FOR_HUMAN_REVIEW");\n  assert.equal(second.report.readiness.humanReviewReady, true);\n  assert.equal(second.report.readiness.conclusionsAllowed, true);\n  assert.equal(second.report.readiness.automaticModelChangesAllowed, false);\n  assert.equal(second.report.readiness.recommendation, "NO_AUTOMATIC_MODEL_CHANGE");\n  assert.ok(second.evidenceToPersist?.concentration);\n});\n`;
if (!tests.includes("does not permit automatic model changes after human review becomes ready")) tests += extraTest;

if (!tests.includes("WAITING_FOR_TEN_CERTIFIED_CYCLES") || !tests.includes("READY_FOR_HUMAN_REVIEW")) {
  throw new Error("S6Q focused tests were not generated correctly");
}
fs.writeFileSync(testTargetPath, tests);

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
    serviceTargetPath,
    testTargetPath,
    "server/mlb-settlement-worker.ts"
  ],
  exclude: ["node_modules", "dist"],
  compilerOptions: { target: "ES2022", noEmit: true }
};
fs.writeFileSync("tsconfig.s6q-fifty-settlement-human-review.json", `${JSON.stringify(tsconfig, null, 2)}\n`);

const docs = `# S6Q / Phase 5C-6 — Preferred 50-settlement human review gate\n\n## Objective\n\nCertify the deterministic first 50 clean post-fix binary MLB settlements and require at least ten independently certified decisions before enabling a formal human scientific review. S6Q never authorizes automatic model changes.\n\n## Prerequisites\n\n- S6M milestone 50 certificate exists and passes independent reconstruction.\n- S6P has certified the minimum sample of 20 settlements.\n- At least ten decisions among the first 50 are independently certified by S6K.\n- S6M/S6L metric parity passes with zero critical issues.\n- The owned ledger remains immutable and monotonic.\n\n## State machine\n\n\`ARMED_AND_WAITING_FOR_50 -> WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION -> WAITING_FOR_TEN_CERTIFIED_CYCLES -> OBSERVING_FIFTY_RESULT_STABILITY -> READY_FOR_HUMAN_REVIEW\`\n\nAny integrity, persistence, certificate, prerequisite, or evidence failure enters \`ACTION_REQUIRED\`.\n\n## Evidence\n\nThe append-only review package contains the immutable first-50 manifest, independent metrics, Brier Score, log loss, Wilson interval, ECE/MCE, informational flat-one-unit ROI, CLV coverage and distribution, market and signal breakdowns, calibration buckets, PROVISIONAL-to-FINAL movement, and descriptive market/signal concentration.\n\n## Scientific boundary\n\nAt \`READY_FOR_HUMAN_REVIEW\`, human interpretation is allowed, but \`automaticModelChangesAllowed=false\` and recommendation remains \`NO_AUTOMATIC_MODEL_CHANGE\`. Any candidate change must be versioned separately and tested in SHADOW.\n\n## Runtime\n\nEnabled by default only in \`p0-integration\`, with a five-minute interval and stability window. Public health: \`GET /health/s6q-fifty-settlement-human-review\`. Protected status/evidence routes are under \`/api/mlb/ledger/v1/s6q-fifty-settlement-human-review\`.\n\n## Safety\n\nSHADOW mode, zero financial exposure, no sportsbook integration, no automatic betting, no production writes, no historical mutation, no automatic promotion, and no formula/probability/signal/market/threshold/settlement/stake changes.\n`;
fs.writeFileSync("docs/S6Q_PHASE5C6_FIFTY_SETTLEMENT_HUMAN_REVIEW.md", docs);

const stagingPath = "server/s5b-staging-entry.ts";
let staging = fs.readFileSync(stagingPath, "utf8");
staging = replaceOnce(
  staging,
  'import { startMlbS6pFirstTwentySettlementsCertificationWorker } from "./mlb-s6p-first-twenty-settlements-certification";',
  'import { startMlbS6pFirstTwentySettlementsCertificationWorker } from "./mlb-s6p-first-twenty-settlements-certification";\nimport { startMlbS6qFiftySettlementHumanReviewWorker } from "./mlb-s6q-fifty-settlement-human-review";',
  "S6Q import anchor",
);
staging = replaceOnce(
  staging,
  `const s6pFirstTwentySettlements = startMlbS6pFirstTwentySettlementsCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6oFirstFiveSettlements.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);`,
  `const s6pFirstTwentySettlements = startMlbS6pFirstTwentySettlementsCertificationWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6oFirstFiveSettlements.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);\nconst s6qFiftySettlementHumanReview = startMlbS6qFiftySettlementHumanReviewWorker(\n  ledgerStore,\n  ownershipStore,\n  s6mStatisticalMilestones.service,\n  s6pFirstTwentySettlements.service,\n  s6kFirstTenCyclesCertification.service,\n  { ownerUserId: systemOwnerUserId },\n);`,
  "S6Q worker anchor",
);

const healthAnchor = 'app.get("/health/s6p-first-twenty-settlements", (_req, res) => {';
const healthRoute = `app.get("/health/s6q-fifty-settlement-human-review", (_req, res) => {\n  const status = s6qFiftySettlementHumanReview.service.status();\n  const latest = status.latest;\n  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);\n  res.status(ready ? 200 : 503).json({\n    status: ready ? "healthy" : "pending",\n    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",\n    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",\n    schemaVersion: status.schemaVersion, enabled: status.enabled, intervalMs: status.intervalMs, initialDelayMs: status.initialDelayMs,\n    minimumStabilityMs: status.minimumStabilityMs, maxSnapshots: status.maxSnapshots, lastRunAt: status.lastRunAt, lastSuccessAt: status.lastSuccessAt, lastError: status.lastError,\n    latest: latest ? {\n      state: latest.state, sourceS6m: latest.sourceS6m, sourceS6p: latest.sourceS6p, sample: latest.sample, target: latest.target,\n      stability: latest.stability, checks: latest.checks, readiness: latest.readiness, persistence: latest.persistence,\n      issueCounts: latest.issues.reduce((counts, entry) => { counts[entry.severity] = (counts[entry.severity] ?? 0) + 1; return counts; }, { INFO: 0, WARNING: 0, CRITICAL: 0 }),\n    } : null,\n    safety: latest?.safety ?? { mode: "SHADOW", realFinancialExposure: 0, sportsbookIntegration: false, automaticBetPlacement: false, productionWrites: false, historicalLedgerMutation: false, automaticPromotion: false, formulasChanged: false, probabilitiesChanged: false, signalsChanged: false, marketsChanged: false, thresholdsChanged: false, settlementRulesChanged: false, stakePolicyChanged: false },\n  });\n});\n\n`;
if (!staging.includes('/health/s6q-fifty-settlement-human-review')) staging = replaceOnce(staging, healthAnchor, healthRoute + healthAnchor, "S6Q health route");

const apiAnchor = 'app.get("/api/mlb/ledger/v1/s6p-first-twenty-settlements/status", (_req, res) => {';
const apiRoutes = `app.get("/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/status", (_req, res) => {\n  const status = s6qFiftySettlementHumanReview.service.status();\n  res.json({ success: true, data: { schemaVersion: status.schemaVersion, enabled: status.enabled, intervalMs: status.intervalMs, initialDelayMs: status.initialDelayMs, minimumStabilityMs: status.minimumStabilityMs, maxSnapshots: status.maxSnapshots, lastRunAt: status.lastRunAt, lastSuccessAt: status.lastSuccessAt, lastError: status.lastError, latest: status.latest } });\n});\n\napp.get("/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/evidence", (_req, res) => {\n  const latest = s6qFiftySettlementHumanReview.service.readLatest();\n  if (!latest) { res.status(404).json({ success: false, error: "No S6Q fifty-settlement human-review report has completed yet" }); return; }\n  res.json({ success: true, data: { latest, baseline: s6qFiftySettlementHumanReview.service.readBaseline(), evidence: s6qFiftySettlementHumanReview.service.readEvidence() } });\n});\n\n`;
if (!staging.includes('/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/status')) staging = replaceOnce(staging, apiAnchor, apiRoutes + apiAnchor, "S6Q API routes");
fs.writeFileSync(stagingPath, staging);

const contractPath = "server/route-contract.extensions.json";
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
for (const routePath of ["/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/evidence", "/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/status"]) {
  if (!contract.some((entry) => entry.method === "GET" && entry.path === routePath)) contract.push({ method: "GET", path: routePath, registrations: 1 });
}
contract.sort((left, right) => left.method.localeCompare(right.method) || left.path.localeCompare(right.path));
fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

const shadowPath = "tsconfig.s5b-shadow.json";
const shadow = JSON.parse(fs.readFileSync(shadowPath, "utf8"));
for (const file of [serviceTargetPath, testTargetPath]) if (!shadow.include.includes(file)) shadow.include.push(file);
fs.writeFileSync(shadowPath, `${JSON.stringify(shadow, null, 2)}\n`);

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
if (!pkg.scripts["test:s5b-shadow"].includes(testTargetPath)) pkg.scripts["test:s5b-shadow"] += ` ${testTargetPath}`;
pkg.scripts["test:s6q-fifty-settlement-human-review"] = `tsx --test ${testTargetPath}`;
pkg.scripts["typecheck:s6q-fifty-settlement-human-review"] = "tsc -p tsconfig.s6q-fifty-settlement-human-review.json";
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const validation = `name: Validate S6Q Fifty Settlement Human Review\n\non:\n  pull_request:\n    branches:\n      - integration/p0-staging-secure\n    paths:\n      - 'server/mlb-s6q-fifty-settlement-human-review.ts'\n      - 'server/mlb-s6q-fifty-settlement-human-review.test.ts'\n      - 'server/mlb-s6p-first-twenty-settlements-certification.ts'\n      - 'server/mlb-s6m-statistical-milestones.ts'\n      - 'server/s5b-staging-entry.ts'\n      - 'server/route-contract.extensions.json'\n      - 'tsconfig.s6q-fifty-settlement-human-review.json'\n      - 'tsconfig.s5b-shadow.json'\n      - 'package.json'\n      - 'docs/S6Q_PHASE5C6_FIFTY_SETTLEMENT_HUMAN_REVIEW.md'\n      - '.github/workflows/validate-s6q-fifty-settlement-human-review.yml'\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\njobs:\n  validate-s6q:\n    runs-on: ubuntu-latest\n    timeout-minutes: 25\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v5\n        with:\n          node-version: '24'\n          cache: npm\n      - run: npm ci\n      - name: Run focused Phase 5C-6 tests\n        run: npm run test:s6q-fifty-settlement-human-review\n      - name: Type-check Phase 5C-6 surface\n        run: npm run typecheck:s6q-fifty-settlement-human-review\n      - name: Type-check complete shadow surface\n        run: npm run typecheck:s5b-shadow\n      - name: Preserve modular route contract\n        run: npm run test:s3-modularization\n      - name: Build production backend bundle\n        run: npm run build:backend\n      - name: Verify scientific and safety boundaries\n        shell: bash\n        run: |\n          set -euo pipefail\n          grep -q 'ARMED_AND_WAITING_FOR_50' server/mlb-s6q-fifty-settlement-human-review.ts\n          grep -q 'WAITING_FOR_TEN_CERTIFIED_CYCLES' server/mlb-s6q-fifty-settlement-human-review.ts\n          grep -q 'READY_FOR_HUMAN_REVIEW' server/mlb-s6q-fifty-settlement-human-review.ts\n          grep -q 'humanReviewReady' server/mlb-s6q-fifty-settlement-human-review.ts\n          grep -q 'automaticModelChangesAllowed: false' server/mlb-s6q-fifty-settlement-human-review.ts\n          grep -q 'realFinancialExposure: 0' server/mlb-s6q-fifty-settlement-human-review.ts\n          grep -q '/health/s6q-fifty-settlement-human-review' server/s5b-staging-entry.ts\n          grep -q '/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/status' server/s5b-staging-entry.ts\n          grep -q '/api/mlb/ledger/v1/s6q-fifty-settlement-human-review/evidence' server/s5b-staging-entry.ts\n`;
fs.writeFileSync(".github/workflows/validate-s6q-fifty-settlement-human-review.yml", validation);

console.log("Generated and integrated S6Q Phase 5C-6.");

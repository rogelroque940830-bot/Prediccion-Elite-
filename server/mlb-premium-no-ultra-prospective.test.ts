import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import {
  buildMlbPremiumNoUltraProspective,
  MLB_PREMIUM_NO_ULTRA_CUTOFF,
  selectedPremiumNoUltra,
} from "./mlb-premium-no-ultra-prospective";

function reviewRow(overrides: Partial<MlbP1M3dReviewRow> = {}): MlbP1M3dReviewRow {
  return {
    predictionId: "p-1",
    lifecycleKey: "life-1",
    recordedAt: "2026-08-09T16:00:00Z",
    gameDate: "2026-08-09",
    gamePk: 900001,
    homeTeam: "HOME",
    awayTeam: "AWAY",
    market: "F5_ML",
    selection: "HOME",
    line: null,
    oddsAmerican: -110,
    closingOddsAmerican: -115,
    stage: "FINAL",
    sourceSignal: "BET",
    sourceCategory: "PREMIUM",
    disposition: "ACCEPTED",
    effectiveDecision: "BET",
    actionability: "ACTIONABLE_FINAL",
    effectiveAnalyticalUnits: 1,
    economicLayerValid: true,
    economicLayerErrors: [],
    modelProbability: 0.7,
    marketImpliedProbability: 0.52381,
    noVigProbability: 0.51,
    edgePp: 19,
    result: "WIN",
    settledAt: "2026-08-10T03:00:00Z",
    flatProfitUnits: 0.909091,
    policyProfitUnits: 0,
    brierScore: 0.09,
    logLoss: 0.356675,
    clvPp: 0.8,
    dataQualityCoveragePct: 100,
    dataQualityMissing: [],
    ...overrides,
  };
}

function ledgerRecord({
  id = "p-1",
  recordedAt = "2026-08-09T16:00:00Z",
  commenceTime = "2026-08-09T23:00:00Z",
  selectedLabel = "PREMIUM",
  finalRecommendation = null as unknown,
  selectedLane = null as unknown,
  alternativePicks = [] as unknown[],
  source = "app",
}: {
  id?: string;
  recordedAt?: string;
  commenceTime?: string;
  selectedLabel?: string | null;
  finalRecommendation?: unknown;
  selectedLane?: unknown;
  alternativePicks?: unknown[];
  source?: string;
} = {}): LedgerRecord {
  return {
    prediction: {
      id,
      source,
      recordedAt,
      game: {
        gameDate: commenceTime.slice(0, 10),
        commenceTime,
        homeTeam: "HOME",
        awayTeam: "AWAY",
      },
      decision: {
        confidenceLabel: selectedLabel,
        rationale: "selected recommendation",
      },
      payload: {
        analysis: {
          rawOutput: {
            selectedLane,
            markets: {
              finalRecommendation,
              alternativePicks,
            },
          },
        },
      },
    },
    settlement: null,
  } as unknown as LedgerRecord;
}

function reportFor(rows: MlbP1M3dReviewRow[], records: LedgerRecord[]) {
  return buildMlbPremiumNoUltraProspective(rows, records, {
    minimumCandidateSettled: 1,
    minimumCandidateDates: 1,
    minimumControlSettled: 1,
    minimumControlDates: 1,
    bootstrapReplicates: 500,
    generatedAt: "2026-10-01T00:00:00Z",
  });
}

test("cutoff is frozen at the permanent-evidence merge timestamp", () => {
  assert.equal(MLB_PREMIUM_NO_ULTRA_CUTOFF, "2026-08-08T04:32:33Z");
});

test("selected PREMIUM without selected ULTRA is candidate; alternative ULTRA text is ignored", () => {
  const record = ledgerRecord({
    selectedLabel: "PREMIUM",
    alternativePicks: [{ confidenceLabel: "ULTRA", note: "not selected" }],
  });
  assert.equal(selectedPremiumNoUltra(record), true);
});

test("selected ULTRA blocks candidate membership even when PREMIUM also appears", () => {
  const record = ledgerRecord({
    selectedLabel: "PREMIUM ULTRA",
  });
  assert.equal(selectedPremiumNoUltra(record), false);
});

test("pre-cutoff and PROVISIONAL rows never enter the prospective FINAL cohort", () => {
  const before = reviewRow({
    predictionId: "before",
    lifecycleKey: "before",
    gamePk: 900010,
    recordedAt: "2026-08-08T04:32:32Z",
  });
  const provisional = reviewRow({
    predictionId: "provisional",
    lifecycleKey: "provisional",
    gamePk: 900011,
    stage: "PROVISIONAL",
  });
  const control = reviewRow({
    predictionId: "control",
    lifecycleKey: "control",
    gamePk: 900012,
    sourceCategory: "STANDARD",
  });
  const result = reportFor(
    [before, provisional, control],
    [
      ledgerRecord({ id: "before", recordedAt: before.recordedAt, selectedLabel: "PREMIUM" }),
      ledgerRecord({ id: "provisional", recordedAt: provisional.recordedAt, selectedLabel: "PREMIUM" }),
      ledgerRecord({ id: "control", recordedAt: control.recordedAt, selectedLabel: "STANDARD" }),
    ],
  );
  assert.equal(result.cohort.afterCutoff, 2);
  assert.equal(result.cohort.eligibleFinalF5Rows, 1);
  assert.equal(result.cohort.candidateGames, 0);
  assert.equal(result.cohort.controlGames, 1);
});

test("multiple FINAL rows from the same game count once and the latest terminal decision wins", () => {
  const first = reviewRow({
    predictionId: "same-1",
    lifecycleKey: "same-life-1",
    gamePk: 900020,
    recordedAt: "2026-08-09T15:00:00Z",
  });
  const latest = reviewRow({
    predictionId: "same-2",
    lifecycleKey: "same-life-2",
    gamePk: 900020,
    recordedAt: "2026-08-09T16:00:00Z",
    result: "LOSS",
    flatProfitUnits: -1,
    brierScore: 0.49,
    logLoss: 1.203973,
  });
  const result = reportFor(
    [first, latest],
    [
      ledgerRecord({ id: "same-1", recordedAt: first.recordedAt, selectedLabel: "PREMIUM" }),
      ledgerRecord({ id: "same-2", recordedAt: latest.recordedAt, selectedLabel: "STANDARD" }),
    ],
  );
  assert.equal(result.cohort.independentGames, 1);
  assert.equal(result.cohort.duplicateGameRowsExcluded, 1);
  assert.equal(result.cohort.candidateGames, 0);
  assert.equal(result.cohort.controlGames, 1);
});

test("changing future outcome and scoring cannot change candidate membership", () => {
  const candidate = reviewRow({ predictionId: "candidate", lifecycleKey: "candidate", gamePk: 900030 });
  const control = reviewRow({ predictionId: "control", lifecycleKey: "control", gamePk: 900031, sourceCategory: "STANDARD" });
  const records = [
    ledgerRecord({ id: "candidate", recordedAt: candidate.recordedAt, selectedLabel: "PREMIUM" }),
    ledgerRecord({ id: "control", recordedAt: control.recordedAt, selectedLabel: "STANDARD" }),
  ];
  const original = reportFor([candidate, control], records);
  const mutatedCandidate = {
    ...candidate,
    result: "LOSS",
    flatProfitUnits: -1,
    brierScore: 0.49,
    logLoss: 1.203973,
    clvPp: -4,
  } satisfies MlbP1M3dReviewRow;
  const mutated = reportFor([mutatedCandidate, control], records);
  assert.equal(original.cohort.candidateGames, 1);
  assert.equal(mutated.cohort.candidateGames, 1);
  assert.equal(original.cohort.controlGames, mutated.cohort.controlGames);
  assert.equal(original.interpretation.historicalThirteenAndFourIncludedInConfirmation, false);
  assert.equal(mutated.interpretation.historicalThirteenAndFourIncludedInConfirmation, false);
});

function isoDate(dayOffset: number): string {
  const base = Date.parse("2026-08-09T00:00:00Z");
  return new Date(base + dayOffset * 86_400_000).toISOString().slice(0, 10);
}

function syntheticPair(index: number, candidateWin: boolean, controlWin: boolean): {
  rows: MlbP1M3dReviewRow[];
  records: LedgerRecord[];
} {
  const date = isoDate(Math.floor(index / 2));
  const candidateId = `cand-${index}`;
  const controlId = `ctrl-${index}`;
  const recordedAt = `${date}T16:00:00Z`;
  const commenceTime = `${date}T23:00:00Z`;
  const candidateProbability = 0.9;
  const controlProbability = 0.5;
  const candidateBrier = (candidateProbability - (candidateWin ? 1 : 0)) ** 2;
  const controlBrier = (controlProbability - (controlWin ? 1 : 0)) ** 2;
  const candidateLogLoss = -(candidateWin ? Math.log(candidateProbability) : Math.log(1 - candidateProbability));
  const controlLogLoss = -(controlWin ? Math.log(controlProbability) : Math.log(1 - controlProbability));
  return {
    rows: [
      reviewRow({
        predictionId: candidateId,
        lifecycleKey: candidateId,
        recordedAt,
        gameDate: date,
        gamePk: 910000 + index,
        modelProbability: candidateProbability,
        result: candidateWin ? "WIN" : "LOSS",
        flatProfitUnits: candidateWin ? 0.909091 : -1,
        brierScore: candidateBrier,
        logLoss: candidateLogLoss,
        clvPp: 1,
      }),
      reviewRow({
        predictionId: controlId,
        lifecycleKey: controlId,
        recordedAt,
        gameDate: date,
        gamePk: 920000 + index,
        sourceCategory: "STANDARD",
        modelProbability: controlProbability,
        result: controlWin ? "WIN" : "LOSS",
        flatProfitUnits: controlWin ? 0.909091 : -1,
        brierScore: controlBrier,
        logLoss: controlLogLoss,
        clvPp: 0.2,
      }),
    ],
    records: [
      ledgerRecord({ id: candidateId, recordedAt, commenceTime, selectedLabel: "PREMIUM" }),
      ledgerRecord({ id: controlId, recordedAt, commenceTime, selectedLabel: "STANDARD" }),
    ],
  };
}

test("strong synthetic future evidence can reach research support but never activates money or betting", () => {
  const rows: MlbP1M3dReviewRow[] = [];
  const records: LedgerRecord[] = [];
  for (let index = 0; index < 60; index += 1) {
    const pair = syntheticPair(index, index % 10 !== 0, index % 2 === 0);
    rows.push(...pair.rows);
    records.push(...pair.records);
  }
  const report = buildMlbPremiumNoUltraProspective(rows, records, {
    minimumCandidateSettled: 50,
    minimumCandidateDates: 20,
    minimumControlSettled: 50,
    minimumControlDates: 20,
    bootstrapReplicates: 500,
    generatedAt: "2026-10-01T00:00:00Z",
  });
  assert.equal(report.cohort.candidateSettled, 60);
  assert.equal(report.cohort.controlSettled, 60);
  assert.equal(report.criteria.minimumCandidateSampleAccepted, true);
  assert.equal(report.criteria.minimumControlSampleAccepted, true);
  assert.equal(report.criteria.candidateRoiLower95Positive, true);
  assert.equal(report.criteria.candidateMinusControlRoiLower95Positive, true);
  assert.equal(report.criteria.meanClvPositive, true);
  assert.equal(report.criteria.properScoringNotWorse, true);
  assert.equal(report.criteria.calibrationAccepted, true);
  assert.equal(report.criteria.allAccepted, true);
  assert.equal(report.state, "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY");
  assert.equal(report.interpretation.economicProfitabilitySupported, true);
  assert.equal(report.interpretation.operationalMoneyGateAllowed, false);
  assert.equal(report.interpretation.stakeChangesAllowed, false);
  assert.equal(report.interpretation.automaticBettingAllowed, false);
  assert.equal(report.interpretation.automaticPromotionAllowed, false);
});

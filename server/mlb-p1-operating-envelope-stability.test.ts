import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3e2OperatingEnvelopeStability,
  matchesMlbP1M3e2Rule,
} from "./mlb-p1-operating-envelope-stability";
import type { MlbP1M3eRule } from "./mlb-p1-operating-envelope";

function isoDate(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
}

function score(probability: number, won: boolean) {
  const target = won ? 1 : 0;
  return {
    logLoss: -(target * Math.log(probability) + (1 - target) * Math.log(1 - probability)),
    brierScore: (probability - target) ** 2,
  };
}

function row(input: {
  id: string;
  day: number;
  won: boolean;
  quality: number;
}): MlbP1M3dReviewRow {
  const probability = 0.8;
  const scores = score(probability, input.won);
  const gameDate = isoDate(input.day);
  return {
    predictionId: input.id,
    lifecycleKey: `life:${input.id}`,
    recordedAt: `${gameDate}T16:00:00.000Z`,
    gameDate,
    gamePk: 800000 + input.day * 100 + Number(input.id.replace(/\D/g, "").slice(-2) || 1),
    homeTeam: "HOME",
    awayTeam: "AWAY",
    market: "ML",
    selection: "HOME",
    line: null,
    oddsAmerican: 100,
    closingOddsAmerican: 100,
    stage: "FINAL",
    sourceSignal: "BET",
    sourceCategory: "PREMIUM",
    disposition: "ACCEPTED",
    effectiveDecision: "BET",
    actionability: "ACTIONABLE_FINAL",
    effectiveAnalyticalUnits: 0.5,
    economicLayerValid: true,
    economicLayerErrors: [],
    modelProbability: probability,
    marketImpliedProbability: 0.55,
    noVigProbability: 0.54,
    edgePp: 25,
    result: input.won ? "WIN" : "LOSS",
    settledAt: `${gameDate}T23:00:00.000Z`,
    flatProfitUnits: input.won ? 1 : -1,
    policyProfitUnits: input.won ? 0.5 : -0.5,
    brierScore: scores.brierScore,
    logLoss: scores.logLoss,
    clvPp: input.won ? 1 : -1,
    dataQualityCoveragePct: input.quality,
    dataQualityMissing: [],
  };
}

type Phase = "discovery" | "validation" | "confirmation";
type Pattern = Record<Phase, { selectedWins: number; rejectedWins: number }>;

function phaseForDay(day: number): Phase {
  if (day < 24) return "discovery";
  if (day < 36) return "validation";
  return "confirmation";
}

function makeRows(pattern: Pattern, days = 48): MlbP1M3dReviewRow[] {
  const rows: MlbP1M3dReviewRow[] = [];
  for (let day = 0; day < days; day += 1) {
    const phase = phaseForDay(day);
    const values = pattern[phase];
    for (let slot = 0; slot < 5; slot += 1) {
      rows.push(row({
        id: `selected-${day}-${slot}`,
        day,
        won: slot < values.selectedWins,
        quality: 100,
      }));
      rows.push(row({
        id: `rejected-${day}-${slot}`,
        day,
        won: slot < values.rejectedWins,
        quality: 80,
      }));
    }
  }
  return rows;
}

const stablePattern: Pattern = {
  discovery: { selectedWins: 4, rejectedWins: 2 },
  validation: { selectedWins: 4, rejectedWins: 2 },
  confirmation: { selectedWins: 4, rejectedWins: 2 },
};

const options = {
  minimumTotalObservations: 120,
  minimumTotalDates: 36,
  minimumDiscoverySelected: 24,
  minimumDiscoveryRejected: 24,
  minimumHoldoutSelected: 12,
  minimumHoldoutRejected: 12,
  minimumHoldoutSelectedDates: 6,
  minimumHoldoutCoveragePct: 10,
  maximumHoldoutCoveragePct: 70,
  bootstrapReplicates: 500,
  generatedAt: "2026-08-08T15:00:00.000Z",
} as const;

test("stable pregame envelope must survive discovery, validation and final untouched confirmation", () => {
  const report = buildMlbP1M3e2OperatingEnvelopeStability(makeRows(stablePattern), options);
  assert.equal(report.temporalSplit.leakageFree, true);
  assert.ok((report.temporalSplit.discovery.maxDate as string) < (report.temporalSplit.validation.minDate as string));
  assert.ok((report.temporalSplit.validation.maxDate as string) < (report.temporalSplit.confirmation.minDate as string));
  assert.equal(report.state, "STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY");
  assert.ok(report.selectedRule);
  assert.ok(report.selectedRule.atoms.some((atom) => atom.kind === "DATA_QUALITY_AT_LEAST"));
  assert.equal(report.validation?.criteria.allAccepted, true);
  assert.equal(report.confirmation?.criteria.allAccepted, true);
  assert.ok((report.validation?.logLossImprovement?.lower ?? 0) > 0);
  assert.ok((report.validation?.brierImprovement?.lower ?? 0) > 0);
  assert.ok((report.confirmation?.logLossImprovement?.lower ?? 0) > 0);
  assert.ok((report.confirmation?.brierImprovement?.lower ?? 0) > 0);
  assert.equal(report.interpretation.stableModelQualityEnvelopeSupported, true);
  assert.equal(report.interpretation.economicProfitabilityCertified, false);
  assert.equal(report.interpretation.operationalRecommendationGateAllowed, false);
  assert.equal(report.interpretation.bettingRecommendationAllowed, false);
  assert.equal(report.interpretation.stakeChangesAllowed, false);
  assert.equal(report.interpretation.automaticBettingAllowed, false);
  assert.equal(report.interpretation.automaticModelChangesAllowed, false);
  assert.equal(report.interpretation.automaticPromotionAllowed, false);
  assert.equal(report.economicsDiagnostics.promotionCriterion, false);
});

test("discovery winner is frozen before validation and rejected when validation reverses", () => {
  const reversedValidation: Pattern = {
    ...stablePattern,
    validation: { selectedWins: 2, rejectedWins: 4 },
  };
  const stable = buildMlbP1M3e2OperatingEnvelopeStability(makeRows(stablePattern), options);
  const reversed = buildMlbP1M3e2OperatingEnvelopeStability(makeRows(reversedValidation), options);
  assert.deepEqual(reversed.selectedRule, stable.selectedRule);
  assert.equal(reversed.state, "VALIDATION_FAILED");
  assert.equal(reversed.validation?.criteria.allAccepted, false);
  assert.equal(reversed.interpretation.stableModelQualityEnvelopeSupported, false);
  assert.ok(reversed.blockers.some((value) => value.startsWith("P1_M3E2_VALIDATION_")));
});

test("a rule that survives validation is still rejected when the final holdout reverses", () => {
  const reversedConfirmation: Pattern = {
    ...stablePattern,
    confirmation: { selectedWins: 2, rejectedWins: 4 },
  };
  const report = buildMlbP1M3e2OperatingEnvelopeStability(makeRows(reversedConfirmation), options);
  assert.equal(report.validation?.criteria.allAccepted, true);
  assert.equal(report.confirmation?.criteria.allAccepted, false);
  assert.equal(report.state, "CONFIRMATION_FAILED");
  assert.equal(report.interpretation.stableModelQualityEnvelopeSupported, false);
  assert.ok(report.blockers.some((value) => value.startsWith("P1_M3E2_CONFIRMATION_")));
});

test("rule membership cannot change when settlement, scores, profit, closing price or CLV change", () => {
  const original = row({ id: "invariant-1", day: 0, won: true, quality: 100 });
  const rule: MlbP1M3eRule = {
    atoms: [
      { kind: "DATA_QUALITY_AT_LEAST", value: 95 },
      { kind: "MODEL_PROBABILITY_AT_LEAST", value: 0.7 },
    ],
    ruleKey: "DATA_QUALITY_AT_LEAST:95&&MODEL_PROBABILITY_AT_LEAST:0.7",
  };
  const mutated: MlbP1M3dReviewRow = {
    ...original,
    result: "LOSS",
    settledAt: "2030-01-01T00:00:00.000Z",
    brierScore: 0.99,
    logLoss: 9.9,
    flatProfitUnits: -100,
    policyProfitUnits: -50,
    closingOddsAmerican: -999,
    clvPp: -25,
  };
  assert.equal(matchesMlbP1M3e2Rule(original, rule), true);
  assert.equal(matchesMlbP1M3e2Rule(mutated, rule), true);
});

test("insufficient date diversity cannot produce a stable research envelope", () => {
  const report = buildMlbP1M3e2OperatingEnvelopeStability(makeRows(stablePattern, 20), options);
  assert.equal(report.state, "INSUFFICIENT_SAMPLE");
  assert.equal(report.selectedRule, null);
  assert.equal(report.interpretation.stableModelQualityEnvelopeSupported, false);
  assert.equal(report.interpretation.operationalRecommendationGateAllowed, false);
});

test("pushes, pending rows and missing proper scores stay outside the scientific cohort", () => {
  const base = makeRows(stablePattern);
  const push = { ...row({ id: "push", day: 49, won: true, quality: 100 }), result: "PUSH" };
  const pending = { ...row({ id: "pending", day: 50, won: true, quality: 100 }), result: null, settledAt: null };
  const unscored = { ...row({ id: "unscored", day: 51, won: true, quality: 100 }), brierScore: null, logLoss: null };
  const report = buildMlbP1M3e2OperatingEnvelopeStability([...base, push, pending, unscored], options);
  assert.equal(report.cohort.inputRows, base.length + 3);
  assert.equal(report.cohort.scoreableRows, base.length);
  assert.equal(report.cohort.excludedRows, 3);
});

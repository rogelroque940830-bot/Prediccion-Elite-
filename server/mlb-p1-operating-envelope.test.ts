import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3eCandidateRules,
  buildMlbP1M3eOperatingEnvelope,
  matchesMlbP1M3eRule,
  type MlbP1M3eRule,
} from "./mlb-p1-operating-envelope";

function isoDate(offset: number): string {
  const date = new Date(Date.UTC(2026, 3, 1 + offset));
  return date.toISOString().slice(0, 10);
}

function score(probability: number, won: boolean): { logLoss: number; brier: number } {
  const target = won ? 1 : 0;
  return {
    logLoss: -(target * Math.log(probability) + (1 - target) * Math.log(1 - probability)),
    brier: (probability - target) ** 2,
  };
}

function row(input: {
  id: string;
  gameDate: string;
  won: boolean;
  quality: number;
  probability?: number;
}): MlbP1M3dReviewRow {
  const probability = input.probability ?? 0.8;
  const scored = score(probability, input.won);
  return {
    predictionId: input.id,
    lifecycleKey: `life:${input.id}`,
    recordedAt: `${input.gameDate}T16:00:00.000Z`,
    gameDate: input.gameDate,
    gamePk: 700000 + Number(input.id.replace(/\D/g, "").slice(-5) || 1),
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
    edgePp: (probability - 0.55) * 100,
    result: input.won ? "WIN" : "LOSS",
    settledAt: `${input.gameDate}T23:00:00.000Z`,
    flatProfitUnits: input.won ? 1 : -1,
    policyProfitUnits: input.won ? 0.5 : -0.5,
    brierScore: scored.brier,
    logLoss: scored.logLoss,
    clvPp: input.won ? 1 : -1,
    dataQualityCoveragePct: input.quality,
    dataQualityMissing: [],
  };
}

function makeStableEnvelopeRows(): MlbP1M3dReviewRow[] {
  const rows: MlbP1M3dReviewRow[] = [];
  let goodIndex = 0;
  let badIndex = 0;
  for (let day = 0; day < 40; day += 1) {
    for (let slot = 0; slot < 2; slot += 1) {
      const goodWon = goodIndex % 5 !== 0; // 80% observed win rate at p=.80
      rows.push(row({ id: `g-${day}-${slot}`, gameDate: isoDate(day), won: goodWon, quality: 100 }));
      goodIndex += 1;
      const badWon = badIndex % 2 === 0; // 50% observed win rate at p=.80
      rows.push(row({ id: `b-${day}-${slot}`, gameDate: isoDate(day), won: badWon, quality: 80 }));
      badIndex += 1;
    }
  }
  return rows;
}

function makeSpuriousEnvelopeRows(): MlbP1M3dReviewRow[] {
  const rows: MlbP1M3dReviewRow[] = [];
  let goodDiscovery = 0;
  let badDiscovery = 0;
  let goodConfirmation = 0;
  let badConfirmation = 0;
  for (let day = 0; day < 40; day += 1) {
    const discovery = day < 24;
    for (let slot = 0; slot < 2; slot += 1) {
      if (discovery) {
        rows.push(row({
          id: `gd-${day}-${slot}`,
          gameDate: isoDate(day),
          won: goodDiscovery % 5 !== 0,
          quality: 100,
        }));
        goodDiscovery += 1;
        rows.push(row({
          id: `bd-${day}-${slot}`,
          gameDate: isoDate(day),
          won: badDiscovery % 2 === 0,
          quality: 80,
        }));
        badDiscovery += 1;
      } else {
        rows.push(row({
          id: `gc-${day}-${slot}`,
          gameDate: isoDate(day),
          won: goodConfirmation % 2 === 0,
          quality: 100,
        }));
        goodConfirmation += 1;
        rows.push(row({
          id: `bc-${day}-${slot}`,
          gameDate: isoDate(day),
          won: badConfirmation % 5 !== 0,
          quality: 80,
        }));
        badConfirmation += 1;
      }
    }
  }
  return rows;
}

test("pre-registered rule library is bounded to at most two non-redundant conditions", () => {
  const rules = buildMlbP1M3eCandidateRules();
  assert.ok(rules.length > 0);
  assert.ok(rules.every((candidate) => candidate.atoms.length >= 1 && candidate.atoms.length <= 2));
  assert.equal(new Set(rules.map((candidate) => candidate.ruleKey)).size, rules.length);
});

test("operating envelope can be supported only when discovery survives later chronological confirmation", () => {
  const report = buildMlbP1M3eOperatingEnvelope(makeStableEnvelopeRows(), {
    minimumTotalObservations: 80,
    minimumTotalDates: 30,
    minimumDiscoverySelected: 20,
    minimumDiscoveryRejected: 20,
    minimumConfirmationSelected: 15,
    minimumConfirmationRejected: 15,
    minimumConfirmationSelectedDates: 10,
    minimumConfirmationCoveragePct: 10,
    bootstrapReplicates: 500,
    generatedAt: "2026-08-07T22:10:00.000Z",
  });

  assert.equal(report.temporalSplit.leakageFree, true);
  assert.ok((report.temporalSplit.discoveryMaxDate as string) < (report.temporalSplit.confirmationMinDate as string));
  assert.equal(report.state, "ELITE_MODEL_QUALITY_SUPPORTED");
  assert.ok(report.selectedRule);
  assert.ok(report.selectedRule.atoms.some((atom) => atom.kind === "DATA_QUALITY_AT_LEAST"));
  assert.ok((report.confirmation?.rejectedMinusSelectedLogLoss ?? 0) > 0);
  assert.ok((report.confirmation?.rejectedMinusSelectedBrier ?? 0) > 0);
  assert.ok((report.confirmationInference?.logLossImprovement?.lower ?? 0) > 0);
  assert.ok((report.confirmationInference?.brierImprovement?.lower ?? 0) > 0);
  assert.equal(report.interpretation.modelQualityOperatingEnvelopeSupported, true);
  assert.equal(report.interpretation.economicProfitabilityCertified, false);
  assert.equal(report.interpretation.operationalGateAllowed, false);
  assert.equal(report.interpretation.modelProbabilityChanged, false);
  assert.equal(report.interpretation.existingEconomicThresholdsChanged, false);
  assert.equal(report.interpretation.automaticModelChangesAllowed, false);
  assert.equal(report.interpretation.automaticPromotionAllowed, false);
});

test("a discovery winner is rejected when its advantage reverses in later confirmation", () => {
  const report = buildMlbP1M3eOperatingEnvelope(makeSpuriousEnvelopeRows(), {
    minimumTotalObservations: 80,
    minimumTotalDates: 30,
    minimumDiscoverySelected: 20,
    minimumDiscoveryRejected: 20,
    minimumConfirmationSelected: 15,
    minimumConfirmationRejected: 15,
    minimumConfirmationSelectedDates: 10,
    minimumConfirmationCoveragePct: 10,
    bootstrapReplicates: 500,
    generatedAt: "2026-08-07T22:10:00.000Z",
  });

  assert.ok(report.selectedRule);
  assert.equal(report.state, "CANDIDATE_NOT_CONFIRMED");
  assert.equal(report.interpretation.modelQualityOperatingEnvelopeSupported, false);
  assert.ok(report.blockers.includes("P1_M3E_LOG_LOSS_IMPROVEMENT_NOT_CONFIRMED"));
  assert.ok(report.blockers.includes("P1_M3E_BRIER_IMPROVEMENT_NOT_CONFIRMED"));
});

test("insufficient prospective evidence cannot create an elite label", () => {
  const rows = Array.from({ length: 12 }, (_, index) => row({
    id: `small-${index}`,
    gameDate: isoDate(index),
    won: index % 2 === 0,
    quality: index % 2 === 0 ? 100 : 80,
  }));
  const report = buildMlbP1M3eOperatingEnvelope(rows, { generatedAt: "2026-08-07T22:10:00.000Z" });
  assert.equal(report.state, "INSUFFICIENT_SAMPLE");
  assert.equal(report.selectedRule, null);
  assert.equal(report.interpretation.operationalGateAllowed, false);
});

test("rule membership is invariant to settlement, proper-score, profit and CLV outcomes", () => {
  const original = row({ id: "invariant", gameDate: isoDate(0), won: true, quality: 100 });
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
    brierScore: 0.99,
    logLoss: 9.9,
    flatProfitUnits: -100,
    policyProfitUnits: -50,
    clvPp: -25,
  };
  assert.equal(matchesMlbP1M3eRule(original, rule), true);
  assert.equal(matchesMlbP1M3eRule(mutated, rule), true);
});

test("pushes, unsettled rows and missing proper scores are excluded from the scientific cohort", () => {
  const base = makeStableEnvelopeRows();
  const push = { ...row({ id: "push", gameDate: isoDate(41), won: true, quality: 100 }), result: "PUSH" };
  const pending = { ...row({ id: "pending", gameDate: isoDate(42), won: true, quality: 100 }), result: null, settledAt: null };
  const unscored = { ...row({ id: "unscored", gameDate: isoDate(43), won: true, quality: 100 }), logLoss: null, brierScore: null };
  const report = buildMlbP1M3eOperatingEnvelope([...base, push, pending, unscored], {
    minimumTotalObservations: 80,
    minimumTotalDates: 30,
    bootstrapReplicates: 500,
    generatedAt: "2026-08-07T22:10:00.000Z",
  });
  assert.equal(report.cohort.inputRows, base.length + 3);
  assert.equal(report.cohort.scoreableRows, base.length);
  assert.equal(report.cohort.excludedRows, 3);
});

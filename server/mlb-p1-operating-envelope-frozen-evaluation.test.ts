import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import { buildMlbP1M3e3OperatingEnvelopeFreeze } from "./mlb-p1-operating-envelope-freeze";
import { buildMlbP1M3e4FrozenManifestEvaluation } from "./mlb-p1-operating-envelope-frozen-evaluation";

function isoDate(day: number): string {
  return new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
}

type Phase = "discovery" | "validation" | "confirmation";
type Pattern = Record<Phase, { selectedWins: number; rejectedWins: number }>;

function phase(day: number): Phase {
  if (day < 18) return "discovery";
  if (day < 27) return "validation";
  return "confirmation";
}

function row(input: {
  id: string;
  day: number;
  selected: boolean;
  won: boolean | null;
}): MlbP1M3dReviewRow {
  const gameDate = isoDate(input.day);
  const probability = 0.8;
  const result = input.won == null ? null : input.won ? "WIN" : "LOSS";
  const target = input.won == null ? null : input.won ? 1 : 0;
  return {
    predictionId: input.id,
    lifecycleKey: `life:${input.id}`,
    recordedAt: `${gameDate}T15:00:00.000Z`,
    gameDate,
    gamePk: 910000 + input.day * 20 + Number(input.id.replace(/\D/g, "").slice(-2) || 1),
    homeTeam: "HOME",
    awayTeam: "AWAY",
    market: "ML",
    selection: "HOME",
    line: null,
    oddsAmerican: 100,
    closingOddsAmerican: result == null ? null : 100,
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
    result,
    settledAt: result == null ? null : `${gameDate}T23:30:00.000Z`,
    flatProfitUnits: result === "WIN" ? 1 : result === "LOSS" ? -1 : 0,
    policyProfitUnits: result === "WIN" ? 0.5 : result === "LOSS" ? -0.5 : 0,
    brierScore: target == null ? null : (probability - target) ** 2,
    logLoss: target == null ? null : -(target * Math.log(probability) + (1 - target) * Math.log(1 - probability)),
    clvPp: result == null ? null : input.selected ? 1 : -1,
    dataQualityCoveragePct: input.selected ? 100 : 80,
    dataQualityMissing: [],
  };
}

function rows(pattern: Pattern, settled: boolean, days = 36): MlbP1M3dReviewRow[] {
  const out: MlbP1M3dReviewRow[] = [];
  for (let day = 0; day < days; day += 1) {
    const p = pattern[phase(day)];
    for (let slot = 0; slot < 5; slot += 1) {
      out.push(row({
        id: `s-${day}-${slot}`,
        day,
        selected: true,
        won: settled ? slot < p.selectedWins : null,
      }));
      out.push(row({
        id: `r-${day}-${slot}`,
        day,
        selected: false,
        won: settled ? slot < p.rejectedWins : null,
      }));
    }
  }
  return out;
}

const stable: Pattern = {
  discovery: { selectedWins: 4, rejectedWins: 2 },
  validation: { selectedWins: 4, rejectedWins: 2 },
  confirmation: { selectedWins: 4, rejectedWins: 2 },
};

const freezeOptions = {
  minimumPregameDecisions: 120,
  minimumDistinctDates: 36,
  generatedAt: "2026-08-08T15:15:00.000Z",
} as const;

const evalOptions = { generatedAt: "2026-08-08T15:20:00.000Z" } as const;

function freezeFromPending(pattern: Pattern = stable) {
  const freeze = buildMlbP1M3e3OperatingEnvelopeFreeze(rows(pattern, false), freezeOptions);
  assert.equal(freeze.state, "FROZEN_RESEARCH_WINDOW");
  assert.ok(freeze.freeze);
  return freeze;
}

test("frozen manifest waits for every frozen settlement before any outcome-driven discovery", () => {
  const pending = rows(stable, false);
  const freeze = buildMlbP1M3e3OperatingEnvelopeFreeze(pending, freezeOptions);
  const partiallySettled = rows(stable, true);
  partiallySettled[0] = { ...partiallySettled[0], result: null, settledAt: null, brierScore: null, logLoss: null };
  const report = buildMlbP1M3e4FrozenManifestEvaluation(partiallySettled, freeze, evalOptions);
  assert.equal(report.state, "FROZEN_WAITING_FOR_SETTLEMENTS");
  assert.equal(report.evaluation, null);
  assert.equal(report.cohort.unresolvedFrozenRows, 1);
  assert.equal(report.manifest.verified, true);
  assert.equal(report.settlementSnapshotDigest, null);
});

test("stable rule can be evaluated only against the exact frozen 50/25/25 partitions", () => {
  const freeze = freezeFromPending();
  const report = buildMlbP1M3e4FrozenManifestEvaluation(rows(stable, true), freeze, evalOptions);
  assert.equal(report.state, "STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY");
  assert.ok(report.evaluation?.selectedRule);
  assert.ok(report.evaluation.selectedRule.atoms.some((atom) => atom.kind === "DATA_QUALITY_AT_LEAST"));
  assert.equal(report.evaluation.validation?.criteria.allAccepted, true);
  assert.equal(report.evaluation.confirmation?.criteria.allAccepted, true);
  assert.equal(report.evaluation.temporalSplit.discovery.minDate, freeze.freeze?.discovery.minDate);
  assert.equal(report.evaluation.temporalSplit.discovery.maxDate, freeze.freeze?.discovery.maxDate);
  assert.equal(report.evaluation.temporalSplit.validation.minDate, freeze.freeze?.validation.minDate);
  assert.equal(report.evaluation.temporalSplit.confirmation.maxDate, freeze.freeze?.confirmation.maxDate);
  assert.equal(report.interpretation.stableModelQualityEnvelopeSupported, true);
  assert.equal(report.interpretation.economicProfitabilityCertified, false);
  assert.equal(report.interpretation.operationalRecommendationGateAllowed, false);
  assert.equal(report.interpretation.bettingRecommendationAllowed, false);
  assert.equal(report.interpretation.automaticBettingAllowed, false);
});

test("validation reversal fails closed and keeps confirmation unopened", () => {
  const freeze = freezeFromPending();
  const reversed: Pattern = {
    ...stable,
    validation: { selectedWins: 2, rejectedWins: 4 },
  };
  const report = buildMlbP1M3e4FrozenManifestEvaluation(rows(reversed, true), freeze, evalOptions);
  assert.equal(report.state, "VALIDATION_FAILED");
  assert.ok(report.evaluation);
  assert.equal(report.evaluation?.confirmation, null);
  assert.equal(report.interpretation.stableModelQualityEnvelopeSupported, false);
});

test("future decisions cannot enter evaluation or change its settlement snapshot", () => {
  const freeze = freezeFromPending();
  const baseRows = rows(stable, true);
  const initial = buildMlbP1M3e4FrozenManifestEvaluation(baseRows, freeze, evalOptions);
  const future = rows(stable, true, 42).slice(baseRows.length).map((value) => ({
    ...value,
    result: value.result === "WIN" ? "LOSS" : "WIN",
    brierScore: value.brierScore == null ? null : 0.99,
    logLoss: value.logLoss == null ? null : 9.9,
    flatProfitUnits: -100,
    clvPp: -30,
  }));
  const appended = buildMlbP1M3e4FrozenManifestEvaluation([...baseRows, ...future], freeze, evalOptions);
  assert.equal(appended.state, initial.state);
  assert.deepEqual(appended.evaluation?.selectedRule, initial.evaluation?.selectedRule);
  assert.equal(appended.settlementSnapshotDigest, initial.settlementSnapshotDigest);
  assert.ok(appended.cohort.futureRowsExcluded > 0);
});

test("pregame identity drift inside the frozen window invalidates the manifest", () => {
  const freeze = freezeFromPending();
  const settled = rows(stable, true);
  settled[0] = { ...settled[0], lifecycleKey: "mutated-life" };
  assert.throws(
    () => buildMlbP1M3e4FrozenManifestEvaluation(settled, freeze, evalOptions),
    /P1_M3E4_FROZEN_MANIFEST_MISMATCH/,
  );
});

test("a frozen date with no binary scoreable outcomes cannot silently move temporal partitions", () => {
  const freeze = freezeFromPending();
  const settled = rows(stable, true).map((value) => value.gameDate === isoDate(10)
    ? { ...value, result: "PUSH", brierScore: null, logLoss: null, settledAt: `${value.gameDate}T23:30:00.000Z` }
    : value);
  const report = buildMlbP1M3e4FrozenManifestEvaluation(settled, freeze, evalOptions);
  assert.equal(report.state, "FROZEN_NOT_EVALUABLE");
  assert.equal(report.evaluation, null);
  assert.ok(report.blockers.includes("P1_M3E4_SCOREABLE_DATE_COVERAGE_INCOMPLETE"));
});

test("a not-yet-frozen M3E.3 report cannot trigger evaluation", () => {
  const pending = rows(stable, false, 20);
  const freeze = buildMlbP1M3e3OperatingEnvelopeFreeze(pending, freezeOptions);
  const report = buildMlbP1M3e4FrozenManifestEvaluation(pending, freeze, evalOptions);
  assert.equal(report.state, "WAITING_FOR_FREEZE");
  assert.equal(report.evaluation, null);
  assert.equal(report.interpretation.stableModelQualityEnvelopeSupported, false);
});

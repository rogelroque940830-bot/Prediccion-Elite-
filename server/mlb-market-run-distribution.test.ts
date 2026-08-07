import test from "node:test";
import assert from "node:assert/strict";
import {
  MLB_P1_M6A3A_TAIL_MASS_TARGET,
  buildMlbHorizonRunDistribution,
  evaluateMlbExactMarketProbability,
  negativeBinomialRunPmf,
} from "./mlb-market-run-distribution";

const HOME = {
  meanRuns: 2.1,
  dispersionK: 3.5,
  sourceVersion: "fixture.v1",
  sourceDigest: "home-fixture",
};
const AWAY = {
  meanRuns: 1.4,
  dispersionK: 2.8,
  sourceVersion: "fixture.v1",
  sourceDigest: "away-fixture",
};

function probabilitySum(values: Array<{ probability: number }>): number {
  return values.reduce((sum, point) => sum + point.probability, 0);
}

test("negative-binomial baseline expands finite support until strict omitted-tail target is met", () => {
  const result = negativeBinomialRunPmf({ ...HOME, meanRuns: 4.5, dispersionK: 2.0 }, 20);
  const represented = probabilitySum(result.pmf);
  assert.ok(result.supportExpanded);
  assert.ok(result.maxRunsUsed > 20);
  assert.ok(result.maxRunsUsed <= 60);
  assert.ok(result.tailMass >= 0 && result.tailMass <= MLB_P1_M6A3A_TAIL_MASS_TARGET);
  assert.ok(represented >= 1 - MLB_P1_M6A3A_TAIL_MASS_TARGET - 1e-9 && represented <= 1 + 1e-9);
  assert.ok(Math.abs(represented + result.tailMass - 1) < 1e-8);
  assert.ok(result.pmf[0].probability > 0);
  assert.ok(result.pmf.some((point) => point.runs >= 10 && point.probability > 0));
});

test("distribution fails closed when the hard support ceiling cannot meet the tail target", () => {
  assert.throws(
    () => buildMlbHorizonRunDistribution({
      horizon: "FULL_GAME",
      home: { ...HOME, meanRuns: 20, dispersionK: 0.5 },
      away: AWAY,
    }),
    /P1_M6A3A_TAIL_MASS_TARGET_NOT_MET/,
  );
});

test("invalid means, dispersion, zero inflation and provenance fail closed", () => {
  assert.throws(
    () => negativeBinomialRunPmf({ ...HOME, meanRuns: -0.1 }),
    /P1_M6A3A_INVALID_MEAN_RUNS/,
  );
  assert.throws(
    () => negativeBinomialRunPmf({ ...HOME, dispersionK: 0 }),
    /P1_M6A3A_INVALID_DISPERSION/,
  );
  assert.throws(
    () => negativeBinomialRunPmf({ ...HOME, zeroInflation: 1 }),
    /P1_M6A3A_INVALID_ZERO_INFLATION/,
  );
  assert.throws(
    () => negativeBinomialRunPmf({ ...HOME, sourceDigest: "" }),
    /P1_M6A3A_INPUT_PROVENANCE_REQUIRED/,
  );
});

test("F3/F5 distributions preserve tie mass because canonical moneylines push on ties", () => {
  const f3 = buildMlbHorizonRunDistribution({ horizon: "FIRST_3", home: HOME, away: AWAY });
  const f5 = buildMlbHorizonRunDistribution({ horizon: "FIRST_5", home: HOME, away: AWAY });
  assert.equal(f3.period, "FIRST_3");
  assert.equal(f5.period, "FIRST_5");
  assert.ok(f3.moneyline.draw > 0);
  assert.ok(f5.moneyline.draw > 0);
  assert.equal(f3.diagnostics.fullGameTieMassRemoved, 0);
  assert.equal(f3.diagnostics.conditionedOnNonTie, false);
  assert.equal(f3.diagnostics.tailMassTarget, MLB_P1_M6A3A_TAIL_MASS_TARGET);
  assert.ok(f3.diagnostics.homeTailMass <= MLB_P1_M6A3A_TAIL_MASS_TARGET);
  assert.ok(f3.diagnostics.awayTailMass <= MLB_P1_M6A3A_TAIL_MASS_TARGET);
  assert.ok(Math.abs(probabilitySum(f3.jointRuns) - 1) < 1e-8);
});

test("full-game baseline conditions impossible final ties out explicitly instead of hiding them", () => {
  const full = buildMlbHorizonRunDistribution({ horizon: "FULL_GAME", home: HOME, away: AWAY });
  assert.equal(full.period, "FULL_GAME");
  assert.equal(full.diagnostics.conditionedOnNonTie, true);
  assert.ok(full.diagnostics.fullGameTieMassRemoved > 0);
  assert.equal(full.moneyline.draw, 0);
  assert.ok(Math.abs(full.moneyline.homeWin + full.moneyline.awayWin - 1) < 1e-8);
  assert.equal(full.actionabilityAllowed, false);
  assert.equal(full.modelStatus, "EXPERIMENTAL_SHADOW");
});

test("exact F3 moneyline and run-line probabilities retain explicit pushes", () => {
  const f3 = buildMlbHorizonRunDistribution({ horizon: "FIRST_3", home: HOME, away: AWAY });
  const ml = evaluateMlbExactMarketProbability(f3, { marketType: "F3_ML", side: "HOME" });
  assert.equal(ml.status, "OK");
  assert.ok((ml.probabilities?.PUSH ?? 0) > 0);
  assert.ok((ml.probabilities?.WIN ?? 0) > (ml.probabilities?.LOSS ?? 1));
  assert.equal(ml.actionabilityAllowed, false);

  const rl = evaluateMlbExactMarketProbability(f3, {
    marketType: "F3_RUN_LINE",
    side: "HOME",
    line: -1,
  });
  assert.equal(rl.status, "OK");
  assert.ok((rl.probabilities?.PUSH ?? 0) > 0);
  assert.ok(Math.abs(
    (rl.probabilities?.WIN ?? 0)
    + (rl.probabilities?.PUSH ?? 0)
    + (rl.probabilities?.LOSS ?? 0)
    - 1,
  ) < 1e-8);
});

test("exact totals use discrete push mass rather than a fixed normal sigma approximation", () => {
  const f5 = buildMlbHorizonRunDistribution({ horizon: "FIRST_5", home: HOME, away: AWAY });
  const integer = evaluateMlbExactMarketProbability(f5, {
    marketType: "F5_TOTAL",
    side: "OVER",
    line: 4,
  });
  const half = evaluateMlbExactMarketProbability(f5, {
    marketType: "F5_TOTAL",
    side: "OVER",
    line: 4.5,
  });
  assert.equal(integer.status, "OK");
  assert.ok((integer.probabilities?.PUSH ?? 0) > 0);
  assert.equal(half.probabilities?.PUSH, 0);
});

test("NRFI/YRFI are derived only from the first-inning zero-run event", () => {
  const first = buildMlbHorizonRunDistribution({
    horizon: "FIRST_INNING",
    home: { ...HOME, meanRuns: 0.55, zeroInflation: 0.05 },
    away: { ...AWAY, meanRuns: 0.42, zeroInflation: 0.03 },
  });
  const nrfi = evaluateMlbExactMarketProbability(first, { marketType: "NRFI", side: "NRFI" });
  const yrfi = evaluateMlbExactMarketProbability(first, { marketType: "YRFI", side: "YRFI" });
  assert.equal(nrfi.status, "OK");
  assert.equal(yrfi.status, "OK");
  assert.equal(nrfi.probabilities?.PUSH, 0);
  assert.equal(yrfi.probabilities?.PUSH, 0);
  assert.ok(Math.abs((nrfi.probabilities?.WIN ?? 0) - (first.firstInningRuns.nrfi ?? -1)) < 1e-8);
  assert.ok(Math.abs((yrfi.probabilities?.WIN ?? 0) - (first.firstInningRuns.yrfi ?? -1)) < 1e-8);
  assert.ok(Math.abs((nrfi.probabilities?.WIN ?? 0) + (yrfi.probabilities?.WIN ?? 0) - 1) < 1e-8);
});

test("market-period mismatch and malformed requests fail closed", () => {
  const f3 = buildMlbHorizonRunDistribution({ horizon: "FIRST_3", home: HOME, away: AWAY });
  const wrongPeriod = evaluateMlbExactMarketProbability(f3, { marketType: "F5_ML", side: "HOME" });
  assert.equal(wrongPeriod.status, "HORIZON_MISMATCH");
  assert.equal(wrongPeriod.probabilities, null);

  const missingLine = evaluateMlbExactMarketProbability(f3, {
    marketType: "F3_TOTAL",
    side: "OVER",
  });
  assert.equal(missingLine.status, "INVALID_REQUEST");
  assert.equal(missingLine.probabilities, null);
});

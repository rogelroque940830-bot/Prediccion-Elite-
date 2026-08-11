import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMlbEliteEvidenceLedger,
  settleMlbEliteEvidenceLedger,
  toMlbOperatingEnvelopeCalibrationObservations,
} from "./mlb-elite-evidence-ledger";

function fixture() {
  const sourceRunId = "run-11c-test";
  const execution = (side: "OVER" | "UNDER", odds: number) => ({
    bookKey: "hardrockbet",
    bookTitle: "Hard Rock Bet",
    selectedSide: side,
    selectedSelection: side === "OVER" ? "Over" : "Under",
    line: 8.5,
    selectedOddsAmerican: odds,
    oppositeOddsAmerican: -110,
    selectedImpliedProbability: 0.5238,
    oppositeImpliedProbability: 0.5238,
    noVigDecisiveProbability: 0.5,
    capturedAt: "2026-08-11T17:00:00.000Z",
    providerLastUpdate: "2026-08-11T16:59:30.000Z",
  });
  const edgeMarket = (side: "OVER" | "UNDER", odds: number) => ({
    marketType: "TOTAL",
    providerMarketKey: "totals",
    intrinsicProjectionScope: "FULL_GAME",
    intrinsicThesisKinds: [side === "OVER" ? "TOTAL_OVER" : "TOTAL_UNDER"],
    supportingComponents: ["TEAM_OFFENSE", "STARTING_PITCHER"],
    selectedSide: side,
    selectedLine: 8.5,
    classification: "POSITIVE_EV",
    eligibleForOperatingEnvelope: true,
    model: {
      status: "READY",
      sourcePolicy: "TOTAL_RUN_DIFFERENTIAL_V1",
      modelVersion: "predictor-full-snapshot-v2",
      generatedAt: "2026-08-11T16:58:00.000Z",
      modelInputDigest: `digest-${side}`,
      winProbability: 0.58,
      pushProbability: 0,
      lossProbability: 0.42,
      decisiveWinProbability: 0.58,
      pushProbabilityDerivedAsZero: true,
    },
    execution: execution(side, odds),
    reference: null,
    economics: {
      fairPrice: { decimal: 1.7241, american: -138.1, modelWinProbability: 0.58, modelPushProbability: 0 },
      currentBreakEvenWinProbability: 0.5238,
      executionEdgePp: 5.62,
      executionNoVigEdgePp: 8.0,
      referenceNoVigEdgePp: null,
      expectedValuePerUnit: 0.1073,
      referenceAgreement: "UNAVAILABLE",
    },
    blockers: [],
    warnings: [],
  });
  const envelopeMarket = (side: "OVER" | "UNDER") => ({
    marketType: "TOTAL",
    providerMarketKey: "totals",
    selectedSide: side,
    selectedLine: 8.5,
    classification: "ELITE_EVIDENCE_CANDIDATE",
    eliteEvidenceCandidate: true,
    intrinsicProjectionScope: "FULL_GAME",
    intrinsicThesisKinds: [side === "OVER" ? "TOTAL_OVER" : "TOTAL_UNDER"],
    supportingComponents: ["TEAM_OFFENSE", "STARTING_PITCHER"],
    modelWinProbability: 0.58,
    modelPushProbability: 0,
    expectedValuePerUnit: 0.1073,
    executionEdgePp: 5.62,
    executionNoVigEdgePp: 8.0,
    referenceNoVigEdgePp: null,
    referenceAgreement: "UNAVAILABLE",
    blockers: [],
    warnings: [],
  });
  return {
    operatingEnvelope: {
      schemaVersion: "courtedge-p0-mlb-operating-envelope.v1",
      generatedAt: "2026-08-11T17:00:05.000Z",
      sourceMarketEdgeSchemaVersion: "courtedge-p0-mlb-market-edge.v1",
      sourceRunId,
      games: [{
        gamePk: 999001,
        intrinsicRank: 1,
        homeTeam: { id: 1, name: "Home" },
        awayTeam: { id: 2, name: "Away" },
        markets: [envelopeMarket("OVER"), envelopeMarket("UNDER")],
        summary: { eliteEvidenceCandidates: 2, positiveEvEnvelopeBlocked: 0, noPositiveEv: 0, upstreamBlocked: 0 },
      }],
      summary: { games: 1, markets: 2, eliteEvidenceCandidates: 2, positiveEvEnvelopeBlocked: 0, noPositiveEv: 0, upstreamBlocked: 0 },
      policy: {},
      safety: {},
    } as any,
    marketEdge: {
      schemaVersion: "courtedge-p0-mlb-market-edge.v1",
      generatedAt: "2026-08-11T17:00:00.000Z",
      sourceSelectiveOddsSchemaVersion: "courtedge-p0-mlb-selective-odds-acquisition.v1",
      sourceRunId,
      games: [{
        gamePk: 999001,
        intrinsicRank: 1,
        homeTeam: { id: 1, name: "Home" },
        awayTeam: { id: 2, name: "Away" },
        acquisitionStatus: "ACQUIRED",
        markets: [edgeMarket("OVER", -110), edgeMarket("UNDER", 120)],
        summary: { thesisMarkets: 2, positiveEvMarkets: 2, noPositiveEvMarkets: 0, blockedOrUnavailableMarkets: 0, operatingEnvelopeEligibleMarkets: 2 },
      }],
      summary: { games: 1, thesisMarkets: 2, positiveEvMarkets: 2, noPositiveEvMarkets: 0, blockedOrUnavailableMarkets: 0, operatingEnvelopeEligibleMarkets: 2 },
      policy: {},
      safety: {},
    } as any,
  };
}

function capture(source = fixture()) {
  return captureMlbEliteEvidenceLedger({
    ...source,
    capturedAt: "2026-08-11T17:00:10.000Z",
    gameDateByGamePk: { 999001: "2026-08-11" },
  });
}

test("captures every Step 11A elite candidate with 100% retention and no extra filter", () => {
  const ledger = capture();
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.summary.step11aEliteCandidates, 2);
  assert.equal(ledger.summary.capturedCandidates, 2);
  assert.equal(ledger.summary.captureRetentionPct, 100);
  assert.equal(ledger.policy.capturesEveryStep11aEliteCandidate, true);
  assert.equal(ledger.policy.additionalEligibilityFilterApplied, false);
  assert.equal(ledger.policy.silentCandidateDropAllowed, false);
  assert.equal(ledger.policy.step11aSummaryCountMustMatchRows, true);
  assert.equal(ledger.policy.exactStep9EvidenceParityRequired, true);
});

test("pregame snapshot preserves exact run game market side line price model and EV identity", () => {
  const ledger = capture();
  const over = ledger.entries.find((entry) => entry.candidate.selectedSide === "OVER")!;
  assert.equal(over.candidate.sourceRunId, "run-11c-test");
  assert.equal(over.candidate.gamePk, 999001);
  assert.equal(over.candidate.marketType, "TOTAL");
  assert.equal(over.candidate.providerMarketKey, "totals");
  assert.equal(over.candidate.selectedLine, 8.5);
  assert.equal(over.candidate.executionBookKey, "hardrockbet");
  assert.equal(over.candidate.executionOddsAmerican, -110);
  assert.equal(over.candidate.modelVersion, "predictor-full-snapshot-v2");
  assert.equal(over.candidate.modelInputDigest, "digest-OVER");
  assert.equal(over.candidate.expectedValuePerUnit, 0.1073);
});

test("malformed or missing exact upstream evidence fails the whole capture instead of silently dropping a pick", () => {
  const source = fixture();
  source.marketEdge.games[0].markets.splice(1, 1);
  assert.throws(() => capture(source), /MLB_ELITE_LEDGER_EXACT_UPSTREAM_MARKET_NOT_FOUND/);
});

test("truncated Step 11A rows cannot hide behind stale per-game or top-level candidate counts", () => {
  const perGame = fixture();
  perGame.operatingEnvelope.games[0].markets.splice(1, 1);
  assert.throws(() => capture(perGame), /MLB_ELITE_LEDGER_STEP11A_GAME_SUMMARY_MISMATCH/);

  const topLevel = fixture();
  topLevel.operatingEnvelope.summary.eliteEvidenceCandidates = 1;
  assert.throws(() => capture(topLevel), /MLB_ELITE_LEDGER_STEP11A_TOP_LEVEL_SUMMARY_MISMATCH/);
});

test("inconsistent Step 11A candidate flags fail closed instead of being undercounted", () => {
  const source = fixture();
  source.operatingEnvelope.games[0].markets[0].eliteEvidenceCandidate = false;
  assert.throws(() => capture(source), /MLB_ELITE_LEDGER_INCONSISTENT_STEP11A_CANDIDATE/);
});

test("Step 11A and Step 9 evidence must match exactly before capture", () => {
  const probability = fixture();
  probability.marketEdge.games[0].markets[0].model.winProbability = 0.5800001;
  assert.throws(() => capture(probability), /MLB_ELITE_LEDGER_STEP9_EVIDENCE_PARITY_MISMATCH/);

  const economics = fixture();
  economics.marketEdge.games[0].markets[0].economics.expectedValuePerUnit = 0.1074;
  assert.throws(() => capture(economics), /MLB_ELITE_LEDGER_STEP9_EVIDENCE_PARITY_MISMATCH/);

  const execution = fixture();
  execution.marketEdge.games[0].markets[0].execution.line = 9.5;
  assert.throws(() => capture(execution), /MLB_ELITE_LEDGER_EXACT_UPSTREAM_MARKET_NOT_FOUND|MLB_ELITE_LEDGER_STEP9_EVIDENCE_PARITY_MISMATCH/);
});

test("impossible game dates fail closed instead of entering the prospective ledger", () => {
  const source = fixture();
  assert.throws(() => captureMlbEliteEvidenceLedger({
    ...source,
    capturedAt: "2026-08-11T17:00:10.000Z",
    gameDateByGamePk: { 999001: "2026-02-30" },
  }), /MLB_ELITE_LEDGER_GAME_DATE_MISSING_OR_INVALID/);
});

test("captured pregame evidence is deeply frozen against post-capture mutation", () => {
  const ledger = capture();
  const first = ledger.entries[0];
  const originalOdds = first.candidate.executionOddsAmerican;
  const originalThesis = [...first.candidate.intrinsicThesisKinds];
  assert.equal(Object.isFrozen(ledger), true);
  assert.equal(Object.isFrozen(ledger.entries), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.candidate), true);
  assert.equal(Object.isFrozen(first.candidate.intrinsicThesisKinds), true);
  assert.equal(Object.isFrozen(first.candidate.supportingComponents), true);
  assert.throws(() => { (first.candidate as any).executionOddsAmerican = 999; }, TypeError);
  assert.throws(() => { (first as any).candidate = { ...first.candidate, executionOddsAmerican: 999 }; }, TypeError);
  assert.throws(() => { (first.candidate.intrinsicThesisKinds as any).push("FORGED"); }, TypeError);
  assert.equal(first.candidate.executionOddsAmerican, originalOdds);
  assert.deepEqual(first.candidate.intrinsicThesisKinds, originalThesis);

  const settled = settleMlbEliteEvidenceLedger({
    ledger,
    settlements: [{ predictionId: first.predictionId, outcome: "WIN", settledAt: "2026-08-12T03:00:00.000Z", officialEvidenceId: "official-frozen" }],
  });
  assert.equal(Object.isFrozen(settled.entries[0].candidate), true);
  assert.equal(Object.isFrozen(settled.entries[0].settlement), true);
  assert.equal(settled.entries[0].candidate.executionOddsAmerican, originalOdds);
});

test("inconsistent settlement status and payload fail closed before Step 11B conversion", () => {
  const ledger = capture();
  const first = ledger.entries[0];
  const settledWithoutPayload = {
    ...ledger,
    entries: [{ ...first, settlementStatus: "SETTLED" as const, settlement: null }, ...ledger.entries.slice(1)],
  } as any;
  assert.throws(
    () => toMlbOperatingEnvelopeCalibrationObservations(settledWithoutPayload),
    /MLB_ELITE_LEDGER_SETTLEMENT_STATE_INVALID/,
  );

  const pendingWithPayload = {
    ...ledger,
    entries: [{
      ...first,
      settlementStatus: "PENDING" as const,
      settlement: {
        status: "SETTLED" as const,
        outcome: "WIN" as const,
        settledAt: "2026-08-12T03:00:00.000Z",
        realizedProfitUnits: 0.9,
        officialEvidenceId: "forged-pending",
      },
    }, ...ledger.entries.slice(1)],
  } as any;
  assert.throws(
    () => toMlbOperatingEnvelopeCalibrationObservations(pendingWithPayload),
    /MLB_ELITE_LEDGER_SETTLEMENT_STATE_INVALID/,
  );
});

test("settlement leaves immutable pregame evidence untouched and uses flat one-unit economics", () => {
  const ledger = capture();
  const before = JSON.stringify(ledger.entries.map((entry) => entry.candidate));
  const [over, under] = ledger.entries;
  const settled = settleMlbEliteEvidenceLedger({
    ledger,
    settlements: [
      { predictionId: over.predictionId, outcome: "WIN", settledAt: "2026-08-12T03:00:00.000Z", officialEvidenceId: "official-1" },
      { predictionId: under.predictionId, outcome: "PUSH", settledAt: "2026-08-12T03:00:00.000Z", officialEvidenceId: "official-2" },
    ],
  });
  assert.equal(JSON.stringify(settled.entries.map((entry) => entry.candidate)), before);
  assert.ok(Math.abs(settled.entries[0].settlement!.realizedProfitUnits - (100 / 110)) < 1e-12);
  assert.equal(settled.entries[1].settlement!.realizedProfitUnits, 0);
  assert.equal(settled.summary.settled, 2);
  assert.equal(settled.policy.flatOneUnitSettlementOnly, true);
  assert.equal(settled.policy.stakeCalculated, false);
});

test("positive American odds settle to the correct one-unit win profit", () => {
  const ledger = capture();
  const under = ledger.entries.find((entry) => entry.candidate.selectedSide === "UNDER")!;
  const settled = settleMlbEliteEvidenceLedger({
    ledger,
    settlements: [{ predictionId: under.predictionId, outcome: "WIN", settledAt: "2026-08-12T03:00:00.000Z", officialEvidenceId: "official-plus" }],
  });
  const profit = settled.entries.find((entry) => entry.predictionId === under.predictionId)!.settlement!.realizedProfitUnits;
  assert.ok(Math.abs(profit - 1.2) < 1e-12);
});

test("loss settles at minus one unit and conflicting resettlement fails closed", () => {
  const ledger = capture();
  const first = ledger.entries[0];
  const settled = settleMlbEliteEvidenceLedger({
    ledger,
    settlements: [{ predictionId: first.predictionId, outcome: "LOSS", settledAt: "2026-08-12T03:00:00.000Z", officialEvidenceId: "official-loss" }],
  });
  assert.equal(settled.entries[0].settlement!.realizedProfitUnits, -1);
  assert.throws(() => settleMlbEliteEvidenceLedger({
    ledger: settled,
    settlements: [{ predictionId: first.predictionId, outcome: "WIN", settledAt: "2026-08-12T03:00:00.000Z", officialEvidenceId: "official-loss" }],
  }), /MLB_ELITE_LEDGER_CONFLICTING_SETTLEMENT/);
});

test("unknown runtime settlement outcomes fail closed instead of being treated as wins", () => {
  const ledger = capture();
  const first = ledger.entries[0];
  assert.throws(() => settleMlbEliteEvidenceLedger({
    ledger,
    settlements: [{ predictionId: first.predictionId, outcome: "VOID", settledAt: "2026-08-12T03:00:00.000Z", officialEvidenceId: "official-void" } as any],
  }), /MLB_ELITE_LEDGER_SETTLEMENT_INPUT_INVALID/);
  assert.equal(ledger.policy.settlementOutcomeWhitelistRequired, true);
});

test("settled ledger converts directly into Step 11B observations without a new selection filter", () => {
  const ledger = capture();
  const settled = settleMlbEliteEvidenceLedger({
    ledger,
    settlements: ledger.entries.map((entry, index) => ({
      predictionId: entry.predictionId,
      outcome: index === 0 ? "WIN" as const : "LOSS" as const,
      settledAt: "2026-08-12T03:00:00.000Z",
      officialEvidenceId: `official-${index}`,
    })),
  });
  const observations = toMlbOperatingEnvelopeCalibrationObservations(settled);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map((row) => row.predictionId).sort(), settled.entries.map((entry) => entry.predictionId).sort());
  assert.equal(observations[0].gameDate, "2026-08-11");
});

test("closing line is deliberately absent from capture requirements and cannot block settlement/calibration", () => {
  const ledger = capture();
  assert.equal(ledger.policy.missingClosingLineBlocksCapture, false);
  assert.equal(ledger.policy.missingClosingLineBlocksSettlement, false);
  assert.equal(ledger.policy.closingLineRequiredForCalibration, false);
});

test("Step 11C produces no BET_ELITE, ranking, stake or automatic wager behavior", () => {
  const ledger = capture();
  assert.equal(ledger.policy.betEliteLabelProduced, false);
  assert.equal(ledger.policy.finalBetRecommendationProduced, false);
  assert.equal(ledger.policy.stakeCalculated, false);
  assert.equal(ledger.policy.automaticBetPlacement, false);
  assert.equal(ledger.policy.realFinancialExposure, 0);
});

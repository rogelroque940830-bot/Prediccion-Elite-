import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M3A_SCHEMA,
  buildMlbP1M3aCaptureIdentity,
  mlbP1M3aSha256,
  toMlbP1M3aLedgerCompatibleInput,
  validateMlbP1M3aCapture,
  type MlbP1M3aCaptureCandidate,
  type MlbP1M3aCategory,
  type MlbP1M3aMarket,
  type MlbP1M3aSide,
  type MlbP1M3aSignal,
  type MlbP1M3aStage,
} from "./mlb-p1-scientific-capture-contract";
import {
  MLB_P1_M4B_LAYER_KEY,
  MLB_P1_M4B_SCHEMA,
  adaptMlbP1M4bEconomicDecision,
  attachMlbP1M4bEconomicDecision,
  mlbP1M4bSourceSignalPolicy,
} from "./mlb-p1-economic-decision-adapter";

const NOW = new Date("2026-08-05T18:00:30.000Z");

function implied(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function categoryFor(signal: MlbP1M3aSignal): MlbP1M3aCategory {
  if (signal === "BET_FUERTE") return "ELITE";
  if (signal === "BET") return "PREMIUM";
  if (signal === "LEAN") return "LEAN";
  if (signal === "PASS") return "PASS";
  return "INFO";
}

function defaultSide(market: MlbP1M3aMarket): MlbP1M3aSide {
  return market === "TOTAL" || market === "F5_TOTAL" ? "OVER" : "HOME";
}

function defaultLine(market: MlbP1M3aMarket): number | null {
  if (market === "RUN_LINE") return -1.5;
  if (market === "TOTAL") return 8.5;
  if (market === "F5_TOTAL") return 4.5;
  return null;
}

function selectionFor(market: MlbP1M3aMarket, side: MlbP1M3aSide, line: number | null): string {
  if (market === "TOTAL" || market === "F5_TOTAL") return `${side} ${line}`;
  if (market === "RUN_LINE") return `Chicago Cubs ${line}`;
  return market === "F5_ML" ? "Chicago Cubs F5 ML" : "Chicago Cubs ML";
}

interface FixtureOptions {
  market?: MlbP1M3aMarket;
  side?: MlbP1M3aSide;
  line?: number | null;
  odds?: number;
  oppositeOdds?: number | null;
  modelProbability?: number;
  signal?: MlbP1M3aSignal;
  category?: MlbP1M3aCategory;
  stakeUnits?: number;
  stage?: MlbP1M3aStage;
  warnings?: string[];
}

function candidate(options: FixtureOptions = {}): MlbP1M3aCaptureCandidate {
  const market = options.market ?? "F5_ML";
  const side = options.side ?? defaultSide(market);
  const line = options.line !== undefined ? options.line : defaultLine(market);
  const odds = options.odds ?? -110;
  const oppositeOdds = options.oppositeOdds !== undefined ? options.oppositeOdds : -110;
  const modelProbability = options.modelProbability ?? 0.72;
  const signal = options.signal ?? "BET";
  const category = options.category ?? categoryFor(signal);
  const stage = options.stage ?? "FINAL";
  const stakeUnits = options.stakeUnits ?? (signal === "BET" || signal === "BET_FUERTE" ? 1 : 0);
  const warnings = options.warnings ?? [];
  const selectedImplied = implied(odds);
  const oppositeImplied = oppositeOdds == null ? null : implied(oppositeOdds);
  const noVig = oppositeImplied == null ? null : selectedImplied / (selectedImplied + oppositeImplied);
  const selection = selectionFor(market, side, line);
  const marketQuote: MlbP1M3aCaptureCandidate["quote"] = {
    market,
    side,
    selection,
    line,
    oddsAmerican: odds,
    oppositeOddsAmerican: oppositeOdds,
    book: "CourtEdge certified consensus",
    sourceMode: "CONSENSUS",
    capturedAt: "2026-08-05T17:59:30.000Z",
    providerLastUpdate: "2026-08-05T17:59:00.000Z",
    consensusMethod: "median_implied_probability",
    provenanceDigest: mlbP1M3aSha256({ market, side, line, odds, oppositeOdds }),
  };
  const payload = {
    schemaVersion: "mlb-scientific-snapshot.v1",
    model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2" },
    analysis: {
      stage,
      warnings,
      factors: [{ name: "MODEL_OUTPUT", direction: side, magnitude: modelProbability, confidence: "FULL" }],
      sources: [{ name: "MLB Stats API", status: "VERIFIED", fetchedAt: "2026-08-05T17:59:20.000Z" }],
      layers: { pickQuality: category },
      rawInputs: { gamePk: 824466, market, side, line, odds, oppositeOdds },
      rawOutput: { selectedMarket: market, modelProbability, signal },
    },
  };
  return {
    schemaVersion: MLB_P1_M3A_SCHEMA,
    capturedAt: "2026-08-05T18:00:00.000Z",
    origin: {
      channel: "INTERACTIVE_MLB_PREDICTOR",
      userAction: "GENERATE_PREDICTION",
      clientEvaluationId: `ui-evaluation-824466-${market.toLowerCase()}-${side.toLowerCase()}`,
      frontendRelease: "p1-m3c1-json-digest-transport-2026-08-05",
    },
    game: {
      gamePk: 824466,
      gameDate: "2026-08-05",
      commenceTime: "2026-08-05T19:05:00.000Z",
      homeTeam: "Chicago Cubs",
      awayTeam: "Los Angeles Dodgers",
      venue: "Wrigley Field",
    },
    readiness: {
      runtimeSchemaVersion: "courtedge-p1-m2b-pregame-readiness.v1",
      contractSchemaVersion: "courtedge-p1-m2a-pregame-readiness-contract.v1",
      generatedAt: "2026-08-05T17:59:45.000Z",
      market,
      gateStatus: stage === "FINAL" ? "READY_FINAL" : "READY_PROVISIONAL",
      analysisStage: stage,
      blockers: [],
      warnings,
      evidenceSummary: {
        fresh: 7,
        stale: 0,
        degraded: 0,
        missing: 0,
        conflict: 0,
        unknown: 0,
        requiredFields: ["GAME_IDENTITY", "PITCHERS", "LINEUPS", "MARKET_ODDS"],
      },
      evidenceDigest: mlbP1M3aSha256({ gamePk: 824466, market, stage, states: ["FRESH", "FRESH"] }),
      certifiedQuote: { ...marketQuote },
    },
    quote: marketQuote,
    model: {
      name: "CourtEdge MLB",
      version: "predictor-full-snapshot-v2",
      gitCommit: "p1-m4b-test-commit",
      environment: "p0-integration",
    },
    probabilities: {
      model: modelProbability,
      marketImplied: selectedImplied,
      noVig,
      edgePp: (modelProbability - selectedImplied) * 100,
    },
    decision: {
      signal,
      category,
      confidenceLabel: category,
      confidencePct: modelProbability * 100,
      recommendedStakeUnits: stakeUnits,
      rationale: "Original model output preserved before economic adaptation.",
      filterReasons: [],
    },
    scientificSnapshot: {
      schemaVersion: "mlb-scientific-snapshot.v1",
      payload,
      payloadDigest: mlbP1M3aSha256(payload),
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("FINAL ML/F5 output adapts to an actionable economic BET without mutating source evidence", () => {
  const source = candidate();
  const original = clone(source);
  const result = adaptMlbP1M4bEconomicDecision(source, NOW);

  assert.equal(result.schemaVersion, MLB_P1_M4B_SCHEMA);
  assert.equal(result.status, "ADAPTED");
  assert.equal(result.economicDecision?.modelSignal, "BET");
  assert.equal(result.economicDecision?.decision, "BET");
  assert.equal(result.economicDecision?.actionability, "ACTIONABLE_FINAL");
  assert.equal(result.effectiveDecision?.decision, "BET");
  assert.equal(result.effectiveDecision?.actionability, "ACTIONABLE_FINAL");
  assert.equal(result.effectiveDecision?.analyticalUnits, 1);
  assert.equal(result.signalCompatibility?.relation, "MATCH");
  assert.equal(result.source.sourceSignal, "BET");
  assert.equal(result.source.sourceRecommendedStakeUnits, 1);
  assert.deepEqual(source, original);
  assert.equal(result.safety.realFinancialExposure, 0);
  assert.equal(result.safety.ledgerWritePerformed, false);
});

test("adapter attaches one digest-valid P1-M4B layer that survives the P1-M3 ledger mapping", () => {
  const source = candidate();
  const attached = attachMlbP1M4bEconomicDecision(source, NOW);
  assert.equal(attached.attached, true);
  assert.equal(attached.idempotent, false);
  assert.ok(attached.candidate);
  assert.equal((source.scientificSnapshot.payload.analysis as any).layers[MLB_P1_M4B_LAYER_KEY], undefined);

  const enriched = attached.candidate!;
  const layer = (enriched.scientificSnapshot.payload.analysis as any).layers[MLB_P1_M4B_LAYER_KEY];
  assert.equal(layer.schemaVersion, MLB_P1_M4B_SCHEMA);
  assert.equal(layer.source.sourceSignal, "BET");
  assert.equal(layer.effectiveDecision.actionability, "ACTIONABLE_FINAL");
  assert.equal(enriched.decision.signal, source.decision.signal);
  assert.equal(enriched.decision.recommendedStakeUnits, source.decision.recommendedStakeUnits);
  assert.equal(enriched.probabilities.model, source.probabilities.model);

  const validation = validateMlbP1M3aCapture(enriched, NOW);
  assert.equal(validation.captureAllowed, true);
  assert.ok(validation.identity);
  const ledger = toMlbP1M3aLedgerCompatibleInput(enriched, validation.identity!);
  assert.equal((ledger.analysis.layers as any)[MLB_P1_M4B_LAYER_KEY].schemaVersion, MLB_P1_M4B_SCHEMA);
  assert.equal(ledger.decision.signal, source.decision.signal);
  assert.equal(ledger.decision.stakeUnits, source.decision.recommendedStakeUnits);
});

test("PROVISIONAL preserves the source BET but effective action waits for FINAL with zero units", () => {
  const result = adaptMlbP1M4bEconomicDecision(candidate({
    stage: "PROVISIONAL",
    warnings: ["LINEUPS_MISSING"],
  }), NOW);

  assert.equal(result.status, "ADAPTED");
  assert.equal(result.source.sourceSignal, "BET");
  assert.equal(result.economicDecision?.modelSignal, "BET");
  assert.equal(result.economicDecision?.decision, "LEAN");
  assert.equal(result.economicDecision?.actionability, "WAIT_FOR_FINAL");
  assert.equal(result.effectiveDecision?.decision, "LEAN");
  assert.equal(result.effectiveDecision?.actionability, "WAIT_FOR_FINAL");
  assert.equal(result.effectiveDecision?.analyticalUnits, 0);
  assert.equal(result.economicDecision?.reasons.includes("PROVISIONAL_REQUIRES_FINAL_CONFIRMATION"), true);
});

test("Run Line keeps its source policy and permits an economic downgrade without changing formulas", () => {
  const result = adaptMlbP1M4bEconomicDecision(candidate({
    market: "RUN_LINE",
    modelProbability: 0.64,
    signal: "BET",
  }), NOW);

  assert.equal(result.status, "ADAPTED");
  assert.equal(result.source.sourcePolicy, "RUN_LINE_COVER_PROBABILITY_V1");
  assert.equal(result.signalCompatibility?.relation, "ECONOMIC_DOWNGRADE");
  assert.equal(result.signalCompatibility?.policyDifferenceExpected, true);
  assert.equal(result.economicDecision?.modelSignal, "LEAN");
  assert.equal(result.effectiveDecision?.decision, "LEAN");
  assert.equal(result.effectiveDecision?.analyticalUnits, 0);
  assert.equal(result.warnings.includes("SOURCE_SIGNAL_POLICY_DIFFERENCE_EXPECTED:RUN_LINE_COVER_PROBABILITY_V1"), true);
});

test("Total economic upgrades are capped by the original LEAN signal", () => {
  const result = adaptMlbP1M4bEconomicDecision(candidate({
    market: "TOTAL",
    modelProbability: 0.72,
    signal: "LEAN",
  }), NOW);

  assert.equal(result.signalCompatibility?.relation, "ECONOMIC_UPGRADE");
  assert.equal(result.economicDecision?.modelSignal, "BET");
  assert.equal(result.economicDecision?.actionability, "ACTIONABLE_FINAL");
  assert.equal(result.effectiveDecision?.decision, "LEAN");
  assert.equal(result.effectiveDecision?.actionability, "OBSERVE_ONLY");
  assert.equal(result.effectiveDecision?.analyticalUnits, 0);
  assert.equal(result.effectiveDecision?.sourceSignalCeilingApplied, true);
  assert.equal(result.effectiveDecision?.reasons.includes("SOURCE_SIGNAL_CEILING_APPLIED"), true);
});

test("PASS and INFO controls can never be upgraded into actionable economic bets", () => {
  const pass = adaptMlbP1M4bEconomicDecision(candidate({ signal: "PASS" }), NOW);
  assert.equal(pass.economicDecision?.modelSignal, "BET");
  assert.equal(pass.effectiveDecision?.decision, "PASS");
  assert.equal(pass.effectiveDecision?.actionability, "OBSERVE_ONLY");
  assert.equal(pass.effectiveDecision?.analyticalUnits, 0);

  const info = adaptMlbP1M4bEconomicDecision(candidate({ signal: "INFO" }), NOW);
  assert.equal(info.signalCompatibility?.relation, "NON_COMPARABLE_INFO");
  assert.equal(info.effectiveDecision?.decision, "PASS");
  assert.equal(info.effectiveDecision?.analyticalUnits, 0);
  assert.equal(info.effectiveDecision?.reasons.includes("SOURCE_INFO_CONTROL_ONLY"), true);
});

test("missing bilateral price remains a captured scientific observation but is economically blocked", () => {
  const result = adaptMlbP1M4bEconomicDecision(candidate({ oppositeOdds: null }), NOW);
  assert.equal(result.status, "ADAPTED");
  assert.equal(result.source.captureAllowed, true);
  assert.equal(result.economicDecision?.actionability, "BLOCKED");
  assert.equal(result.economicDecision?.reasons.includes("BILATERAL_PRICE_REQUIRED"), true);
  assert.equal(result.effectiveDecision?.actionability, "BLOCKED");
  assert.equal(result.effectiveDecision?.analyticalUnits, 0);

  const attached = attachMlbP1M4bEconomicDecision(candidate({ oppositeOdds: null }), NOW);
  assert.equal(attached.attached, true);
  assert.equal((attached.candidate!.scientificSnapshot.payload.analysis as any).layers[MLB_P1_M4B_LAYER_KEY].effectiveDecision.actionability, "BLOCKED");
});

test("invalid P1-M3 capture fails closed and cannot receive an economic layer", () => {
  const tampered = candidate();
  (tampered.scientificSnapshot.payload.analysis as any).rawOutput.modelProbability = 0.61;
  const adapted = adaptMlbP1M4bEconomicDecision(tampered, NOW);
  assert.equal(adapted.status, "REJECTED");
  assert.equal(adapted.economicDecision, null);
  assert.equal(adapted.effectiveDecision, null);
  assert.equal(adapted.errors.includes("P1_M3A:SCIENTIFIC_SNAPSHOT_DIGEST_MISMATCH"), true);

  const attached = attachMlbP1M4bEconomicDecision(tampered, NOW);
  assert.equal(attached.candidate, null);
  assert.equal(attached.attached, false);
});

test("certified quote mismatch rejects before economic interpretation", () => {
  const mismatch = candidate();
  mismatch.readiness.certifiedQuote.oddsAmerican = -105;
  const result = adaptMlbP1M4bEconomicDecision(mismatch, NOW);
  assert.equal(result.status, "REJECTED");
  assert.equal(result.errors.includes("P1_M3A:CERTIFIED_QUOTE_MISMATCH"), true);
  assert.equal(result.economicDecision, null);
});

test("attachment is idempotent and rejects a conflicting pre-existing P1-M4B layer", () => {
  const first = attachMlbP1M4bEconomicDecision(candidate(), NOW);
  assert.ok(first.candidate);

  const retry = attachMlbP1M4bEconomicDecision(first.candidate!, NOW);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.attached, false);
  assert.equal(retry.candidate?.scientificSnapshot.payloadDigest, first.candidate?.scientificSnapshot.payloadDigest);

  const conflict = clone(first.candidate!);
  const layer = (conflict.scientificSnapshot.payload.analysis as any).layers[MLB_P1_M4B_LAYER_KEY];
  layer.sourceDigest = "0".repeat(64);
  conflict.scientificSnapshot.payloadDigest = mlbP1M3aSha256(conflict.scientificSnapshot.payload);
  assert.equal(validateMlbP1M3aCapture(conflict, NOW).captureAllowed, true);

  const rejected = attachMlbP1M4bEconomicDecision(conflict, NOW);
  assert.equal(rejected.adapter.status, "REJECTED");
  assert.equal(rejected.adapter.errors.includes("P1_M4B_LAYER_CONFLICT"), true);
  assert.equal(rejected.candidate, null);
});

test("source policy versions cover all existing markets without enabling a new route or selection", () => {
  assert.equal(mlbP1M4bSourceSignalPolicy("ML"), "ML_F5_EDGE_CONFIDENCE_V2");
  assert.equal(mlbP1M4bSourceSignalPolicy("F5_ML"), "ML_F5_EDGE_CONFIDENCE_V2");
  assert.equal(mlbP1M4bSourceSignalPolicy("RUN_LINE"), "RUN_LINE_COVER_PROBABILITY_V1");
  assert.equal(mlbP1M4bSourceSignalPolicy("TOTAL"), "TOTAL_RUN_DIFFERENTIAL_V1");
  assert.equal(mlbP1M4bSourceSignalPolicy("F5_TOTAL"), "F5_TOTAL_RUN_DIFFERENTIAL_V1");
});

test("source digest is stable for the same scientific decision and changes with price or source signal", () => {
  const first = adaptMlbP1M4bEconomicDecision(candidate(), NOW);
  const retry = adaptMlbP1M4bEconomicDecision(candidate(), NOW);
  assert.equal(first.sourceDigest, retry.sourceDigest);
  assert.equal(first.economicInputDigest, retry.economicInputDigest);

  const repriced = candidate({ odds: -105 });
  const repricedResult = adaptMlbP1M4bEconomicDecision(repriced, NOW);
  assert.notEqual(repricedResult.sourceDigest, first.sourceDigest);

  const changedSignal = adaptMlbP1M4bEconomicDecision(candidate({ signal: "LEAN" }), NOW);
  assert.notEqual(changedSignal.sourceDigest, first.sourceDigest);

  const identity = buildMlbP1M3aCaptureIdentity(candidate());
  assert.equal(first.source.captureIdentity?.semanticFingerprint, identity.semanticFingerprint);
});

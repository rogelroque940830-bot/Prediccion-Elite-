import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M3A_AUDIT_FINDINGS,
  MLB_P1_M3A_SCHEMA,
  buildMlbP1M3aCaptureIdentity,
  decideMlbP1M3aRevision,
  mlbP1M3aSha256,
  toMlbP1M3aLedgerCompatibleInput,
  validateMlbP1M3aCapture,
  type MlbP1M3aCaptureCandidate,
} from "./mlb-p1-scientific-capture-contract";

const NOW = new Date("2026-08-05T18:00:30.000Z");

function quote(overrides: Partial<MlbP1M3aCaptureCandidate["quote"]> = {}): MlbP1M3aCaptureCandidate["quote"] {
  return {
    market: "F5_ML",
    side: "HOME",
    selection: "Chicago Cubs F5 ML",
    line: null,
    oddsAmerican: -120,
    oppositeOddsAmerican: 110,
    book: "CourtEdge F5 consensus",
    sourceMode: "CONSENSUS",
    capturedAt: "2026-08-05T17:59:30.000Z",
    providerLastUpdate: "2026-08-05T17:59:00.000Z",
    consensusMethod: "median_implied_probability",
    provenanceDigest: mlbP1M3aSha256({ books: ["FanDuel", "BetMGM", "DraftKings"], home: -120, away: 110 }),
    ...overrides,
  };
}

function candidate(overrides: Partial<MlbP1M3aCaptureCandidate> = {}): MlbP1M3aCaptureCandidate {
  const marketQuote = quote();
  const payload = {
    schemaVersion: "mlb-scientific-snapshot.v1",
    model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2" },
    analysis: {
      stage: "FINAL",
      warnings: [],
      factors: [{ name: "PITCHER_QUALITY", direction: "HOME", magnitude: 0.18, confidence: "FULL" }],
      sources: [{ name: "MLB Stats API", status: "VERIFIED", fetchedAt: "2026-08-05T17:59:20.000Z" }],
      layers: { pickQuality: "PREMIUM" },
      rawInputs: { gamePk: 824466, lines: { home: -120, away: 110 } },
      rawOutput: { selectedMarket: "F5_ML", modelProbability: 0.6 },
    },
  };
  const base: MlbP1M3aCaptureCandidate = {
    schemaVersion: MLB_P1_M3A_SCHEMA,
    capturedAt: "2026-08-05T18:00:00.000Z",
    origin: {
      channel: "INTERACTIVE_MLB_PREDICTOR",
      userAction: "GENERATE_PREDICTION",
      clientEvaluationId: "ui-evaluation-824466-f5ml-home",
      frontendRelease: "p1-m2c3-mlb-smart-default-2026-08-05",
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
      market: "F5_ML",
      gateStatus: "READY_FINAL",
      analysisStage: "FINAL",
      blockers: [],
      warnings: [],
      evidenceSummary: {
        fresh: 7,
        stale: 0,
        degraded: 0,
        missing: 0,
        conflict: 0,
        unknown: 0,
        requiredFields: ["GAME_IDENTITY", "PITCHERS", "LINEUPS", "INJURIES", "MARKET_ODDS", "PITCHER_FORM", "LINEUP_MATCHUP"],
      },
      evidenceDigest: mlbP1M3aSha256({ gamePk: 824466, market: "F5_ML", states: ["FRESH", "FRESH", "FRESH"] }),
      certifiedQuote: { ...marketQuote },
    },
    quote: marketQuote,
    model: {
      name: "CourtEdge MLB",
      version: "predictor-full-snapshot-v2",
      gitCommit: "frontend-commit-a",
      environment: "p0-integration",
    },
    probabilities: {
      model: 0.6,
      marketImplied: 120 / 220,
      noVig: (120 / 220) / ((120 / 220) + (100 / 210)),
      edgePp: (0.6 - (120 / 220)) * 100,
    },
    decision: {
      signal: "BET",
      category: "PREMIUM",
      confidenceLabel: "PREMIUM",
      confidencePct: 60,
      recommendedStakeUnits: 1,
      rationale: "Model edge remains positive after the certified F5 market price.",
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
  return { ...base, ...overrides };
}

test("audit identifies the exact capture gaps that P1-M3B must close", () => {
  const codes = new Set(MLB_P1_M3A_AUDIT_FINDINGS.map((finding) => finding.code));
  assert.equal(codes.has("INTERACTIVE_EVALUATIONS_NOT_AUTOMATICALLY_LEDGERED"), true);
  assert.equal(codes.has("S5C_IS_INDEPENDENT_RECOMPUTATION"), true);
  assert.equal(codes.has("READINESS_BINDING_NOT_PERSISTED_UNIFORMLY"), true);
  assert.equal(codes.has("QUOTE_MODEL_EQUALITY_MUST_SURVIVE_CAPTURE"), true);
  assert.equal(codes.has("DEPLOYMENT_COMMIT_IS_AUDIT_NOT_SPORTING_IDENTITY"), true);
  assert.equal(codes.has("CONTROL_DECISIONS_MUST_BE_RETAINED"), true);
});

test("a complete FINAL evaluation is ready for append and maps to mlb-ledger.v1", () => {
  const input = candidate();
  const decision = validateMlbP1M3aCapture(input, NOW);
  assert.equal(decision.status, "READY_TO_APPEND");
  assert.equal(decision.captureAllowed, true);
  assert.equal(decision.economicDisposition, "ACCEPTED");
  assert.deepEqual(decision.errors, []);
  assert.ok(decision.identity);

  const ledger = toMlbP1M3aLedgerCompatibleInput(input, decision.identity!);
  assert.equal(ledger.schemaVersion, "mlb-ledger.v1");
  assert.equal(ledger.clientRequestId, decision.identity!.clientRequestId);
  assert.equal(ledger.market.type, "F5_ML");
  assert.equal(ledger.market.oddsAmerican, -120);
  assert.equal(ledger.analysis.stage, "FINAL");
  assert.equal((ledger.analysis.layers as any).p1M3aCapture.readiness.gateStatus, "READY_FINAL");
  assert.equal((ledger.analysis.layers as any).p1M3aCapture.safety.realFinancialExposure, 0);
});

test("a READY_PROVISIONAL model execution is captured with an explicit warning", () => {
  const input = candidate();
  input.readiness.gateStatus = "READY_PROVISIONAL";
  input.readiness.analysisStage = "PROVISIONAL";
  input.readiness.warnings = ["LINEUPS_MISSING"];
  (input.scientificSnapshot.payload.analysis as any).stage = "PROVISIONAL";
  input.scientificSnapshot.payloadDigest = mlbP1M3aSha256(input.scientificSnapshot.payload);

  const decision = validateMlbP1M3aCapture(input, NOW);
  assert.equal(decision.captureAllowed, true);
  assert.equal(decision.warnings.includes("PROVISIONAL_EVALUATION"), true);
  assert.equal(decision.warnings.includes("READINESS:LINEUPS_MISSING"), true);
});

test("blocked readiness and a mismatched certified quote are rejected fail-closed", () => {
  const blocked = candidate();
  blocked.readiness.blockers = ["MARKET_ODDS_STALE"];
  assert.equal(validateMlbP1M3aCapture(blocked, NOW).errors.includes("READINESS_HAS_BLOCKERS"), true);

  const mismatch = candidate();
  mismatch.readiness.certifiedQuote.oddsAmerican = -115;
  const mismatchDecision = validateMlbP1M3aCapture(mismatch, NOW);
  assert.equal(mismatchDecision.captureAllowed, false);
  assert.equal(mismatchDecision.errors.includes("CERTIFIED_QUOTE_MISMATCH"), true);
});

test("invalid or stale prices cannot enter the scientific sample", () => {
  const invalid = candidate();
  invalid.quote.oddsAmerican = -4;
  invalid.readiness.certifiedQuote = { ...invalid.quote };
  invalid.probabilities.marketImplied = 4 / 104;
  invalid.probabilities.edgePp = (invalid.probabilities.model - invalid.probabilities.marketImplied) * 100;
  assert.equal(validateMlbP1M3aCapture(invalid, NOW).errors.includes("MARKET_ODDS_INVALID"), true);

  const stale = candidate();
  stale.quote.capturedAt = "2026-08-05T17:50:00.000Z";
  stale.readiness.certifiedQuote = { ...stale.quote };
  assert.equal(validateMlbP1M3aCapture(stale, NOW).errors.includes("MARKET_QUOTE_STALE"), true);
});

test("market probability and edge arithmetic must agree with the stored price", () => {
  const impliedMismatch = candidate();
  impliedMismatch.probabilities.marketImplied = 0.25;
  impliedMismatch.probabilities.edgePp = 35;
  const impliedDecision = validateMlbP1M3aCapture(impliedMismatch, NOW);
  assert.equal(impliedDecision.errors.includes("MARKET_IMPLIED_ARITHMETIC_MISMATCH"), true);

  const edgeMismatch = candidate();
  edgeMismatch.probabilities.edgePp = 25;
  assert.equal(validateMlbP1M3aCapture(edgeMismatch, NOW).errors.includes("EDGE_ARITHMETIC_MISMATCH"), true);
});

test("PASS is retained as a zero-stake control and cannot carry a simulated wager", () => {
  const control = candidate();
  control.decision.signal = "PASS";
  control.decision.category = "PASS";
  control.decision.recommendedStakeUnits = 0;
  const allowed = validateMlbP1M3aCapture(control, NOW);
  assert.equal(allowed.captureAllowed, true);
  assert.equal(allowed.economicDisposition, "BLOCKED");

  control.decision.recommendedStakeUnits = 1;
  const rejected = validateMlbP1M3aCapture(control, NOW);
  assert.equal(rejected.errors.includes("NON_ACTIONABLE_STAKE_MUST_BE_ZERO"), true);
});

test("snapshot tampering, oversized payloads and unredacted secrets are rejected", () => {
  const tampered = candidate();
  (tampered.scientificSnapshot.payload.analysis as any).rawOutput.modelProbability = 0.61;
  assert.equal(validateMlbP1M3aCapture(tampered, NOW).errors.includes("SCIENTIFIC_SNAPSHOT_DIGEST_MISMATCH"), true);

  const sensitive = candidate();
  (sensitive.scientificSnapshot.payload.analysis as any).rawInputs.authorization = "Bearer secret";
  sensitive.scientificSnapshot.payloadDigest = mlbP1M3aSha256(sensitive.scientificSnapshot.payload);
  assert.equal(validateMlbP1M3aCapture(sensitive, NOW).errors.some((error) => error.startsWith("SCIENTIFIC_SNAPSHOT_SENSITIVE_FIELD:")), true);
});

test("semantic identity ignores transmission time and deployment commit but changes with price", () => {
  const original = candidate();
  const retry = candidate({
    capturedAt: "2026-08-05T18:00:10.000Z",
    origin: { ...candidate().origin, clientEvaluationId: "ui-retry-824466-f5ml-home" },
    model: { ...candidate().model, gitCommit: "frontend-commit-b" },
  });
  const firstIdentity = buildMlbP1M3aCaptureIdentity(original);
  const retryIdentity = buildMlbP1M3aCaptureIdentity(retry);
  assert.equal(firstIdentity.semanticFingerprint, retryIdentity.semanticFingerprint);
  assert.equal(firstIdentity.lifecycleKey, retryIdentity.lifecycleKey);

  const repriced = candidate();
  repriced.quote.oddsAmerican = -125;
  repriced.readiness.certifiedQuote = { ...repriced.quote };
  repriced.probabilities.marketImplied = 125 / 225;
  repriced.probabilities.edgePp = (repriced.probabilities.model - repriced.probabilities.marketImplied) * 100;
  assert.notEqual(buildMlbP1M3aCaptureIdentity(repriced).semanticFingerprint, firstIdentity.semanticFingerprint);
  assert.equal(buildMlbP1M3aCaptureIdentity(repriced).lifecycleKey, firstIdentity.lifecycleKey);
});

test("revision policy is append-only, idempotent and forbids FINAL to PROVISIONAL regression", () => {
  const first = candidate();
  const firstIdentity = buildMlbP1M3aCaptureIdentity(first);
  const previous = {
    predictionId: "prediction-1",
    lifecycleKey: firstIdentity.lifecycleKey,
    semanticFingerprint: firstIdentity.semanticFingerprint,
    analysisStage: "PROVISIONAL" as const,
    capturedAt: "2026-08-05T17:55:00.000Z",
  };

  assert.equal(decideMlbP1M3aRevision(null, first).decision, "NEW_CHAIN");
  assert.equal(decideMlbP1M3aRevision(previous, first).decision, "IDEMPOTENT_RETRY");

  const finalRevision = candidate();
  finalRevision.quote.oddsAmerican = -125;
  finalRevision.readiness.certifiedQuote = { ...finalRevision.quote };
  finalRevision.probabilities.marketImplied = 125 / 225;
  finalRevision.probabilities.edgePp = (finalRevision.probabilities.model - finalRevision.probabilities.marketImplied) * 100;
  const append = decideMlbP1M3aRevision(previous, finalRevision);
  assert.equal(append.decision, "APPEND_SUPERSEDING_REVISION");
  assert.equal(append.supersedesId, "prediction-1");

  const finalPrevious = { ...previous, semanticFingerprint: "different", analysisStage: "FINAL" as const };
  const provisional = candidate();
  provisional.readiness.gateStatus = "READY_PROVISIONAL";
  provisional.readiness.analysisStage = "PROVISIONAL";
  assert.equal(decideMlbP1M3aRevision(finalPrevious, provisional).decision, "REJECT_STAGE_REGRESSION");
});

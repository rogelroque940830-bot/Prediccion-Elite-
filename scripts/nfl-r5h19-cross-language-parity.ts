#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { predictFrozenLogit, type FrozenLogitSpec } from "../server/nfl-frozen-logit";
import {
  evaluateNflR5H8,
  type NflR5H8CoreConfig,
  type NflR5H8Pair,
  type NflR5H8Reliability,
} from "../server/nfl-r5h8-engine";

const TOLERANCE = 1e-10;
const EXPECTED_FIXTURE_DIGEST = "a8f2ee6dc935e9024775c25da4d197838db81a141666d42c72dd004df20cbed2";
const EXPECTED_GAMES = 271;
const EXPECTED_CORE_SELECTIONS = 15;

type Fixture = {
  schemaVersion: string;
  season: number;
  trainedThroughSeason: number;
  semanticDigest: string;
  rules: string[];
  models: {
    reference: { name: string; pipeline: FrozenLogitSpec };
    experts: Record<string, FrozenLogitSpec>;
  };
  coreConfig: NflR5H8CoreConfig;
  reliability: NflR5H8Reliability[];
  pairStructure: NflR5H8Pair[];
  rows: Array<{
    gameId: string;
    season: number;
    week: number;
    features: Record<string, number | null>;
    expected: {
      referenceProbability: number;
      expertProbabilities: Record<string, number>;
      interactionScore: number;
      agreement: number;
      confidenceStratum: number;
      coreSelected: boolean;
    };
  }>;
};

function numericError(a: number, b: number): number {
  return Math.abs(a - b);
}

function main(): void {
  const fixturePath = process.argv[2];
  if (!fixturePath) throw new Error("Usage: nfl-r5h19-cross-language-parity.ts <fixture.json>");
  const fixture = JSON.parse(fs.readFileSync(path.resolve(fixturePath), "utf8")) as Fixture;
  if (fixture.semanticDigest !== EXPECTED_FIXTURE_DIGEST) {
    throw new Error(`Unexpected R5H19 parity fixture digest ${fixture.semanticDigest}`);
  }
  if (fixture.season !== 2025 || fixture.trainedThroughSeason !== 2024) {
    throw new Error("R5H19 parity fixture training/target custody mismatch");
  }
  if (fixture.rows.length !== EXPECTED_GAMES) {
    throw new Error(`R5H19 parity fixture expected ${EXPECTED_GAMES} games, got ${fixture.rows.length}`);
  }

  let maxReferenceProbabilityError = 0;
  let maxExpertProbabilityError = 0;
  let maxInteractionScoreError = 0;
  let maxAgreementError = 0;
  let selectionMismatches = 0;
  let confidenceBinMismatches = 0;
  let selected = 0;

  for (const row of fixture.rows) {
    const referenceProbability = predictFrozenLogit(fixture.models.reference.pipeline, row.features);
    maxReferenceProbabilityError = Math.max(
      maxReferenceProbabilityError,
      numericError(referenceProbability, row.expected.referenceProbability),
    );

    const expertProbabilities: Record<string, number> = {};
    for (const rule of fixture.rules) {
      const spec = fixture.models.experts[rule];
      if (!spec) throw new Error(`R5H19 parity fixture missing expert ${rule}`);
      const probability = predictFrozenLogit(spec, row.features);
      expertProbabilities[rule] = probability;
      maxExpertProbabilityError = Math.max(
        maxExpertProbabilityError,
        numericError(probability, row.expected.expertProbabilities[rule]),
      );
    }

    const actual = evaluateNflR5H8(
      referenceProbability,
      expertProbabilities,
      fixture.reliability,
      fixture.pairStructure,
      fixture.coreConfig,
    );
    maxInteractionScoreError = Math.max(
      maxInteractionScoreError,
      numericError(actual.interactionScore, row.expected.interactionScore),
    );
    maxAgreementError = Math.max(
      maxAgreementError,
      numericError(actual.agreement, row.expected.agreement),
    );
    if (actual.confidenceStratum !== row.expected.confidenceStratum) confidenceBinMismatches += 1;
    if (actual.coreSelected !== row.expected.coreSelected) selectionMismatches += 1;
    if (actual.coreSelected) selected += 1;
  }

  const maxProbabilityError = Math.max(maxReferenceProbabilityError, maxExpertProbabilityError);
  const summary = {
    schemaVersion: "courtedge-nfl-r5h19-typescript-parity.v1",
    sourceFixtureDigest: fixture.semanticDigest,
    games: fixture.rows.length,
    selected,
    maxReferenceProbabilityError,
    maxExpertProbabilityError,
    maxProbabilityError,
    maxInteractionScoreError,
    maxAgreementError,
    confidenceBinMismatches,
    selectionMismatches,
    tolerance: TOLERANCE,
    pass: false,
  };

  if (selected !== EXPECTED_CORE_SELECTIONS) {
    throw new Error(`R5H19 TypeScript parity selected ${selected}, expected ${EXPECTED_CORE_SELECTIONS}`);
  }
  if (confidenceBinMismatches !== 0 || selectionMismatches !== 0) {
    throw new Error(`R5H19 TypeScript parity mismatch bins=${confidenceBinMismatches} selections=${selectionMismatches}`);
  }
  if (
    maxProbabilityError > TOLERANCE
    || maxInteractionScoreError > TOLERANCE
    || maxAgreementError > TOLERANCE
  ) {
    throw new Error(`R5H19 TypeScript numeric parity exceeded tolerance: ${JSON.stringify(summary)}`);
  }

  summary.pass = true;
  console.log("NFL_R5H19_TYPESCRIPT_PARITY");
  console.log(JSON.stringify(summary, null, 2));
  console.log("NFL_R5H19_TYPESCRIPT_PARITY_PASS");
}

main();

import fs from "node:fs";
import { predictFrozenLogit, type FrozenLogitSpec } from "../server/nfl-frozen-logit";

function logit(probability: number): number {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(p / (1 - p));
}

type Row = {
  gameId: string;
  features: Record<string, number | null>;
  referenceProbability: number;
  coreSelected: boolean;
  expected: {
    lateDownProbability: number;
    supportScore: number;
    thresholdOnlySelected: boolean;
  };
};

type Fixture = {
  schemaVersion: string;
  season: number;
  threshold: number;
  model: FrozenLogitSpec;
  rows: Row[];
};

const path = process.argv[2];
if (!path) throw new Error("Usage: nfl-r5h21-cross-language-parity.ts <fixture.json>");
const fixture = JSON.parse(fs.readFileSync(path, "utf8")) as Fixture;
if (fixture.schemaVersion !== "courtedge-nfl-r5h21-late-down-2025-parity.v1" || fixture.season !== 2025) {
  throw new Error("NFL R5H21 parity fixture custody mismatch");
}
if (fixture.rows.length !== 271) throw new Error(`NFL R5H21 parity fixture expected 271 rows, got ${fixture.rows.length}`);

let maxProbabilityError = 0;
let maxSupportError = 0;
let mismatches = 0;
let selections = 0;
for (const row of fixture.rows) {
  const probability = predictFrozenLogit(fixture.model, row.features);
  const support = (row.referenceProbability >= 0.5 ? 1 : -1) * logit(probability);
  const selected = !row.coreSelected && Number.isFinite(support) && support > 0 && support >= fixture.threshold;
  maxProbabilityError = Math.max(maxProbabilityError, Math.abs(probability - row.expected.lateDownProbability));
  maxSupportError = Math.max(maxSupportError, Math.abs(support - row.expected.supportScore));
  if (selected !== row.expected.thresholdOnlySelected) mismatches += 1;
  if (selected) selections += 1;
}

if (maxProbabilityError > 1e-10) throw new Error(`NFL R5H21 probability parity failed: ${maxProbabilityError}`);
if (maxSupportError > 1e-10) throw new Error(`NFL R5H21 support parity failed: ${maxSupportError}`);
if (mismatches !== 0) throw new Error(`NFL R5H21 selection parity failed: ${mismatches} mismatches`);
if (selections !== 34) throw new Error(`NFL R5H21 expected 34 2025 threshold-only selections, got ${selections}`);

console.log(JSON.stringify({
  stage: "R5H21_TYPESCRIPT_PARITY",
  games: fixture.rows.length,
  selections,
  selectionMismatches: mismatches,
  maxProbabilityError,
  maxSupportScoreError: maxSupportError,
  pass: true,
}));

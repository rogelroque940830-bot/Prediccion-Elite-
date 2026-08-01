import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6p-first-twenty-settlements-certification.ts";
let service = fs.readFileSync(servicePath, "utf8");

const readerEnd = `function writeAppendOnlyJson(filePath: string, value: unknown): void {\n`;
const helper = `export function buildMlbS6pStoredArtifacts(\n  baselineArtifact: { value: S6pBaseline | null; error: string | null; present: boolean },\n  evidenceArtifact: { value: S6pEvidence | null; error: string | null; present: boolean },\n): StoredArtifacts {\n  return {\n    baseline: baselineArtifact.value,\n    evidence: evidenceArtifact.value,\n    baselinePresent: baselineArtifact.present,\n    evidencePresent: evidenceArtifact.present,\n    baselineReadError: baselineArtifact.error,\n    evidenceReadError: evidenceArtifact.error,\n  };\n}\n\n`;
service = replaceOnce(service, readerEnd, helper + readerEnd, "stored artifact helper anchor");

const artifactObject = `        {\n          baseline: baselineArtifact.value,\n          evidence: evidenceArtifact.value,\n          baselinePresent: baselineArtifact.present,\n          evidencePresent: evidenceArtifact.present,\n          baselineReadError: baselineArtifact.error,\n          evidenceReadError: evidenceArtifact.error,\n        },`;
service = replaceOnce(
  service,
  artifactObject,
  `        buildMlbS6pStoredArtifacts(baselineArtifact, evidenceArtifact),`,
  "initial stored artifacts helper use",
);

const refreshedObject = `          {\n            baseline: refreshedBaseline.value,\n            evidence: refreshedEvidence.value,\n            baselineReadError: refreshedBaseline.error,\n            evidenceReadError: refreshedEvidence.error,\n          },`;
service = replaceOnce(
  service,
  refreshedObject,
  `          buildMlbS6pStoredArtifacts(refreshedBaseline, refreshedEvidence),`,
  "refreshed stored artifacts helper use",
);
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6p-first-twenty-settlements-certification.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  `  evaluateMlbS6pFirstTwentySettlements,\n  type S6pBaseline,`,
  `  buildMlbS6pStoredArtifacts,\n  evaluateMlbS6pFirstTwentySettlements,\n  type S6pBaseline,`,
  "stored artifact helper test import",
);
const helperTest = `

test("preserves present-but-null artifacts when rebuilding refreshed worker state", () => {
  const stored = buildMlbS6pStoredArtifacts(
    { value: null, error: null, present: true },
    { value: null, error: null, present: true },
  );
  assert.equal(stored.baseline, null);
  assert.equal(stored.evidence, null);
  assert.equal(stored.baselinePresent, true);
  assert.equal(stored.evidencePresent, true);
});
`;
if (!tests.includes("preserves present-but-null artifacts when rebuilding refreshed worker state")) tests += helperTest;
fs.writeFileSync(testPath, tests);
console.log("Applied refreshed S6P artifact presence patch.");

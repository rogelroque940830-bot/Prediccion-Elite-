import fs from "node:fs";

const contractPath = "server/mlb-p1-scientific-capture-contract.ts";
const testPath = "server/mlb-p1-scientific-capture-contract.test.ts";

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: expected exactly one match`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

let contract = fs.readFileSync(contractPath, "utf8");
contract = replaceOnce(
  contract,
  "    scientificSnapshotDigest: candidate.scientificSnapshot.payloadDigest,\n",
  "",
  "remove technical snapshot digest from semantic fingerprint",
);
contract = replaceOnce(
  contract,
  "  if (candidate.scientificSnapshot.schemaVersion !== MLB_P1_M3A_SNAPSHOT_SCHEMA) pushUnique(errors, \"SCIENTIFIC_SNAPSHOT_SCHEMA_MISMATCH\");\n",
  "  if (candidate.scientificSnapshot.schemaVersion !== MLB_P1_M3A_SNAPSHOT_SCHEMA) pushUnique(errors, \"SCIENTIFIC_SNAPSHOT_SCHEMA_MISMATCH\");\n  if (candidate.scientificSnapshot.payload.schemaVersion !== MLB_P1_M3A_SNAPSHOT_SCHEMA) pushUnique(errors, \"SCIENTIFIC_SNAPSHOT_PAYLOAD_SCHEMA_MISMATCH\");\n",
  "validate snapshot payload schema",
);
fs.writeFileSync(contractPath, contract);

let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOnce(
  tests,
  "  const firstIdentity = buildMlbP1M3aCaptureIdentity(original);\n  const retryIdentity = buildMlbP1M3aCaptureIdentity(retry);\n",
  "  (retry.scientificSnapshot.payload.model as Record<string, unknown>).gitCommit = \"frontend-commit-b\";\n  retry.scientificSnapshot.payloadDigest = mlbP1M3aSha256(retry.scientificSnapshot.payload);\n  const firstIdentity = buildMlbP1M3aCaptureIdentity(original);\n  const retryIdentity = buildMlbP1M3aCaptureIdentity(retry);\n",
  "prove technical snapshot commit does not change semantic identity",
);
fs.writeFileSync(testPath, tests);

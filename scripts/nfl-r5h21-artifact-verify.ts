import assert from "node:assert/strict";
import fs from "node:fs";
import { getNflR5H21Artifact, NFL_R5H21_ARTIFACT_DIGEST } from "../server/nfl-r5h21-artifact";

const path = process.argv[2];
if (!path) throw new Error("Usage: nfl-r5h21-artifact-verify.ts <artifact.json>");
const downloaded = JSON.parse(fs.readFileSync(path, "utf8"));
const embedded = getNflR5H21Artifact();
assert.equal(downloaded.semanticDigest, NFL_R5H21_ARTIFACT_DIGEST);
assert.deepEqual(embedded, downloaded);
console.log(JSON.stringify({
  stage: "R5H21_PRODUCTION_ARTIFACT_CUSTODY",
  semanticDigest: NFL_R5H21_ARTIFACT_DIGEST,
  threshold: embedded.thresholdConfig.threshold,
  processedCompletedGames: embedded.end2025State.processedCompletedGames,
  pass: true,
}));

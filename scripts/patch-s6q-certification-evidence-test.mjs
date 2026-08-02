import fs from "node:fs";

const path = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let source = fs.readFileSync(path, "utf8");
const before = `  assert.equal(certification?.required, 10);\n  assert.equal(certification?.certifiedAtReview, 10);\n  assert.deepEqual(certification?.terminalPredictionIds, terminalIds(10));`;
const after = `  assert.equal(certification?.required, 10);\n  assert.equal(certification?.certifiedAtReview, 50);\n  assert.deepEqual(certification?.terminalPredictionIds, terminalIds(50));`;
if (!source.includes(before)) throw new Error("Expected certification evidence assertions not found");
source = source.replace(before, after);
fs.writeFileSync(path, source);

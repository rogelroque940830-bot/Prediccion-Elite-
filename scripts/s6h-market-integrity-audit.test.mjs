import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { auditMlbMarketIntegrity } from "./lib/s6h-market-integrity-audit.mjs";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/s6h-screenshot-sample.json", import.meta.url), "utf8"));
const report = auditMlbMarketIntegrity(fixture);

function record(id) {
  const found = report.records.find((entry) => entry.id === id);
  assert.ok(found, `Missing ${id}`);
  return found;
}

test("valid -145 F5 moneyline passes deterministic arithmetic", () => {
  const pick = record("valid-f5-ml");
  assert.equal(pick.classification, "PASS");
  assert.ok(Math.abs(pick.formulaImpliedPct - 59.1836734694) < 1e-6);
  assert.ok(Math.abs(pick.recomputedEdgePp - 6.5163265306) < 1e-6);
});

test("-120 record is arithmetically coherent but is an edge outlier", () => {
  const pick = record("baltimore-edge-outlier");
  assert.equal(pick.classification, "REVIEW");
  assert.ok(pick.issues.some((entry) => entry.code === "EDGE_OUTLIER"));
  assert.ok(!pick.issues.some((entry) => entry.code === "EDGE_ARITHMETIC_MISMATCH"));
});

test("-126 total preserves arithmetic but flags nonstandard 4.4 line and outlier edge", () => {
  const pick = record("rangers-nonstandard-line");
  assert.equal(pick.classification, "REVIEW");
  assert.ok(pick.issues.some((entry) => entry.code === "NON_STANDARD_LINE_INCREMENT"));
  assert.ok(pick.issues.some((entry) => entry.code === "EDGE_OUTLIER"));
  assert.ok(Math.abs(pick.formulaImpliedPct - 55.7522123894) < 1e-6);
});

test("-4 proves invalid American odds were accepted upstream", () => {
  const pick = record("royals-invalid-odds");
  assert.equal(pick.classification, "REJECT");
  assert.ok(pick.issues.some((entry) => entry.code === "INVALID_AMERICAN_ODDS"));
  assert.ok(pick.issues.some((entry) => entry.code === "NON_STANDARD_LINE_INCREMENT"));
  assert.ok(Math.abs(pick.formulaImpliedPct - 3.8461538462) < 1e-6);
  assert.ok(Math.abs(pick.recomputedEdgePp - 57.2538461538) < 1e-6);
  assert.ok(!pick.issues.some((entry) => entry.code === "EDGE_ARITHMETIC_MISMATCH"));
});

test("fixture accounting is one pass, two review, one reject", () => {
  assert.deepEqual(
    { PASS: report.summary.PASS, REVIEW: report.summary.REVIEW, REJECT: report.summary.REJECT },
    { PASS: 1, REVIEW: 2, REJECT: 1 },
  );
});

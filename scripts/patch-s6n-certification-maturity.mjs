import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const s6mPath = "server/mlb-s6m-statistical-milestones.ts";
let s6m = fs.readFileSync(s6mPath, "utf8");
s6m = replaceOnce(
  s6m,
  `  const expectedManifest = manifestFor(expected);\n  if (stableDigest(certificate.manifest) !== certificate.manifestDigestSha256) {`,
  `  const currentManifest = manifestFor(expected);\n  const expectedManifest = currentManifest.map((entry, index) => ({\n    ...entry,\n    // Independent certification is a later lifecycle annotation, not part of the immutable pick identity.\n    independentlyCertified: certificate.manifest[index]?.independentlyCertified ?? entry.independentlyCertified,\n  }));\n  if (stableDigest(certificate.manifest) !== certificate.manifestDigestSha256) {`,
  "S6M mutable certification annotation",
);
fs.writeFileSync(s6mPath, s6m);

const s6nPath = "server/mlb-s6n-first-real-settlement-monitor.ts";
let s6n = fs.readFileSync(s6nPath, "utf8");
s6n = replaceOnce(
  s6n,
  `    const expectedManifest = expectedManifestEntry(records, certifiedTerminalPredictionIds);\n    if (!expectedManifest || canonicalDigest(expectedManifest) !== canonicalDigest(certificate.manifest[0])) {`,
  `    const currentExpectedManifest = expectedManifestEntry(records, certifiedTerminalPredictionIds);\n    const expectedManifest = currentExpectedManifest ? {\n      ...currentExpectedManifest,\n      // Preserve the immutable certificate-time annotation while validating every pick/settlement field.\n      independentlyCertified: certificate.manifest[0].independentlyCertified,\n    } : null;\n    if (!expectedManifest || canonicalDigest(expectedManifest) !== canonicalDigest(certificate.manifest[0])) {`,
  "S6N mutable certification annotation",
);
fs.writeFileSync(s6nPath, s6n);

const s6mTestPath = "server/mlb-s6m-statistical-milestones.test.ts";
let s6mTests = fs.readFileSync(s6mTestPath, "utf8");
const s6mAddition = `\n\ntest("keeps an immutable milestone valid when independent certification matures later", () => {\n  const records = pairedDecision(0);\n  const first = evaluate(records, []);\n  const certificate = first.newCertificates.find((entry) => entry.milestone === 1);\n  assert.ok(certificate);\n  assert.equal(certificate.manifest[0].independentlyCertified, false);\n\n  const second = evaluate(records, ["final-0"], { "1": certificate });\n  assert.equal(second.report.state, "MILESTONE_1_CERTIFIED");\n  assert.equal(second.report.sample.independentlyCertifiedDecisions, 1);\n  assert.equal(second.report.issues.some((entry) => entry.code === "MILESTONE_1_CERTIFICATE_INVALID"), false);\n  assert.equal(second.newCertificates.length, 0);\n});\n`;
if (!s6mTests.includes('test("keeps an immutable milestone valid when independent certification matures later"')) {
  s6mTests += s6mAddition;
}
fs.writeFileSync(s6mTestPath, s6mTests);

const s6nTestPath = "server/mlb-s6n-first-real-settlement-monitor.test.ts";
let s6nTests = fs.readFileSync(s6nTestPath, "utf8");
const s6nAddition = `\n\ntest("accepts later independent-certification maturity without changing the immutable pick", () => {\n  const records = pairedDecision(0, "WIN");\n  const initial = buildS6m(records, []);\n  const certificate = initial.certificates["1"];\n  if (!certificate) throw new Error("fixture certificate missing");\n  assert.equal(certificate.manifest[0].independentlyCertified, false);\n\n  const matureS6l = buildMlbS6lScientificMetrics(records, {\n    certifiedTerminalPredictionIds: ["final-0"],\n    generatedAt: "2026-08-01T20:04:00.000Z",\n  });\n  const matureS6m = evaluateMlbS6mMilestones(\n    records,\n    matureS6l,\n    ["final-0"],\n    { "1": certificate },\n    { generatedAt: "2026-08-01T20:05:00.000Z", deploymentCommit: "fixture", environment: "test" },\n  );\n  assert.equal(matureS6m.report.state, "MILESTONE_1_CERTIFIED");\n\n  const result = evaluateMlbS6nFirstRealSettlement(\n    records,\n    matureS6m.report,\n    { "1": certificate },\n    ["final-0"],\n    { baseline: null, evidence: null },\n    {\n      generatedAt: "2026-08-01T20:06:00.000Z",\n      deploymentCommit: "fixture",\n      environment: "test",\n      minimumStabilityMs: 60_000,\n    },\n  );\n  assert.equal(result.report.state, "OBSERVING_CERTIFICATE_STABILITY");\n  assert.equal(result.report.checks.currentLedgerManifestMatches, true);\n  assert.equal(result.report.issues.some((entry) => entry.code === "CURRENT_LEDGER_MANIFEST_MISMATCH"), false);\n});\n`;
if (!s6nTests.includes('test("accepts later independent-certification maturity without changing the immutable pick"')) {
  s6nTests += s6nAddition;
}
fs.writeFileSync(s6nTestPath, s6nTests);

console.log("Applied S6M/S6N certification maturity hardening.");

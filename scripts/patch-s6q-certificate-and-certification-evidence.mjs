import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const servicePath = "server/mlb-s6q-fifty-settlement-human-review.ts";
let service = fs.readFileSync(servicePath, "utf8");

service = replaceOnce(
  service,
  `  manifest: S6mManifestEntry[];\n  metrics: S6mMilestoneCertificate["metrics"];`,
  `  manifest: S6mManifestEntry[];\n  independentCertification: {\n    required: 10;\n    certifiedAtReview: number;\n    terminalPredictionIds: string[];\n    digestSha256: string;\n  };\n  metrics: S6mMilestoneCertificate["metrics"];`,
  "independent certification evidence type",
);

service = replaceOnce(
  service,
  `function certificateCore(certificate: S6mMilestoneCertificate): Omit<S6mMilestoneCertificate, "certificateDigestSha256"> {`,
  `function isS6mManifestEntryShape(value: unknown): value is S6mManifestEntry {\n  if (!isObjectRecord(value)) return false;\n  return typeof value.ordinal === "number"\n    && typeof value.rootPredictionId === "string"\n    && typeof value.terminalPredictionId === "string"\n    && typeof value.payloadSha256 === "string"\n    && typeof value.gameDate === "string"\n    && typeof value.marketType === "string"\n    && typeof value.selection === "string"\n    && typeof value.signal === "string"\n    && typeof value.modelProbability === "number"\n    && typeof value.marketImpliedProbability === "number"\n    && typeof value.oddsAmerican === "number"\n    && (value.result === "WIN" || value.result === "LOSS" || value.result === "PUSH" || value.result === "VOID")\n    && (value.outcome === 0 || value.outcome === 1 || value.outcome === null)\n    && typeof value.independentlyCertified === "boolean"\n    && typeof value.settlementEventId === "string"\n    && typeof value.settlementSource === "string"\n    && typeof value.settledAt === "string";\n}\n\nfunction isS6mMilestoneCertificateShape(value: unknown): value is S6mMilestoneCertificate {\n  if (!isObjectRecord(value)) return false;\n  return typeof value.schemaVersion === "string"\n    && typeof value.milestone === "number"\n    && typeof value.createdAt === "string"\n    && typeof value.sourceS6lGeneratedAt === "string"\n    && typeof value.deploymentCommit === "string"\n    && typeof value.environment === "string"\n    && typeof value.sampleRule === "string"\n    && Array.isArray(value.manifest)\n    && value.manifest.every(isS6mManifestEntryShape)\n    && typeof value.manifestDigestSha256 === "string"\n    && isObjectRecord(value.metrics)\n    && typeof value.metrics.binaryDecisions === "number"\n    && typeof value.metrics.wins === "number"\n    && typeof value.metrics.losses === "number"\n    && typeof value.metrics.clvAvailable === "number"\n    && isObjectRecord(value.checks)\n    && typeof value.certificateDigestSha256 === "string";\n}\n\nfunction certificateCore(certificate: S6mMilestoneCertificate): Omit<S6mMilestoneCertificate, "certificateDigestSha256"> {`,
  "certificate shape guards",
);

service = replaceOnce(
  service,
  `function makeEvidence(\n  certificate: S6mMilestoneCertificate,`,
  `function independentCertificationEvidence(selected: S6mObservation[]) {\n  const terminalPredictionIds = selected\n    .filter((entry) => entry.independentlyCertified)\n    .map((entry) => entry.terminalPredictionId);\n  const core = {\n    required: 10 as const,\n    certifiedAtReview: terminalPredictionIds.length,\n    terminalPredictionIds,\n  };\n  return { ...core, digestSha256: sha256(core) };\n}\n\nfunction makeEvidence(\n  certificate: S6mMilestoneCertificate,`,
  "independent certification evidence builder",
);

service = replaceOnce(
  service,
  `    manifest: certificate.manifest,\n    metrics: certificate.metrics,`,
  `    manifest: certificate.manifest,\n    independentCertification: independentCertificationEvidence(selected),\n    metrics: certificate.metrics,`,
  "persist certification annotations",
);

service = replaceOnce(
  service,
  `    && Array.isArray(value.manifest)\n    && isObjectRecord(value.metrics)`,
  `    && Array.isArray(value.manifest)\n    && isObjectRecord(value.independentCertification)\n    && value.independentCertification.required === 10\n    && typeof value.independentCertification.certifiedAtReview === "number"\n    && isStringArray(value.independentCertification.terminalPredictionIds)\n    && typeof value.independentCertification.digestSha256 === "string"\n    && isObjectRecord(value.metrics)`,
  "evidence certification shape",
);

service = replaceOnce(
  service,
  `  const certificate = certificates["50"] ?? null;\n  const milestoneFiftyRow`,
  `  const rawCertificate = certificates["50"] ?? null;\n  const certificateShapeValid = rawCertificate ? isS6mMilestoneCertificateShape(rawCertificate) : null;\n  const certificate = certificateShapeValid ? rawCertificate : null;\n  if (rawCertificate && !certificateShapeValid) {\n    pushIssue(issues, "CERTIFICATE_SHAPE_INVALID", "CRITICAL", "The persisted milestone-50 certificate has an incomplete or incompatible structure.");\n  }\n  const milestoneFiftyRow`,
  "safe certificate selection",
);

service = service.replaceAll("s6mClaimsCertificate && !certificate", "s6mClaimsCertificate && !rawCertificate");
service = service.replaceAll("if (certificate && !s6mClaimsCertificate)", "if (rawCertificate && !s6mClaimsCertificate)");
service = service.replaceAll("if (certificate && !prerequisiteMinimumSample20Certified)", "if (rawCertificate && !prerequisiteMinimumSample20Certified)");

service = replaceOnce(
  service,
  `  let certificateIntegrity: boolean | null = certificate ? true : null;\n  let currentLedgerManifestMatches: boolean | null = certificate ? true : null;\n  let settlementIdentitiesMatch: boolean | null = certificate ? true : null;\n\n  if (!certificate) {\n    if (baselinePresent || evidencePresent) {`,
  `  let certificateIntegrity: boolean | null = rawCertificate ? Boolean(certificateShapeValid) : null;\n  let currentLedgerManifestMatches: boolean | null = rawCertificate ? Boolean(certificateShapeValid) : null;\n  let settlementIdentitiesMatch: boolean | null = rawCertificate ? Boolean(certificateShapeValid) : null;\n\n  if (!rawCertificate) {\n    if (baselinePresent || evidencePresent) {`,
  "raw certificate absence branch",
);

service = replaceOnce(
  service,
  `      );\n    }\n  } else {\n    if (certificate.schemaVersion !== MLB_S6M_CERTIFICATE_VERSION || certificate.milestone !== 50) {`,
  `      );\n    }\n  } else if (!certificate) {\n    currentLedgerManifestMatches = false;\n    settlementIdentitiesMatch = false;\n  } else {\n    if (certificate.schemaVersion !== MLB_S6M_CERTIFICATE_VERSION || certificate.milestone !== 50) {`,
  "invalid-shape certificate branch",
);

service = replaceOnce(
  service,
  `    if (!Object.values(validStoredEvidence.checks).every((value) => value === true)) {`,
  `    const certification = validStoredEvidence.independentCertification;\n    const certificationCore = {\n      required: certification.required,\n      certifiedAtReview: certification.certifiedAtReview,\n      terminalPredictionIds: certification.terminalPredictionIds,\n    };\n    const currentlyCertifiedIds = new Set(\n      selected.filter((entry) => entry.independentlyCertified).map((entry) => entry.terminalPredictionId),\n    );\n    const certificationValid = certification.required === 10\n      && certification.certifiedAtReview === certification.terminalPredictionIds.length\n      && certification.certifiedAtReview >= 10\n      && new Set(certification.terminalPredictionIds).size === certification.terminalPredictionIds.length\n      && certification.terminalPredictionIds.every((id) => currentlyCertifiedIds.has(id))\n      && certification.digestSha256 === sha256(certificationCore);\n    if (!certificationValid) {\n      pushIssue(issues, "INDEPENDENT_CERTIFICATION_EVIDENCE_INVALID", "CRITICAL", "S6Q evidence does not substantiate the ten independent certifications that unlocked human review.");\n    }\n    if (!Object.values(validStoredEvidence.checks).every((value) => value === true)) {`,
  "independent certification evidence validation",
);

service = replaceOnce(
  service,
  `      certificatePresent: Boolean(certificate),`,
  `      certificatePresent: Boolean(rawCertificate),`,
  "raw certificate presence report",
);

if (!service.includes("CERTIFICATE_SHAPE_INVALID") || !service.includes("INDEPENDENT_CERTIFICATION_EVIDENCE_INVALID")) {
  throw new Error("S6Q certificate/evidence hardening was not applied");
}
fs.writeFileSync(servicePath, service);

const testPath = "server/mlb-s6q-fifty-settlement-human-review.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
const additions = `

test("turns a malformed milestone-50 certificate into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(certificates);
  malformed["50"] = {} as any;
  const result = evaluate(records, report, malformed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.target.certificatePresent, true);
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_SHAPE_INVALID"), true);
});

test("persists the exact independent certifications that unlocked human review", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  const certification = second.evidenceToPersist?.independentCertification;
  assert.ok(certification);
  assert.equal(certification?.required, 10);
  assert.equal(certification?.certifiedAtReview, 10);
  assert.deepEqual(certification?.terminalPredictionIds, terminalIds(10));
});

test("rejects certification evidence that no longer substantiates the review gate", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !second.evidenceToPersist) throw new Error("fixture review evidence missing");
  const tampered = structuredClone(second.evidenceToPersist);
  tampered.independentCertification.terminalPredictionIds = tampered.independentCertification.terminalPredictionIds.slice(0, 9);
  tampered.independentCertification.certifiedAtReview = 9;
  const certificationCore = {
    required: tampered.independentCertification.required,
    certifiedAtReview: tampered.independentCertification.certifiedAtReview,
    terminalPredictionIds: tampered.independentCertification.terminalPredictionIds,
  };
  tampered.independentCertification.digestSha256 = digest(certificationCore);
  const { evidenceDigestSha256: _ignored, ...evidenceCore } = tampered;
  tampered.evidenceDigestSha256 = digest(evidenceCore);
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "INDEPENDENT_CERTIFICATION_EVIDENCE_INVALID"), true);
});
`;
if (!tests.includes("turns a malformed milestone-50 certificate into ACTION_REQUIRED without throwing")) tests += additions;
fs.writeFileSync(testPath, tests);
console.log("Applied S6Q certificate-shape and certification-evidence hardening.");

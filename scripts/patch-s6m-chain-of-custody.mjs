import fs from "node:fs";

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  return source.replace(before, after);
}

const sourcePath = "server/mlb-s6m-statistical-milestones.ts";
let source = fs.readFileSync(sourcePath, "utf8");

source = replaceOnce(
  source,
  `    previousOwnedLedgerRecords?: number | null;\n  } = {},`,
  `    previousOwnedLedgerRecords?: number | null;\n    certificateReadErrors?: Array<{ milestone: S6mMilestone; message: string }>;\n    previouslyCertifiedMilestones?: S6mMilestone[];\n  } = {},`,
  "evaluate options",
);

source = replaceOnce(
  source,
  `  const issues: S6mMilestoneReport["issues"] = [];\n  const parityMismatches: string[] = [];`,
  `  const issues: S6mMilestoneReport["issues"] = [];\n  const parityMismatches: string[] = [];\n\n  for (const readError of options.certificateReadErrors ?? []) {\n    issues.push({\n      code: \`MILESTONE_\${readError.milestone}_CERTIFICATE_UNREADABLE\`,\n      severity: "CRITICAL",\n      message: readError.message,\n    });\n  }`,
  "certificate read errors",
);

source = replaceOnce(
  source,
  `  const certificates: S6mCertificateMap = { ...existingCertificates };\n  for (const milestone of MLB_S6M_MILESTONES) {`,
  `  const certificates: S6mCertificateMap = { ...existingCertificates };\n  for (const milestone of options.previouslyCertifiedMilestones ?? []) {\n    if (certificates[\`\${milestone}\`]) continue;\n    issues.push({\n      code: \`MILESTONE_\${milestone}_CERTIFICATE_MISSING\`,\n      severity: "CRITICAL",\n      message: \`Milestone \${milestone} was previously certified, but its append-only certificate file is missing.\`,\n    });\n  }\n  for (const milestone of MLB_S6M_MILESTONES) {`,
  "missing previous certificates",
);

source = replaceOnce(
  source,
  `  const preferredSampleCertified = highestCertifiedMilestone >= 50;\n  const humanReviewReady = preferredSampleCertified\n    && tenCertifiedCyclesReached\n    && s6lReport?.state === "READY_FOR_REVIEW"\n    && s6lReport.readiness.conclusionsAllowed === true;\n  const critical = issues.some((entry) => entry.severity === "CRITICAL");`,
  `  const preferredSampleCertified = highestCertifiedMilestone >= 50;\n  const critical = issues.some((entry) => entry.severity === "CRITICAL");\n  const humanReviewReady = !critical\n    && preferredSampleCertified\n    && tenCertifiedCyclesReached\n    && s6lReport?.state === "READY_FOR_REVIEW"\n    && s6lReport.readiness.conclusionsAllowed === true;`,
  "critical human review gate",
);

source = replaceOnce(
  source,
  `  readCertificates(): S6mCertificateMap {\n    const certificates: S6mCertificateMap = {};\n    for (const milestone of MLB_S6M_MILESTONES) {\n      const value = readJson<S6mMilestoneCertificate>(path.join(this.root, "certificates", \`milestone-\${milestone}.json\`));\n      if (value) certificates[\`\${milestone}\`] = value;\n    }\n    return certificates;\n  }`,
  `  private readCertificateInventory(): {\n    certificates: S6mCertificateMap;\n    errors: Array<{ milestone: S6mMilestone; message: string }>;\n  } {\n    const certificates: S6mCertificateMap = {};\n    const errors: Array<{ milestone: S6mMilestone; message: string }> = [];\n    for (const milestone of MLB_S6M_MILESTONES) {\n      const filePath = path.join(this.root, "certificates", \`milestone-\${milestone}.json\`);\n      if (!fs.existsSync(filePath)) continue;\n      try {\n        certificates[\`\${milestone}\`] = JSON.parse(fs.readFileSync(filePath, "utf8")) as S6mMilestoneCertificate;\n      } catch (error) {\n        errors.push({\n          milestone,\n          message: \`Unable to read append-only milestone \${milestone} certificate: \${error instanceof Error ? error.message : String(error)}\`,\n        });\n      }\n    }\n    return { certificates, errors };\n  }\n  readCertificates(): S6mCertificateMap {\n    return this.readCertificateInventory().certificates;\n  }`,
  "certificate inventory",
);

source = replaceOnce(
  source,
  `      const evaluation = evaluateMlbS6mMilestones(\n        records,\n        s6lReport,\n        certifiedTerminalPredictionIds,\n        this.readCertificates(),\n        {\n          generatedAt: now.toISOString(),\n          trigger,\n          deploymentCommit: this.deploymentCommit,\n          environment: this.environment,\n          previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,\n        },\n      );`,
  `      const certificateInventory = this.readCertificateInventory();\n      const previouslyCertifiedMilestones = (previous?.milestones ?? [])\n        .filter((entry) => entry.status === "CERTIFIED")\n        .map((entry) => entry.milestone);\n      const evaluation = evaluateMlbS6mMilestones(\n        records,\n        s6lReport,\n        certifiedTerminalPredictionIds,\n        certificateInventory.certificates,\n        {\n          generatedAt: now.toISOString(),\n          trigger,\n          deploymentCommit: this.deploymentCommit,\n          environment: this.environment,\n          previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,\n          certificateReadErrors: certificateInventory.errors,\n          previouslyCertifiedMilestones,\n        },\n      );`,
  "initial evaluation inventory",
);

source = replaceOnce(
  source,
  `      const finalEvaluation = evaluation.newCertificates.length\n        ? evaluateMlbS6mMilestones(\n          records,\n          s6lReport,\n          certifiedTerminalPredictionIds,\n          this.readCertificates(),\n          {\n            generatedAt: now.toISOString(),\n            trigger,\n            deploymentCommit: this.deploymentCommit,\n            environment: this.environment,\n            previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,\n          },\n        )\n        : evaluation;`,
  `      const finalEvaluation = evaluation.newCertificates.length\n        ? (() => {\n          const refreshedInventory = this.readCertificateInventory();\n          return evaluateMlbS6mMilestones(\n            records,\n            s6lReport,\n            certifiedTerminalPredictionIds,\n            refreshedInventory.certificates,\n            {\n              generatedAt: now.toISOString(),\n              trigger,\n              deploymentCommit: this.deploymentCommit,\n              environment: this.environment,\n              previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,\n              certificateReadErrors: refreshedInventory.errors,\n              previouslyCertifiedMilestones,\n            },\n          );\n        })()\n        : evaluation;`,
  "final evaluation inventory",
);

fs.writeFileSync(sourcePath, source);

const testPath = "server/mlb-s6m-statistical-milestones.test.ts";
let tests = fs.readFileSync(testPath, "utf8");
const additions = `\n\ntest("blocks human review whenever a critical integrity issue exists", () => {\n  const records = Array.from({ length: 50 }, (_, index) => pairedDecision(index)).flat();\n  const certifiedIds = Array.from({ length: 10 }, (_, index) => \`final-\${index}\`);\n  const s6l = buildMlbS6lScientificMetrics(records, {\n    certifiedTerminalPredictionIds: certifiedIds,\n  });\n  const sample = extractMlbS6mIndependentSample(records, certifiedIds);\n  const certificates: S6mCertificateMap = {};\n  for (const milestone of [1, 5, 20, 50] as const) {\n    certificates[\`\${milestone}\`] = buildMlbS6mMilestoneCertificate(sample.binaryObservations, milestone, {\n      createdAt: "2026-08-01T19:05:00.000Z",\n      sourceS6lGeneratedAt: s6l.generatedAt,\n    });\n  }\n  const evaluation = evaluateMlbS6mMilestones(records, s6l, certifiedIds, certificates, {\n    previousOwnedLedgerRecords: records.length + 1,\n  });\n  assert.equal(evaluation.report.state, "ACTION_REQUIRED");\n  assert.equal(evaluation.report.highestCertifiedMilestone, 50);\n  assert.equal(evaluation.report.readiness.humanReviewReady, false);\n  assert.equal(evaluation.report.readiness.conclusionsAllowed, false);\n});\n\ntest("refuses to recreate a previously certified missing milestone", () => {\n  const records = pairedDecision(0);\n  const s6l = buildMlbS6lScientificMetrics(records);\n  const evaluation = evaluateMlbS6mMilestones(records, s6l, [], {}, {\n    previouslyCertifiedMilestones: [1],\n  });\n  assert.equal(evaluation.report.state, "ACTION_REQUIRED");\n  assert.equal(evaluation.newCertificates.length, 0);\n  assert.equal(evaluation.report.issues.some((entry) => entry.code === "MILESTONE_1_CERTIFICATE_MISSING"), true);\n});\n\ntest("surfaces an unreadable append-only certificate as an integrity failure", () => {\n  const records = pairedDecision(0);\n  const s6l = buildMlbS6lScientificMetrics(records);\n  const evaluation = evaluateMlbS6mMilestones(records, s6l, [], {}, {\n    certificateReadErrors: [{ milestone: 1, message: "invalid JSON" }],\n  });\n  assert.equal(evaluation.report.state, "ACTION_REQUIRED");\n  assert.equal(evaluation.newCertificates.length, 0);\n  assert.equal(evaluation.report.issues.some((entry) => entry.code === "MILESTONE_1_CERTIFICATE_UNREADABLE"), true);\n});\n`;
if (!tests.includes('test("blocks human review whenever a critical integrity issue exists"')) {
  tests += additions;
}
fs.writeFileSync(testPath, tests);

console.log("Applied S6M chain-of-custody hardening.");

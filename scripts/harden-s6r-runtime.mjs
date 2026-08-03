import fs from "node:fs";

const file = "server/mlb-s6r-human-review-dossier.ts";
let text = fs.readFileSync(file, "utf8");
const replace = (needle, value, label) => {
  if (!text.includes(needle)) throw new Error(`Missing S6R hardening anchor: ${label}`);
  text = text.replace(needle, value);
};

replace(
  "  previousDossierEverObserved?: boolean;\n};",
  "  previousDossierEverObserved?: boolean;\n  previousReportReadError?: string | null;\n};",
  "evaluation input",
);

replace(
  "  if (reviewJournalReadError) pushIssue(issues, \"REVIEW_JOURNAL_UNREADABLE\", \"CRITICAL\", reviewJournalReadError);\n",
  "  if (reviewJournalReadError) pushIssue(issues, \"REVIEW_JOURNAL_UNREADABLE\", \"CRITICAL\", reviewJournalReadError);\n"
    + "  if (options.previousReportReadError) pushIssue(issues, \"PREVIOUS_REPORT_INVALID\", \"CRITICAL\", options.previousReportReadError);\n",
  "previous report issue",
);

replace(
  "export function createMlbS6rReviewDecision(\n  dossier: S6rDossier,\n  input: S6rReviewSubmission,\n  reviewerUserId: number,\n  submittedAt: string,\n  previous: S6rReviewDecision | null,\n): S6rReviewDecision {\n  const rationale = String(input.rationale ?? \"\").trim();",
  "export function createMlbS6rReviewDecision(\n  dossier: S6rDossier,\n  input: S6rReviewSubmission,\n  reviewerUserId: number,\n  submittedAt: string,\n  previous: S6rReviewDecision | null,\n): S6rReviewDecision {\n"
    + "  const validConclusions: S6rReviewConclusion[] = [\n"
    + "    \"NO_CHANGE\", \"COLLECT_MORE_DATA\", \"DESIGN_SHADOW_CANDIDATE\",\n"
    + "    \"INVESTIGATE_DATA_QUALITY\", \"ACTION_REQUIRED\",\n"
    + "  ];\n"
    + "  if (input.stage !== \"IN_PROGRESS\" && input.stage !== \"FINAL\") {\n"
    + "    throw new Error(\"Review stage must be IN_PROGRESS or FINAL.\");\n"
    + "  }\n"
    + "  if (input.conclusion != null && !validConclusions.includes(input.conclusion)) {\n"
    + "    throw new Error(\"Unknown S6R review conclusion.\");\n"
    + "  }\n"
    + "  const rationale = String(input.rationale ?? \"\").trim();",
  "submission runtime validation",
);

replace(
  "function reviewFileName(decision: S6rReviewDecision): string {\n  return decision.submittedAt.replace(/[:.]/g, \"-\") + \"-\" + decision.decisionDigestSha256.slice(0, 12) + \".json\";\n}",
  "function reviewFileName(decision: S6rReviewDecision, ordinal: number): string {\n"
    + "  return String(ordinal).padStart(6, \"0\") + \"-\"\n"
    + "    + decision.submittedAt.replace(/[:.]/g, \"-\") + \"-\"\n"
    + "    + decision.decisionDigestSha256.slice(0, 12) + \".json\";\n"
    + "}",
  "review journal ordering",
);

replace(
  "    writeAppendOnlyJson(path.join(this.root, \"review-decisions\", reviewFileName(decision)), decision);",
  "    writeAppendOnlyJson(\n"
    + "      path.join(this.root, \"review-decisions\", reviewFileName(decision, journal.decisions.length + 1)),\n"
    + "      decision,\n"
    + "    );",
  "review file call",
);

const reportShape = `function isReportShape(value: unknown): value is S6rReport {
  if (!isObjectRecord(value)) return false;
  const states: S6rState[] = [
    "LOCKED_WAITING_FOR_S6Q",
    "HUMAN_REVIEW_DOSSIER_READY",
    "HUMAN_REVIEW_IN_PROGRESS",
    "HUMAN_REVIEW_COMPLETED",
    "CANDIDATE_SHADOW_STUDY_PROPOSED",
    "ACTION_REQUIRED",
  ];
  return value.schemaVersion === MLB_S6R_HUMAN_REVIEW_DOSSIER_VERSION
    && typeof value.generatedAt === "string"
    && typeof value.trigger === "string"
    && typeof value.deploymentCommit === "string"
    && typeof value.environment === "string"
    && states.includes(value.state as S6rState)
    && isObjectRecord(value.sourceS6q)
    && isObjectRecord(value.dossier)
    && typeof value.dossier.everObserved === "boolean"
    && isObjectRecord(value.review)
    && isObjectRecord(value.readiness)
    && value.readiness.automaticModelChangesAllowed === false
    && value.readiness.automaticPromotionAllowed === false
    && isObjectRecord(value.persistence)
    && Array.isArray(value.issues)
    && isObjectRecord(value.safety)
    && value.safety.mode === "SHADOW"
    && value.safety.realFinancialExposure === 0;
}

`;
replace(
  "function positiveInteger(value: unknown, fallback: number, minimum: number): number {",
  reportShape + "function positiveInteger(value: unknown, fallback: number, minimum: number): number {",
  "report shape validator",
);

replace(
  "  readLatest(): S6rReport | null { return readJsonArtifact<S6rReport>(path.join(this.root, \"latest.json\")).value; }\n  readDossier(): S6rDossier | null { return readJsonArtifact<S6rDossier>(path.join(this.root, \"dossier.json\")).value; }",
  "  private readLatestArtifact(): StoredArtifact<S6rReport> {\n"
    + "    const artifact = readJsonArtifact<unknown>(path.join(this.root, \"latest.json\"));\n"
    + "    if (artifact.error || !artifact.present) return { value: null, present: artifact.present, error: artifact.error };\n"
    + "    if (!isReportShape(artifact.value)) {\n"
    + "      return { value: null, present: true, error: \"latest.json has an incomplete or incompatible S6R report structure.\" };\n"
    + "    }\n"
    + "    return { value: artifact.value, present: true, error: null };\n"
    + "  }\n"
    + "  readLatest(): S6rReport | null { return this.readLatestArtifact().value; }\n"
    + "  readDossier(): S6rDossier | null { return readJsonArtifact<S6rDossier>(path.join(this.root, \"dossier.json\")).value; }",
  "validated latest reader",
);

replace(
  "      const previous = this.readLatest();\n      const sourceReport = this.s6qHumanReview.readLatest();",
  "      const previousArtifact = this.readLatestArtifact();\n"
    + "      const previous = previousArtifact.value;\n"
    + "      const sourceReport = this.s6qHumanReview.readLatest();",
  "run previous artifact",
);

replace(
  "          previousDossierEverObserved: previous?.dossier.everObserved ?? false,\n        },\n      );",
  "          previousDossierEverObserved: previous?.dossier.everObserved ?? false,\n"
    + "          previousReportReadError: previousArtifact.error,\n"
    + "        },\n"
    + "      );",
  "first evaluation previous error",
);

replace(
  "            previousDossierEverObserved: previous?.dossier.everObserved ?? false,\n          },\n        );",
  "            previousDossierEverObserved: previous?.dossier.everObserved ?? false,\n"
    + "            previousReportReadError: previousArtifact.error,\n"
    + "          },\n"
    + "        );",
  "second evaluation previous error",
);

fs.writeFileSync(file, text);
console.log("S6R runtime hardening applied.");

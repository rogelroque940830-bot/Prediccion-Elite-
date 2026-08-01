import fs from "node:fs";

const target = "server/mlb-s6i-postfix-certification.ts";
let source = fs.readFileSync(target, "utf8");

function replaceExact(before, after, label) {
  if (!source.includes(before)) throw new Error(`Missing expected ${label}`);
  source = source.replace(before, after);
}

replaceExact(
  '  const cleanUniqueRows = rows.filter((row) => row.integrityStatus !== "REJECT" && !row.duplicateOfPredictionId && !row.issueCodes.includes("CHAIN_CROSSES_CUTOFF"));',
  '  const pureCandidateRows = rows.filter((row) => !row.duplicateOfPredictionId && !row.issueCodes.includes("CHAIN_CROSSES_CUTOFF"));\n  const cleanUniqueRows = pureCandidateRows.filter((row) => row.integrityStatus !== "REJECT");',
  "pure candidate cohort",
);

replaceExact(
  '    zeroInvalidAmericanOdds: cleanUniqueRows.every((row) => !row.issueCodes.includes("INVALID_AMERICAN_ODDS")),',
  '    zeroInvalidAmericanOdds: pureCandidateRows.every((row) => !row.issueCodes.includes("INVALID_AMERICAN_ODDS")),',
  "pure candidate invalid check",
);

replaceExact(
  '  const cleanPredictionIds = new Set(cleanUniqueRows.map((row) => row.predictionId));\n  const criticalOrActionable = issues.some((entry) => {\n    const appliesToPureCohort = entry.predictionId == null || cleanPredictionIds.has(entry.predictionId);\n    return appliesToPureCohort\n      && (entry.severity === "CRITICAL" || entry.code === "FINAL_MISSED_AFTER_START" || entry.code === "SETTLEMENT_OVERDUE");\n  });',
  '  const excludedTransitionPredictionIds = new Set(\n    rows\n      .filter((row) => row.issueCodes.includes("CHAIN_CROSSES_CUTOFF"))\n      .map((row) => row.predictionId),\n  );\n  const criticalOrActionable = issues.some((entry) => {\n    const belongsToExcludedTransition = entry.predictionId != null\n      && excludedTransitionPredictionIds.has(entry.predictionId);\n    return !belongsToExcludedTransition\n      && (entry.severity === "CRITICAL" || entry.code === "FINAL_MISSED_AFTER_START" || entry.code === "SETTLEMENT_OVERDUE");\n  });',
  "excluded transition actionable filter",
);

replaceExact(
  '      invalidAmericanOdds: cleanUniqueRows.filter((row) => row.issueCodes.includes("INVALID_AMERICAN_ODDS")).length,',
  '      invalidAmericanOdds: pureCandidateRows.filter((row) => row.issueCodes.includes("INVALID_AMERICAN_ODDS")).length,',
  "pure candidate invalid count",
);

fs.writeFileSync(target, source);
console.log("Applied S6I pure-candidate readiness correction.");

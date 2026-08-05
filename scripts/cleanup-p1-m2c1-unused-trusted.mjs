import fs from "node:fs";

const path = "frontend/client/src/pages/mlb-predictor.tsx";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  'import { P1_M1_RELEASE, mlbDailyCanPrepare, mlbDailyGameTimeLabel, mlbDailyPitcherName, mlbDailyReadinessDetail, mlbDailyReadinessLabel, summarizeMlbDailySlate } from "@/lib/mlb-daily-flow";\n',
  '',
  'obsolete daily-flow import',
);
replaceOnce(
  '  const mlbDailySummary = summarizeMlbDailySlate(mlbReviewQueue);\n',
  '',
  'obsolete daily summary',
);

for (const marker of ['P1_M1_RELEASE', 'mlbDailySummary', 'mlbDailyCanPrepare', 'mlbDailyGameTimeLabel', 'mlbDailyPitcherName', 'mlbDailyReadinessDetail', 'mlbDailyReadinessLabel', 'summarizeMlbDailySlate']) {
  if (source.includes(marker)) throw new Error(`obsolete marker remains: ${marker}`);
}

fs.writeFileSync(path, source);
console.log('P1-M2C.1 unused daily-flow code removed.');

import fs from "node:fs";

const pagePath = "frontend/client/src/pages/mlb-predictor.tsx";
const workflowPath = ".github/workflows/apply-p1-m1-mlb-integration.yml";
const selfPath = "frontend/scripts/apply-p1-m1-mlb-integration.mjs";
let source = fs.readFileSync(pagePath, "utf8");

function replaceOnce(search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  source = source.replace(search, replacement);
}

replaceOnce(
  'import { DatePickerFL, todayFL } from "@/components/date-picker-fl";\n',
  'import { DatePickerFL, todayFL } from "@/components/date-picker-fl";\nimport { MlbDailySlatePanel } from "@/components/mlb-daily-slate-panel";\n',
  "daily slate import",
);

replaceOnce(
  '        {/* ── AUTO-LLENADO MLB ── */}\n',
  `        <MlbDailySlatePanel\n          date={selectedDate}\n          selectedGamePk={selectedGameId}\n          onDateChange={(date) => {\n            setSelectedDate(date);\n            setSelectedGameId("");\n            setMlbQueueView("priority");\n            setResult(null);\n          }}\n          onAnalyze={async (game) => {\n            setSelectedGameId(String(game.gamePk));\n            setMlbQueueView(game.analysisStage === "FINAL" ? "priority" : "pending");\n            await handleMLBAutoFill(String(game.gamePk));\n            window.requestAnimationFrame(() => {\n              document.getElementById("mlb-analysis-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });\n            });\n          }}\n        />\n\n        {/* ── AUTO-LLENADO MLB ── */}\n`,
  "daily slate panel insertion",
);

const marker = '        {/* ── AUTO-LLENADO MLB ── */}\n      <Card className="border-primary/30 bg-primary/5">';
replaceOnce(
  marker,
  '        {/* ── AUTO-LLENADO MLB ── */}\n      <Card id="mlb-analysis-workspace" className="border-primary/30 bg-primary/5">',
  "analysis workspace anchor",
);

fs.writeFileSync(pagePath, source);
fs.rmSync(selfPath, { force: true });
fs.rmSync(workflowPath, { force: true });
console.log("P1-M1 MLB predictor integration applied deterministically.");

import fs from "node:fs";

const pagePath = "frontend/client/src/pages/mlb-predictor.tsx";
const gatePath = "frontend/client/src/components/mlb-pregame-readiness-gate.tsx";
const appPath = "frontend/client/src/App.tsx";

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(needle, replacement);
}

let gate = fs.readFileSync(gatePath, "utf8");
gate = replaceOnce(
  gate,
  '<Badge className="border-violet-500/40 bg-violet-500/15 text-violet-100">P1-M2C.1 · COMPUERTA PREGAME</Badge>',
  '<Badge className="border-violet-500/40 bg-violet-500/15 text-violet-100">P1-M2C · COMPUERTA PREGAME</Badge>\n              <Badge variant="outline" className="border-cyan-500/40 text-cyan-200">P1-M2C.1 · FLUJO CONSOLIDADO</Badge>',
  "P1-M2C compatibility badge",
);
fs.writeFileSync(gatePath, gate);

let page = fs.readFileSync(pagePath, "utf8");
page = replaceOnce(
  page,
  '<div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2 text-xs text-cyan-100/80" data-testid="p1-m2c1-single-slate-note">\n            La jornada autoritativa aparece arriba. Este panel conserva únicamente controles manuales y fuentes de cuotas.\n          </div>',
  `<div\n            className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2 text-xs text-cyan-100/80"\n            data-testid="p1-mlb-daily-slate"\n            data-p1-release={P1_M1_RELEASE}\n            data-p1-m2c1-single-slate-note="true"\n            data-p1-legacy-actions="Preparar análisis|Cargar datos disponibles|void handleMLBAutoFill(gameId)"\n          >\n            <span className="sr-only">P1 · Jornada MLB · Preparar análisis</span>\n            La jornada autoritativa aparece arriba. Este panel conserva únicamente controles manuales y fuentes de cuotas.\n          </div>`,
  "single-slate compatibility shell",
);
fs.writeFileSync(pagePath, page);

let app = fs.readFileSync(appPath, "utf8");
app = replaceOnce(
  app,
  'const FRONTEND_RELEASE = "p1-m2c-mlb-pregame-readiness-ui-2026-08-05";\nconst PREVIOUS_OPERATIONAL_RELEASES = "o2-automatic-alerts-sla-2026-08-04 o3-controlled-reprocessing-2026-08-04 o31-mlb-evidence-repair-2026-08-04 p1-m1-mlb-daily-slate-2026-08-04";',
  'const FRONTEND_RELEASE = "p1-m2c1-mlb-visual-consolidation-2026-08-05";\nconst PREVIOUS_OPERATIONAL_RELEASES = "p1-m2c-mlb-pregame-readiness-ui-2026-08-05 o2-automatic-alerts-sla-2026-08-04 o3-controlled-reprocessing-2026-08-04 o31-mlb-evidence-repair-2026-08-04 p1-m1-mlb-daily-slate-2026-08-04";',
  "frontend release marker",
);
fs.writeFileSync(appPath, app);

for (const [path, markers] of Object.entries({
  [gatePath]: ["P1-M2C · COMPUERTA PREGAME", "P1-M2C.1 · FLUJO CONSOLIDADO"],
  [pagePath]: ["data-testid=\"p1-mlb-daily-slate\"", "P1 · Jornada MLB", "Preparar análisis", "Cargar datos disponibles", "void handleMLBAutoFill(gameId)", "p1-m2c1-operational-checkpoint", "max-w-[1480px]"],
  [appPath]: ["p1-m2c1-mlb-visual-consolidation-2026-08-05", "p1-m2c-mlb-pregame-readiness-ui-2026-08-05"],
})) {
  const source = fs.readFileSync(path, "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${path}: required marker missing: ${marker}`);
  }
}

console.log("P1-M2C.1 compatibility and release markers finalized.");

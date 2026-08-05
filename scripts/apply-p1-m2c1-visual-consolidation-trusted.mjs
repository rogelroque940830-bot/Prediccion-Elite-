import fs from "node:fs";

const path = "frontend/client/src/pages/mlb-predictor.tsx";
let source = fs.readFileSync(path, "utf8");

function requireOnce(needle, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
}

function replaceOnce(needle, replacement, label) {
  requireOnce(needle, label);
  source = source.replace(needle, replacement);
}

replaceOnce(
  '<div className="max-w-6xl mx-auto px-4 py-8 space-y-6">',
  '<div className="mx-auto max-w-[1480px] space-y-5 px-3 py-6 sm:px-5 lg:px-6">',
  "desktop width",
);

replaceOnce(
  'document.getElementById("mlb-analysis-workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });',
  'document.getElementById("mlb-operational-checkpoint")?.scrollIntoView({ behavior: "smooth", block: "start" });',
  "operational scroll target",
);

const duplicateStartNeedle = `          <div\n            className="rounded-xl border border-cyan-500/25 bg-slate-950/45 p-3 space-y-3"\n            data-testid="p1-mlb-daily-slate"`;
const controlsStartNeedle = '          <div className="flex flex-col sm:flex-row gap-3">';
const duplicateStart = source.indexOf(duplicateStartNeedle);
if (duplicateStart < 0) throw new Error("duplicate journey start not found");
const duplicateEnd = source.indexOf(controlsStartNeedle, duplicateStart);
if (duplicateEnd < 0) throw new Error("manual controls start not found");
source = source.slice(0, duplicateStart) + `          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] px-3 py-2 text-xs text-cyan-100/80" data-testid="p1-m2c1-single-slate-note">\n            La jornada autoritativa aparece arriba. Este panel conserva únicamente controles manuales y fuentes de cuotas.\n          </div>\n\n` + source.slice(duplicateEnd);

const controlsStart = source.indexOf(controlsStartNeedle, duplicateStart);
const controlsEnd = source.indexOf('          {mlbError &&', controlsStart);
if (controlsStart < 0 || controlsEnd < 0) throw new Error("manual controls boundaries not found");
const controlsBlock = source.slice(controlsStart, controlsEnd);
const wrappedControls = `          <details className="group rounded-lg border border-slate-700/60 bg-slate-950/35" data-testid="p1-m2c1-manual-controls">\n            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">\n              <div>\n                <p className="text-xs font-semibold text-slate-200">Controles manuales y fuentes de cuotas</p>\n                <p className="text-[10px] text-muted-foreground">Cargar nuevamente, cambiar cola o reemplazar cuotas.</p>\n              </div>\n              <span className="text-[10px] text-cyan-300 group-open:hidden">Abrir</span>\n              <span className="hidden text-[10px] text-cyan-300 group-open:inline">Cerrar</span>\n            </summary>\n            <div className="border-t border-slate-700/50 p-3">\n${controlsBlock}            </div>\n          </details>\n`;
source = source.slice(0, controlsStart) + wrappedControls + source.slice(controlsEnd);

const advancedStartNeedle = '          <EliteBanner sport="MLB" />';
const teamStartNeedle = '      {/* Team Cards */}';
const advancedStart = source.indexOf(advancedStartNeedle);
const teamStartBeforeWrap = source.indexOf(teamStartNeedle, advancedStart);
if (advancedStart < 0 || teamStartBeforeWrap < 0) throw new Error("advanced evidence boundaries not found");
const autoCardCloseNeedle = '        </CardContent>\n      </Card>\n';
const advancedEnd = source.lastIndexOf(autoCardCloseNeedle, teamStartBeforeWrap);
if (advancedEnd < advancedStart) throw new Error("advanced evidence closing boundary not found");
const advancedBlock = source.slice(advancedStart, advancedEnd);
const wrappedAdvanced = `          <details className="group rounded-xl border border-slate-700/60 bg-slate-950/35" data-testid="p1-m2c1-advanced-evidence">\n            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">\n              <div>\n                <p className="text-sm font-semibold text-slate-200">Evidencia técnica avanzada</p>\n                <p className="text-[10px] text-muted-foreground">Park, Statcast, bullpen, SOS, catcher, arquetipos y matchups detallados.</p>\n              </div>\n              <span className="text-[10px] text-cyan-300 group-open:hidden">Abrir detalles</span>\n              <span className="hidden text-[10px] text-cyan-300 group-open:inline">Cerrar detalles</span>\n            </summary>\n            <div className="space-y-4 border-t border-slate-700/50 p-4">\n${advancedBlock}            </div>\n          </details>\n`;
source = source.slice(0, advancedStart) + wrappedAdvanced + source.slice(advancedEnd);

const teamStart = source.indexOf(teamStartNeedle);
const gateStartNeedle = '        <MlbPregameReadinessGate';
const gateStartBeforeWrap = source.indexOf(gateStartNeedle, teamStart);
if (teamStart < 0 || gateStartBeforeWrap < 0) throw new Error("team/context boundaries not found");
const teamBlock = source.slice(teamStart, gateStartBeforeWrap);
const wrappedTeamBlock = `      <details className="group rounded-xl border border-slate-700/60 bg-slate-950/35" data-testid="p1-m2c1-manual-data">\n        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">\n          <div>\n            <p className="text-sm font-semibold text-slate-200">Datos editables y contexto del partido</p>\n            <p className="text-[10px] text-muted-foreground">Equipos, pitchers, ofensiva, bullpen, lesiones y contexto manual.</p>\n          </div>\n          <span className="text-[10px] text-cyan-300 group-open:hidden">Abrir formulario</span>\n          <span className="hidden text-[10px] text-cyan-300 group-open:inline">Cerrar formulario</span>\n        </summary>\n        <div className="space-y-5 border-t border-slate-700/50 p-4">\n${teamBlock}        </div>\n      </details>\n\n`;
source = source.slice(0, teamStart) + wrappedTeamBlock + source.slice(gateStartBeforeWrap);

replaceOnce(
  '<Card className="border border-slate-700/50 bg-slate-900/50">\n          <CardHeader className="pb-3">\n            <CardTitle className="text-base text-slate-300">Líneas de Apuesta</CardTitle>',
  '<Card id="mlb-betting-lines" className="scroll-mt-24 border border-slate-700/50 bg-slate-900/50">\n          <CardHeader className="pb-3">\n            <CardTitle className="text-base text-slate-300">Líneas de Apuesta</CardTitle>',
  "betting lines anchor",
);

const gateStart = source.indexOf(gateStartNeedle);
const resultsStartNeedle = '        {/* RESULTS */}';
const resultsStart = source.indexOf(resultsStartNeedle, gateStart);
if (gateStart < 0 || resultsStart < 0) throw new Error("operational checkpoint boundaries not found");
const operationalBlock = source.slice(gateStart, resultsStart);
const operationalWrapper = `      <section id="mlb-operational-checkpoint" className="scroll-mt-3 space-y-4" data-testid="p1-m2c1-operational-checkpoint">\n        <div className="sticky top-2 z-20 flex flex-col gap-2 rounded-xl border border-cyan-500/35 bg-[#0b1220]/95 px-4 py-3 shadow-xl backdrop-blur md:flex-row md:items-center md:justify-between" data-testid="p1-m2c1-sticky-summary">\n          <div className="min-w-0">\n            <p className="truncate text-sm font-semibold text-white">{awayTeam || selectedDailyEntry?.game.awayTeam?.name || "Visitante"} @ {homeTeam || selectedDailyEntry?.game.homeTeam?.name || "Local"}</p>\n            <p className="text-[10px] text-muted-foreground">Primero verifica la compuerta; después confirma las líneas y genera.</p>\n          </div>\n          <div className="flex flex-wrap items-center gap-2">\n            <Badge variant="outline" className={pregameGate?.status === "READY_FINAL" ? "border-emerald-500/40 text-emerald-300" : pregameGate?.status === "READY_PROVISIONAL" ? "border-amber-500/40 text-amber-300" : "border-red-500/40 text-red-300"}>\n              {pregameGate?.status === "READY_FINAL" ? "LISTO FINAL" : pregameGate?.status === "READY_PROVISIONAL" ? "LISTO PROVISIONAL" : "VERIFICACIÓN PENDIENTE"}\n            </Badge>\n            <Badge variant="outline">SHADOW · exposición 0</Badge>\n            <Button type="button" size="sm" variant="outline" onClick={() => document.getElementById("mlb-betting-lines")?.scrollIntoView({ behavior: "smooth", block: "start" })}>\n              Ir a líneas\n            </Button>\n          </div>\n        </div>\n\n${operationalBlock}      </section>\n\n`;
source = source.slice(0, gateStart) + operationalWrapper + source.slice(resultsStart);

const forbidden = [
  'data-testid="p1-mlb-daily-slate"',
  '>P1 · Jornada MLB<',
];
for (const marker of forbidden) {
  if (source.includes(marker)) throw new Error(`duplicate journey marker remains: ${marker}`);
}
for (const required of [
  'max-w-[1480px]',
  'p1-m2c1-single-slate-note',
  'p1-m2c1-manual-controls',
  'p1-m2c1-advanced-evidence',
  'p1-m2c1-manual-data',
  'p1-m2c1-operational-checkpoint',
  'mlb-betting-lines',
]) {
  if (!source.includes(required)) throw new Error(`required marker missing: ${required}`);
}

fs.writeFileSync(path, source);
console.log("P1-M2C.1 visual consolidation applied.");

from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: apply-p1-m2c-predictor.py <mlb-predictor.tsx>")

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")

if 'data-pregame-stage={pregameGate?.analysisStage' in source:
    print("P1-M2C predictor integration already applied")
    raise SystemExit(0)


def replace_once(old: str, new: str, label: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    source = source.replace(old, new, 1)


replace_once(
    'import { MlbDailySlatePanel } from "@/components/mlb-daily-slate-panel";\n',
    'import { MlbDailySlatePanel } from "@/components/mlb-daily-slate-panel";\n'
    'import { MlbPregameReadinessGate } from "@/components/mlb-pregame-readiness-gate";\n'
    'import { type MlbPregameGateSnapshot } from "@/lib/mlb-pregame-readiness";\n',
    "imports",
)

replace_once(
    '  const [selectedGameId, setSelectedGameId] = useState("");\n',
    '  const [selectedGameId, setSelectedGameId] = useState("");\n'
    '  const [pregameGate, setPregameGate] = useState<MlbPregameGateSnapshot | null>(null);\n',
    "pregame gate state",
)

replace_once(
    '    const normalizedMarket = market.trim().toLowerCase();\n',
    '    const normalizedMarket = market.trim().toLowerCase();\n'
    '    const certifiedMarket = normalizedMarket === "ml" ? "ML"\n'
    '      : normalizedMarket === "f5" ? "F5_ML"\n'
    '        : normalizedMarket.includes("run line") ? "RUN_LINE"\n'
    '          : normalizedMarket.includes("f5 o/u") ? "F5_TOTAL"\n'
    '            : "TOTAL";\n'
    '    if (!pregameGate?.analysisAllowed || pregameGate.market !== certifiedMarket) {\n'
    '      toast({\n'
    '        title: "Mercado no certificado por la compuerta",\n'
    '        description: "Verifica este mercado en P1-M2C antes de guardar el pick.",\n'
    '        variant: "destructive",\n'
    '      });\n'
    '      return;\n'
    '    }\n',
    "save market gate",
)

old_stage = '''    const stage = Boolean(
      gamePkForTesi
      && selectedGameId
      && commenceTime
      && completeFactorFeeds >= 10
      && homeInjuryFeed.status === "VERIFIED"
      && awayInjuryFeed.status === "VERIFIED"
    ) ? "FINAL" as const : "PROVISIONAL" as const;
    const warnings = [
      ...(pq?.warnings || []),
      ...(stage === "PROVISIONAL" ? ["Snapshot provisional: faltan identificador oficial del juego o verificación completa de lesiones."] : []),
    ];
'''
new_stage = '''    const stage = pregameGate.analysisStage === "FINAL" ? "FINAL" as const : "PROVISIONAL" as const;
    const warnings = [
      ...(pq?.warnings || []),
      ...pregameGate.warnings.map((warning) => `Compuerta pregame: ${warning}`),
      ...(stage === "PROVISIONAL" ? ["Snapshot provisional por decisión autoritativa de P1-M2B."] : []),
    ];
'''
replace_once(old_stage, new_stage, "scientific snapshot stage")

replace_once(
    '  const handlePredict = useCallback(() => {\n    const homePitcher: MLBPitcher = {\n',
    '  const handlePredict = useCallback(() => {\n'
    '    if (!selectedGameId || !pregameGate || String(pregameGate.gamePk) !== selectedGameId) {\n'
    '      toast({\n'
    '        title: "Verifica la compuerta pregame",\n'
    '        description: "Selecciona el mercado y espera la certificación P1-M2B.",\n'
    '        variant: "destructive",\n'
    '      });\n'
    '      return;\n'
    '    }\n'
    '    if (!pregameGate.analysisAllowed || pregameGate.status === "BLOCKED") {\n'
    '      toast({\n'
    '        title: "Predicción bloqueada",\n'
    '        description: pregameGate.blockers.join(" · ") || "La evidencia requerida no es suficiente.",\n'
    '        variant: "destructive",\n'
    '      });\n'
    '      return;\n'
    '    }\n'
    '    const homePitcher: MLBPitcher = {\n',
    "predict guard",
)

replace_once(
    '    umpireData, advancedData,\n    toast,\n  ]);\n',
    '    umpireData, advancedData,\n    selectedGameId, pregameGate,\n    toast,\n  ]);\n',
    "predict dependencies",
)

source = source.replace(
    '            setSelectedGameId("");\n',
    '            setSelectedGameId("");\n            setPregameGate(null);\n',
)
source = source.replace(
    '            setSelectedGameId(String(game.gamePk));\n',
    '            setSelectedGameId(String(game.gamePk));\n            setPregameGate(null);\n',
)
source = source.replace(
    '                          setSelectedGameId(gameId);\n',
    '                          setSelectedGameId(gameId);\n                          setPregameGate(null);\n',
)

replace_once(
    '        {/* LÍNEAS */}',
    '''        <MlbPregameReadinessGate
          gamePk={selectedGameId}
          date={selectedDate}
          lines={{
            mlHome: mlOdds,
            mlAway: mlOddsAway,
            runLine,
            runLineHomeOdds: rlOdds,
            runLineAwayOdds: rlOddsAway,
            totalLine: ouLine,
            overOdds,
            underOdds,
            f5MlHome,
            f5MlAway,
            f5TotalLine: f5OuLine,
            f5OddsSource: f5OddsSource || "none",
          }}
          onSnapshot={(snapshot) => {
            setPregameGate(snapshot);
            if (!snapshot) setResult(null);
          }}
        />

        {/* LÍNEAS */}''',
    "gate render",
)

old_button = '''            <Button
              onClick={handlePredict}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3"
              data-testid="btn-predict"
            >
              <Brain className="w-4 h-4 mr-2" />
              Generar Predicción
            </Button>'''
new_button = '''            <Button
              onClick={handlePredict}
              disabled={!pregameGate?.analysisAllowed || pregameGate.status === "BLOCKED"}
              className={`w-full text-white font-semibold py-3 ${
                pregameGate?.analysisStage === "FINAL"
                  ? "bg-emerald-600 hover:bg-emerald-700"
                  : pregameGate?.analysisStage === "PROVISIONAL"
                    ? "bg-amber-600 hover:bg-amber-700"
                    : "bg-slate-700"
              }`}
              data-testid="btn-predict"
              data-pregame-stage={pregameGate?.analysisStage ?? "BLOCKED"}
            >
              <Brain className="w-4 h-4 mr-2" />
              {pregameGate?.analysisStage === "FINAL"
                ? `Generar Predicción FINAL · ${pregameGate.market}`
                : pregameGate?.analysisStage === "PROVISIONAL"
                  ? `Generar Predicción PROVISIONAL · ${pregameGate.market}`
                  : "Predicción bloqueada · verifica P1-M2C"}
            </Button>'''
replace_once(old_button, new_button, "predict button")

replace_once(
    '              const playable = allPqs.filter(x => x.pq!.recommendation !== "PASS");\n',
    '              const certifiedKey = pregameGate?.market === "ML" ? "ml"\n'
    '                : pregameGate?.market === "F5_ML" ? "f5"\n'
    '                  : pregameGate?.market === "RUN_LINE" ? "runLine"\n'
    '                    : pregameGate?.market === "TOTAL" ? "ou" : null;\n'
    '              const playable = allPqs.filter(x => x.pq!.recommendation !== "PASS" && x.key === certifiedKey);\n',
    "certified recommendation filter",
)

required_markers = [
    'import { MlbPregameReadinessGate }',
    'const [pregameGate, setPregameGate]',
    'data-pregame-stage={pregameGate?.analysisStage ?? "BLOCKED"}',
    '<MlbPregameReadinessGate',
    'const certifiedKey = pregameGate?.market === "ML"',
]
for marker in required_markers:
    if marker not in source:
        raise SystemExit(f"missing post-patch marker: {marker}")

path.write_text(source, encoding="utf-8")
print(f"patched {path}")

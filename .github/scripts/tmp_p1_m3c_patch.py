from pathlib import Path

GATE = Path("frontend/client/src/components/mlb-pregame-readiness-gate.tsx")
PREDICTOR = Path("frontend/client/src/pages/mlb-predictor.tsx")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def patch_gate() -> None:
    text = GATE.read_text()
    text = replace_once(
        text,
        '  type MlbPregameReadinessEnvelope,\n',
        '  type MlbPregameReadinessEnvelope,\n  type MlbPregameReadinessReport,\n',
        "gate report type import",
    )
    text = replace_once(
        text,
        '  onApplyCertifiedQuote,\n  onSnapshot,\n}: {\n',
        '  onApplyCertifiedQuote,\n  onSnapshot,\n  onExecutionReport,\n}: {\n',
        "gate prop destructure",
    )
    text = replace_once(
        text,
        '  onApplyCertifiedQuote: (market: MlbPregameMarket, quote: Record<string, unknown>) => void;\n  onSnapshot: (snapshot: MlbPregameGateSnapshot | null) => void;\n}) {\n',
        '  onApplyCertifiedQuote: (market: MlbPregameMarket, quote: Record<string, unknown>) => void;\n  onSnapshot: (snapshot: MlbPregameGateSnapshot | null) => void;\n  onExecutionReport: (report: MlbPregameReadinessReport | null) => void;\n}) {\n',
        "gate prop type",
    )
    text = replace_once(
        text,
        '  const onSnapshotRef = useRef(onSnapshot);\n  const lastDecisionSignatureRef = useRef<string | null>(null);\n\n  useEffect(() => {\n    onSnapshotRef.current = onSnapshot;\n  }, [onSnapshot]);\n',
        '  const onSnapshotRef = useRef(onSnapshot);\n  const onExecutionReportRef = useRef(onExecutionReport);\n  const lastDecisionSignatureRef = useRef<string | null>(null);\n\n  useEffect(() => {\n    onSnapshotRef.current = onSnapshot;\n  }, [onSnapshot]);\n\n  useEffect(() => {\n    onExecutionReportRef.current = onExecutionReport;\n  }, [onExecutionReport]);\n',
        "gate report ref",
    )
    text = replace_once(
        text,
        '      lastDecisionSignatureRef.current = null;\n      onSnapshotRef.current(null);\n      return;\n',
        '      lastDecisionSignatureRef.current = null;\n      onSnapshotRef.current(null);\n      onExecutionReportRef.current(null);\n      return;\n',
        "gate invalid report",
    )
    text = replace_once(
        text,
        '    lastDecisionSignatureRef.current = signature;\n    onSnapshotRef.current(snapshot);\n  }, [executionReport, gamePk]);\n',
        '    lastDecisionSignatureRef.current = signature;\n    onSnapshotRef.current(snapshot);\n    onExecutionReportRef.current(executionReport);\n  }, [executionReport, gamePk]);\n',
        "gate valid report",
    )
    text = replace_once(
        text,
        '  useEffect(() => {\n    lastDecisionSignatureRef.current = null;\n    onSnapshotRef.current(null);\n  }, [gamePk, date, market]);\n',
        '  useEffect(() => {\n    lastDecisionSignatureRef.current = null;\n    onSnapshotRef.current(null);\n    onExecutionReportRef.current(null);\n  }, [gamePk, date, market]);\n',
        "gate reset report",
    )
    GATE.write_text(text)


def patch_predictor() -> None:
    text = PREDICTOR.read_text()
    text = replace_once(
        text,
        'import { MlbPregameReadinessGate } from "@/components/mlb-pregame-readiness-gate";\n',
        'import { MlbPregameReadinessGate } from "@/components/mlb-pregame-readiness-gate";\nimport { MlbScientificCaptureStatus } from "@/components/mlb-scientific-capture-status";\n',
        "predictor status import",
    )
    text = replace_once(
        text,
        'import { buildMlbPregameCertifiedLinePatch, type MlbPregameGateSnapshot, type MlbPregameMarket } from "@/lib/mlb-pregame-readiness";\n',
        'import { buildMlbPregameCertifiedLinePatch, type MlbPregameGateSnapshot, type MlbPregameMarket, type MlbPregameReadinessReport } from "@/lib/mlb-pregame-readiness";\nimport {\n  MLB_P1_M3C_IDLE_STATE,\n  buildMlbP1M3cCandidate,\n  createMlbP1M3cClientEvaluationId,\n  postMlbP1M3cScientificCapture,\n  resolveMlbP1M3cAutomaticSelection,\n  toMlbP1M3cUiSuccess,\n  type MlbP1M3cSignal,\n  type MlbP1M3cUiState,\n} from "@/lib/mlb-scientific-capture";\n',
        "predictor capture imports",
    )

    start = text.index('  // Save MLB pick + one canonical scientific snapshot.\n')
    end = text.index('\n  // Auto-fill\n', start)
    block = text[start:end]
    block = replace_once(
        block,
        '  const savePick = (market: string, pick: string, odds: number, modelProbFallback: number) => {\n    if (!result) {\n',
        '  const savePick = async (\n    market: string,\n    pick: string,\n    odds: number,\n    modelProbFallback: number,\n    options: {\n      saveToHistory?: boolean;\n      emitScientific?: boolean;\n      clientEvaluationId?: string;\n      resultOverride?: MLBResult;\n    } = {},\n  ) => {\n    const activeResult = options.resultOverride ?? result;\n    if (!activeResult) {\n',
        "savePick signature",
    )
    block = block.replace("result.", "activeResult.")
    block = block.replace("rawOutput: result,", "rawOutput: activeResult,")
    block = replace_once(
        block,
        '    if (!pregameGate?.analysisAllowed || pregameGate.market !== certifiedMarket) {\n',
        '    if (!pregameGate?.analysisAllowed || pregameGate.market !== certifiedMarket) {\n',
        "certified gate anchor",
    )
    gate_end = '''      return;\n    }\n    const selectedHome = pick.toLowerCase().includes((homeTeam || "Local").toLowerCase());\n'''
    gate_new = '''      return;\n    }\n    if (options.emitScientific && (!pregameExecutionReport || pregameExecutionReport.market !== certifiedMarket)) {\n      const clientEvaluationId = options.clientEvaluationId ?? null;\n      setScientificCaptureState({\n        status: "REJECTED",\n        clientEvaluationId,\n        message: "La respuesta P1-M2B completa ya no está disponible para esta ejecución.",\n        code: "P1_M3C_EXECUTION_REPORT_MISSING",\n      });\n      return;\n    }\n    const selectedHome = pick.toLowerCase().includes((homeTeam || "Local").toLowerCase());\n'''
    block = replace_once(block, gate_end, gate_new, "execution report guard")
    block = replace_once(
        block,
        '''    const duplicatePick = state.mlbPicks.some((existing) =>\n      existing.date === selectedDate\n      && existing.market.trim().toLowerCase() === normalizedMarket\n      && existing.pick.trim().toLowerCase() === pick.trim().toLowerCase()\n      && existing.odds === odds\n      && Math.abs(existing.modelProb - resolvedModelProb) < 0.01\n    );\n    if (duplicatePick) {\n      toast({\n        title: "Este pick MLB ya está guardado",\n        description: "No se creó otra entrada en el historial ni en el ledger.",\n      });\n      return;\n    }\n''',
        '''    const saveToHistory = options.saveToHistory !== false;\n    if (saveToHistory) {\n      const duplicatePick = state.mlbPicks.some((existing) =>\n        existing.date === selectedDate\n        && existing.market.trim().toLowerCase() === normalizedMarket\n        && existing.pick.trim().toLowerCase() === pick.trim().toLowerCase()\n        && existing.odds === odds\n        && Math.abs(existing.modelProb - resolvedModelProb) < 0.01\n      );\n      if (duplicatePick) {\n        toast({\n          title: "Este pick MLB ya está guardado",\n          description: "No se creó otra entrada en el historial. La captura científica automática usa idempotencia del servidor.",\n        });\n        return;\n      }\n    }\n''',
        "history duplicate boundary",
    )
    block = replace_once(
        block,
        '    const operationalStake = Math.min(1, Math.max(0, pq?.stakeUnits ?? fallbackKelly));\n',
        '''    const operationalStake = Math.min(1, Math.max(0, pq?.stakeUnits ?? fallbackKelly));\n    const resolvedSignal = (pq?.recommendation || (normalizedMarket === "ml" ? activeResult.mlSignal\n      : normalizedMarket === "f5" ? activeResult.f5Signal\n        : normalizedMarket.includes("run line") ? activeResult.runLine.signal\n          : normalizedMarket.includes("f5 o/u") ? activeResult.f5OuResult?.signal || "INFO"\n            : activeResult.ouResult.signal)) as MlbP1M3cSignal;\n    const scientificStake = resolvedSignal === "BET" || resolvedSignal === "BET_FUERTE"\n      ? Math.round(operationalStake * 100) / 100\n      : 0;\n''',
        "resolved signal",
    )
    block = replace_once(
        block,
        '    const commenceTime = isoDateTimeOrUndefined(selectedGame?.commenceTime || selectedGame?.gameTime || selectedGame?.gameDate);\n',
        '    const commenceTime = isoDateTimeOrUndefined(selectedGame?.commenceTime || selectedGame?.gameTime || selectedGame?.gameDate || pregameExecutionReport?.game.startTime);\n',
        "commence fallback",
    )
    old_signal = '''        signal: pq?.recommendation || (normalizedMarket === "ml" ? activeResult.mlSignal\n          : normalizedMarket === "f5" ? activeResult.f5Signal\n            : normalizedMarket.includes("run line") ? activeResult.runLine.signal\n              : normalizedMarket.includes("f5 o/u") ? activeResult.f5OuResult?.signal || "INFO"\n                : activeResult.ouResult.signal),\n'''
    block = replace_once(block, old_signal, '        signal: resolvedSignal,\n', "snapshot signal")
    block = replace_once(
        block,
        '        stakeUnits: Math.round(operationalStake * 100) / 100,\n',
        '        stakeUnits: scientificStake,\n',
        "snapshot stake",
    )
    emission_anchor = '''    dispatch({\n      type: "ADD_MLB_PICK",\n'''
    emission = '''    if (options.emitScientific) {\n      const clientEvaluationId = options.clientEvaluationId\n        ?? createMlbP1M3cClientEvaluationId(Number(selectedGameId), certifiedMarket);\n      setScientificCaptureState({ status: "CAPTURING", clientEvaluationId });\n      try {\n        if (!pregameExecutionReport) throw new Error("P1_M3C_EXECUTION_REPORT_MISSING");\n        if (implied == null || edgePp == null) throw new Error("P1_M3C_MARKET_MATH_INCOMPLETE");\n        const side = normalizedMarket === "o/u"\n          ? activeResult.ouResult.side\n          : normalizedMarket.includes("f5 o/u")\n            ? activeResult.f5OuResult?.side ?? "OVER"\n            : selectedHome ? "HOME" : "AWAY";\n        const line = certifiedMarket === "ML" || certifiedMarket === "F5_ML"\n          ? null\n          : parseMlbMarketLine(pick) ?? null;\n        const category = resolvedSignal === "BET_FUERTE" ? "ELITE"\n          : resolvedSignal === "BET" ? "PREMIUM"\n            : resolvedSignal === "LEAN" ? "LEAN"\n              : resolvedSignal === "PASS" ? "PASS" : "INFO";\n        const candidate = await buildMlbP1M3cCandidate({\n          report: pregameExecutionReport,\n          scientificSnapshot,\n          evaluation: {\n            market: certifiedMarket,\n            side,\n            selection: pick,\n            line,\n            oddsAmerican: Math.round(odds),\n            oppositeOddsAmerican: oppositeOdds ?? null,\n            sourceModeHint: normalizedMarket === "f5"\n              ? f5OddsSource === "manual" ? "MANUAL" : f5OddsSource === "consenso" ? "CONSENSUS" : null\n              : "AUTOMATIC",\n            modelProbability: resolvedModelProb / 100,\n            marketImplied: implied,\n            noVig: noVig ?? null,\n            edgePp,\n            signal: resolvedSignal,\n            category,\n            confidenceLabel: pq?.rating ?? "MODEL",\n            confidencePct: resolvedModelProb,\n            recommendedStakeUnits: scientificStake,\n            rationale: pq?.reasoning || activeResult.bestPlay?.reason || "Evaluación automática del mercado certificado.",\n            filterReasons: [...new Set(pq?.warnings || [])].slice(0, 100),\n          },\n          capturedAt,\n          clientEvaluationId,\n          venue: selectedGame?.venue ? String(selectedGame.venue) : null,\n          model: {\n            name: "CourtEdge MLB",\n            version: "predictor-full-snapshot-v2",\n            gitCommit: null,\n            environment: import.meta.env.MODE || null,\n          },\n        });\n        const captureResult = await postMlbP1M3cScientificCapture(candidate);\n        setScientificCaptureState(toMlbP1M3cUiSuccess(captureResult, clientEvaluationId));\n        toast({\n          title: captureResult.outcome === "APPENDED"\n            ? "Evaluación científica registrada"\n            : "Evaluación científica idempotente",\n          description: captureResult.outcome === "APPENDED"\n            ? "Esta ejecución ya cuenta para ROI, CLV y calibración SHADOW."\n            : "La misma decisión ya estaba registrada; no se infló la muestra.",\n        });\n      } catch (error: unknown) {\n        const message = error instanceof Error ? error.message : "No se pudo registrar la evaluación científica.";\n        setScientificCaptureState({\n          status: "REJECTED",\n          clientEvaluationId,\n          message,\n          code: error instanceof Error ? error.name : null,\n        });\n        toast({\n          title: "Captura científica rechazada",\n          description: message,\n          variant: "destructive",\n        });\n      }\n    }\n\n    if (!saveToHistory) return;\n\n    dispatch({\n      type: "ADD_MLB_PICK",\n'''
    block = replace_once(block, emission_anchor, emission, "automatic emission")
    text = text[:start] + block + text[end:]

    text = replace_once(
        text,
        '  const [selectedGameId, setSelectedGameId] = useState("");\n  const [pregameGate, setPregameGate] = useState<MlbPregameGateSnapshot | null>(null);\n',
        '  const [selectedGameId, setSelectedGameId] = useState("");\n  const [pregameGate, setPregameGate] = useState<MlbPregameGateSnapshot | null>(null);\n  const [pregameExecutionReport, setPregameExecutionReport] = useState<MlbPregameReadinessReport | null>(null);\n  const [scientificCaptureState, setScientificCaptureState] = useState<MlbP1M3cUiState>(MLB_P1_M3C_IDLE_STATE);\n',
        "capture state",
    )
    text = replace_once(
        text,
        '    setPregameGate(null);\n    setResult(null);\n    toast({ title: "Cuota certificada aplicada", description: "La compuerta volverá a verificar el mismo precio que usará el modelo." });\n',
        '    setPregameGate(null);\n    setPregameExecutionReport(null);\n    setScientificCaptureState(MLB_P1_M3C_IDLE_STATE);\n    setResult(null);\n    toast({ title: "Cuota certificada aplicada", description: "La compuerta volverá a verificar el mismo precio que usará el modelo." });\n',
        "quote reset capture",
    )
    text = replace_once(
        text,
        '    // P1-M1: fail closed between games. No factor from the previous matchup may remain visible or enter a new calculation.\n    setResult(null);\n',
        '    // P1-M1: fail closed between games. No factor from the previous matchup may remain visible or enter a new calculation.\n    setScientificCaptureState(MLB_P1_M3C_IDLE_STATE);\n    setPregameExecutionReport(null);\n    setResult(null);\n',
        "autofill reset capture",
    )

    predict_start = text.index('  const handlePredict = useCallback(() => {')
    predict_end = text.index('\n  // ── INLINE HELPERS', predict_start)
    predict = text[predict_start:predict_end]
    predict = replace_once(
        predict,
        '    const bestPlay = mlbGetBestPlay(candidates);\n\n    setResult({\n',
        '    const bestPlay = mlbGetBestPlay(candidates);\n\n    const nextResult: MLBResult = {\n',
        "next result start",
    )
    predict = replace_once(
        predict,
        '''      },\n    });\n\n    toast({ title: "Predicción generada", description: "Análisis MLB completado" });\n''',
        '''      },\n    };\n\n    setResult(nextResult);\n    const automaticSelection = resolveMlbP1M3cAutomaticSelection({\n      market: pregameGate.market,\n      homeTeam,\n      awayTeam,\n      lines: {\n        mlHome: mlOdds,\n        mlAway: mlOddsAway,\n        runLineHomeOdds: rlOdds,\n        runLineAwayOdds: rlOddsAway,\n        overOdds,\n        underOdds,\n        f5MlHome,\n        f5MlAway,\n      },\n      result: nextResult,\n    });\n    if (!automaticSelection) {\n      setScientificCaptureState({\n        status: "REJECTED",\n        clientEvaluationId: null,\n        message: "El mercado certificado no tiene una selección y precio exactos para emitir.",\n        code: "P1_M3C_AUTOMATIC_SELECTION_UNAVAILABLE",\n      });\n    } else {\n      const clientEvaluationId = createMlbP1M3cClientEvaluationId(Number(selectedGameId), pregameGate.market);\n      void savePick(\n        automaticSelection.marketLabel,\n        automaticSelection.pick,\n        automaticSelection.oddsAmerican,\n        automaticSelection.modelProbPct,\n        {\n          saveToHistory: false,\n          emitScientific: true,\n          clientEvaluationId,\n          resultOverride: nextResult,\n        },\n      );\n    }\n\n    toast({ title: "Predicción generada", description: "Análisis MLB completado; captura científica en proceso." });\n''',
        "automatic capture after prediction",
    )
    predict = replace_once(
        predict,
        '    selectedGameId, pregameGate,\n',
        '    selectedGameId, pregameGate, pregameExecutionReport,\n',
        "predict dependencies",
    )
    text = text[:predict_start] + predict + text[predict_end:]

    text = replace_once(
        text,
        '            setSelectedGameId("");\n            setPregameGate(null);\n            setMlbQueueView("priority");\n            setResult(null);\n',
        '            setSelectedGameId("");\n            setPregameGate(null);\n            setPregameExecutionReport(null);\n            setScientificCaptureState(MLB_P1_M3C_IDLE_STATE);\n            setMlbQueueView("priority");\n            setResult(null);\n',
        "slate date reset",
    )
    text = replace_once(
        text,
        '            setSelectedGameId(String(game.gamePk));\n            setPregameGate(null);\n            setMlbQueueView(game.analysisStage === "FINAL" ? "priority" : "pending");\n',
        '            setSelectedGameId(String(game.gamePk));\n            setPregameGate(null);\n            setPregameExecutionReport(null);\n            setScientificCaptureState(MLB_P1_M3C_IDLE_STATE);\n            setMlbQueueView(game.analysisStage === "FINAL" ? "priority" : "pending");\n',
        "slate game reset",
    )
    text = replace_once(
        text,
        '              setSelectedDate(date);\n              setSelectedGameId("");\n            setPregameGate(null);\n              setMlbQueueView("priority");\n',
        '              setSelectedDate(date);\n              setSelectedGameId("");\n              setPregameGate(null);\n              setPregameExecutionReport(null);\n              setScientificCaptureState(MLB_P1_M3C_IDLE_STATE);\n              setMlbQueueView("priority");\n',
        "manual date reset",
    )
    text = replace_once(
        text,
        '          onApplyCertifiedQuote={applyCertifiedQuote}\n          onSnapshot={setPregameGate}\n',
        '          onApplyCertifiedQuote={applyCertifiedQuote}\n          onSnapshot={setPregameGate}\n          onExecutionReport={setPregameExecutionReport}\n',
        "gate report callback",
    )
    text = replace_once(
        text,
        '''            <h2 className="text-lg font-bold text-slate-200 flex items-center gap-2">\n              <Star className="w-5 h-5 text-yellow-400" />\n              Resultados del Análisis\n            </h2>\n''',
        '''            <h2 className="text-lg font-bold text-slate-200 flex items-center gap-2">\n              <Star className="w-5 h-5 text-yellow-400" />\n              Resultados del Análisis\n            </h2>\n            <MlbScientificCaptureStatus state={scientificCaptureState} />\n''',
        "capture status display",
    )
    PREDICTOR.write_text(text)


patch_gate()
patch_predictor()
print("P1-M3C deterministic patch applied")

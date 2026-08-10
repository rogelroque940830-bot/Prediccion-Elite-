from pathlib import Path

PATH = Path("frontend/client/src/components/mlb-pregame-readiness-gate.tsx")
text = PATH.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    text = text.replace(old, new, 1)


replace_once(
    '''} from "@/lib/mlb-pregame-readiness";\n''',
    '''} from "@/lib/mlb-pregame-readiness";
import {
  applyMlbManualQuoteCapture,
  buildMlbManualQuoteSignature,
  createMlbManualQuoteCapture,
  isMlbManualQuoteCaptureCurrent,
  type MlbManualQuoteCapture,
} from "@/lib/mlb-manual-quote-capture";
''',
    "manual quote capture import",
)

replace_once(
    '''  const [market, setMarket] = useState<MlbPregameMarket>("ML");
  const [verificationNonce, setVerificationNonce] = useState(0);
''',
    '''  const [market, setMarket] = useState<MlbPregameMarket>("ML");
  const [verificationNonce, setVerificationNonce] = useState(0);
  const [manualCapture, setManualCapture] = useState<MlbManualQuoteCapture | null>(null);
''',
    "manual capture state",
)

old_request = '''  const capturedAt = useMemo(() => new Date().toISOString(), [
    gamePk,
    date,
    market,
    verificationNonce,
    lines.mlHome,
    lines.mlAway,
    lines.runLine,
    lines.runLineHomeOdds,
    lines.runLineAwayOdds,
    lines.totalLine,
    lines.overOdds,
    lines.underOdds,
    lines.f5MlHome,
    lines.f5MlAway,
    lines.f5TotalLine,
    lines.f5OddsSource,
  ]);

  const request = useMemo(() => buildMlbPregameReadinessUrl({
    gamePk,
    date,
    market,
    lines,
    capturedAt,
  }), [gamePk, date, market, lines, capturedAt]);
'''
new_request = '''  const capturedAt = useMemo(() => new Date().toISOString(), [
    gamePk,
    date,
    market,
    verificationNonce,
    lines.mlHome,
    lines.mlAway,
    lines.runLine,
    lines.runLineHomeOdds,
    lines.runLineAwayOdds,
    lines.totalLine,
    lines.overOdds,
    lines.underOdds,
    lines.f5MlHome,
    lines.f5MlAway,
    lines.f5TotalLine,
    lines.f5OddsSource,
  ]);

  // P1-M2C.4: automatic requests must never inherit the old implicit F5 manual
  // behavior. A manual snapshot is sent only after the user explicitly confirms
  // that the visible values were just verified in Hard Rock Bet.
  const automaticLines = useMemo<MlbPregameLineInputs>(() => ({
    ...lines,
    f5OddsSource: "none",
  }), [lines]);
  const automaticRequest = useMemo(() => buildMlbPregameReadinessUrl({
    gamePk,
    date,
    market,
    lines: automaticLines,
    capturedAt,
  }), [gamePk, date, market, automaticLines, capturedAt]);
  const manualQuoteSignature = useMemo(
    () => buildMlbManualQuoteSignature(market, lines),
    [market, lines],
  );
  const manualCaptureCurrent = useMemo(
    () => isMlbManualQuoteCaptureCurrent(manualCapture, market, lines),
    [manualCapture, market, lines],
  );
  const request = useMemo(() => applyMlbManualQuoteCapture({
    automaticUrl: automaticRequest.url,
    market,
    lines,
    capture: manualCapture,
  }), [automaticRequest.url, market, lines, manualCapture]);
  const captureManualQuote = () => {
    const capture = createMlbManualQuoteCapture(market, lines, new Date().toISOString());
    if (!capture) return;
    setManualCapture(capture);
    setVerificationNonce((value) => value + 1);
  };
'''
replace_once(old_request, new_request, "request provenance block")

replace_once(
    '''  useEffect(() => {
    lastDecisionSignatureRef.current = null;
    onSnapshotRef.current(null);
    onExecutionReportRef.current(null);
  }, [gamePk, date, market]);
''',
    '''  useEffect(() => {
    lastDecisionSignatureRef.current = null;
    onSnapshotRef.current(null);
    onExecutionReportRef.current(null);
    setManualCapture(null);
  }, [gamePk, date, market]);
''',
    "capture reset on identity/market change",
)

replace_once(
    '''              <Badge variant="outline" className="border-blue-500/40 text-blue-200">P1-M2C.2 · PRIORITY FIRST</Badge>
''',
    '''              <Badge variant="outline" className="border-blue-500/40 text-blue-200">P1-M2C.2 · PRIORITY FIRST</Badge>
              <Badge variant="outline" className="border-fuchsia-500/40 text-fuchsia-200">P1-M2C.4 · HARD ROCK MANUAL</Badge>
''',
    "release badge",
)

replace_once(
    '''          <Badge variant="outline">Cuotas: {request.oddsMode === "manual" ? "captura manual F5" : "fuente automática"}</Badge>
''',
    '''          <Badge variant="outline">Cuotas: {request.oddsMode === "manual" ? "Hard Rock manual verificada" : "fuente automática"}</Badge>
''',
    "odds source badge",
)

manual_panel_anchor = '''        </div>

        {readinessQuery.isLoading || readinessQuery.isFetching && !report ? (
'''
manual_panel = '''        </div>

        <div
          className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/[0.05] p-4"
          data-testid="p1-m2c4-manual-hardrock-capture"
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-fuchsia-100">Fallback manual Hard Rock Bet</p>
                {manualCapture && manualCapture.market === market && (
                  <Badge
                    variant="outline"
                    className={manualCaptureCurrent
                      ? "border-emerald-500/40 text-emerald-200"
                      : "border-red-500/40 text-red-200"}
                  >
                    {manualCaptureCurrent ? "CAPTURA ACTIVA" : "CAPTURA INVALIDADA"}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Úsalo solo después de comprobar ahora mismo estos valores en Hard Rock. El botón registra el instante exacto; editar cualquier línea o cuota después invalida la captura.
              </p>
              <p className="mt-2 text-xs font-mono text-white" data-testid="p1-m2c4-manual-visible-quote">{modelQuote}</p>
              {manualCaptureCurrent && manualCapture && (
                <p className="mt-1 text-[10px] text-emerald-200">
                  Capturada {new Intl.DateTimeFormat("es-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(manualCapture.capturedAt))} ET · el backend aplica el límite de 5 minutos.
                </p>
              )}
              {!manualQuoteSignature && (
                <p className="mt-1 text-[10px] text-amber-200">
                  Completa la línea y las dos cuotas válidas de este mercado antes de capturar. F5 Total sigue sin habilitarse sin Over/Under propios.
                </p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 border-fuchsia-500/40 text-fuchsia-100"
              onClick={captureManualQuote}
              disabled={!manualQuoteSignature || readinessQuery.isFetching}
              data-testid="p1-m2c4-capture-hardrock-now"
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              Confirmo Hard Rock y capturo ahora
            </Button>
          </div>
        </div>

        {readinessQuery.isLoading || readinessQuery.isFetching && !report ? (
'''
replace_once(manual_panel_anchor, manual_panel, "manual capture panel")

PATH.write_text(text)

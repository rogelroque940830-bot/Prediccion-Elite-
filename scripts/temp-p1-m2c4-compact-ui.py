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
    '''  isMlbManualQuoteCaptureCurrent,\n  type MlbManualQuoteCapture,\n''',
    '''  type MlbManualQuoteCapture,\n''',
    "remove redundant component currentness import",
)

replace_once(
    '''  const manualCaptureCurrent = useMemo(\n    () => isMlbManualQuoteCaptureCurrent(manualCapture, { gamePk, date, market, lines }),\n    [manualCapture, gamePk, date, market, lines],\n  );\n''',
    "",
    "remove redundant component currentness memo",
)

old_panel = '''        <div
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
'''
new_panel = '''        <div className="flex flex-wrap items-center gap-2" data-testid="p1-m2c4-manual-hardrock-capture">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={captureManualQuote}
            disabled={!manualQuoteSignature || readinessQuery.isFetching}
            data-testid="p1-m2c4-capture-hardrock-now"
          >
            <ShieldCheck className="mr-2 h-4 w-4" />
            Confirmo Hard Rock y capturo ahora
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {request.captureCurrent ? "Hard Rock capturada · backend valida ≤5 min" : manualQuoteSignature ? "Verifica la cuota mostrada arriba" : "Cuota bilateral incompleta"}
          </span>
        </div>
'''
replace_once(old_panel, new_panel, "compact manual quote panel")

PATH.write_text(text)

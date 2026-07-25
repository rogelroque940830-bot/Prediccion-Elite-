from pathlib import Path

TARGET = Path("frontend/client/src/pages/predictor.tsx")
text = TARGET.read_text(encoding="utf-8")

old_warning = '''          {nbaError && (
            <p className="text-xs text-red-400">⚠️ No se pudo conectar con NBA.com. Llena los datos manualmente.</p>
          )}
'''
new_warning = '''          {nbaError && manualTeams.length > 0 && (
            <p className="text-xs text-amber-400">
              ⚠️ No hay partidos NBA disponibles para esta fecha o el calendario no respondió. El selector manual sigue disponible con estadísticas verificadas.
            </p>
          )}
          {nbaError && manualTeams.length === 0 && !manualTeamsLoading && (
            <p className="text-xs text-red-400">
              ⚠️ No se pudo cargar el calendario ni las estadísticas verificadas NBA. Completa los datos manualmente.
            </p>
          )}
          {!nbaError && nbaData?.success && todayGames.length === 0 && (
            <p className="text-xs text-amber-400">
              ℹ️ No hay partidos NBA programados para esta fecha. Puedes usar el selector manual con estadísticas verificadas.
            </p>
          )}
'''
if old_warning not in text:
    raise SystemExit("NBA schedule warning block not found")
text = text.replace(old_warning, new_warning, 1)

old_summary = '''          <div className="text-xs text-muted-foreground border-t border-border pt-2">
            <span className="font-medium text-foreground">Se llena solo:</span> Todo (Stats · Racha · B2B · Descanso · O/U · SOS)
            &nbsp;&nbsp;<span className="font-medium text-amber-400">Tú solo agregas:</span> Lesiones · Líneas Hard Rock
          </div>
'''
new_summary = '''          <div className="text-xs text-muted-foreground border-t border-border pt-2">
            {selectedGameId && autoFillStatus === "success" ? (
              <>
                <span className="font-medium text-foreground">Partido cargado:</span> Stats · Racha · B2B · Descanso · O/U · SOS
                &nbsp;&nbsp;<span className="font-medium text-amber-400">Tú agregas:</span> Lesiones · Líneas Hard Rock
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">Selector manual:</span> Stats de temporada · Pace · Win Rate · contexto disponible
                &nbsp;&nbsp;<span className="font-medium text-amber-400">Tú agregas:</span> Descanso si no hay partido activo · Lesiones · Líneas Hard Rock
              </>
            )}
          </div>
'''
if old_summary not in text:
    raise SystemExit("NBA status summary block not found")
text = text.replace(old_summary, new_summary, 1)

old_team_status = '''            {team && (
              <p className={`mt-1 text-[11px] ${
                (isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? "text-green-400"
                  : "text-amber-400"
              }`}>
                {(isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? `Autollenado verificado · ${manualTeamPayload?.source === "production-readonly-fallback" ? "respaldo de solo lectura" : "fuente directa"}`
                  : manualTeamsLoading
                    ? "Cargando estadísticas verificadas…"
                    : "Entrada manual · no usar valores sin verificar"}
              </p>
            )}
'''
new_team_status = '''            {team && (
              <p className={`mt-1 text-[11px] ${
                (isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? "text-green-400"
                  : "text-amber-400"
              }`}>
                {(isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? `Autollenado verificado · ${manualTeamPayload?.source === "production-readonly-fallback" ? "respaldo de solo lectura" : "fuente directa"}`
                  : manualTeamsLoading
                    ? "Cargando estadísticas verificadas…"
                    : "Entrada manual · no usar valores sin verificar"}
              </p>
            )}
            {team && (isHome ? homeManualStatus : awayManualStatus) === "verified" && !daysRest.trim() && (
              <p className="mt-1 text-[11px] text-amber-400">
                Descanso pendiente · no hay partido activo en la fecha seleccionada.
              </p>
            )}
'''
if old_team_status not in text:
    raise SystemExit("NBA manual team status block not found")
text = text.replace(old_team_status, new_team_status, 1)

TARGET.write_text(text, encoding="utf-8")
print("NBA schedule and manual-mode status messaging updated")

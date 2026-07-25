from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


path = Path("frontend/client/src/pages/nhl-predictor.tsx")
text = path.read_text(encoding="utf-8")

old_save = '''  // ── Save Pick (reuse mlbPicks for NHL) ───────────────────────────────────
  const savePick = (market: string, pick: string, odds: number, modelProb: number, key: string) => {
    if (!result) return;
    const bankroll =
      state.bankrollInitial + state.mlbPicks.reduce((s, p) => s + p.profit, 0);
    const stake = Math.round(kellyFraction(modelProb / 100, odds) * bankroll * 100) / 100;

    dispatch({
      type: "ADD_NHL_PICK",
      payload: {
        date: new Date().toISOString().split("T")[0],
        sport: "NHL", // reuse MLB picks for NHL
        team: result.homeTeam,
        opponent: result.awayTeam,
        market,
        pick,
        odds,
        modelProb,
        stake: Math.max(stake, 1),
        result: "P",
      },
    });
    setSaved((prev) => ({ ...prev, [key]: true }));
    toast({ title: `✅ Pick NHL guardado — ${pick}` });
  };
'''

new_save = '''  // ── Save Pick ────────────────────────────────────────────────────────────
  const savePick = (market: string, pick: string, odds: number, modelProb: number, key: string) => {
    if (!result) return;
    const marketSignal = key === "ml"
      ? result.mlSignal
      : key === "puckline"
        ? result.puckLineResult?.signal
        : key === "ou"
          ? result.totalResult?.signal
          : null;
    if (result.factorBreakdown?.goalieUnconfirmed || marketSignal !== "BET") {
      toast({
        title: "Pick provisional — no se guardó",
        description: result.factorBreakdown?.goalieUnconfirmed
          ? "Confirma ambos porteros antes de guardar una apuesta oficial."
          : "Este mercado todavía no alcanza señal BET.",
      });
      return;
    }
    const bankroll =
      state.bankrollInitial + state.mlbPicks.reduce((s, p) => s + p.profit, 0);
    const stake = Math.round(kellyFraction(modelProb / 100, odds) * bankroll * 100) / 100;

    dispatch({
      type: "ADD_NHL_PICK",
      payload: {
        date: new Date().toISOString().split("T")[0],
        sport: "NHL",
        team: result.homeTeam,
        opponent: result.awayTeam,
        market,
        pick,
        odds,
        modelProb,
        stake: Math.max(stake, 1),
        result: "P",
      },
    });
    setSaved((prev) => ({ ...prev, [key]: true }));
    toast({ title: `✅ Pick NHL guardado — ${pick}` });
  };
'''
text = replace_once(text, old_save, new_save, "save guard")

old_star = '''          {/* Jugada Estrella */}
          {result.bestPlay && (
            <Card className="border-yellow-500/40 bg-yellow-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-yellow-400 flex items-center gap-2">
                  <Star className="h-4 w-4" />
                  Jugada Estrella
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-base font-bold text-white">{result.bestPlay.recommendation}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Mercado: <span className="text-yellow-400">{result.bestPlay.market}</span>
                      {" · "}Edge: <span className="text-yellow-400">{result.bestPlay.edgeLabel}</span>
                    </p>
                  </div>
                  <Badge className={`text-sm px-3 py-1 border ${signalColor(result.bestPlay.signal)}`}>
                    {signalLabel(result.bestPlay.signal)}
                  </Badge>
                </div>
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Confianza del modelo</span>
                    <span>{result.bestPlay.confidence.toFixed(0)}%</span>
                  </div>
                  <Progress value={result.bestPlay.confidence} className="h-2" />
                </div>
              </CardContent>
            </Card>
          )}
'''

new_star = '''          {/* Recomendación principal */}
          {result.bestPlay && (() => {
            const goalieUnconfirmed = result.factorBreakdown?.goalieUnconfirmed === true;
            const isStarPlay = !goalieUnconfirmed && result.bestPlay.signal === "BET";
            const title = goalieUnconfirmed
              ? "Análisis provisional — no apostar"
              : isStarPlay
                ? "Jugada Estrella"
                : "Sin jugada estrella";
            const cardClass = goalieUnconfirmed
              ? "border-amber-500/40 bg-amber-500/5"
              : isStarPlay
                ? "border-yellow-500/40 bg-yellow-500/5"
                : "border-slate-500/30 bg-slate-500/5";
            const titleClass = goalieUnconfirmed
              ? "text-amber-400"
              : isStarPlay
                ? "text-yellow-400"
                : "text-slate-300";
            return (
              <Card className={cardClass}>
                <CardHeader className="pb-2 px-4 pt-4">
                  <CardTitle className={`text-sm font-semibold flex items-center gap-2 ${titleClass}`}>
                    {isStarPlay && <Star className="h-4 w-4" />}
                    {title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <p className="text-base font-bold text-white">{result.bestPlay.recommendation}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Mercado: <span className={isStarPlay ? "text-yellow-400" : "text-amber-400"}>{result.bestPlay.market}</span>
                        {" · "}Edge: <span className={isStarPlay ? "text-yellow-400" : "text-amber-400"}>{result.bestPlay.edgeLabel}</span>
                      </p>
                    </div>
                    <Badge className={`text-sm px-3 py-1 border ${signalColor(result.bestPlay.signal)}`}>
                      {signalLabel(result.bestPlay.signal)}
                    </Badge>
                  </div>
                  {goalieUnconfirmed && (
                    <p className="mt-3 text-xs font-medium text-amber-300">
                      Esperar confirmación de ambos porteros. Esta recomendación no está habilitada para apostar ni guardar.
                    </p>
                  )}
                  {!goalieUnconfirmed && !isStarPlay && (
                    <p className="mt-3 text-xs font-medium text-slate-300">
                      Los porteros están confirmados, pero ningún mercado alcanza todavía una señal BET clara.
                    </p>
                  )}
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>Confianza del modelo</span>
                      <span>{result.bestPlay.confidence.toFixed(0)}%</span>
                    </div>
                    <Progress value={result.bestPlay.confidence} className="h-2" />
                  </div>
                </CardContent>
              </Card>
            );
          })()}
'''
text = replace_once(text, old_star, new_star, "recommendation card")

text = replace_once(
    text,
    '                  disabled={saved["ml"]}\n',
    '                  disabled={saved["ml"] || result.factorBreakdown?.goalieUnconfirmed === true || result.mlSignal !== "BET"}\n',
    "ml save disabled",
)
text = replace_once(
    text,
    '                    disabled={saved["puckline"]}\n',
    '                    disabled={saved["puckline"] || result.factorBreakdown?.goalieUnconfirmed === true || result.puckLineResult.signal !== "BET"}\n',
    "puck line save disabled",
)
text = replace_once(
    text,
    '                    disabled={saved["ou"]}\n',
    '                    disabled={saved["ou"] || result.factorBreakdown?.goalieUnconfirmed === true || result.totalResult.signal !== "BET"}\n',
    "total save disabled",
)

old_save_intro = '''            <CardContent className="px-4 pb-4">
              <div className="flex flex-wrap gap-3">
'''
new_save_intro = '''            <CardContent className="px-4 pb-4">
              {result.factorBreakdown?.goalieUnconfirmed ? (
                <p className="text-xs text-amber-300 mb-3">
                  Guardado bloqueado: confirma ambos porteros para convertir el análisis provisional en una apuesta oficial.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mb-3">
                  Solo se pueden guardar mercados que alcancen señal BET.
                </p>
              )}
              <div className="flex flex-wrap gap-3">
'''
# The fragment appears in multiple cards; target the occurrence after Guardar Picks NHL.
save_header = '''                Guardar Picks NHL
              </CardTitle>
            </CardHeader>
'''
pos = text.index(save_header) + len(save_header)
head, tail = text[:pos], text[pos:]
tail = replace_once(tail, old_save_intro, new_save_intro, "save section intro")
text = head + tail

text = replace_once(
    text,
    '                Los picks NHL se guardan en el historial MLB. Resultado pendiente (P) hasta que lo actualices.\n',
    '                Los picks NHL se guardan en el Historial NHL. Resultado pendiente (P) hasta que lo actualices.\n',
    "history label",
)

path.write_text(text, encoding="utf-8")
print("NHL recommendation labels and official-save rules applied")

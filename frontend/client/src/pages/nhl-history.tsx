import { useAppContext, type Pick } from "@/lib/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Trophy, Trash2 } from "lucide-react";

function signalColor(result: string) {
  if (result === "W") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (result === "L") return "bg-red-500/20 text-red-400 border-red-500/30";
  return "bg-amber-500/20 text-amber-400 border-amber-500/30";
}

export default function NHLHistory() {
  const { state, dispatch } = useAppContext();
  const picks = state.nhlPicks;

  // Stats
  const resolved = picks.filter((p) => p.result !== "P");
  const wins = resolved.filter((p) => p.result === "W").length;
  const losses = resolved.filter((p) => p.result === "L").length;
  const winRate = resolved.length > 0 ? (wins / resolved.length) * 100 : 0;
  const totalProfit = picks.reduce((s, p) => s + p.profit, 0);
  const totalStaked = resolved.reduce((s, p) => s + p.stake, 0);
  const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;

  // Stats by market
  const markets = ["ML", "Puck Line", "O/U", ];
  const marketStats = markets.map((m) => {
    const mp = picks.filter((p) => p.market === m);
    const mr = mp.filter((p) => p.result !== "P");
    const mw = mr.filter((p) => p.result === "W").length;
    const mProfit = mp.reduce((s, p) => s + p.profit, 0);
    return { market: m, total: mp.length, wins: mw, resolved: mr.length, winRate: mr.length > 0 ? (mw / mr.length) * 100 : 0, profit: mProfit };
  }).filter((m) => m.total > 0);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1200px] mx-auto">
      <div className="flex items-center gap-3">
        <Trophy className="h-5 w-5 text-amber-400" />
        <h1 className="text-xl font-display font-bold">Historial NHL</h1>
        <Badge variant="outline" className="ml-auto">{picks.length} picks</Badge>
      </div>

      <Card className="border-blue-500/20 bg-blue-500/[0.04]">
        <CardContent className="flex items-start gap-2 p-3 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
          <p>Este historial contiene picks guardados por el usuario. Los resultados se confirman manualmente y los pendientes no entran en el ROI.</p>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="bg-blue-500/10 border-blue-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Total Picks</p>
            <p className="text-2xl font-bold text-blue-400">{picks.length}</p>
          </CardContent>
        </Card>
        <Card className="bg-green-500/10 border-green-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Ganados</p>
            <p className="text-2xl font-bold text-green-400">{wins}</p>
          </CardContent>
        </Card>
        <Card className="bg-red-500/10 border-red-500/20">
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Perdidos</p>
            <p className="text-2xl font-bold text-red-400">{losses}</p>
          </CardContent>
        </Card>
        <Card className={`${winRate >= 55 ? "bg-green-500/10 border-green-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Win Rate</p>
            <p className={`text-2xl font-bold ${winRate >= 55 ? "text-green-400" : "text-amber-400"}`}>{winRate.toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card className={`${totalProfit >= 0 ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
          <CardContent className="p-3 text-center">
            <p className="text-xs text-muted-foreground">G/P Total</p>
            <p className={`text-2xl font-bold ${totalProfit >= 0 ? "text-green-400" : "text-red-400"}`}>${totalProfit.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">ROI: {roi.toFixed(1)}%</p>
          </CardContent>
        </Card>
      </div>

      {/* Stats by Market */}
      {marketStats.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Rendimiento por Mercado</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
              {marketStats.map((m) => (
                <div key={m.market} className="bg-slate-800/50 rounded-lg p-2 text-center">
                  <p className="text-xs text-muted-foreground">{m.market}</p>
                  <p className="text-sm font-bold">{m.wins}/{m.resolved}</p>
                  <p className={`text-xs ${m.winRate >= 55 ? "text-green-400" : m.winRate >= 45 ? "text-amber-400" : "text-red-400"}`}>
                    {m.winRate.toFixed(0)}% · ${m.profit.toFixed(0)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Picks list */}
      {picks.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">No hay picks NHL guardados. Ve al Predictor NHL y guarda tus jugadas.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {[...picks].reverse().map((pick) => (
            <Card key={pick.id} className={`border-l-4 ${pick.result === "W" ? "border-l-green-500" : pick.result === "L" ? "border-l-red-500" : "border-l-amber-500"}`}>
              <CardContent className="p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className={`${signalColor(pick.result)} text-xs`}>{pick.result}</Badge>
                  <span className="text-xs text-muted-foreground">{pick.date}</span>
                  <span className="text-sm font-medium">{pick.team} vs {pick.opponent}</span>
                  <Badge variant="outline" className="text-xs">{pick.market}</Badge>
                  <span className="text-xs text-muted-foreground ml-auto">{pick.pick}</span>
                </div>
                <div className="flex items-center gap-4 mt-2 text-xs">
                  <span>Cuota: {pick.odds > 0 ? "+" : ""}{pick.odds}</span>
                  <span>Modelo: {pick.modelProb.toFixed(1)}%</span>
                  <span>Edge: {pick.edge > 0 ? "+" : ""}{pick.edge.toFixed(1)}%</span>
                  <span>Stake: ${pick.stake.toFixed(2)}</span>
                  <span className={pick.profit >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                    {pick.profit >= 0 ? "+" : ""}${pick.profit.toFixed(2)}
                  </span>

                  {/* Result selector */}
                  {pick.result === "P" && (
                    <Select onValueChange={(val) => dispatch({ type: "UPDATE_NHL_PICK", payload: { id: pick.id, result: val } })}>
                      <SelectTrigger className="w-20 h-6 text-xs">
                        <SelectValue placeholder="Resultado" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="W">W</SelectItem>
                        <SelectItem value="L">L</SelectItem>
                      </SelectContent>
                    </Select>
                  )}

                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400 ml-auto"
                    onClick={() => dispatch({ type: "DELETE_NHL_PICK", payload: pick.id })}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

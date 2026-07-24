// CLV (Closing Line Value) Tracker — TOTALMENTE AUTOMÁTICO
// Cuando el partido termina, el servidor busca el snapshot más cercano al
// commence_time del partido y calcula CLV. Tú no haces nada manualmente.

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, RefreshCw, CheckCircle2 } from "lucide-react";
import { useAppContext, type Pick } from "@/lib/context";
import { useToast } from "@/hooks/use-toast";
import { API_BASE } from "@/lib/queryClient";

interface AllPick extends Pick { sportTag: string }

export function CLVTracker() {
  const { state, dispatch } = useAppContext();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const allPicks: AllPick[] = useMemo(() => [
    ...state.picks.map(p => ({ ...p, sportTag: "NBA" })),
    ...state.mlbPicks.map(p => ({ ...p, sportTag: "MLB" })),
    ...state.nhlPicks.map(p => ({ ...p, sportTag: "NHL" })),
    ...state.wnbaPicks.map(p => ({ ...p, sportTag: "WNBA" })),
  ], [state]);

  // Stats CLV
  const clvStats = useMemo(() => {
    const withClv = allPicks.filter(p => p.clvPercent !== undefined && p.clvPercent !== null);
    const totalCLV = withClv.reduce((s, p) => s + (p.clvPercent ?? 0), 0);
    const avgCLV = withClv.length > 0 ? totalCLV / withClv.length : 0;
    const positiveCLV = withClv.filter(p => (p.clvPercent ?? 0) > 0).length;
    const negativeCLV = withClv.filter(p => (p.clvPercent ?? 0) < 0).length;
    const positiveCLVRate = withClv.length > 0 ? (positiveCLV / withClv.length) * 100 : 0;
    return { withClv, total: withClv.length, avgCLV, positiveCLV, negativeCLV, positiveCLVRate };
  }, [allPicks]);

  // Refresh CLV automáticamente al cargar el dashboard y cada 5 minutos
  const refreshCLV = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${API_BASE}/api/clv/refresh`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        // Recargar picks del servidor
        const picksRes = await fetch(`${API_BASE}/api/picks`);
        const picksData = await picksRes.json();
        if (picksData.success) {
          dispatch({
            type: "LOAD_STATE",
            payload: {
              picks: picksData.picks || [],
              mlbPicks: picksData.mlbPicks || [],
              nhlPicks: picksData.nhlPicks || [],
              wnbaPicks: picksData.wnbaPicks || [],
              bankrollInitial: picksData.bankroll ?? 1000,
              nextId: picksData.nextId ?? 1,
            },
          });
        }
        setLastRefresh(new Date().toLocaleTimeString("es-ES"));
        if (data.updated > 0) {
          toast({
            title: `✓ CLV actualizado`,
            description: `${data.updated} pick${data.updated === 1 ? "" : "s"} con cuota de cierre nueva`,
          });
        }
      }
    } catch (e) {
      console.error("CLV refresh failed", e);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    refreshCLV(); // primer refresh al montar
    const interval = setInterval(refreshCLV, 5 * 60 * 1000); // cada 5 min
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card className="border-cyan-500/30 bg-cyan-500/5">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-cyan-400" />
              <span className="text-cyan-300">CLV Tracker</span>
              <Badge variant="outline" className="text-[9px] border-green-500/40 text-green-400">
                <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                Automático
              </Badge>
            </CardTitle>
            <p className="text-[10px] text-muted-foreground mt-1">
              Compara tu cuota vs la cuota de cierre. CLV positivo sostenido (≥2%) significa que vences al mercado a largo plazo, aunque pierdas hoy.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={refreshCLV} disabled={refreshing} className="h-7 text-[10px] border-cyan-500/30 text-cyan-300 shrink-0">
            <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "..." : "Refrescar"}
          </Button>
        </div>
        {lastRefresh && (
          <p className="text-[9px] text-muted-foreground">Última actualización: {lastRefresh}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="p-2 rounded bg-slate-800/50 border border-slate-700">
            <p className="text-[10px] text-muted-foreground">CLV Promedio</p>
            <p className={`text-lg font-bold font-mono ${clvStats.avgCLV > 0 ? "text-green-400" : clvStats.avgCLV < 0 ? "text-red-400" : "text-slate-400"}`}>
              {clvStats.avgCLV > 0 ? "+" : ""}{clvStats.avgCLV.toFixed(2)}%
            </p>
            <p className="text-[9px] text-muted-foreground">
              {clvStats.avgCLV >= 2 ? "Excelente" : clvStats.avgCLV >= 0.5 ? "Bueno" : clvStats.avgCLV >= 0 ? "Neutral" : "Negativo"}
            </p>
          </div>
          <div className="p-2 rounded bg-slate-800/50 border border-slate-700">
            <p className="text-[10px] text-muted-foreground">Picks con CLV</p>
            <p className="text-lg font-bold font-mono text-white">{clvStats.total}</p>
            <p className="text-[9px] text-muted-foreground">
              {clvStats.total >= 50 ? "Muestra confiable" : `Necesitas ${50 - clvStats.total} más`}
            </p>
          </div>
          <div className="p-2 rounded bg-slate-800/50 border border-slate-700">
            <p className="text-[10px] text-muted-foreground">% CLV Positivo</p>
            <p className={`text-lg font-bold font-mono ${clvStats.positiveCLVRate >= 55 ? "text-green-400" : "text-amber-400"}`}>
              {clvStats.positiveCLVRate.toFixed(1)}%
            </p>
            <p className="text-[9px] text-muted-foreground">
              {clvStats.positiveCLV}V - {clvStats.negativeCLV}D
            </p>
          </div>
          <div className="p-2 rounded bg-slate-800/50 border border-slate-700">
            <p className="text-[10px] text-muted-foreground">Diagnóstico</p>
            <p className={`text-sm font-bold ${
              clvStats.total < 20 ? "text-amber-400" :
              clvStats.avgCLV >= 2 ? "text-green-400" :
              clvStats.avgCLV >= 0.5 ? "text-cyan-400" :
              clvStats.avgCLV >= 0 ? "text-yellow-400" : "text-red-400"
            }`}>
              {clvStats.total < 20 ? "Datos insuficientes" :
                clvStats.avgCLV >= 2 ? "Vences al mercado" :
                clvStats.avgCLV >= 0.5 ? "Edge ligero" :
                clvStats.avgCLV >= 0 ? "Break-even" : "Pierdes valor"}
            </p>
          </div>
        </div>

        {/* Recent picks with CLV */}
        {clvStats.withClv.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold text-cyan-300 mb-2">
              Últimos picks con CLV ({clvStats.total})
            </h4>
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {[...clvStats.withClv].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 25).map(pick => (
                <div key={`${pick.sportTag}-${pick.id}`} className="flex items-center justify-between gap-2 p-2 rounded bg-slate-800/30 border border-slate-700">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="outline" className={`text-[9px] px-1 py-0 ${
                        pick.sportTag === "NBA" ? "text-blue-400 border-blue-500/30" :
                        pick.sportTag === "MLB" ? "text-green-400 border-green-500/30" :
                        pick.sportTag === "NHL" ? "text-amber-400 border-amber-500/30" :
                        "text-purple-400 border-purple-500/30"
                      }`}>{pick.sportTag}</Badge>
                      <span className="text-[10px] text-muted-foreground">{pick.date}</span>
                      <Badge variant="outline" className="text-[9px] px-1 py-0">{pick.market}</Badge>
                    </div>
                    <p className="text-xs font-medium truncate">{pick.pick}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      Apuesta: {pick.odds > 0 ? "+" : ""}{pick.odds} → Cierre: {(pick.closingOdds ?? 0) > 0 ? "+" : ""}{pick.closingOdds}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-bold font-mono ${(pick.clvPercent ?? 0) > 0 ? "text-green-400" : "text-red-400"}`}>
                      {(pick.clvPercent ?? 0) > 0 ? "+" : ""}{(pick.clvPercent ?? 0).toFixed(2)}%
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-3 rounded bg-amber-500/10 border border-amber-500/30 text-center">
            <p className="text-xs text-amber-300 font-semibold">Aún no hay picks con CLV calculado</p>
            <p className="text-[10px] text-muted-foreground mt-1">
              CLV se calcula automáticamente cuando un partido empieza. Para que funcione, debes haber consultado las cuotas del partido en CourtEdge antes del primer pitch (eso registra los snapshots de cuotas que el sistema usa como cierre). El próximo partido que apuestes y mires en la app tendrá CLV en automático.
            </p>
          </div>
        )}

        {/* Educational footer */}
        <div className="p-2 rounded bg-cyan-500/10 border border-cyan-500/20 text-[10px] text-cyan-200/90 space-y-1">
          <p><strong>¿Cómo lo calcula?</strong> Cada vez que abres un partido en CourtEdge, el sistema guarda un snapshot de las cuotas. Cuando el partido empieza, automáticamente toma el snapshot más cercano al inicio como "cuota de cierre" y compara con tu apuesta.</p>
          <p className="pt-1 border-t border-cyan-500/20">
            <span className="text-green-400">+2% sostenido</span> = ganarás dinero a largo plazo · {" "}
            <span className="text-cyan-400">+0.5%</span> = edge ligero · {" "}
            <span className="text-yellow-400">0%</span> = break-even · {" "}
            <span className="text-red-400">Negativo</span> = pierdes valor
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

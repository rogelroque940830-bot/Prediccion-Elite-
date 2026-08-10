// CLV (Closing Line Value) Tracker — canonical picks v2 integration.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, RefreshCw, CheckCircle2, LockKeyhole } from "lucide-react";
import { useAppContext, type Pick } from "@/lib/context";
import { useToast } from "@/hooks/use-toast";
import { refreshClv } from "@/lib/picks-api";
import { useAuth } from "@/lib/auth-context";

interface AllPick extends Pick { sportTag: string }

export function CLVTracker() {
  const { state, reloadFromServer } = useAppContext();
  const { authenticated, requestLogin } = useAuth();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const allPicks: AllPick[] = useMemo(() => [
    ...state.picks.map(p => ({ ...p, sportTag: "NBA" })),
    ...state.mlbPicks.map(p => ({ ...p, sportTag: "MLB" })),
    ...state.nhlPicks.map(p => ({ ...p, sportTag: "NHL" })),
    ...state.wnbaPicks.map(p => ({ ...p, sportTag: "WNBA" })),
  ], [state]);

  const clvStats = useMemo(() => {
    const withClv = allPicks.filter(p => p.clvPercent !== undefined && p.clvPercent !== null);
    const totalCLV = withClv.reduce((sum, pick) => sum + (pick.clvPercent ?? 0), 0);
    const avgCLV = withClv.length > 0 ? totalCLV / withClv.length : 0;
    const positiveCLV = withClv.filter(p => (p.clvPercent ?? 0) > 0).length;
    const negativeCLV = withClv.filter(p => (p.clvPercent ?? 0) < 0).length;
    const positiveCLVRate = withClv.length > 0 ? (positiveCLV / withClv.length) * 100 : 0;
    return { withClv, total: withClv.length, avgCLV, positiveCLV, negativeCLV, positiveCLVRate };
  }, [allPicks]);

  const refreshCLV = useCallback(async () => {
    if (!authenticated) {
      requestLogin();
      return;
    }

    setRefreshing(true);
    try {
      const result = await refreshClv();
      await reloadFromServer();
      setLastRefresh(new Date().toLocaleTimeString("es-ES"));
      if (result.updated > 0) {
        toast({
          title: "CLV actualizado",
          description: `${result.updated} pick${result.updated === 1 ? "" : "s"} con cuota de cierre nueva`,
        });
      }
    } catch (error) {
      toast({
        title: "No se pudo actualizar CLV",
        description: error instanceof Error ? error.message : "Error desconocido",
        variant: "destructive",
      });
    } finally {
      setRefreshing(false);
    }
  }, [authenticated, reloadFromServer, requestLogin, toast]);

  useEffect(() => {
    if (!authenticated) return;
    void refreshCLV();
    const interval = setInterval(() => void refreshCLV(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [authenticated, refreshCLV]);

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
              Compara tu cuota con la cuota de cierre. Es una señal de calidad de precio, no una garantía de resultado.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshCLV()}
            disabled={refreshing}
            className="h-7 text-[10px] border-cyan-500/30 text-cyan-300 shrink-0"
          >
            {authenticated
              ? <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`} />
              : <LockKeyhole className="h-3 w-3 mr-1" />}
            {refreshing ? "..." : authenticated ? "Refrescar" : "Iniciar sesión"}
          </Button>
        </div>
        {lastRefresh && (
          <p className="text-[9px] text-muted-foreground">Última actualización: {lastRefresh}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
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
              {clvStats.total >= 50 ? "Muestra amplia" : `Faltan ${Math.max(0, 50 - clvStats.total)} para 50`}
            </p>
          </div>
          <div className="p-2 rounded bg-slate-800/50 border border-slate-700">
            <p className="text-[10px] text-muted-foreground">% CLV Positivo</p>
            <p className={`text-lg font-bold font-mono ${clvStats.positiveCLVRate >= 55 ? "text-green-400" : "text-amber-400"}`}>
              {clvStats.positiveCLVRate.toFixed(1)}%
            </p>
            <p className="text-[9px] text-muted-foreground">
              {clvStats.positiveCLV} positivo · {clvStats.negativeCLV} negativo
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
                clvStats.avgCLV >= 2 ? "Precio favorable" :
                clvStats.avgCLV >= 0.5 ? "Edge ligero" :
                clvStats.avgCLV >= 0 ? "Neutral" : "Precio desfavorable"}
            </p>
          </div>
        </div>

        {clvStats.withClv.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold text-cyan-300 mb-2">
              Últimos picks con CLV ({clvStats.total})
            </h4>
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {[...clvStats.withClv]
                .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
                .slice(0, 25)
                .map(pick => (
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
              El servidor utiliza snapshots de cuotas cercanos al inicio del partido. El cálculo se ejecuta únicamente dentro de una sesión autenticada.
            </p>
          </div>
        )}

        <div className="p-2 rounded bg-cyan-500/10 border border-cyan-500/20 text-[10px] text-cyan-200/90 space-y-1">
          <p><strong>Interpretación:</strong> CLV compara la probabilidad implícita de la cuota tomada con la cuota de cierre disponible.</p>
          <p className="pt-1 border-t border-cyan-500/20">
            CLV no garantiza que una apuesta individual gane ni demuestra rentabilidad por sí solo.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

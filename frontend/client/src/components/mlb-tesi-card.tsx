import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Zap, AlertCircle } from "lucide-react";
import { API_BASE } from "@/lib/queryClient";

interface TesiData {
  teamId: number;
  teamName: string;
  gamesAnalyzed: number;
  dataStatus: "VERIFIED" | "PARTIAL" | "DATA_INCOMPLETE";
  asOfDate: string;
  windowStart: string;
  sourceErrors: string[];
  earlyOff: number;
  earlyDef: number;
  f5Runs: number;
  netTesi: number;
  probFirstInn: number;
  probNoFirstInn: number;
  opsVsHand?: number;
  opsVsHandLabel?: string;
  lineupTop3Obp?: number;
  lineupTop3K?: number;
  lineupConfirmed?: boolean;
  pitcher1stInnEra?: number;
  pitcherTto1xwoba?: number;
  pitcherName?: string;
  scoreOff: number;
  scoreDef: number;
  scoreNet: number;
  scoreLineup?: number;
  scorePitcherVuln?: number;
  signal: string;
  recommendation: string;
}

interface Props {
  homeTeamId?: number;
  awayTeamId?: number;
  homeTeamName?: string;
  awayTeamName?: string;
  gamePk?: number;
  homePitcherId?: number;
  homePitcherHand?: "R" | "L";
  awayPitcherId?: number;
  awayPitcherHand?: "R" | "L";
  gameDate?: string;
}

const signalColor = (s: string): string => {
  if (s.includes("ELITE_OFF") || s.includes("STRONG_OFF")) return "bg-orange-500/20 text-orange-300 border-orange-500/40";
  if (s.includes("ELITE_DEF") || s.includes("STRONG_DEF")) return "bg-blue-500/20 text-blue-300 border-blue-500/40";
  if (s.includes("WEAK")) return "bg-red-500/20 text-red-300 border-red-500/40";
  return "bg-slate-500/20 text-slate-300 border-slate-500/40";
};

const scoreColor = (s: number): string => {
  if (s >= 70) return "text-green-400";
  if (s >= 60) return "text-emerald-400";
  if (s >= 40) return "text-yellow-400";
  return "text-red-400";
};

function TeamTesiPanel({ data, label }: { data: TesiData; label: string }) {
  return (
    <div className="space-y-2 p-3 rounded-lg bg-slate-800/40">
      {data.dataStatus !== "VERIFIED" && (
        <div className={`rounded border p-2 text-[11px] ${data.dataStatus === "DATA_INCOMPLETE" ? "border-red-500/50 bg-red-500/10 text-red-300" : "border-yellow-500/50 bg-yellow-500/10 text-yellow-300"}`}>
          {data.dataStatus === "DATA_INCOMPLETE"
            ? "Datos incompletos: no se autoriza señal NRFI/YRFI/F5."
            : `Muestra parcial (${data.gamesAnalyzed} juegos): usar solo como contexto.`}
        </div>
      )}
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm">{label}</h4>
        <Badge variant="outline" className={`text-xs ${signalColor(data.signal)}`}>
          {data.signal.replace("_", " ")}
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground">Últimos {data.gamesAnalyzed} juegos</div>

      {/* Team scoring (1-3 y F5) */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Off 1-3</div>
          <div className={`text-base font-bold ${scoreColor(data.scoreOff)}`}>{data.scoreOff}</div>
          <div className="text-[10px]">{data.earlyOff} R/g</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Def 1-3</div>
          <div className={`text-base font-bold ${scoreColor(data.scoreDef)}`}>{data.scoreDef}</div>
          <div className="text-[10px]">{data.earlyDef} R/g</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">F5</div>
          <div className="text-base font-bold text-cyan-300">{data.f5Runs.toFixed(1)}</div>
          <div className="text-[10px]">R/g</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Net</div>
          <div className={`text-base font-bold ${scoreColor(data.scoreNet)}`}>{data.scoreNet}</div>
          <div className="text-[10px]">{data.netTesi > 0 ? "+" : ""}{data.netTesi.toFixed(1)}</div>
        </div>
      </div>

      {/* YRFI / NRFI / OPS vs hand */}
      <div className="border-t border-slate-700 pt-2 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">YRFI</div>
          <div className={`text-sm font-bold ${data.probFirstInn >= 0.5 ? "text-orange-400" : "text-slate-300"}`}>
            {(data.probFirstInn * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">NRFI</div>
          <div className={`text-sm font-bold ${data.probNoFirstInn >= 0.5 ? "text-blue-400" : "text-slate-300"}`}>
            {(data.probNoFirstInn * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">{data.opsVsHandLabel || "OPS"}</div>
          {data.opsVsHand !== undefined ? (
            <div className={`text-sm font-bold ${data.opsVsHand >= 0.750 ? "text-orange-400" : data.opsVsHand >= 0.700 ? "text-yellow-400" : "text-slate-300"}`}>
              {data.opsVsHand.toFixed(3)}
            </div>
          ) : <div className="text-sm text-slate-500">N/D</div>}
        </div>
      </div>

      {/* Lineup top-3 + Pitcher rival */}
      <div className="border-t border-slate-700 pt-2 grid grid-cols-2 gap-2 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase flex items-center justify-center gap-1">
            Top-3 Lineup
            {data.lineupConfirmed === false && (
              <AlertCircle className="w-3 h-3 text-yellow-400" />
            )}
          </div>
          {data.scoreLineup !== undefined ? (
            <>
              <div className={`text-sm font-bold ${scoreColor(data.scoreLineup)}`}>{data.scoreLineup}</div>
              <div className="text-[9px] text-slate-400">
                OBP {data.lineupTop3Obp?.toFixed(3) ?? "—"} · K% {data.lineupTop3K ? (data.lineupTop3K * 100).toFixed(0) + "%" : "—"}
              </div>
              {data.lineupConfirmed === false && (
                <div className="text-[9px] text-yellow-500 italic">proyectado</div>
              )}
            </>
          ) : <div className="text-sm text-slate-500">N/D</div>}
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Pitcher Vuln</div>
          {data.scorePitcherVuln !== undefined ? (
            <>
              <div className={`text-sm font-bold ${scoreColor(data.scorePitcherVuln)}`}>{data.scorePitcherVuln}</div>
              <div className="text-[9px] text-slate-400">
                {data.pitcher1stInnEra !== undefined && `1Inn ERA ${data.pitcher1stInnEra.toFixed(2)}`}
                {data.pitcher1stInnEra !== undefined && data.pitcherTto1xwoba !== undefined && " · "}
                {data.pitcherTto1xwoba !== undefined && `TTO1 xwOBA ${data.pitcherTto1xwoba.toFixed(3)}`}
              </div>
            </>
          ) : <div className="text-sm text-slate-500">N/D</div>}
        </div>
      </div>

      <div className="text-[11px] italic text-slate-300 mt-1">{data.recommendation}</div>
    </div>
  );
}

export function MlbTesiCard({
  homeTeamId, awayTeamId, homeTeamName, awayTeamName,
  gamePk, homePitcherId, homePitcherHand, awayPitcherId, awayPitcherHand, gameDate,
}: Props) {
  // Para HOME: el pitcher rival es el AWAY
  const homeQ = useQuery<{ success: boolean; data: TesiData }>({
    queryKey: [`tesi-home-${homeTeamId}-${gamePk}-${awayPitcherId}-${awayPitcherHand}-${gameDate}`],
    enabled: !!homeTeamId,
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.set("name", homeTeamName || "");
      if (gamePk) qs.set("gamePk", String(gamePk));
      if (awayPitcherId) qs.set("pitcherId", String(awayPitcherId));
      if (awayPitcherHand) qs.set("hand", awayPitcherHand);
      if (gameDate) qs.set("date", gameDate);
      const r = await fetch(`${API_BASE}/api/mlb/tesi/${homeTeamId}?${qs}`);
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  // Para AWAY: el pitcher rival es el HOME
  const awayQ = useQuery<{ success: boolean; data: TesiData }>({
    queryKey: [`tesi-away-${awayTeamId}-${gamePk}-${homePitcherId}-${homePitcherHand}-${gameDate}`],
    enabled: !!awayTeamId,
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.set("name", awayTeamName || "");
      if (gamePk) qs.set("gamePk", String(gamePk));
      if (homePitcherId) qs.set("pitcherId", String(homePitcherId));
      if (homePitcherHand) qs.set("hand", homePitcherHand);
      if (gameDate) qs.set("date", gameDate);
      const r = await fetch(`${API_BASE}/api/mlb/tesi/${awayTeamId}?${qs}`);
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  if (!homeTeamId && !awayTeamId) return null;

  const homeData = homeQ.data?.data;
  const awayData = awayQ.data?.data;
  const isLoading = homeQ.isLoading || awayQ.isLoading;

  // Edge combinado: si un equipo tiene mejor netTesi por +0.8 R/g → ventaja early clara
  let combinedEdge: { side: "Home" | "Away"; diff: number } | null = null;
  if (homeData && awayData && homeData.dataStatus === "VERIFIED" && awayData.dataStatus === "VERIFIED") {
    const diff = homeData.netTesi - awayData.netTesi;
    if (Math.abs(diff) >= 0.8) {
      combinedEdge = { side: diff > 0 ? "Home" : "Away", diff: Math.abs(diff) };
    }
  }

  return (
    <Card className="border-emerald-500/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="w-4 h-4 text-emerald-400" />
          Team Early Scoring Index (TESI v2) · 7 componentes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <div className="text-sm text-muted-foreground">Cargando datos early scoring (puede tomar 5-10s)...</div>}
        {!isLoading && !homeData && !awayData && (
          <div className="text-sm text-muted-foreground">Sin datos disponibles</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {awayData && <TeamTesiPanel data={awayData} label={awayTeamName ? `✈️ ${awayTeamName}` : "Visitante"} />}
          {homeData && <TeamTesiPanel data={homeData} label={homeTeamName ? `🏠 ${homeTeamName}` : "Local"} />}
        </div>

        {combinedEdge && (
          <div className="p-2 rounded bg-emerald-900/30 border border-emerald-500/40 text-xs flex items-center gap-2">
            {combinedEdge.side === "Home" ? <TrendingUp className="w-4 h-4 text-emerald-400" /> : <TrendingDown className="w-4 h-4 text-emerald-400" />}
            <span>
              <span className="font-semibold text-emerald-300">{combinedEdge.side === "Home" ? "Local" : "Visitante"}</span>
              {" "}tiene ventaja early scoring de <span className="font-bold">+{combinedEdge.diff.toFixed(1)} R/g</span> (innings 1-3).
              Considerar F5 a su favor.
            </span>
          </div>
        )}

        {homeData && awayData && (
          <div className="text-[11px] text-muted-foreground italic">
            7 componentes: runs 1-3, F5, YRFI/NRFI, OPS vs hand, top-3 OBP/K%, pitcher rival 1st inn ERA + TTO1 xwOBA.
            Scores normalizados vs liga (50=promedio). <AlertCircle className="w-3 h-3 inline text-yellow-400" /> = lineup proyectado.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

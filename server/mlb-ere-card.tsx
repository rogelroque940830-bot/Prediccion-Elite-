import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, AlertCircle, TrendingUp, TrendingDown, Info } from "lucide-react";
import { API_BASE } from "@/lib/queryClient";

interface EreVar {
  raw: number | null;
  score: number;
  weight: number;
  sample: number;
}

interface EreData {
  teamId: number;
  teamName: string;
  ereScore: number;
  ereRaw: number;
  category: string;
  offenseScore: number;
  pitcherSuppressionScore: number;
  parkFactor: number;
  weatherModifier: number;
  variables: {
    offense: Record<string, EreVar>;
    pitcher: Record<string, EreVar>;
  };
  marketSuggestions: string[];
  warnings: string[];
  dataSources?: {
    top5xwoba: "savant" | "proxy" | "none";
    savantXwobaRaw?: number;
    savantPa?: number;
  };
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
  venue?: string;
  tempF?: number;
  windMph?: number;
  windOut?: boolean;
}

const categoryColor = (c: string): string => {
  if (c === "ELITE_EARLY") return "bg-red-500/30 text-red-200 border-red-500/50";
  if (c === "STRONG_EARLY") return "bg-orange-500/30 text-orange-200 border-orange-500/50";
  if (c === "SLIGHT_OVER") return "bg-yellow-500/20 text-yellow-200 border-yellow-500/40";
  if (c === "NEUTRAL") return "bg-slate-500/20 text-slate-300 border-slate-500/40";
  if (c === "SLOW_START") return "bg-blue-500/20 text-blue-300 border-blue-500/40";
  if (c === "STRONG_SLOW") return "bg-blue-600/30 text-blue-200 border-blue-600/50";
  return "bg-slate-500/20 text-slate-300";
};

const categoryLabel = (c: string): string => {
  const m: Record<string, string> = {
    ELITE_EARLY: "🔥 ELITE EARLY",
    STRONG_EARLY: "⚡ STRONG EARLY",
    SLIGHT_OVER: "↗ SLIGHT OVER",
    NEUTRAL: "= NEUTRAL",
    SLOW_START: "↘ SLOW START",
    STRONG_SLOW: "🧊 STRONG SLOW",
  };
  return m[c] || c;
};

const scoreColor = (s: number): string => {
  if (s >= 70) return "text-red-400";
  if (s >= 60) return "text-orange-400";
  if (s >= 50) return "text-yellow-400";
  if (s >= 40) return "text-blue-400";
  return "text-blue-500";
};

function ScoreGauge({ value, label, size = "md" }: { value: number; label: string; size?: "sm" | "md" | "lg" }) {
  const sizeClass = size === "lg" ? "text-3xl" : size === "md" ? "text-xl" : "text-sm";
  return (
    <div className="text-center">
      <div className={`${sizeClass} font-bold ${scoreColor(value)}`}>{value.toFixed(0)}</div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}

const VAR_LABELS: Record<string, string> = {
  runs13: "Runs 1-3", f5: "F5 Runs", yrfi: "YRFI %",
  top5xwoba: "xwOBA T5", top3obp: "OBP T3", top5k: "K% T5",
  top5iso: "ISO T5", l7rpg: "L7 RPG",
  firstInnEra: "1Inn ERA", xwobaTto1: "xwOBA TTO1", kbbTto1: "K-BB% TTO1",
  runs13Gs: "R 1-3/GS", yrfiAllowed: "YRFI allow", pitchCount: "P count 1-2",
  ttoPenalty: "TTO pen", whip13: "WHIP 1-3",
};

function TeamErePanel({ data, label }: { data: EreData; label: string }) {
  return (
    <div className="space-y-3 p-3 rounded-lg bg-slate-800/40 border border-slate-700">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm">{label}</h4>
        <Badge className={categoryColor(data.category)} variant="outline">
          {categoryLabel(data.category)}
        </Badge>
      </div>

      {/* Badge procedencia de datos xwOBA */}
      {data.dataSources && (
        <div className="flex flex-wrap gap-1 text-[9px]">
          {data.dataSources.top5xwoba === "savant" && (
            <Badge variant="outline" className="text-[9px] bg-emerald-900/30 border-emerald-500/50 text-emerald-300 px-1.5 py-0">
              xwOBA: Savant real {data.dataSources.savantXwobaRaw?.toFixed(3)}
            </Badge>
          )}
          {data.dataSources.top5xwoba === "proxy" && (
            <Badge variant="outline" className="text-[9px] bg-yellow-900/20 border-yellow-500/40 text-yellow-300 px-1.5 py-0">
              xwOBA: proxy lineup
            </Badge>
          )}
          {data.dataSources.top5xwoba === "none" && (
            <Badge variant="outline" className="text-[9px] bg-slate-800 border-slate-600 text-slate-400 px-1.5 py-0">
              xwOBA: N/D
            </Badge>
          )}
        </div>
      )}

      {/* Main ERE score + sub-scores */}
      <div className="grid grid-cols-3 gap-2 items-center bg-slate-900/40 rounded p-2">
        <ScoreGauge value={data.ereScore} label="ERE" size="lg" />
        <ScoreGauge value={data.offenseScore} label="Offense" />
        <ScoreGauge value={data.pitcherSuppressionScore} label="Sup. Rival" />
      </div>

      {/* Modifiers */}
      {(data.parkFactor !== 1 || data.weatherModifier !== 1) && (
        <div className="text-[10px] flex gap-2 justify-center text-muted-foreground">
          {data.parkFactor !== 1 && <span>Park: <span className={data.parkFactor > 1 ? "text-orange-400" : "text-blue-400"}>{data.parkFactor.toFixed(2)}×</span></span>}
          {data.weatherModifier !== 1 && <span>Weather: <span className={data.weatherModifier > 1 ? "text-orange-400" : "text-blue-400"}>{data.weatherModifier.toFixed(2)}×</span></span>}
        </div>
      )}

      {/* Variables collapsible */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Ver 16 variables individuales
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
          <div className="space-y-1">
            <div className="font-semibold text-emerald-400">OFFENSE</div>
            {Object.entries(data.variables.offense).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-slate-400">{VAR_LABELS[k] || k}</span>
                <span className={v.raw === null ? "text-slate-600" : scoreColor(v.score)}>
                  {v.raw === null ? "N/D" : `${v.score.toFixed(0)}`}
                  <span className="text-slate-500"> ({(v.weight * 100).toFixed(0)}%)</span>
                </span>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <div className="font-semibold text-blue-400">PITCHER</div>
            {Object.entries(data.variables.pitcher).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-slate-400">{VAR_LABELS[k] || k}</span>
                <span className={v.raw === null ? "text-slate-600" : scoreColor(v.score)}>
                  {v.raw === null ? "N/D" : `${v.score.toFixed(0)}`}
                  <span className="text-slate-500"> ({(v.weight * 100).toFixed(0)}%)</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </details>

      {/* Sugerencias mercado */}
      {data.marketSuggestions.length > 0 && (
        <div className="border-t border-slate-700 pt-2">
          <div className="text-[10px] uppercase text-muted-foreground mb-1">Mercados sugeridos</div>
          <div className="flex flex-wrap gap-1">
            {data.marketSuggestions.map((s, i) => (
              <Badge key={i} variant="outline" className="text-[10px] bg-emerald-900/20 border-emerald-500/30 text-emerald-300">
                {s}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="border-t border-yellow-500/20 pt-1 space-y-0.5">
          {data.warnings.map((w, i) => (
            <div key={i} className="text-[10px] text-yellow-400 flex items-start gap-1">
              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" /> {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MlbEreCard({
  homeTeamId, awayTeamId, homeTeamName, awayTeamName,
  gamePk, homePitcherId, homePitcherHand, awayPitcherId, awayPitcherHand,
  venue, tempF, windMph, windOut,
}: Props) {
  const homeQ = useQuery<{ success: boolean; data: EreData }>({
    queryKey: [`ere-home-${homeTeamId}-${gamePk}-${awayPitcherId}-${awayPitcherHand}-${venue}-${tempF}`],
    enabled: !!homeTeamId,
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.set("name", homeTeamName || "");
      if (gamePk) qs.set("gamePk", String(gamePk));
      if (awayPitcherId) qs.set("pitcherId", String(awayPitcherId));
      if (awayPitcherHand) qs.set("hand", awayPitcherHand);
      if (venue) qs.set("venue", venue);
      if (tempF !== undefined) qs.set("tempF", String(tempF));
      if (windMph !== undefined) qs.set("windMph", String(windMph));
      if (windOut) qs.set("windOut", "true");
      const r = await fetch(`${API_BASE}/api/mlb/ere/${homeTeamId}?${qs}`);
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  const awayQ = useQuery<{ success: boolean; data: EreData }>({
    queryKey: [`ere-away-${awayTeamId}-${gamePk}-${homePitcherId}-${homePitcherHand}-${venue}-${tempF}`],
    enabled: !!awayTeamId,
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.set("name", awayTeamName || "");
      if (gamePk) qs.set("gamePk", String(gamePk));
      if (homePitcherId) qs.set("pitcherId", String(homePitcherId));
      if (homePitcherHand) qs.set("hand", homePitcherHand);
      if (venue) qs.set("venue", venue);
      if (tempF !== undefined) qs.set("tempF", String(tempF));
      if (windMph !== undefined) qs.set("windMph", String(windMph));
      if (windOut) qs.set("windOut", "true");
      const r = await fetch(`${API_BASE}/api/mlb/ere/${awayTeamId}?${qs}`);
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  if (!homeTeamId && !awayTeamId) return null;

  const homeData = homeQ.data?.data;
  const awayData = awayQ.data?.data;
  const isLoading = homeQ.isLoading || awayQ.isLoading;

  // Composite del juego: promedio de ambos ERE
  let gameComposite: number | null = null;
  let gameSignal: string | null = null;
  if (homeData && awayData) {
    gameComposite = (homeData.ereScore + awayData.ereScore) / 2;
    if (gameComposite >= 65) gameSignal = "F5 OVER / Full Game OVER lean";
    else if (gameComposite <= 40) gameSignal = "F5 UNDER / NRFI";
    else gameSignal = "F5 neutral";
  }

  return (
    <Card className="border-emerald-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Zap className="w-4 h-4 text-emerald-400" />
          Early Run Environment (ERE) · 16 variables
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <div className="text-sm text-muted-foreground">Cargando ERE (10-15s primera vez)...</div>}
        {!isLoading && !homeData && !awayData && (
          <div className="text-sm text-muted-foreground">Sin datos disponibles</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {awayData && <TeamErePanel data={awayData} label={awayTeamName ? `✈️ ${awayTeamName}` : "Visitante"} />}
          {homeData && <TeamErePanel data={homeData} label={homeTeamName ? `🏠 ${homeTeamName}` : "Local"} />}
        </div>

        {gameComposite !== null && gameSignal && (
          <div className="p-2 rounded bg-emerald-900/20 border border-emerald-500/30 text-xs flex items-center gap-2">
            {gameComposite >= 65 ? <TrendingUp className="w-4 h-4 text-orange-400" /> : gameComposite <= 40 ? <TrendingDown className="w-4 h-4 text-blue-400" /> : <Info className="w-4 h-4 text-slate-400" />}
            <span>
              Composite del juego: <span className="font-bold">{gameComposite.toFixed(0)}/100</span> — {gameSignal}
            </span>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground italic">
          ERE = 50% Offense + 50% (100 − Pitcher Suppression rival). Modulado por park & weather.
          Umbrales: 75+ Elite, 65-74 Strong, 55-64 Lean, 45-54 Neutral, 35-44 Slow, &lt;35 Strong Slow.
        </div>
      </CardContent>
    </Card>
  );
}

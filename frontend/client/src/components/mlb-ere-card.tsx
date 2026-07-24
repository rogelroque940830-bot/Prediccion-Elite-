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
    lineupSource?: "rotowire" | "mlb-boxscore" | "mlb-pa-fallback" | "none";
    lineupStatus?: "CONFIRMED" | "EXPECTED" | "PROJECTED" | "UNKNOWN";
    lineupBatters?: number;
  };
  // F5 INNING-BY-INNING DATA (nuevo 14 jun 2026)
  // Valores principales son BLENDED (recent 60% + season 40%) cuando hay sample.
  // *Season expone season-only para comparación visual.
  f5InningData?: {
    inningsByInning: Record<string, { era: number; ip: number; er: number; k: number; bb: number; h: number; hr: number }> | null;
    f5Era: number | null;       // BLENDED
    f5EraSeason: number | null; // Season only
    f5K9: number | null;
    f5Bb9: number | null;
    f5KbbPct: number | null;
    f5Whip: number | null;
    f5Hr9: number | null;
    f5Ip: number;
    hasRecentForm: boolean;
    tto1EraProxy: number | null;
    tto1EraSeason: number | null;
    tto2EraProxy: number | null;
    tto2EraSeason: number | null;
    tto3EraProxy: number | null;
    tto3EraSeason: number | null;
    ttoPenaltyEra: number | null;
    tto3PenaltyEra: number | null;
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
  // NEW 14 jun 2026
  f5EraBlended: "F5 ERA*", inning23Era: "ERA I2-3",
};

function TeamErePanel({ data, label }: { data: EreData; label: string }) {
  // FIX 14 jun 2026: badge BAJA CONFIANZA cuando >=3 variables pitcher N/D (raw===null)
  // Senal visual de que el ERE se apoya en prior, no en datos reales del pitcher.
  const pitcherNdCount = Object.values(data.variables.pitcher).filter(v => v.raw === null).length;
  const offenseNdCount = Object.values(data.variables.offense).filter(v => v.raw === null).length;
  const totalNd = pitcherNdCount + offenseNdCount;
  const lowConfidence = pitcherNdCount >= 3 || totalNd >= 5;
  const partialConfidence = !lowConfidence && totalNd >= 2;

  return (
    <div className="space-y-3 p-3 rounded-lg bg-slate-800/40 border border-slate-700">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm">{label}</h4>
        <div className="flex gap-1 items-center">
          {lowConfidence && (
            <Badge variant="outline" className="text-[9px] bg-red-900/40 border-red-500/60 text-red-300 px-1.5 py-0" title={`${pitcherNdCount} N/D pitcher, ${offenseNdCount} N/D offense`}>
              BAJA CONFIANZA · {totalNd} N/D
            </Badge>
          )}
          {partialConfidence && (
            <Badge variant="outline" className="text-[9px] bg-yellow-900/30 border-yellow-500/50 text-yellow-300 px-1.5 py-0" title={`${pitcherNdCount} N/D pitcher, ${offenseNdCount} N/D offense`}>
              Cobertura parcial · {totalNd} N/D
            </Badge>
          )}
          <Badge className={categoryColor(data.category)} variant="outline">
            {categoryLabel(data.category)}
          </Badge>
        </div>
      </div>

      {/* Badges procedencia de datos */}
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
          {data.dataSources.lineupSource === "rotowire" && (
            <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${
              data.dataSources.lineupStatus === "CONFIRMED"
                ? "bg-emerald-900/30 border-emerald-500/50 text-emerald-300"
                : data.dataSources.lineupStatus === "EXPECTED"
                ? "bg-orange-900/30 border-orange-500/50 text-orange-300"
                : "bg-slate-700/40 border-slate-500/40 text-slate-300"
            }`}>
              Lineup {data.dataSources.lineupStatus} {data.dataSources.lineupBatters}/9
            </Badge>
          )}
          {data.dataSources.lineupSource === "mlb-boxscore" && (
            <Badge variant="outline" className="text-[9px] bg-slate-800 border-slate-600 text-slate-300 px-1.5 py-0">
              Lineup: MLB box
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

      {/* F5 INNING-BY-INNING + TTO REAL (nuevo) */}
      {data.f5InningData && data.f5InningData.f5Ip > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground flex items-center gap-2">
            <span>🎯 F5 Pitcher — Inning por inning + TTO real</span>
            {data.f5InningData.hasRecentForm && (
              <Badge variant="outline" className="text-[9px] bg-purple-900/30 border-purple-500/50 text-purple-300 px-1.5 py-0">
                BLEND 60% recent + 40% season
              </Badge>
            )}
            {!data.f5InningData.hasRecentForm && (
              <Badge variant="outline" className="text-[9px] bg-slate-800 border-slate-600 text-slate-400 px-1.5 py-0">
                Season only
              </Badge>
            )}
          </summary>
          <div className="mt-2 space-y-3 text-[10px]">
            {/* ERA por inning 1-5 */}
            {data.f5InningData.inningsByInning && (
              <div>
                <div className="font-semibold text-purple-400 mb-1">ERA por inning (F5)</div>
                <div className="grid grid-cols-5 gap-1">
                  {["i01", "i02", "i03", "i04", "i05"].map((code) => {
                    const i = data.f5InningData!.inningsByInning?.[code];
                    if (!i) return (
                      <div key={code} className="text-center p-1 rounded bg-slate-900/40">
                        <div className="text-slate-600">N/D</div>
                        <div className="text-[8px] text-slate-500">Inn {code.slice(2)}</div>
                      </div>
                    );
                    const eraColor = i.era < 3 ? "text-emerald-400" : i.era < 4.5 ? "text-yellow-400" : i.era < 6 ? "text-orange-400" : "text-red-400";
                    return (
                      <div key={code} className="text-center p-1 rounded bg-slate-900/40">
                        <div className={`font-bold ${eraColor}`}>{i.era.toFixed(2)}</div>
                        <div className="text-[8px] text-slate-500">Inn {code.slice(2)} ({i.ip}IP)</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* F5 agregada */}
            <div className="grid grid-cols-3 gap-2 bg-slate-900/40 rounded p-2">
              <div>
                <div className="text-slate-500 text-[9px]">F5 ERA {data.f5InningData.hasRecentForm ? "(blend)" : ""}</div>
                <div className={`font-bold ${data.f5InningData.f5Era !== null && data.f5InningData.f5Era < 4.5 ? "text-emerald-400" : "text-orange-400"}`}>
                  {data.f5InningData.f5Era?.toFixed(2) ?? "N/D"}
                </div>
                {data.f5InningData.hasRecentForm && data.f5InningData.f5EraSeason !== null && (
                  <div className="text-[8px] text-slate-500">season: {data.f5InningData.f5EraSeason.toFixed(2)}</div>
                )}
              </div>
              <div>
                <div className="text-slate-500 text-[9px]">F5 K-BB%</div>
                <div className={`font-bold ${data.f5InningData.f5KbbPct !== null && data.f5InningData.f5KbbPct > 4 ? "text-emerald-400" : "text-orange-400"}`}>
                  {data.f5InningData.f5KbbPct?.toFixed(2) ?? "N/D"}
                </div>
              </div>
              <div>
                <div className="text-slate-500 text-[9px]">F5 WHIP</div>
                <div className={`font-bold ${data.f5InningData.f5Whip !== null && data.f5InningData.f5Whip < 1.3 ? "text-emerald-400" : "text-orange-400"}`}>
                  {data.f5InningData.f5Whip?.toFixed(2) ?? "N/D"}
                </div>
              </div>
            </div>

            {/* TTO Real (ERA based) */}
            <div>
              <div className="font-semibold text-cyan-400 mb-1">
                TTO Real (ERA based) {data.f5InningData.hasRecentForm && <span className="text-purple-300 text-[8px]">[blend recent/season]</span>}
              </div>
              <div className="grid grid-cols-3 gap-1">
                <div className="text-center p-1 rounded bg-slate-900/40">
                  <div className="font-bold text-cyan-300">{data.f5InningData.tto1EraProxy?.toFixed(2) ?? "N/D"}</div>
                  <div className="text-[8px] text-slate-500">TTO1 (i1-3)</div>
                  {data.f5InningData.hasRecentForm && data.f5InningData.tto1EraSeason !== null && (
                    <div className="text-[8px] text-slate-600">season: {data.f5InningData.tto1EraSeason.toFixed(2)}</div>
                  )}
                </div>
                <div className="text-center p-1 rounded bg-slate-900/40">
                  <div className="font-bold text-cyan-300">{data.f5InningData.tto2EraProxy?.toFixed(2) ?? "N/D"}</div>
                  <div className="text-[8px] text-slate-500">TTO2 (i4-6)</div>
                  {data.f5InningData.hasRecentForm && data.f5InningData.tto2EraSeason !== null && (
                    <div className="text-[8px] text-slate-600">season: {data.f5InningData.tto2EraSeason.toFixed(2)}</div>
                  )}
                </div>
                <div className="text-center p-1 rounded bg-slate-900/40">
                  <div className="font-bold text-cyan-300">{data.f5InningData.tto3EraProxy?.toFixed(2) ?? "N/D"}</div>
                  <div className="text-[8px] text-slate-500">TTO3 (i7-9)</div>
                  {data.f5InningData.hasRecentForm && data.f5InningData.tto3EraSeason !== null && (
                    <div className="text-[8px] text-slate-600">season: {data.f5InningData.tto3EraSeason.toFixed(2)}</div>
                  )}
                </div>
              </div>
              {data.f5InningData.ttoPenaltyEra !== null && (
                <div className="mt-2 text-center">
                  <span className="text-slate-500">TTO penalty (TTO2 - TTO1): </span>
                  <span className={`font-bold ${data.f5InningData.ttoPenaltyEra > 1 ? "text-red-400" : data.f5InningData.ttoPenaltyEra > 0 ? "text-yellow-400" : "text-emerald-400"}`}>
                    {data.f5InningData.ttoPenaltyEra > 0 ? "+" : ""}{data.f5InningData.ttoPenaltyEra.toFixed(2)}
                  </span>
                  <span className="text-slate-500 ml-1">
                    ({data.f5InningData.ttoPenaltyEra > 1 ? "se desploma 2da vuelta" : data.f5InningData.ttoPenaltyEra > 0 ? "empeora ligeramente" : "se mantiene/mejora"})
                  </span>
                </div>
              )}
            </div>
          </div>
        </details>
      )}

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

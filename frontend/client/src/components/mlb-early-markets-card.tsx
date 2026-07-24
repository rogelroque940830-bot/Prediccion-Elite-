import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Target, TrendingUp, TrendingDown, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { API_BASE } from "@/lib/queryClient";

interface EarlyMarkets {
  f5ProbHome: number; f5ProbAway: number;
  f5RecommendedSide: "HOME" | "AWAY" | "PASS";
  f5MlEdge?: number;
  f5TotalRunsEstimated: number;
  f5OverProb?: number; f5UnderProb?: number;
  f5OverEdge?: number; f5UnderEdge?: number;
  f5TotalSide?: "OVER" | "UNDER" | "PASS";
  probAnyRun1stInn: number; probNoRun1stInn: number;
  nrfiEdge?: number; yrfiEdge?: number;
  nrfiYrfiRec?: "NRFI" | "YRFI" | "PASS";
  inning1: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  inning2: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  inning3: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  confidence: "HIGH" | "MEDIUM" | "LOW";
  warnings: string[];
  // Team Total F5 markets (7 jul): probabilidad por lado según ERE category
  teamTotalOver15F5?: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  teamTotalUnder25F5?: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  // Recomendación final agregada
  finalRecommendation?: {
    market: "F5_ML" | "INNING_1_ML" | "TT_OVER_15_F5" | "TT_UNDER_25_F5" | "PASS";
    side: "HOME" | "AWAY" | "PASS";
    action: "BET" | "PASS";
    reason: string;
    isPremium?: boolean;
  };
  // Picks alternos PREMIUM (cuando hay 2+ PREMIUM, el usuario decide)
  alternativePicks?: Array<{
    market: "F5_ML" | "INNING_1_ML" | "TT_OVER_15_F5" | "TT_UNDER_25_F5";
    side: "HOME" | "AWAY";
    prob: number;
    reason: string;
    isPremium: boolean;
  }>;
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
  // Optional book lines
  f5OverLine?: number;
  f5OverOdds?: number;
  f5UnderOdds?: number;
  f5HomeMlOdds?: number;
  f5AwayMlOdds?: number;
  nrfiOdds?: number;
  yrfiOdds?: number;
}

const sideBadge = (side: string, label: string): JSX.Element => {
  if (side === "PASS") return <Badge variant="outline" className="text-slate-400 border-slate-500/40">PASS</Badge>;
  const color = side === "OVER" || side === "YRFI" || side === "HOME"
    ? "bg-orange-500/30 text-orange-200 border-orange-500/50"
    : "bg-blue-500/30 text-blue-200 border-blue-500/50";
  return <Badge className={color} variant="outline">{label}</Badge>;
};

const edgeColor = (edge?: number): string => {
  if (edge === undefined) return "text-slate-500";
  if (edge >= 5) return "text-green-400 font-bold";
  if (edge >= 2) return "text-green-300";
  if (edge >= 0) return "text-emerald-400";
  return "text-red-400";
};

function MarketRow({ label, sideElement, probHome, probAway, edge, line }: {
  label: string;
  sideElement: JSX.Element;
  probHome?: number; probAway?: number;
  edge?: number;
  line?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-800 last:border-0">
      <div className="flex-1">
        <div className="text-xs font-semibold">{label}</div>
        {(probHome !== undefined && probAway !== undefined) && (
          <div className="text-[10px] text-slate-400">
            H {(probHome * 100).toFixed(0)}% · A {(probAway * 100).toFixed(0)}%
          </div>
        )}
        {line && <div className="text-[10px] text-slate-500">{line}</div>}
      </div>
      <div className="flex items-center gap-2">
        {edge !== undefined && (
          <span className={`text-xs ${edgeColor(edge)}`}>
            {edge >= 0 ? "+" : ""}{edge.toFixed(1)}pp
          </span>
        )}
        {sideElement}
      </div>
    </div>
  );
}

export function MlbEarlyMarketsCard(props: Props) {
  const {
    homeTeamId, awayTeamId, homeTeamName, awayTeamName, gamePk,
    homePitcherId, homePitcherHand, awayPitcherId, awayPitcherHand,
  } = props;

  const q = useQuery<{ success: boolean; data: { markets: EarlyMarkets } }>({
    queryKey: [
      "early-markets", homeTeamId, awayTeamId, gamePk,
      props.f5OverLine, props.f5OverOdds, props.f5UnderOdds,
      props.nrfiOdds, props.yrfiOdds,
    ],
    enabled: !!homeTeamId && !!awayTeamId,
    queryFn: async () => {
      const body = {
        home: {
          teamId: homeTeamId, teamName: homeTeamName, gamePk,
          opposingPitcherId: awayPitcherId, opposingPitcherHand: awayPitcherHand,
        },
        away: {
          teamId: awayTeamId, teamName: awayTeamName, gamePk,
          opposingPitcherId: homePitcherId, opposingPitcherHand: homePitcherHand,
        },
        lines: {
          f5OverLine: props.f5OverLine,
          f5OverOdds: props.f5OverOdds, f5UnderOdds: props.f5UnderOdds,
          f5HomeMlOdds: props.f5HomeMlOdds, f5AwayMlOdds: props.f5AwayMlOdds,
          nrfiOdds: props.nrfiOdds, yrfiOdds: props.yrfiOdds,
        },
      };
      const r = await fetch(`${API_BASE}/api/mlb/early-markets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return r.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  if (!homeTeamId || !awayTeamId) return null;
  const m = q.data?.data?.markets;
  const isLoading = q.isLoading;

  return (
    <Card className="border-purple-500/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Target className="w-4 h-4 text-purple-400" />
          Mercados Early MLB · F5 + NRFI/YRFI + Innings 1-2-3
          {m && (
            <Badge variant="outline" className={`ml-auto text-[10px] ${
              m.confidence === "HIGH" ? "bg-green-500/20 text-green-300 border-green-500/40" :
              m.confidence === "MEDIUM" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
              "bg-red-500/20 text-red-300 border-red-500/40"
            }`}>
              Conf {m.confidence}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <div className="text-sm text-slate-400">Calculando mercados early (15-20s)...</div>}
        {!isLoading && !m && <div className="text-sm text-slate-400">Sin datos disponibles</div>}

        {m && (
          <>
            {/* 🎯 PICK RECOMENDADO (reglas 23 jun + recalibración 1 jul) */}
            {m.finalRecommendation && (
              <div className={`rounded-lg p-3 border-2 ${
                m.finalRecommendation.action === "BET"
                  ? m.finalRecommendation.reason.includes("Light bucket")
                    ? "bg-yellow-500/10 border-yellow-500/60"
                    : "bg-green-500/10 border-green-500/60"
                  : "bg-red-500/10 border-red-500/40"
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  {m.finalRecommendation.action === "BET" ? (
                    <CheckCircle2 className={`w-4 h-4 ${m.finalRecommendation.reason.includes("Light bucket") ? "text-yellow-400" : "text-green-400"}`} />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400" />
                  )}
                  <span className={`text-[10px] uppercase font-bold tracking-wide ${
                    m.finalRecommendation.action === "BET"
                      ? m.finalRecommendation.reason.includes("Light bucket") ? "text-yellow-300" : "text-green-300"
                      : "text-red-300"
                  }`}>
                    Pick Recomendado
                  </span>
                  {m.finalRecommendation.action === "BET" && (
                    <Badge className={`ml-auto text-[10px] ${
                      m.finalRecommendation.reason.includes("Light bucket")
                        ? "bg-yellow-500/30 text-yellow-200 border-yellow-500/50"
                        : "bg-green-500/30 text-green-200 border-green-500/50"
                    }`} variant="outline">
                      {m.finalRecommendation.market} · {m.finalRecommendation.side}
                    </Badge>
                  )}
                  {m.finalRecommendation.action === "PASS" && (
                    <Badge className="ml-auto text-[10px] bg-red-500/30 text-red-200 border-red-500/50" variant="outline">
                      PASS
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-slate-300 leading-snug">
                  {m.finalRecommendation.reason}
                </div>
              </div>
            )}

            {/* Alternativas PREMIUM (cuando hay 2+ PREMIUM en el mismo juego) */}
            {m.alternativePicks && m.alternativePicks.length > 0 && (
              <div className="rounded-lg p-3 border-2 border-amber-500/40 bg-amber-500/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase font-bold tracking-wide text-amber-300">
                    🏆 Tú decides — Otro(s) PREMIUM disponible(s)
                  </span>
                </div>
                <div className="space-y-2">
                  {m.alternativePicks.map((alt, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs text-slate-300">
                      <Badge className="text-[10px] bg-amber-500/25 text-amber-200 border-amber-500/50 shrink-0" variant="outline">
                        {alt.market} · {alt.side}
                      </Badge>
                      <span className="leading-snug">{alt.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* F5 MARKETS */}
            <div className="bg-slate-900/40 rounded p-2 border border-slate-700/50">
              <div className="text-[10px] uppercase text-purple-400 font-semibold mb-1">F5 (First 5 Innings)</div>
              <MarketRow
                label="F5 Moneyline"
                sideElement={sideBadge(m.f5RecommendedSide, m.f5RecommendedSide)}
                probHome={m.f5ProbHome}
                probAway={m.f5ProbAway}
                edge={m.f5MlEdge}
              />
              <MarketRow
                label="F5 Total Runs"
                line={`Modelo: ${m.f5TotalRunsEstimated} runs${props.f5OverLine ? ` · Línea: ${props.f5OverLine}` : ""}`}
                sideElement={sideBadge(m.f5TotalSide ?? "PASS", m.f5TotalSide ?? "PASS")}
                edge={m.f5TotalSide === "OVER" ? m.f5OverEdge : m.f5TotalSide === "UNDER" ? m.f5UnderEdge : undefined}
              />
            </div>

            {/* NRFI/YRFI */}
            <div className="bg-slate-900/40 rounded p-2 border border-slate-700/50">
              <div className="text-[10px] uppercase text-purple-400 font-semibold mb-1">First Inning</div>
              <MarketRow
                label="NRFI / YRFI"
                line={`NRFI ${(m.probNoRun1stInn * 100).toFixed(0)}% · YRFI ${(m.probAnyRun1stInn * 100).toFixed(0)}%`}
                sideElement={sideBadge(m.nrfiYrfiRec ?? "PASS", m.nrfiYrfiRec ?? "PASS")}
                edge={m.nrfiYrfiRec === "NRFI" ? m.nrfiEdge : m.nrfiYrfiRec === "YRFI" ? m.yrfiEdge : undefined}
              />
            </div>

            {/* Inning by inning */}
            <div className="bg-slate-900/40 rounded p-2 border border-slate-700/50">
              <div className="text-[10px] uppercase text-purple-400 font-semibold mb-1">Inning ML</div>
              <MarketRow
                label="1st Inning"
                sideElement={sideBadge(m.inning1.side, m.inning1.side)}
                probHome={m.inning1.homeProb}
                probAway={m.inning1.awayProb}
              />
              <MarketRow
                label="2nd Inning"
                sideElement={sideBadge(m.inning2.side, m.inning2.side)}
                probHome={m.inning2.homeProb}
                probAway={m.inning2.awayProb}
              />
              <MarketRow
                label="3rd Inning"
                sideElement={sideBadge(m.inning3.side, m.inning3.side)}
                probHome={m.inning3.homeProb}
                probAway={m.inning3.awayProb}
              />
            </div>

            {/* Warnings */}
            {m.warnings.length > 0 && (
              <div className="border-t border-yellow-500/30 pt-1.5 space-y-0.5">
                {m.warnings.slice(0, 4).map((w, i) => (
                  <div key={i} className="text-[10px] text-yellow-400 flex items-start gap-1">
                    <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" /> {w}
                  </div>
                ))}
              </div>
            )}

            <div className="text-[10px] text-slate-500 italic pt-1">
              Modelos derivados de ERE. INDEPENDIENTES del modelo full game ML/Total/Spread (cero doble conteo).
              Umbral BET: prob ≥58% del lado picado.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

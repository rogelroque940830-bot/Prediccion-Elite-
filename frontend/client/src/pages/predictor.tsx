import { useState, useCallback } from "react";
import { predict, americanToProb, kellyStake, getEdge, getSignal, evaluateSpread, evaluateTotal, getBestPlay, getScheduleAdjusted, nbaPoissonTotal, nbaFindSafePlay, generateAltLines, regressToMarket, nbaCalibrate, applyRefAdjustment, applyRefTotalAdjustment, type TeamStats, type BestPlay, type NBAPoissonResult, type NBASafePlay, type AltLine, type NBARefComposite, NBA_TEAMS } from "@/lib/model";
import { getAwayTravelDistance, travelPenalty } from "@/lib/travel";
import { useAppContext } from "@/lib/context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Brain, Save, AlertTriangle, Star, TrendingUp, RefreshCw, Zap, Check, UserX } from "lucide-react";
import { PrintFab } from "@/components/print-fab";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import { DatePickerFL, todayFL } from "@/components/date-picker-fl";
import { NBARefsCard, EliteBanner, SharpSignalsCard, NBAContextualCard, sharpBadgeFor, type SharpDirection } from "@/components/elite-factors";

interface PredictionResult {
  homeProb: number;
  awayProb: number;
  edge: number;            // edge del lado recomendado (ya no de home solo)
  signal: "BET" | "LEAN" | "PASS";
  stake: number;
  impliedProb: number;     // implied prob del lado recomendado
  homeTeam: string;
  awayTeam: string;
  odds: number;            // odds del lado recomendado
  pickedSide?: "home" | "away"; // qué lado eligió el modelo
  spread?: { expectedMargin: number; edgeVsSpread: number; signal: "BET"|"LEAN"|"PASS"; side: string; pickedSide?: "home"|"away"; coverProb?: number; confidence?: string };
  total?: { estimatedTotal: number; edge: number; signal: "BET"|"LEAN"|"PASS"; side: "OVER"|"UNDER"; hitProb?: number; confidence?: string };
  homeInjuryAdj: number;
  awayInjuryAdj: number;
  bestPlay: BestPlay | null;
  poisson?: NBAPoissonResult;
  safePlay?: NBASafePlay | null;
  altLines?: AltLine[];
  factorBreakdown?: {
    baseProb: number;
    refAdj?: number;
    totalRefAdj?: number;
    finalProb: number;
    notes: string[];
  };
}

// ── NBA API types ────────────────────────────────────────────────────────────
interface NBATeamStats {
  netRtg: number; offRtg: number; defRtg: number; pace: number;
  winPct: number; ppg: number;
  pace5?: number; ppg5?: number;
  oppAvgOffRtg?: number; oppAvgDefRtg?: number;
  oppAvgNetRtg?: number; sosLabel?: string;
  opponents?: { name: string; netRtg: number; l10NetRtg: number; blended: number }[];
  streak?: number; isB2B?: boolean; daysRest?: number;
  // Four Factors
  eFGPct?: number; ftRate?: number; tovPct?: number; orebPct?: number;
  oppEFGPct?: number; oppFTRate?: number; oppTovPct?: number; oppOrebPct?: number;
  l10EFGPct?: number; l10OppEFGPct?: number; l10TovPct?: number; l10OppTovPct?: number;
  gamesPlayed?: number;
  // Provider aliases consumed by the current auto-fill path.
  gamesLast7Days?: number; gp?: number;
  l10eFGPct?: number; l10FTRate?: number; l10OrebPct?: number;
  l10OppFTRate?: number; l10OppOrebPct?: number;
  // Home/Away splits
  homeOffRtg?: number; homeDefRtg?: number; homeNetRtg?: number; homeRecord?: string;
  awayOffRtg?: number; awayDefRtg?: number; awayNetRtg?: number; awayRecord?: string;
}
interface NBAGame {
  gameId: string;
  gameTimeUTC: string;
  homeTeam: { id: number; name: string; tricode: string };
  awayTeam: { id: number; name: string; tricode: string };
  homeStats: NBATeamStats | null;
  awayStats: NBATeamStats | null;
}

interface NBAManualTeam extends NBATeamStats {
  teamId: number;
  teamName: string;
}

function gameTimeLabel(utc: string): string {
  try {
    const d = new Date(utc);
    return d.toLocaleTimeString("es-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
  } catch { return ""; }
}

function signalColor(s: string) {
  if (s === "BET") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "LEAN") return "bg-amber-500/20 text-amber-400 border-amber-500/30";
  return "bg-red-500/20 text-red-400 border-red-500/30";
}

function streakLabel(v: number) {
  if (v === 0) return null;
  if (v >= 5) return { text: `Racha ${v}V 🔥`, color: "text-green-400" };
  if (v >= 3) return { text: `Racha ${v}V`, color: "text-green-400" };
  if (v >= 1) return { text: `Racha ${v}V`, color: "text-emerald-400" };
  if (v <= -5) return { text: `Racha ${Math.abs(v)}D ❄️`, color: "text-red-400" };
  if (v <= -3) return { text: `Racha ${Math.abs(v)}D`, color: "text-red-400" };
  return { text: `Racha ${Math.abs(v)}D`, color: "text-orange-400" };
}

function injuryLabel(adj: number) {
  if (adj === 0) return null;
  if (adj <= -6) return { text: "Estrella OUT", color: "text-red-400" };
  if (adj <= -3) return { text: "Jugador clave OUT", color: "text-amber-400" };
  if (adj < 0) return { text: "Rol OUT", color: "text-yellow-400" };
  if (adj >= 4) return { text: "Estrella regresa", color: "text-green-400" };
  return { text: "Ajuste positivo", color: "text-green-400" };
}

function confidenceColor(c: number) {
  if (c >= 75) return "text-green-400";
  if (c >= 60) return "text-amber-400";
  return "text-orange-400";
}

// gamesOut: map of player name → number of games they've been out
// If out 10+, L10 stats already reflect absence → reduce adjustment
// If out 5+, L5 also reflects it → further reduce
// Auto-detectar tipo de jugador por stats → devuelve [offFactor, defFactor]
// Si escribimos manualmente un número, usamos el default suave (1.0, 0.5)
function detectPlayerType(p: {ppg:number;rpg:number;apg:number;mpg:number}): { off: number; def: number; type: string } {
  // Defensor / rim protector: bajo PPG, alto RPG, mucho minuto
  if (p.ppg < 12 && p.rpg >= 8 && p.mpg >= 26) {
    return { off: 0.30, def: 1.00, type: "Defensor" };
  }
  // Playmaker puro: muchos asistentes, no super anotador
  if (p.apg >= 7 && p.ppg < 22) {
    return { off: 1.00, def: 0.20, type: "Playmaker" };
  }
  // Two-way estrella grande (Jokic, Giannis, LeBron): PPG alto + REB alto + APG decente
  if (p.ppg >= 22 && p.rpg >= 8 && p.apg >= 5) {
    return { off: 1.00, def: 0.90, type: "Dos-vías" };
  }
  // Anotador puro: PPG alto sin defensa o playmaking destacado
  if (p.ppg >= 20 && p.apg < 6 && p.rpg < 8) {
    return { off: 1.00, def: 0.30, type: "Anotador" };
  }
  // Default moderado
  return { off: 1.00, def: 0.50, type: "Mixto" };
}

function calcInjuryImpact(
  roster: {name:string;ppg:number;rpg:number;apg:number;mpg:number;gp:number;gamesMissed?:number}[],
  missing: Set<string>,
  gamesOut: Record<string, number>,
): { adj: number; details: string[]; offFactor: number; defFactor: number } {
  let totalAdj = 0;
  let weightedOff = 0;
  let weightedDef = 0;
  let totalWeight = 0;
  const details: string[] = [];
  for (const p of roster) {
    if (!missing.has(p.name)) continue;
    let baseAdj = 0;
    let category = "";
    if (p.ppg >= 25 || (p.ppg >= 20 && p.mpg >= 33)) {
      category = "MVP/Superestrella";
      baseAdj = -8;
    } else if (p.ppg >= 18 || (p.ppg >= 15 && p.mpg >= 30)) {
      category = "Estrella";
      baseAdj = -7;
    } else if (p.ppg >= 13 || (p.ppg >= 10 && p.mpg >= 25)) {
      category = "Jugador Clave";
      baseAdj = -5;
    } else if (p.ppg >= 8 || p.mpg >= 20) {
      category = "Rol Importante";
      baseAdj = -3;
    } else {
      category = "Rotación";
      baseAdj = -1;
    }

    const ptype = detectPlayerType(p);
    
    // Adjust based on how long they've been out
    const out = gamesOut[p.name] ?? 0;
    let adj = baseAdj;
    let note = "";
    if (out >= 10) {
      // Stats L10 ya reflejan su ausencia completamente
      adj = 0;
      note = " (10+ fuera → stats ya ajustadas)";
    } else if (out >= 5) {
      // L5 lo refleja, L10 parcialmente → 30% del impacto
      adj = Math.round(baseAdj * 0.3);
      note = ` (${out} fuera → L5 ajustado, 30% impacto)`;
    } else if (out >= 3) {
      // Reciente → 60% del impacto
      adj = Math.round(baseAdj * 0.6);
      note = ` (${out} fuera → 60% impacto)`;
    } else {
      // 0-2 partidos fuera → impacto completo
      note = out > 0 ? ` (${out} fuera → impacto total)` : " (recién lesionado)";
    }
    
    totalAdj += adj;
    // Pesar el factor por magnitud de la lesión
    const w = Math.abs(adj);
    weightedOff += ptype.off * w;
    weightedDef += ptype.def * w;
    totalWeight += w;
    details.push(`${p.name} (${p.ppg}ppg) → ${category} · ${ptype.type}: ${adj}${note}`);
  }
  const offFactor = totalWeight > 0 ? weightedOff / totalWeight : 1.0;
  const defFactor = totalWeight > 0 ? weightedDef / totalWeight : 0.5;
  return { adj: Math.max(-16, totalAdj), details, offFactor, defFactor };
}

// Jugador que REGRESA — boost positivo (espejo de lesiones)
// Si estuvo fuera 10+, las stats no lo reflejan → boost completo
// Si estuvo fuera 5-9, boost parcial
function calcReturnImpact(
  roster: {name:string;ppg:number;rpg:number;apg:number;mpg:number;gp:number;gamesMissed?:number}[],
  returning: Set<string>,
  gamesWasOut: Record<string, number>,
): { adj: number; details: string[] } {
  let totalAdj = 0;
  const details: string[] = [];
  for (const p of roster) {
    if (!returning.has(p.name)) continue;
    let baseAdj = 0;
    let category = "";
    if (p.ppg >= 25 || (p.ppg >= 20 && p.mpg >= 33)) {
      category = "MVP/Superestrella";
      baseAdj = 8;
    } else if (p.ppg >= 18 || (p.ppg >= 15 && p.mpg >= 30)) {
      category = "Estrella";
      baseAdj = 7;
    } else if (p.ppg >= 13 || (p.ppg >= 10 && p.mpg >= 25)) {
      category = "Jugador Clave";
      baseAdj = 5;
    } else if (p.ppg >= 8 || p.mpg >= 20) {
      category = "Rol Importante";
      baseAdj = 3;
    } else {
      category = "Rotación";
      baseAdj = 1;
    }
    
    const wasOut = gamesWasOut[p.name] ?? 0;
    let adj = 0;
    let note = "";
    if (wasOut >= 10) {
      adj = baseAdj;
      note = ` (estuvo ${wasOut} fuera → boost completo)`;
    } else if (wasOut >= 5) {
      adj = Math.round(baseAdj * 0.7);
      note = ` (estuvo ${wasOut} fuera → 70% boost)`;
    } else if (wasOut >= 3) {
      adj = Math.round(baseAdj * 0.4);
      note = ` (estuvo ${wasOut} fuera → 40% boost)`;
    } else {
      adj = 0;
      note = " (0-2 partidos fuera → sin boost)";
    }
    
    totalAdj += adj;
    details.push(`${p.name} (${p.ppg}ppg) → ${category}: +${adj}${note}`);
  }
  return { adj: Math.min(16, totalAdj), details };
}

export default function Predictor() {
  const { state, dispatch } = useAppContext();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  // Home
  const [homeTeam, setHomeTeam] = useState("");
  const [homeNetRtg, setHomeNetRtg] = useState("");
  const [homeOffRtg, setHomeOffRtg] = useState("");
  const [homeDefRtg, setHomeDefRtg] = useState("");
  const [homePace, setHomePace] = useState("");
  const [homeDaysRest, setHomeDaysRest] = useState("");
  const [homeWinRate, setHomeWinRate] = useState("");
  const [homeB2B, setHomeB2B] = useState(false);
  const [homeGamesLast7, setHomeGamesLast7] = useState(2);
  const [homeInjury, setHomeInjury] = useState("0");
  // Factores asimétricos auto-detectados (offFactor, defFactor). Default suave si manual.
  const [homeInjuryFactors, setHomeInjuryFactors] = useState<{off: number; def: number; type: string}>({off: 1.0, def: 0.5, type: "Mixto"});
  const [homeStreak, setHomeStreak] = useState("0");
  const [homeRecentPace, setHomeRecentPace] = useState("");
  const [homeRecentPPG, setHomeRecentPPG] = useState("");
  const [homeOppDefRtg, setHomeOppDefRtg] = useState("");
  const [homeOppOffRtg, setHomeOppOffRtg] = useState("");

  // Away
  const [awayTeam, setAwayTeam] = useState("");
  const [awayNetRtg, setAwayNetRtg] = useState("");
  const [awayOffRtg, setAwayOffRtg] = useState("");
  const [awayDefRtg, setAwayDefRtg] = useState("");
  const [awayPace, setAwayPace] = useState("");
  const [awayDaysRest, setAwayDaysRest] = useState("");
  const [awayWinRate, setAwayWinRate] = useState("");
  const [awayB2B, setAwayB2B] = useState(false);
  const [awayGamesLast7, setAwayGamesLast7] = useState(2);
  const [awayInjury, setAwayInjury] = useState("0");
  const [awayInjuryFactors, setAwayInjuryFactors] = useState<{off: number; def: number; type: string}>({off: 1.0, def: 0.5, type: "Mixto"});
  const [awayStreak, setAwayStreak] = useState("0");
  const [awayRecentPace, setAwayRecentPace] = useState("");
  const [awayRecentPPG, setAwayRecentPPG] = useState("");
  const [awayOppDefRtg, setAwayOppDefRtg] = useState("");
  const [awayOppOffRtg, setAwayOppOffRtg] = useState("");

  // Four Factors — Home
  const [homeEFGPct, setHomeEFGPct] = useState("");
  const [homeFTRate, setHomeFTRate] = useState("");
  const [homeTovPct, setHomeTovPct] = useState("");
  const [homeOrebPct, setHomeOrebPct] = useState("");
  const [homeOppEFGPct, setHomeOppEFGPct] = useState("");
  const [homeOppFTRate, setHomeOppFTRate] = useState("");
  const [homeOppTovPct, setHomeOppTovPct] = useState("");
  const [homeOppOrebPct, setHomeOppOrebPct] = useState("");
  const [homeL10EFGPct, setHomeL10EFGPct] = useState("");
  const [homeL10FTRate, setHomeL10FTRate] = useState("");
  const [homeL10TovPct, setHomeL10TovPct] = useState("");
  const [homeL10OrebPct, setHomeL10OrebPct] = useState("");
  const [homeL10OppEFGPct, setHomeL10OppEFGPct] = useState("");
  const [homeL10OppFTRate, setHomeL10OppFTRate] = useState("");
  const [homeL10OppTovPct, setHomeL10OppTovPct] = useState("");
  const [homeL10OppOrebPct, setHomeL10OppOrebPct] = useState("");
  const [homeGP, setHomeGP] = useState("");

  // Four Factors — Away
  const [awayEFGPct, setAwayEFGPct] = useState("");
  const [awayFTRate, setAwayFTRate] = useState("");
  const [awayTovPct, setAwayTovPct] = useState("");
  const [awayOrebPct, setAwayOrebPct] = useState("");
  const [awayOppEFGPct, setAwayOppEFGPct] = useState("");
  const [awayOppFTRate, setAwayOppFTRate] = useState("");
  const [awayOppTovPct, setAwayOppTovPct] = useState("");
  const [awayOppOrebPct, setAwayOppOrebPct] = useState("");
  const [awayL10EFGPct, setAwayL10EFGPct] = useState("");
  const [awayL10FTRate, setAwayL10FTRate] = useState("");
  const [awayL10TovPct, setAwayL10TovPct] = useState("");
  const [awayL10OrebPct, setAwayL10OrebPct] = useState("");
  const [awayL10OppEFGPct, setAwayL10OppEFGPct] = useState("");
  const [awayL10OppFTRate, setAwayL10OppFTRate] = useState("");
  const [awayL10OppTovPct, setAwayL10OppTovPct] = useState("");
  const [awayL10OppOrebPct, setAwayL10OppOrebPct] = useState("");
  const [awayGP, setAwayGP] = useState("");

  // Auto-fill
  const [selectedGameId, setSelectedGameId] = useState("");
  const [autoFillStatus, setAutoFillStatus] = useState<"idle"|"loading"|"success"|"error">("idle");
  const [homeManualStatus, setHomeManualStatus] = useState<"idle"|"verified"|"manual">("idle");
  const [awayManualStatus, setAwayManualStatus] = useState<"idle"|"verified"|"manual">("idle");
  const [h2hRecord, setH2HRecord] = useState("");
  const [h2hHomeWins, setH2HHomeWins] = useState(0);
  const [h2hAwayWins, setH2HAwayWins] = useState(0);
  const [gameType, setGameType] = useState("");
  const [homeNetRtgHome, setHomeNetRtgHome] = useState<number | undefined>(undefined);
  const [homeOffRtgHome, setHomeOffRtgHome] = useState<number | undefined>(undefined);
  const [homeDefRtgHome, setHomeDefRtgHome] = useState<number | undefined>(undefined);
  const [awayNetRtgAway, setAwayNetRtgAway] = useState<number | undefined>(undefined);
  const [awayOffRtgAway, setAwayOffRtgAway] = useState<number | undefined>(undefined);
  const [awayDefRtgAway, setAwayDefRtgAway] = useState<number | undefined>(undefined);

  // Roster state
  const [homeRoster, setHomeRoster] = useState<{name:string;ppg:number;rpg:number;apg:number;mpg:number;gp:number;gamesMissed?:number}[]>([]);
  const [awayRoster, setAwayRoster] = useState<{name:string;ppg:number;rpg:number;apg:number;mpg:number;gp:number;gamesMissed?:number}[]>([]);
  const [homeMissing, setHomeMissing] = useState<Set<string>>(new Set());
  const [awayMissing, setAwayMissing] = useState<Set<string>>(new Set());
  const [homeGamesOut, setHomeGamesOut] = useState<Record<string, number>>({});
  const [awayGamesOut, setAwayGamesOut] = useState<Record<string, number>>({});
  const [homeReturning, setHomeReturning] = useState<Set<string>>(new Set());
  const [awayReturning, setAwayReturning] = useState<Set<string>>(new Set());
  const [homeReturnGames, setHomeReturnGames] = useState<Record<string, number>>({});
  const [awayReturnGames, setAwayReturnGames] = useState<Record<string, number>>({});

  // Lines
  const [odds, setOdds] = useState("-150");
  const [awayOdds, setAwayOdds] = useState("+130");
  const [spreadLine, setSpreadLine] = useState("");
  const [spreadOdds, setSpreadOdds] = useState("-110");
  const [spreadOddsAway, setSpreadOddsAway] = useState("-110");
  const [ouLine, setOuLine] = useState("");
  const [overOdds, setOverOdds] = useState("-110");
  const [underOdds, setUnderOdds] = useState("-110");
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(todayFL()); // YYYY-MM-DD Florida
  const [sharpGameKey, setSharpGameKey] = useState<string | null>(null);
  const [refComposite, setRefComposite] = useState<NBARefComposite | null>(null);
  const [contextAdjPp, setContextAdjPp] = useState<number>(0);
  const [contextTri, setContextTri] = useState<{ home: string | null; away: string | null }>({ home: null, away: null });
  const [sharpDir, setSharpDir] = useState<SharpDirection | null>(null);

  // Fetch games + stats for the selected date
  const { data: nbaData, isLoading: nbaLoading, refetch: refetchNBA, error: nbaError } = useQuery<{ success: boolean; games: NBAGame[]; date: string }>({
    queryKey: ["/api/nba/all", selectedDate],
    queryFn: async () => {
      // NBA Stats API ahora acepta ISO YYYY-MM-DD directamente (cambio reciente del API)
      const res = await fetch(`${API_BASE}/api/nba/all?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: false, // only fetch when user requests
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  const todayGames: NBAGame[] = nbaData?.games ?? [];

  const { data: manualTeamPayload, isLoading: manualTeamsLoading } = useQuery<{ success: boolean; data: NBAManualTeam[]; source: string }>({
    queryKey: ["/api/nba/manual-teams", selectedDate],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/nba/manual-teams?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
  const manualTeams: NBAManualTeam[] = manualTeamPayload?.data ?? [];

  const applyManualTeam = (side: "home" | "away", teamName: string) => {
    const isHome = side === "home";
    const setTeam = isHome ? setHomeTeam : setAwayTeam;
    const setStatus = isHome ? setHomeManualStatus : setAwayManualStatus;
    setTeam(teamName);
    setResult(null);

    const team = manualTeams.find((row) => row.teamName === teamName);
    const setters = isHome
      ? {
          net: setHomeNetRtg, off: setHomeOffRtg, def: setHomeDefRtg, pace: setHomePace,
          rest: setHomeDaysRest, win: setHomeWinRate, b2b: setHomeB2B, streak: setHomeStreak,
          games7: setHomeGamesLast7, recentPace: setHomeRecentPace, recentPPG: setHomeRecentPPG,
          oppDef: setHomeOppDefRtg, oppOff: setHomeOppOffRtg,
        }
      : {
          net: setAwayNetRtg, off: setAwayOffRtg, def: setAwayDefRtg, pace: setAwayPace,
          rest: setAwayDaysRest, win: setAwayWinRate, b2b: setAwayB2B, streak: setAwayStreak,
          games7: setAwayGamesLast7, recentPace: setAwayRecentPace, recentPPG: setAwayRecentPPG,
          oppDef: setAwayOppDefRtg, oppOff: setAwayOppOffRtg,
        };

    if (!team) {
      setters.net(""); setters.off(""); setters.def(""); setters.pace("");
      setters.rest(""); setters.win(""); setters.b2b(false); setters.streak("0");
      setters.games7(0); setters.recentPace(""); setters.recentPPG("");
      setters.oppDef(""); setters.oppOff("");
      setStatus("manual");
      toast({
        title: manualTeamsLoading ? "Cargando estadísticas NBA" : "Entrada manual NBA",
        description: manualTeamsLoading
          ? "Espera a que termine la carga y vuelve a seleccionar el equipo."
          : "No hay estadísticas verificadas disponibles; los campos permanecen vacíos.",
      });
      return;
    }

    setters.net(team.netRtg.toFixed(1));
    setters.off(team.offRtg.toFixed(1));
    setters.def(team.defRtg.toFixed(1));
    setters.pace(team.pace.toFixed(1));
    setters.win(team.winPct.toFixed(2));
    setters.rest(team.daysRest !== undefined ? String(team.daysRest) : "");
    setters.b2b(team.isB2B ?? false);
    setters.streak(team.streak !== undefined ? String(team.streak) : "0");
    setters.games7(team.gamesLast7Days ?? 0);
    setters.recentPace(team.pace5 !== undefined ? team.pace5.toFixed(1) : "");
    setters.recentPPG(team.ppg5 !== undefined ? team.ppg5.toFixed(1) : "");
    setters.oppDef(team.oppAvgDefRtg !== undefined ? team.oppAvgDefRtg.toFixed(1) : "");
    setters.oppOff(team.oppAvgOffRtg !== undefined ? team.oppAvgOffRtg.toFixed(1) : "");
    (window as any)[isHome ? "__homeSOS" : "__awaySOS"] = {
      label: team.sosLabel,
      netRtg: team.oppAvgNetRtg,
      opps: team.opponents,
    };
    setStatus("verified");
    toast({
      title: `✅ ${teamName} cargado`,
      description: team.daysRest === undefined
        ? "Stats de temporada verificadas. Descanso pendiente porque no hay juego activo en la fecha seleccionada."
        : "Stats y contexto reciente cargados.",
    });
  };

  const handleAutoFill = async (gameId: string) => {
    setAutoFillStatus("loading");
    let games = todayGames;
    if (games.length === 0) {
      const result = await refetchNBA();
      games = (result.data as any)?.games ?? [];
    }
    const game = games.find((g) => g.gameId === gameId);
    if (!game) { setAutoFillStatus("error"); return; }

    const hs = game.homeStats;
    const as_ = game.awayStats;
    if (!hs || !as_) { setAutoFillStatus("error"); return; }

    // Store tricodes for contextual card
    setContextTri({ home: game.homeTeam.tricode, away: game.awayTeam.tricode });

    // Home team
    setHomeTeam(game.homeTeam.name);
    setHomeNetRtg(hs.netRtg.toFixed(1));
    setHomeOffRtg(hs.offRtg.toFixed(1));
    setHomeDefRtg(hs.defRtg.toFixed(1));
    setHomePace(hs.pace.toFixed(1));
    setHomeWinRate(hs.winPct.toFixed(2));
    if (hs.pace5) setHomeRecentPace(hs.pace5.toFixed(1));
    if (hs.ppg5)  setHomeRecentPPG(hs.ppg5.toFixed(1));

    // SOS v2 for home team (blended L10+season)
    if (hs.oppAvgDefRtg) setHomeOppDefRtg(hs.oppAvgDefRtg.toFixed(1));
    if (hs.oppAvgOffRtg) setHomeOppOffRtg(hs.oppAvgOffRtg.toFixed(1));
    (window as any).__homeSOS = { label: hs.sosLabel, netRtg: hs.oppAvgNetRtg, opps: hs.opponents };

    // Home: streak, B2B, rest
    if (hs.streak !== undefined) setHomeStreak(String(hs.streak));
    if (hs.isB2B !== undefined) setHomeB2B(hs.isB2B);
    if (hs.daysRest !== undefined) setHomeDaysRest(String(hs.daysRest));
    if (hs.gamesLast7Days !== undefined) setHomeGamesLast7(hs.gamesLast7Days);

    // Away team
    setAwayTeam(game.awayTeam.name);
    setAwayNetRtg(as_.netRtg.toFixed(1));
    setAwayOffRtg(as_.offRtg.toFixed(1));
    setAwayDefRtg(as_.defRtg.toFixed(1));
    setAwayPace(as_.pace.toFixed(1));
    setAwayWinRate(as_.winPct.toFixed(2));
    if (as_.pace5) setAwayRecentPace(as_.pace5.toFixed(1));
    if (as_.ppg5)  setAwayRecentPPG(as_.ppg5.toFixed(1));

    // SOS v2 for away team (blended L10+season)
    if (as_.oppAvgDefRtg) setAwayOppDefRtg(as_.oppAvgDefRtg.toFixed(1));
    if (as_.oppAvgOffRtg) setAwayOppOffRtg(as_.oppAvgOffRtg.toFixed(1));
    (window as any).__awaySOS = { label: as_.sosLabel, netRtg: as_.oppAvgNetRtg, opps: as_.opponents };

    // Away: streak, B2B, rest
    if (as_.streak !== undefined) setAwayStreak(String(as_.streak));
    if (as_.isB2B !== undefined) setAwayB2B(as_.isB2B);
    if (as_.daysRest !== undefined) setAwayDaysRest(String(as_.daysRest));
    if (as_.gamesLast7Days !== undefined) setAwayGamesLast7(as_.gamesLast7Days);

    // Four Factors — Home
    if (hs.eFGPct !== undefined) setHomeEFGPct(String(hs.eFGPct));
    if (hs.ftRate !== undefined) setHomeFTRate(String(hs.ftRate));
    if (hs.tovPct !== undefined) setHomeTovPct(String(hs.tovPct));
    if (hs.orebPct !== undefined) setHomeOrebPct(String(hs.orebPct));
    if (hs.oppEFGPct !== undefined) setHomeOppEFGPct(String(hs.oppEFGPct));
    if (hs.oppFTRate !== undefined) setHomeOppFTRate(String(hs.oppFTRate));
    if (hs.oppTovPct !== undefined) setHomeOppTovPct(String(hs.oppTovPct));
    if (hs.oppOrebPct !== undefined) setHomeOppOrebPct(String(hs.oppOrebPct));
    if (hs.l10eFGPct !== undefined) setHomeL10EFGPct(String(hs.l10eFGPct));
    if (hs.l10FTRate !== undefined) setHomeL10FTRate(String(hs.l10FTRate));
    if (hs.l10TovPct !== undefined) setHomeL10TovPct(String(hs.l10TovPct));
    if (hs.l10OrebPct !== undefined) setHomeL10OrebPct(String(hs.l10OrebPct));
    if (hs.l10OppEFGPct !== undefined) setHomeL10OppEFGPct(String(hs.l10OppEFGPct));
    if (hs.l10OppFTRate !== undefined) setHomeL10OppFTRate(String(hs.l10OppFTRate));
    if (hs.l10OppTovPct !== undefined) setHomeL10OppTovPct(String(hs.l10OppTovPct));
    if (hs.l10OppOrebPct !== undefined) setHomeL10OppOrebPct(String(hs.l10OppOrebPct));
    if (hs.gp !== undefined) setHomeGP(String(hs.gp));

    // Four Factors — Away
    if (as_.eFGPct !== undefined) setAwayEFGPct(String(as_.eFGPct));
    if (as_.ftRate !== undefined) setAwayFTRate(String(as_.ftRate));
    if (as_.tovPct !== undefined) setAwayTovPct(String(as_.tovPct));
    if (as_.orebPct !== undefined) setAwayOrebPct(String(as_.orebPct));
    if (as_.oppEFGPct !== undefined) setAwayOppEFGPct(String(as_.oppEFGPct));
    if (as_.oppFTRate !== undefined) setAwayOppFTRate(String(as_.oppFTRate));
    if (as_.oppTovPct !== undefined) setAwayOppTovPct(String(as_.oppTovPct));
    if (as_.oppOrebPct !== undefined) setAwayOppOrebPct(String(as_.oppOrebPct));
    if (as_.l10eFGPct !== undefined) setAwayL10EFGPct(String(as_.l10eFGPct));
    if (as_.l10FTRate !== undefined) setAwayL10FTRate(String(as_.l10FTRate));
    if (as_.l10TovPct !== undefined) setAwayL10TovPct(String(as_.l10TovPct));
    if (as_.l10OrebPct !== undefined) setAwayL10OrebPct(String(as_.l10OrebPct));
    if (as_.l10OppEFGPct !== undefined) setAwayL10OppEFGPct(String(as_.l10OppEFGPct));
    if (as_.l10OppFTRate !== undefined) setAwayL10OppFTRate(String(as_.l10OppFTRate));
    if (as_.l10OppTovPct !== undefined) setAwayL10OppTovPct(String(as_.l10OppTovPct));
    if (as_.l10OppOrebPct !== undefined) setAwayL10OppOrebPct(String(as_.l10OppOrebPct));
    if (as_.gp !== undefined) setAwayGP(String(as_.gp));

    if ((game as any).homeRoster) setHomeRoster((game as any).homeRoster);
    if ((game as any).awayRoster) setAwayRoster((game as any).awayRoster);
    setHomeMissing(new Set());
    setAwayMissing(new Set());
    setHomeGamesOut({});
    setAwayGamesOut({});
    setHomeReturning(new Set());
    setAwayReturning(new Set());
    setHomeReturnGames({});
    setAwayReturnGames({});

    if ((game as any).h2h) setH2HRecord((game as any).h2h);
    else setH2HRecord("");
    setH2HHomeWins((game as any).h2hHomeWins || 0);
    setH2HAwayWins((game as any).h2hAwayWins || 0);
    if ((game as any).gameType) setGameType((game as any).gameType);
    else setGameType("");

    // Home/Away splits
    setHomeNetRtgHome(hs.homeNetRtg);
    setHomeOffRtgHome(hs.homeOffRtg);
    setHomeDefRtgHome(hs.homeDefRtg);
    setAwayNetRtgAway(as_.awayNetRtg);
    setAwayOffRtgAway(as_.awayOffRtg);
    setAwayDefRtgAway(as_.awayDefRtg);

    setAutoFillStatus("success");
    toast({ title: "✅ Todo cargado — solo agrega lesiones y líneas" });
  };

  const runPrediction = useCallback(() => {
    const requiredStats = [
      { label: "NetRtg Local", value: homeNetRtg },
      { label: "OffRtg Local", value: homeOffRtg },
      { label: "DefRtg Local", value: homeDefRtg },
      { label: "Pace Local", value: homePace },
      { label: "Descanso Local", value: homeDaysRest },
      { label: "Win Rate Local", value: homeWinRate },
      { label: "NetRtg Visitante", value: awayNetRtg },
      { label: "OffRtg Visitante", value: awayOffRtg },
      { label: "DefRtg Visitante", value: awayDefRtg },
      { label: "Pace Visitante", value: awayPace },
      { label: "Descanso Visitante", value: awayDaysRest },
      { label: "Win Rate Visitante", value: awayWinRate },
    ];
    const missingStats = requiredStats
      .filter(({ value }) => value.trim() === "" || !Number.isFinite(Number(value)))
      .map(({ label }) => label);
    if (!homeTeam || !awayTeam || homeTeam === awayTeam || missingStats.length > 0) {
      const description = !homeTeam || !awayTeam
        ? "Selecciona el equipo Local y el Visitante."
        : homeTeam === awayTeam
          ? "Selecciona dos equipos diferentes."
          : `Faltan: ${missingStats.join(", ")}.`;
      toast({ title: "Faltan datos NBA", description });
      return;
    }

    const homeAdj = parseFloat(homeInjury) || 0;
    const awayAdj = parseFloat(awayInjury) || 0;

    // Factores asimétricos auto-detectados desde roster picker, o default 1.0/0.5 si manual
    const hOffF = homeInjuryFactors.off;
    const hDefF = homeInjuryFactors.def;
    const aOffF = awayInjuryFactors.off;
    const aDefF = awayInjuryFactors.def;
    const home: TeamStats = {
      netRtg: (parseFloat(homeNetRtg) || 0) + homeAdj,
      offRtg: (parseFloat(homeOffRtg) || 0) + homeAdj * hOffF,
      defRtg: (parseFloat(homeDefRtg) || 0) - homeAdj * hDefF,
      pace: parseFloat(homePace) || 100,
      daysRest: parseInt(homeDaysRest) || 1,
      winRate: parseFloat(homeWinRate) || 0.5,
      isB2B: homeB2B,
      gamesLast7Days: homeGamesLast7,
      streak: parseInt(homeStreak) || 0,
      recentPace:   homeRecentPace.trim() ? parseFloat(homeRecentPace) || undefined : undefined,
      recentPPG:    homeRecentPPG.trim()  ? parseFloat(homeRecentPPG)  || undefined : undefined,
      oppAvgDefRtg: homeOppDefRtg.trim()  ? parseFloat(homeOppDefRtg)  || undefined : undefined,
      oppAvgOffRtg: homeOppOffRtg.trim()  ? parseFloat(homeOppOffRtg)  || undefined : undefined,
      name: homeTeam || "Local",
      homeOffRtg: homeOffRtgHome,
      homeDefRtg: homeDefRtgHome,
      homeNetRtg: homeNetRtgHome,
      h2hWins: h2hHomeWins,
      h2hLosses: h2hAwayWins,
      isPlayoff: gameType !== "" && gameType !== "Regular Season",
      isElimination: gameType.toLowerCase().includes("eliminated") || gameType.toLowerCase().includes("loser"),
      gameContextType: gameType.toLowerCase().includes("finals") ? "finals" as const
        : gameType.toLowerCase().includes("playoff") || gameType.toLowerCase().includes("series") ? "playoff" as const
        : gameType !== "" && gameType !== "Regular Season" ? "playin" as const
        : "regular" as const,
      // Four Factors
      eFGPct:      homeEFGPct.trim()      ? parseFloat(homeEFGPct)      || undefined : undefined,
      ftRate:      homeFTRate.trim()      ? parseFloat(homeFTRate)      || undefined : undefined,
      tovPct:      homeTovPct.trim()      ? parseFloat(homeTovPct)      || undefined : undefined,
      orebPct:     homeOrebPct.trim()     ? parseFloat(homeOrebPct)     || undefined : undefined,
      oppEFGPct:   homeOppEFGPct.trim()   ? parseFloat(homeOppEFGPct)   || undefined : undefined,
      oppFTRate:   homeOppFTRate.trim()   ? parseFloat(homeOppFTRate)   || undefined : undefined,
      oppTovPct:   homeOppTovPct.trim()   ? parseFloat(homeOppTovPct)   || undefined : undefined,
      oppOrebPct:  homeOppOrebPct.trim()  ? parseFloat(homeOppOrebPct)  || undefined : undefined,
      l10eFGPct:    homeL10EFGPct.trim()    ? parseFloat(homeL10EFGPct)    || undefined : undefined,
      l10FTRate:    homeL10FTRate.trim()    ? parseFloat(homeL10FTRate)    || undefined : undefined,
      l10TovPct:    homeL10TovPct.trim()    ? parseFloat(homeL10TovPct)    || undefined : undefined,
      l10OrebPct:   homeL10OrebPct.trim()   ? parseFloat(homeL10OrebPct)   || undefined : undefined,
      l10OppEFGPct: homeL10OppEFGPct.trim() ? parseFloat(homeL10OppEFGPct) || undefined : undefined,
      l10OppFTRate: homeL10OppFTRate.trim() ? parseFloat(homeL10OppFTRate) || undefined : undefined,
      l10OppTovPct: homeL10OppTovPct.trim() ? parseFloat(homeL10OppTovPct) || undefined : undefined,
      l10OppOrebPct:homeL10OppOrebPct.trim()? parseFloat(homeL10OppOrebPct)|| undefined : undefined,
      gamesPlayed: homeGP.trim()          ? parseInt(homeGP)            || undefined : undefined,
    };
    const away: TeamStats = {
      netRtg: (parseFloat(awayNetRtg) || 0) + awayAdj,
      offRtg: (parseFloat(awayOffRtg) || 0) + awayAdj * aOffF,
      defRtg: (parseFloat(awayDefRtg) || 0) - awayAdj * aDefF,
      pace: parseFloat(awayPace) || 100,
      daysRest: parseInt(awayDaysRest) || 1,
      winRate: parseFloat(awayWinRate) || 0.5,
      isB2B: awayB2B,
      gamesLast7Days: awayGamesLast7,
      travelPenalty: travelPenalty(getAwayTravelDistance(awayTeam || "", homeTeam || "", "nba")),
      streak: parseInt(awayStreak) || 0,
      recentPace:   awayRecentPace.trim() ? parseFloat(awayRecentPace) || undefined : undefined,
      recentPPG:    awayRecentPPG.trim()  ? parseFloat(awayRecentPPG)  || undefined : undefined,
      oppAvgDefRtg: awayOppDefRtg.trim()  ? parseFloat(awayOppDefRtg)  || undefined : undefined,
      oppAvgOffRtg: awayOppOffRtg.trim()  ? parseFloat(awayOppOffRtg)  || undefined : undefined,
      name: awayTeam || "Visitante",
      awayOffRtg: awayOffRtgAway,
      awayDefRtg: awayDefRtgAway,
      awayNetRtg: awayNetRtgAway,
      h2hWins: h2hAwayWins,
      h2hLosses: h2hHomeWins,
      isPlayoff: gameType !== "" && gameType !== "Regular Season",
      isElimination: gameType.toLowerCase().includes("eliminated") || gameType.toLowerCase().includes("loser"),
      gameContextType: gameType.toLowerCase().includes("finals") ? "finals" as const
        : gameType.toLowerCase().includes("playoff") || gameType.toLowerCase().includes("series") ? "playoff" as const
        : gameType !== "" && gameType !== "Regular Season" ? "playin" as const
        : "regular" as const,
      // Four Factors
      eFGPct:      awayEFGPct.trim()      ? parseFloat(awayEFGPct)      || undefined : undefined,
      ftRate:      awayFTRate.trim()      ? parseFloat(awayFTRate)      || undefined : undefined,
      tovPct:      awayTovPct.trim()      ? parseFloat(awayTovPct)      || undefined : undefined,
      orebPct:     awayOrebPct.trim()     ? parseFloat(awayOrebPct)     || undefined : undefined,
      oppEFGPct:   awayOppEFGPct.trim()   ? parseFloat(awayOppEFGPct)   || undefined : undefined,
      oppFTRate:   awayOppFTRate.trim()   ? parseFloat(awayOppFTRate)   || undefined : undefined,
      oppTovPct:   awayOppTovPct.trim()   ? parseFloat(awayOppTovPct)   || undefined : undefined,
      oppOrebPct:  awayOppOrebPct.trim()  ? parseFloat(awayOppOrebPct)  || undefined : undefined,
      l10eFGPct:    awayL10EFGPct.trim()    ? parseFloat(awayL10EFGPct)    || undefined : undefined,
      l10FTRate:    awayL10FTRate.trim()    ? parseFloat(awayL10FTRate)    || undefined : undefined,
      l10TovPct:    awayL10TovPct.trim()    ? parseFloat(awayL10TovPct)    || undefined : undefined,
      l10OrebPct:   awayL10OrebPct.trim()   ? parseFloat(awayL10OrebPct)   || undefined : undefined,
      l10OppEFGPct: awayL10OppEFGPct.trim() ? parseFloat(awayL10OppEFGPct) || undefined : undefined,
      l10OppFTRate: awayL10OppFTRate.trim() ? parseFloat(awayL10OppFTRate) || undefined : undefined,
      l10OppTovPct: awayL10OppTovPct.trim() ? parseFloat(awayL10OppTovPct) || undefined : undefined,
      l10OppOrebPct:awayL10OppOrebPct.trim()? parseFloat(awayL10OppOrebPct)|| undefined : undefined,
      gamesPlayed: awayGP.trim()          ? parseInt(awayGP)            || undefined : undefined,
    };

    let homeProb = predict(home, away);
    const baseProb = homeProb;

    // Calibration (backtested k=1.3) then market regression
    homeProb = nbaCalibrate(homeProb);
    const oddsNum = parseInt(odds) || -110;
    const impliedProb = americanToProb(oddsNum);
    if (odds.trim() !== "" && impliedProb > 0.01 && impliedProb < 0.99) {
      homeProb = regressToMarket(homeProb, impliedProb, 0.25);
    }

    // ÉLITE: aplicar ajuste por árbitros (afecta WR y total)
    const probPreRef = homeProb;
    const factorNotes: string[] = [];
    if (refComposite) {
      homeProb = applyRefAdjustment(homeProb, refComposite);
      const refDelta = (homeProb - probPreRef) * 100;
      if (Math.abs(refDelta) >= 0.1) {
        factorNotes.push(`Árbitros ${refDelta > 0 ? "+" : ""}${refDelta.toFixed(1)}pp`);
      }
    }

    // ÉLITE: aplicar ajustes contextuales (revenge / trap / b2b direccional / load mgmt)
    if (contextAdjPp !== 0) {
      homeProb = Math.max(0.05, Math.min(0.95, homeProb + contextAdjPp / 100));
      factorNotes.push(`Contextual ${contextAdjPp > 0 ? "+" : ""}${contextAdjPp.toFixed(1)}pp`);
    }

    const ouLineNum = ouLine.trim() ? parseFloat(ouLine) || 220 : 220;
    const spreadLineNum = spreadLine.trim() ? parseFloat(spreadLine) || 0 : 0;

    // FIX: evaluar AMBOS lados ML, elegir el del modelo
    const awayOddsNum = parseInt(awayOdds) || +100;
    const impliedHome = americanToProb(oddsNum);
    const impliedAway = americanToProb(awayOddsNum);
    const edgeHome = (homeProb - impliedHome) * 100;
    const edgeAway = ((1 - homeProb) - impliedAway) * 100;

    // El lado recomendado es donde el modelo tiene mayor edge positivo
    const pickedSide: "home" | "away" = edgeHome >= edgeAway ? "home" : "away";
    const edge = pickedSide === "home" ? edgeHome : edgeAway;
    const recommendedOdds = pickedSide === "home" ? oddsNum : awayOddsNum;
    const recommendedImplied = pickedSide === "home" ? impliedHome : impliedAway;
    const pickProb = pickedSide === "home" ? homeProb : (1 - homeProb);

    const signal = getSignal(edge, pickProb);
    const bankroll = state.bankrollInitial + state.picks.reduce((s, p) => s + p.profit, 0);
    const stake = kellyStake(pickProb, recommendedOdds, bankroll);

    let spreadResult: PredictionResult["spread"];
    if (spreadLine.trim() !== "") {
      const n = parseFloat(spreadLine);
      if (!isNaN(n)) spreadResult = evaluateSpread(homeProb, n);
    }
    let totalResult: PredictionResult["total"];
    if (ouLine.trim() !== "") {
      const n = parseFloat(ouLine);
      if (!isNaN(n)) {
        totalResult = evaluateTotal(home, away, n);
        // ÉLITE: aplicar ajuste de pace de árbitros al total estimado
        if (refComposite && totalResult) {
          const origTotal = totalResult.estimatedTotal;
          const adjTotal = applyRefTotalAdjustment(origTotal, refComposite);
          if (Math.abs(adjTotal - origTotal) >= 0.2) {
            factorNotes.push(`Total refs ${adjTotal > origTotal ? "+" : ""}${(adjTotal - origTotal).toFixed(1)} pts`);
          }
          totalResult = { ...totalResult, estimatedTotal: adjTotal };
        }
      }
    }

    const bestPlay = getBestPlay({
      homeTeam: homeTeam || "Local",
      awayTeam: awayTeam || "Visitante",
      mlEdge: edge,
      mlSignal: signal,
      homeProb,
      spread: spreadResult ?? null,
      total: totalResult ?? null,
    });

    const poisson = nbaPoissonTotal(home, away, ouLineNum);
    const safePlay = nbaFindSafePlay(home, away, homeProb, poisson, ouLineNum, spreadLineNum);

    // Generate alternate lines for higher confidence plays
    // Only generate when user has entered actual spread or O/U values
    const hasSpread = spreadLine.trim() !== "" && spreadLineNum !== 0;
    const hasOU = ouLine.trim() !== "";
    const estTotal = totalResult?.estimatedTotal ?? (hasOU ? ouLineNum : 0);
    const altLines = (hasSpread || hasOU)
      ? generateAltLines(homeProb, hasSpread ? spreadLineNum : 0, hasOU ? ouLineNum : 0, estTotal, homeTeam || "Local", awayTeam || "Visitante")
      : [];

    setResult({
      homeProb: homeProb * 100,
      awayProb: (1 - homeProb) * 100,
      edge, signal, stake,
      impliedProb: recommendedImplied * 100,
      homeTeam: homeTeam || "Local",
      awayTeam: awayTeam || "Visitante",
      odds: recommendedOdds,
      pickedSide,
      spread: spreadResult,
      total: totalResult,
      homeInjuryAdj: homeAdj,
      awayInjuryAdj: awayAdj,
      bestPlay,
      poisson,
      safePlay,
      altLines,
      factorBreakdown: {
        baseProb: baseProb * 100,
        finalProb: homeProb * 100,
        notes: factorNotes,
      },
    });
  }, [homeNetRtg, homeOffRtg, homeDefRtg, homePace, homeDaysRest, homeWinRate, homeB2B, homeInjury, homeStreak, homeRecentPace, homeRecentPPG, homeOppDefRtg, homeOppOffRtg,
      awayNetRtg, awayOffRtg, awayDefRtg, awayPace, awayDaysRest, awayWinRate, awayB2B, awayInjury, awayStreak, awayRecentPace, awayRecentPPG, awayOppDefRtg, awayOppOffRtg,
      homeEFGPct, homeFTRate, homeTovPct, homeOrebPct, homeOppEFGPct, homeOppFTRate, homeOppTovPct, homeOppOrebPct,
      homeL10EFGPct, homeL10OppEFGPct, homeL10TovPct, homeL10OppTovPct, homeGP,
      awayEFGPct, awayFTRate, awayTovPct, awayOrebPct, awayOppEFGPct, awayOppFTRate, awayOppTovPct, awayOppOrebPct,
      awayL10EFGPct, awayL10OppEFGPct, awayL10TovPct, awayL10OppTovPct, awayGP,
      odds, awayOdds, spreadLine, spreadOdds, spreadOddsAway, ouLine, overOdds, underOdds, homeTeam, awayTeam, state,
      homeNetRtgHome, homeOffRtgHome, homeDefRtgHome, awayNetRtgAway, awayOffRtgAway, awayDefRtgAway, gameType, h2hHomeWins, h2hAwayWins, refComposite, contextAdjPp,
      homeInjuryFactors, awayInjuryFactors]);

  const saveToHistory = () => {
    if (!result || !homeTeam || !awayTeam) {
      toast({ title: "Selecciona ambos equipos", variant: "destructive" });
      return;
    }
    dispatch({
      type: "ADD_PICK",
      payload: {
        date: new Date().toISOString().split("T")[0],
        team: homeTeam, opponent: awayTeam, market: "ML",
        pick: `${homeTeam.split(" ").pop()} ML`,
        odds: result.odds, modelProb: result.homeProb,
        stake: Math.round(result.stake * 100) / 100, result: "P",
      },
    });
    toast({ title: "Pick guardado en historial" });
    navigate("/history");
  };

  // ── Input helper ─────────────────────────────────────────────
  const numInput = (label: string, value: string, setter: (v: string) => void, testid: string, mode: "decimal"|"numeric" = "decimal", placeholder?: string) => (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="text"
        inputMode={mode}
        value={value}
        onChange={(e) => setter(e.target.value)}
        data-testid={testid}
        placeholder={placeholder ?? ""}
        className="mt-1"
      />
    </div>
  );

  // ── Team section (inlined — NO inner component to avoid re-mount) ──
  const teamSection = (side: "home" | "away") => {
    const isHome = side === "home";
    const color = isHome ? "text-blue-400" : "text-amber-400";
    const label = isHome ? "Local" : "Visitante";

    const team =     isHome ? homeTeam     : awayTeam;
    const netRtg =   isHome ? homeNetRtg   : awayNetRtg;
    const offRtg =   isHome ? homeOffRtg   : awayOffRtg;
    const defRtg =   isHome ? homeDefRtg   : awayDefRtg;
    const pace =     isHome ? homePace     : awayPace;
    const daysRest = isHome ? homeDaysRest : awayDaysRest;
    const winRate =  isHome ? homeWinRate  : awayWinRate;
    const b2b =      isHome ? homeB2B      : awayB2B;
    const injury =   isHome ? homeInjury   : awayInjury;
    const streak =   isHome ? homeStreak   : awayStreak;

    const setTeam =     isHome ? setHomeTeam     : setAwayTeam;
    const setNetRtg =   isHome ? setHomeNetRtg   : setAwayNetRtg;
    const setOffRtg =   isHome ? setHomeOffRtg   : setAwayOffRtg;
    const setDefRtg =   isHome ? setHomeDefRtg   : setAwayDefRtg;
    const setPace =     isHome ? setHomePace     : setAwayPace;
    const setDaysRest = isHome ? setHomeDaysRest : setAwayDaysRest;
    const setWinRate =  isHome ? setHomeWinRate  : setAwayWinRate;
    const setB2B =      isHome ? setHomeB2B      : setAwayB2B;
    const setInjury =   isHome ? setHomeInjury   : setAwayInjury;
    const injuryFactors = isHome ? homeInjuryFactors : awayInjuryFactors;
    const setInjuryFactors = isHome ? setHomeInjuryFactors : setAwayInjuryFactors;
    const setStreak =   isHome ? setHomeStreak   : setAwayStreak;

    // Four Factors bindings
    const eFGPctVal =    isHome ? homeEFGPct    : awayEFGPct;
    const setEFGPct =    isHome ? setHomeEFGPct    : setAwayEFGPct;
    const ftRateVal =    isHome ? homeFTRate    : awayFTRate;
    const setFTRate =    isHome ? setHomeFTRate    : setAwayFTRate;
    const tovPctVal =    isHome ? homeTovPct    : awayTovPct;
    const setTovPct =    isHome ? setHomeTovPct    : setAwayTovPct;
    const orebPctVal =   isHome ? homeOrebPct   : awayOrebPct;
    const setOrebPct =   isHome ? setHomeOrebPct   : setAwayOrebPct;
    const oppEFGPctVal = isHome ? homeOppEFGPct : awayOppEFGPct;
    const setOppEFGPct = isHome ? setHomeOppEFGPct : setAwayOppEFGPct;
    const oppFTRateVal = isHome ? homeOppFTRate : awayOppFTRate;
    const setOppFTRate = isHome ? setHomeOppFTRate : setAwayOppFTRate;
    const oppTovPctVal = isHome ? homeOppTovPct : awayOppTovPct;
    const setOppTovPct = isHome ? setHomeOppTovPct : setAwayOppTovPct;
    const oppOrebPctVal= isHome ? homeOppOrebPct: awayOppOrebPct;
    const setOppOrebPct= isHome ? setHomeOppOrebPct: setAwayOppOrebPct;

    const streakVal = parseInt(streak) || 0;
    const injuryVal = parseFloat(injury) || 0;

    return (
      <Card key={side}>
        <CardHeader className="pb-3 px-4 pt-4">
          <CardTitle className={`text-sm font-medium ${color}`}>{label}</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          {/* Team selector */}
          <div>
            <Label className="text-xs text-muted-foreground">Equipo</Label>
            <Select value={team} onValueChange={(value) => applyManualTeam(side, value)}>
              <SelectTrigger data-testid={`select-${side}-team`} className="mt-1">
                <SelectValue placeholder="Seleccionar equipo" />
              </SelectTrigger>
              <SelectContent>
                {NBA_TEAMS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            {team && (
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
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            {numInput("Net RTG", netRtg, setNetRtg, `input-${side}-netrtg`)}
            {numInput("Off RTG", offRtg, setOffRtg, `input-${side}-offrtg`)}
            {numInput("Def RTG", defRtg, setDefRtg, `input-${side}-defrtg`)}
            {numInput("Pace", pace, setPace, `input-${side}-pace`)}
            {numInput("Días Descanso", daysRest, setDaysRest, `input-${side}-rest`, "numeric")}
            {numInput("Win Rate (0-1)", winRate, setWinRate, `input-${side}-winrate`)}
          </div>

          {/* B2B */}
          <div className="flex items-center gap-2">
            <Switch checked={b2b} onCheckedChange={setB2B} data-testid={`switch-${side}-b2b`} />
            <Label className="text-xs text-muted-foreground">Back-to-Back</Label>
          </div>

          {/* Streak */}
          <div className="border border-blue-500/20 rounded-lg p-3 bg-blue-500/5 space-y-2">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-blue-400" />
              <Label className="text-xs text-blue-400 font-medium">Racha actual</Label>
            </div>
            <Input
              type="text"
              inputMode="numeric"
              value={streak}
              onChange={(e) => setStreak(e.target.value)}
              placeholder="0"
              data-testid={`input-${side}-streak`}
              className="border-blue-500/30"
            />
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>Victorias seguidas: <span className="text-green-400">+3, +5, +7</span></p>
              <p>Derrotas seguidas: <span className="text-red-400">-3, -5, -7</span></p>
            </div>
            {streakLabel(streakVal) && (
              <p className={`text-xs font-medium ${streakLabel(streakVal)?.color}`}>
                → {streakLabel(streakVal)?.text}
              </p>
            )}
          </div>

          {/* Injury */}
          <div className="border border-amber-500/20 rounded-lg p-3 bg-amber-500/5 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              <Label className="text-xs text-amber-400 font-medium">Ajuste por Lesión</Label>
            </div>
            <Input
              type="text"
              inputMode="numeric"
              value={injury}
              onChange={(e) => {
                setInjury(e.target.value);
                // Manual edit → reset to safe default 1.0/0.5
                setInjuryFactors({off: 1.0, def: 0.5, type: "Manual"});
              }}
              placeholder="0"
              data-testid={`input-${side}-injury`}
              className="border-amber-500/30"
            />
            {injury && injury !== "0" && parseFloat(injury) !== 0 && (
              <div className="text-[11px] text-amber-300/80 bg-amber-500/5 rounded px-2 py-1 border border-amber-500/15">
                <span className="font-medium">Auto-tipo: </span>
                <span className="text-amber-200">{injuryFactors.type}</span>
                <span className="text-muted-foreground ml-1">(off {(injuryFactors.off * 100).toFixed(0)}% · def {(injuryFactors.def * 100).toFixed(0)}%)</span>
              </div>
            )}
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>Estrella OUT: <span className="text-red-400">-6 a -8</span></p>
              <p>Jugador clave OUT: <span className="text-amber-400">-3 a -5</span></p>
              <p>Regresa hoy: <span className="text-green-400">+4 a +6</span></p>
            </div>
            {injuryLabel(injuryVal) && (
              <p className={`text-xs font-medium ${injuryLabel(injuryVal)?.color}`}>
                → {injuryLabel(injuryVal)?.text}
              </p>
            )}
          </div>

          {/* Factor Dinamico O/U */}
          <div className="border border-teal-500/20 rounded-lg p-3 bg-teal-500/5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-teal-400">📊</span>
              <Label className="text-xs text-teal-400 font-medium">Factor Dinámico O/U — Últimos 5 partidos</Label>
              <span className="text-xs text-muted-foreground ml-auto italic">opcional</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Pace últimos 5</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={isHome ? homeRecentPace : awayRecentPace}
                  onChange={(e) => (isHome ? setHomeRecentPace : setAwayRecentPace)(e.target.value)}
                  placeholder="Ej: 101.5"
                  data-testid={`input-${side}-recent-pace`}
                  className="border-teal-500/30 mt-1"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">PPG últimos 5</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={isHome ? homeRecentPPG : awayRecentPPG}
                  onChange={(e) => (isHome ? setHomeRecentPPG : setAwayRecentPPG)(e.target.value)}
                  placeholder="Ej: 124.8"
                  data-testid={`input-${side}-recent-ppg`}
                  className="border-teal-500/30 mt-1"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Fuente: <span className="text-teal-400">nba.com/stats</span> → Advanced → Last 5 GP
            </p>
          </div>

          {/* SOS - Contexto de Agenda */}
          {(() => {
            const oppDefVal = parseFloat(isHome ? homeOppDefRtg : awayOppDefRtg) || 0;
            const oppOffVal = parseFloat(isHome ? homeOppOffRtg : awayOppOffRtg) || 0;
            const offRtgVal = parseFloat(isHome ? homeOffRtg : awayOffRtg) || 0;
            const defRtgVal = parseFloat(isHome ? homeDefRtg : awayDefRtg) || 0;
            const adjOff = oppDefVal ? offRtgVal * (113.5 / oppDefVal) : 0;
            const adjDef = oppOffVal ? defRtgVal * (113.5 / oppOffVal) : 0;
            const offDiff = adjOff - offRtgVal;
            const defDiff = adjDef - defRtgVal;
            return (
              <div className="border border-orange-500/20 rounded-lg p-3 bg-orange-500/5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-orange-400">🗓️</span>
                  <Label className="text-xs text-orange-400 font-medium">Contexto de Agenda (SOS)</Label>
                  <span className="text-xs text-muted-foreground ml-auto italic">opcional</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">DefRtg prom. rivals últ. 10</Label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={isHome ? homeOppDefRtg : awayOppDefRtg}
                      onChange={(e) => (isHome ? setHomeOppDefRtg : setAwayOppDefRtg)(e.target.value)}
                      placeholder="Ej: 116.5"
                      data-testid={`input-${side}-opp-def`}
                      className="border-orange-500/30 mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">OffRtg prom. rivals últ. 10</Label>
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={isHome ? homeOppOffRtg : awayOppOffRtg}
                      onChange={(e) => (isHome ? setHomeOppOffRtg : setAwayOppOffRtg)(e.target.value)}
                      placeholder="Ej: 110.2"
                      data-testid={`input-${side}-opp-off`}
                      className="border-orange-500/30 mt-1"
                    />
                  </div>
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p>Rivals con DefRtg alto (agenda fácil) → <span className="text-orange-400">OffRtg inflado</span></p>
                  <p>Rivals con DefRtg bajo (agenda difícil) → <span className="text-green-400">OffRtg subestimado</span></p>
                </div>
                {(oppDefVal > 0 || oppOffVal > 0) && (() => {
                  const sosData = (window as any)[isHome ? "__homeSOS" : "__awaySOS"];
                  const sosLbl = sosData?.label || "";
                  const sosNet = sosData?.netRtg ?? 0;
                  const opps: { name: string; netRtg: number; l10NetRtg: number; blended: number }[] = sosData?.opps || [];
                  const sosColor = sosNet > 4 ? "text-green-400" : sosNet > 1.5 ? "text-green-400" : sosNet > -1.5 ? "text-slate-400" : sosNet > -4 ? "text-orange-400" : "text-red-400";
                  return (
                    <div className="bg-orange-500/10 rounded p-2 space-y-2">
                      {sosLbl && (
                        <p className={`text-xs font-bold ${sosColor}`}>
                          📊 {sosLbl} (NetRtg prom. rivales: {sosNet > 0 ? "+" : ""}{sosNet})
                        </p>
                      )}
                      {oppDefVal > 0 && (
                        <p className="text-xs text-muted-foreground">
                          OffRtg ajustado: {adjOff.toFixed(1)} ({offDiff > 0 ? "+" : ""}{offDiff.toFixed(1)})
                        </p>
                      )}
                      {oppOffVal > 0 && (
                        <p className="text-xs text-muted-foreground">
                          DefRtg ajustado: {adjDef.toFixed(1)} ({defDiff > 0 ? "+" : ""}{defDiff.toFixed(1)})
                        </p>
                      )}
                      {opps.length > 0 && (
                        <div className="pt-1 border-t border-orange-500/20">
                          <p className="text-xs text-muted-foreground mb-1">Últ. 10 rivales (NetRtg blend 60% L10 + 40% temporada):</p>
                          <div className="flex flex-wrap gap-1">
                            {opps.map((o, i) => (
                              <span key={i} className={`text-xs px-1.5 py-0.5 rounded border ${
                                o.blended > 3 ? "bg-green-500/15 border-green-500/30 text-green-400" :
                                o.blended > 0 ? "bg-slate-700/40 border-slate-600 text-slate-300" :
                                o.blended > -3 ? "bg-slate-700/40 border-slate-600 text-slate-400" :
                                "bg-red-500/15 border-red-500/30 text-red-400"
                              }`}>
                                {o.name.split(" ").pop()} {o.blended > 0 ? "+" : ""}{o.blended}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}
          {/* Four Factors (Dean Oliver) */}
          <div className="border border-purple-500/30 rounded-lg p-3 bg-purple-500/5 space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-purple-400 uppercase tracking-wider">🧠 Four Factors (Dean Oliver)</p>
              <span className="text-xs text-muted-foreground ml-auto italic">opcional</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("eFG%", eFGPctVal, setEFGPct, `input-${side}-efg`, "decimal", "0.540")}
              {numInput("TOV%", tovPctVal, setTovPct, `input-${side}-tov`, "decimal", "0.140")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("OREB%", orebPctVal, setOrebPct, `input-${side}-oreb`, "decimal", "0.270")}
              {numInput("FT Rate", ftRateVal, setFTRate, `input-${side}-ftrate`, "decimal", "0.250")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("Opp eFG%", oppEFGPctVal, setOppEFGPct, `input-${side}-oppefg`, "decimal", "0.540")}
              {numInput("Opp TOV%", oppTovPctVal, setOppTovPct, `input-${side}-opptov`, "decimal", "0.140")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("Opp OREB%", oppOrebPctVal, setOppOrebPct, `input-${side}-opporeb`, "decimal", "0.270")}
              {numInput("Opp FT Rate", oppFTRateVal, setOppFTRate, `input-${side}-oppftrate`, "decimal", "0.250")}
            </div>
            <p className="text-xs text-muted-foreground">
              Fuente: <span className="text-purple-400">nba.com/stats</span> → Four Factors
            </p>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1200px] mx-auto">
      <div className="flex items-center gap-3">
        <Brain className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-display font-bold" data-testid="text-predictor-title">Predictor</h1>
        <Badge variant="outline" className="ml-auto text-xs border-green-500/40 text-green-400">
          v3.0 — Four Factors + Poisson
        </Badge>
      </div>

      {/* ── AUTO-LLENADO ── */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold text-primary">Auto-llenar desde NBA.com</span>
            <span className="text-xs text-muted-foreground ml-auto">Llena los stats automáticamente</span>
          </div>

          <DatePickerFL value={selectedDate} onChange={setSelectedDate} />

          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchNBA()}
              disabled={nbaLoading}
              className="shrink-0 border-primary/30 text-primary hover:bg-primary/10"
              data-testid="button-load-games"
            >
              {nbaLoading ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {nbaLoading ? "Cargando..." : "Cargar partidos"}
            </Button>

            {todayGames.length > 0 && (
              <Select value={selectedGameId} onValueChange={setSelectedGameId}>
                <SelectTrigger className="flex-1 border-primary/30" data-testid="select-game">
                  <SelectValue placeholder="Selecciona un partido" />
                </SelectTrigger>
                <SelectContent>
                  {todayGames.map((g) => (
                    <SelectItem key={g.gameId} value={g.gameId}>
                      {g.awayTeam.tricode} @ {g.homeTeam.tricode} · {gameTimeLabel(g.gameTimeUTC)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {selectedGameId && (
              <Button
                size="sm"
                onClick={() => handleAutoFill(selectedGameId)}
                disabled={autoFillStatus === "loading"}
                data-testid="button-autofill"
                className="shrink-0"
              >
                {autoFillStatus === "loading" ? (
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 mr-2" />
                )}
                Auto-llenar
              </Button>
            )}
            {homeTeam && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                onClick={async () => {
                  try {
                    const res = await apiRequest("GET", `/api/odds/nba?date=${encodeURIComponent(selectedDate)}`);
                    const data = await res.json();
                    const games = data.games ?? [];
                    const matched = games.find((g: any) =>
                      g.homeTeam?.toLowerCase().includes(homeTeam.toLowerCase()) ||
                      homeTeam.toLowerCase().includes(g.homeTeam?.toLowerCase())
                    );
                    if (!matched) {
                      toast({ title: "No se encontraron cuotas para este partido", variant: "destructive" });
                      return;
                    }
                    if (matched.ml) { setOdds(String(matched.ml.home)); setAwayOdds(String(matched.ml.away)); }
                    if (matched.spread) { setSpreadLine(String(matched.spread.line)); setSpreadOdds(String(matched.spread.homeOdds)); setSpreadOddsAway(String(matched.spread.awayOdds)); }
                    if (matched.total) { setOuLine(String(matched.total.line)); setOverOdds(String(matched.total.overOdds)); setUnderOdds(String(matched.total.underOdds)); }
                    if (matched.gameKey) setSharpGameKey(matched.gameKey);
                    toast({ title: "Cuotas Hard Rock cargadas" });
                  } catch {
                    toast({ title: "No se encontraron cuotas para este partido", variant: "destructive" });
                  }
                }}
              >
                ⚡ Cuotas HR
              </Button>
            )}
          </div>

          {nbaError && (
            <p className="text-xs text-red-400">⚠️ No se pudo conectar con NBA.com. Llena los datos manualmente.</p>
          )}
          {autoFillStatus === "success" && (
            <p className="text-xs text-green-400">✅ Todo cargado — solo agrega Lesiones y Líneas de Hard Rock</p>
          )}

          <div className="text-xs text-muted-foreground border-t border-border pt-2">
            <span className="font-medium text-foreground">Se llena solo:</span> Todo (Stats · Racha · B2B · Descanso · O/U · SOS)
            &nbsp;&nbsp;<span className="font-medium text-amber-400">Tú solo agregas:</span> Lesiones · Líneas Hard Rock
          </div>

          <EliteBanner sport="NBA" />
          {selectedGameId && <NBARefsCard gameId={selectedGameId} onComposite={(value) => setRefComposite(value ?? null)} />}
          {contextTri.home && contextTri.away && (
            <NBAContextualCard
              homeTri={contextTri.home}
              awayTri={contextTri.away}
              gameDate={(() => { const [y,m,d] = selectedDate.split("-"); return `${m}/${d}/${y}`; })()}
              onContext={setContextAdjPp}
            />
          )}
          {sharpGameKey && <SharpSignalsCard sport="nba" gameKey={sharpGameKey} onDirection={setSharpDir} />}
        </CardContent>
      </Card>

      {/* ANÁLISIS DE LESIONES — Roster Picker */}
      <Card className="border-red-500/30 bg-red-500/5">
        <CardHeader className="pb-2 px-4 pt-4">
          <CardTitle className="text-sm font-semibold text-red-400 flex items-center gap-2">
            <UserX className="h-4 w-4" />
            Análisis de Lesiones
            <span className="text-xs text-muted-foreground ml-auto">Toca jugadores ausentes</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* HOME ROSTER */}
          {homeRoster.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-blue-400 mb-2">🏠 {homeTeam || "Local"} — Toca jugadores ausentes:</p>
              <div className="flex flex-wrap gap-1.5">
                {homeRoster.map((p) => {
                  const isMissing = homeMissing.has(p.name);
                  return (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => {
                        const next = new Set(homeMissing);
                        if (isMissing) { next.delete(p.name); }
                        else { next.add(p.name); }
                        setHomeMissing(next);
                        const impact = calcInjuryImpact(homeRoster, next, homeGamesOut);
                        setHomeInjury(impact.adj !== 0 ? String(impact.adj) : ""); setHomeInjuryFactors({off: impact.offFactor, def: impact.defFactor, type: impact.adj !== 0 ? "Auto" : "Mixto"});
                      }}
                      className={`text-xs px-2 py-1 rounded border transition-all ${
                        isMissing
                          ? "bg-red-500/30 border-red-400 text-red-300 font-bold"
                          : "bg-slate-700/40 border-slate-600 text-slate-300 hover:bg-slate-600/40"
                      }`}
                    >
                      <span className={isMissing ? "line-through" : ""}>{p.name}</span>
                      <span className="text-muted-foreground ml-1">({p.ppg}p {p.mpg}m)</span>
                    </button>
                  );
                })}
              </div>
              {homeMissing.size > 0 && (
                <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/20 space-y-2">
                  {Array.from(homeMissing).map((name) => {
                    const out = homeGamesOut[name] ?? 0;
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span className="text-xs text-red-300 flex-1">{name}</span>
                        <span className="text-xs text-muted-foreground">Partidos fuera:</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(out)}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            const nextGO = { ...homeGamesOut, [name]: val };
                            setHomeGamesOut(nextGO);
                            const impact = calcInjuryImpact(homeRoster, homeMissing, nextGO);
                            setHomeInjury(impact.adj !== 0 ? String(impact.adj) : ""); setHomeInjuryFactors({off: impact.offFactor, def: impact.defFactor, type: impact.adj !== 0 ? "Auto" : "Mixto"});
                          }}
                          className="w-12 text-center text-xs bg-slate-800 border border-red-500/30 rounded px-1 py-0.5 text-white"
                        />
                      </div>
                    );
                  })}
                  <div className="pt-1 border-t border-red-500/20">
                    <p className="text-xs text-red-300 font-medium">
                      Ajuste total: {calcInjuryImpact(homeRoster, homeMissing, homeGamesOut).adj} puntos
                    </p>
                    {calcInjuryImpact(homeRoster, homeMissing, homeGamesOut).details.map((d, i) => (
                      <p key={i} className="text-xs text-red-300/70">• {d}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* HOME — REGRESOS */}
          {homeRoster.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-green-400 mb-2">🏠 {homeTeam || "Local"} — Jugadores que REGRESAN:</p>
              <div className="flex flex-wrap gap-1.5">
                {homeRoster.filter(p => !homeMissing.has(p.name)).map((p) => {
                  const isRet = homeReturning.has(p.name);
                  return (
                    <button key={p.name} type="button"
                      onClick={() => {
                        const next = new Set(homeReturning);
                        if (isRet) { next.delete(p.name); } else { next.add(p.name); }
                        setHomeReturning(next);
                        const retImpact = calcReturnImpact(homeRoster, next, homeReturnGames);
                        const missImpact = calcInjuryImpact(homeRoster, homeMissing, homeGamesOut);
                        const total = missImpact.adj + retImpact.adj;
                        setHomeInjury(total !== 0 ? String(total) : "");
                      }}
                      className={`text-xs px-2 py-1 rounded border transition-all ${
                        isRet ? "bg-green-500/30 border-green-400 text-green-300 font-bold" : "bg-slate-700/40 border-slate-600 text-slate-300 hover:bg-slate-600/40"
                      }`}
                    >
                      {isRet && "↑ "}{p.name} <span className="text-muted-foreground ml-1">({p.ppg}p)</span>
                    </button>
                  );
                })}
              </div>
              {homeReturning.size > 0 && (
                <div className="mt-2 p-2 rounded bg-green-500/10 border border-green-500/20 space-y-2">
                  {Array.from(homeReturning).map((name) => {
                    const wasOut = homeReturnGames[name] ?? 0;
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span className="text-xs text-green-300 flex-1">↑ {name}</span>
                        <span className="text-xs text-muted-foreground">Estuvo fuera:</span>
                        <input type="text" inputMode="numeric" value={String(wasOut)}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            const nextRG = { ...homeReturnGames, [name]: val };
                            setHomeReturnGames(nextRG);
                            const retImpact = calcReturnImpact(homeRoster, homeReturning, nextRG);
                            const missImpact = calcInjuryImpact(homeRoster, homeMissing, homeGamesOut);
                            setHomeInjury(String(missImpact.adj + retImpact.adj) || "");
                          }}
                          className="w-12 text-center text-xs bg-slate-800 border border-green-500/30 rounded px-1 py-0.5 text-white"
                        />
                      </div>
                    );
                  })}
                  <div className="pt-1 border-t border-green-500/20">
                    <p className="text-xs text-green-300 font-medium">
                      Boost regreso: +{calcReturnImpact(homeRoster, homeReturning, homeReturnGames).adj} puntos
                    </p>
                    {calcReturnImpact(homeRoster, homeReturning, homeReturnGames).details.map((d, i) => (
                      <p key={i} className="text-xs text-green-300/70">• {d}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* AWAY ROSTER */}
          {awayRoster.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-amber-400 mb-2">✈️ {awayTeam || "Visitante"} — Toca jugadores ausentes:</p>
              <div className="flex flex-wrap gap-1.5">
                {awayRoster.map((p) => {
                  const isMissing = awayMissing.has(p.name);
                  return (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => {
                        const next = new Set(awayMissing);
                        if (isMissing) { next.delete(p.name); }
                        else { next.add(p.name); }
                        setAwayMissing(next);
                        const impact = calcInjuryImpact(awayRoster, next, awayGamesOut);
                        setAwayInjury(impact.adj !== 0 ? String(impact.adj) : ""); setAwayInjuryFactors({off: impact.offFactor, def: impact.defFactor, type: impact.adj !== 0 ? "Auto" : "Mixto"});
                      }}
                      className={`text-xs px-2 py-1 rounded border transition-all ${
                        isMissing
                          ? "bg-red-500/30 border-red-400 text-red-300 font-bold"
                          : "bg-slate-700/40 border-slate-600 text-slate-300 hover:bg-slate-600/40"
                      }`}
                    >
                      <span className={isMissing ? "line-through" : ""}>{p.name}</span>
                      <span className="text-muted-foreground ml-1">({p.ppg}p {p.mpg}m)</span>
                    </button>
                  );
                })}
              </div>
              {awayMissing.size > 0 && (
                <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/20 space-y-2">
                  {Array.from(awayMissing).map((name) => {
                    const out = awayGamesOut[name] ?? 0;
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span className="text-xs text-red-300 flex-1">{name}</span>
                        <span className="text-xs text-muted-foreground">Partidos fuera:</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          value={String(out)}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            const nextGO = { ...awayGamesOut, [name]: val };
                            setAwayGamesOut(nextGO);
                            const impact = calcInjuryImpact(awayRoster, awayMissing, nextGO);
                            setAwayInjury(impact.adj !== 0 ? String(impact.adj) : ""); setAwayInjuryFactors({off: impact.offFactor, def: impact.defFactor, type: impact.adj !== 0 ? "Auto" : "Mixto"});
                          }}
                          className="w-12 text-center text-xs bg-slate-800 border border-red-500/30 rounded px-1 py-0.5 text-white"
                        />
                      </div>
                    );
                  })}
                  <div className="pt-1 border-t border-red-500/20">
                    <p className="text-xs text-red-300 font-medium">
                      Ajuste total: {calcInjuryImpact(awayRoster, awayMissing, awayGamesOut).adj} puntos
                    </p>
                    {calcInjuryImpact(awayRoster, awayMissing, awayGamesOut).details.map((d, i) => (
                      <p key={i} className="text-xs text-red-300/70">• {d}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* AWAY — REGRESOS */}
          {awayRoster.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-green-400 mb-2">✈️ {awayTeam || "Visitante"} — Jugadores que REGRESAN:</p>
              <div className="flex flex-wrap gap-1.5">
                {awayRoster.filter(p => !awayMissing.has(p.name)).map((p) => {
                  const isRet = awayReturning.has(p.name);
                  return (
                    <button key={p.name} type="button"
                      onClick={() => {
                        const next = new Set(awayReturning);
                        if (isRet) { next.delete(p.name); } else { next.add(p.name); }
                        setAwayReturning(next);
                        const retImpact = calcReturnImpact(awayRoster, next, awayReturnGames);
                        const missImpact = calcInjuryImpact(awayRoster, awayMissing, awayGamesOut);
                        const total = missImpact.adj + retImpact.adj;
                        setAwayInjury(total !== 0 ? String(total) : "");
                      }}
                      className={`text-xs px-2 py-1 rounded border transition-all ${
                        isRet ? "bg-green-500/30 border-green-400 text-green-300 font-bold" : "bg-slate-700/40 border-slate-600 text-slate-300 hover:bg-slate-600/40"
                      }`}
                    >
                      {isRet && "↑ "}{p.name} <span className="text-muted-foreground ml-1">({p.ppg}p)</span>
                    </button>
                  );
                })}
              </div>
              {awayReturning.size > 0 && (
                <div className="mt-2 p-2 rounded bg-green-500/10 border border-green-500/20 space-y-2">
                  {Array.from(awayReturning).map((name) => {
                    const wasOut = awayReturnGames[name] ?? 0;
                    return (
                      <div key={name} className="flex items-center gap-2">
                        <span className="text-xs text-green-300 flex-1">↑ {name}</span>
                        <span className="text-xs text-muted-foreground">Estuvo fuera:</span>
                        <input type="text" inputMode="numeric" value={String(wasOut)}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            const nextRG = { ...awayReturnGames, [name]: val };
                            setAwayReturnGames(nextRG);
                            const retImpact = calcReturnImpact(awayRoster, awayReturning, nextRG);
                            const missImpact = calcInjuryImpact(awayRoster, awayMissing, awayGamesOut);
                            setAwayInjury(String(missImpact.adj + retImpact.adj) || "");
                          }}
                          className="w-12 text-center text-xs bg-slate-800 border border-green-500/30 rounded px-1 py-0.5 text-white"
                        />
                      </div>
                    );
                  })}
                  <div className="pt-1 border-t border-green-500/20">
                    <p className="text-xs text-green-300 font-medium">
                      Boost regreso: +{calcReturnImpact(awayRoster, awayReturning, awayReturnGames).adj} puntos
                    </p>
                    {calcReturnImpact(awayRoster, awayReturning, awayReturnGames).details.map((d, i) => (
                      <p key={i} className="text-xs text-green-300/70">• {d}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {homeRoster.length === 0 && awayRoster.length === 0 && (
            <p className="text-xs text-muted-foreground">Carga un partido primero para ver los rosters</p>
          )}
        </CardContent>
      </Card>

      {/* H2H and Game Type card */}
      {(h2hRecord || (gameType && gameType !== "Regular Season")) && (
        <Card className="border-violet-500/30 bg-violet-500/5">
          <CardContent className="p-4 space-y-2">
            {gameType && gameType !== "Regular Season" && (
              <div className="flex items-center gap-2">
                <Badge className="bg-violet-500/30 text-violet-300 border-violet-400">{gameType}</Badge>
                <span className="text-xs text-violet-300">Factor postemporada aplicado</span>
              </div>
            )}
            {h2hRecord && (
              <p className="text-xs text-muted-foreground">H2H esta temporada: <span className="text-white font-medium">{h2hRecord}</span></p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Forms */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {teamSection("home")}
        {teamSection("away")}
      </div>

      {/* Lines + Button */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground font-medium">Moneyline</p>
          <div className="grid grid-cols-2 gap-4">
            {numInput("ML Local", odds, setOdds, "input-odds", "numeric", "-200")}
            {numInput("ML Visitante", awayOdds, setAwayOdds, "input-away-odds", "numeric", "+170")}
          </div>
          <p className="text-xs text-muted-foreground font-medium">Spread</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {numInput("Línea Spread", spreadLine, setSpreadLine, "input-spread", "decimal", "-7.5")}
            {numInput("Cuota Local", spreadOdds, setSpreadOdds, "input-spread-odds", "numeric", "-110")}
            {numInput("Cuota Visitante", spreadOddsAway, setSpreadOddsAway, "input-spread-away", "numeric", "-110")}
          </div>
          <p className="text-xs text-muted-foreground font-medium">Over/Under</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {numInput("Línea O/U", ouLine, setOuLine, "input-ou", "decimal", "225.5")}
            {numInput("Cuota OVER", overOdds, setOverOdds, "input-over-odds", "numeric", "-110")}
            {numInput("Cuota UNDER", underOdds, setUnderOdds, "input-under-odds", "numeric", "-110")}
          </div>
          <Button onClick={runPrediction} className="w-full" data-testid="button-predict">
            <Brain className="h-4 w-4 mr-2" />
            Generar Predicción
          </Button>
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <div className="space-y-4" data-testid="card-prediction-result">

          {/* JUGADA SEGURA */}
          {result.safePlay && (
            <Card className="border-green-500/50 bg-green-500/10 shadow-lg shadow-green-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-green-400 flex items-center gap-2">
                  <span className="text-lg">🛡️</span>
                  Jugada Segura {result.safePlay.confidence === "ULTRA" ? "92%+" : "90%+"}
                  <Badge className={`ml-auto border ${result.safePlay.confidence === "ULTRA" ? "bg-green-500/30 text-green-300 border-green-400" : "bg-emerald-500/20 text-emerald-300 border-emerald-400"}`}>
                    {(result.safePlay.probability * 100).toFixed(1)}%
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-lg font-bold text-white mb-2">{result.safePlay.description}</p>
                <p className="text-xs text-muted-foreground mb-2">Tipo: {result.safePlay.type}</p>
                <div className="space-y-1">
                  {result.safePlay.reasoning.map((r, i) => (
                    <p key={i} className="text-xs text-green-300/80">✔ {r}</p>
                  ))}
                </div>
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Probabilidad</span>
                    <span>{(result.safePlay.probability * 100).toFixed(1)}%</span>
                  </div>
                  <Progress value={result.safePlay.probability * 100} className="h-2" />
                </div>
              </CardContent>
            </Card>
          )}

          {/* LÍNEAS ALTERNATIVAS — mayor confianza */}
          {result.altLines && result.altLines.length > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5 shadow-lg shadow-amber-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                  <span className="text-lg">🎯</span>
                  Líneas Alternativas (Comprar Puntos)
                  <Badge className="ml-auto bg-amber-500/20 text-amber-300 border border-amber-400 text-[10px]">
                    Mayor Confianza
                  </Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Spread/O-U ajustados para ganar con mas seguridad. Las cuotas son estimadas — verifica en Hard Rock.
                </p>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="space-y-2">
                  {result.altLines.map((alt, i) => {
                    const probPct = (alt.coverProb * 100).toFixed(1);
                    const confColor = alt.confidence === "ULTRA"
                      ? "text-green-400 bg-green-500/20 border-green-500/40"
                      : alt.confidence === "ALTA"
                      ? "text-emerald-400 bg-emerald-500/20 border-emerald-500/40"
                      : "text-yellow-400 bg-yellow-500/20 border-yellow-500/40";
                    const barColor = alt.confidence === "ULTRA"
                      ? "[&>div]:bg-green-500"
                      : alt.confidence === "ALTA"
                      ? "[&>div]:bg-emerald-500"
                      : "[&>div]:bg-yellow-500";
                    return (
                      <div key={i} className="rounded-lg border border-border/50 bg-background/30 p-3">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <Badge className={`text-[10px] px-1.5 py-0 border ${confColor}`}>
                              {alt.type}
                            </Badge>
                            <span className="text-sm font-bold text-white">{alt.description}</span>
                          </div>
                          <span className={`text-sm font-bold font-mono ${alt.confidence === "ULTRA" ? "text-green-400" : alt.confidence === "ALTA" ? "text-emerald-400" : "text-yellow-400"}`}>
                            {probPct}%
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <Progress value={alt.coverProb * 100} className={`h-1.5 flex-1 ${barColor}`} />
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            Cuota est. {alt.estOdds}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* ANALISIS ESTADISTICO O/U - POISSON */}
          {result.poisson && (
            <Card className="border-indigo-500/30 bg-indigo-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-indigo-400">🎲 Análisis Estadístico (O/U)</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="p-2 rounded bg-indigo-500/10">
                    <p className="text-xs text-muted-foreground">Pts Local</p>
                    <p className="text-lg font-bold text-white">{result.poisson.homeExpPoints}</p>
                  </div>
                  <div className="p-2 rounded bg-indigo-500/10">
                    <p className="text-xs text-muted-foreground">Pts Visit</p>
                    <p className="text-lg font-bold text-white">{result.poisson.awayExpPoints}</p>
                  </div>
                  <div className="p-2 rounded bg-indigo-500/10">
                    <p className="text-xs text-muted-foreground">Total</p>
                    <p className="text-lg font-bold text-white">{result.poisson.totalExpPoints}</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className={`flex-1 p-2 rounded text-center ${result.poisson.overProb > result.poisson.underProb ? "bg-green-500/10 border border-green-500/30" : "bg-slate-700/30"}`}>
                    <p className="text-xs text-muted-foreground">OVER</p>
                    <p className="text-base font-bold text-white">{(result.poisson.overProb * 100).toFixed(1)}%</p>
                  </div>
                  <div className={`flex-1 p-2 rounded text-center ${result.poisson.underProb > result.poisson.overProb ? "bg-blue-500/10 border border-blue-500/30" : "bg-slate-700/30"}`}>
                    <p className="text-xs text-muted-foreground">UNDER</p>
                    <p className="text-base font-bold text-white">{(result.poisson.underProb * 100).toFixed(1)}%</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* JUGADA ESTRELLA */}
          {result.bestPlay ? (
            <Card className="border-yellow-400/50 shadow-lg shadow-yellow-400/10">
              <CardContent className="p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Star className="h-5 w-5 text-yellow-400 fill-yellow-400" />
                  <span className="text-yellow-400 font-bold text-base tracking-wide">JUGADA ESTRELLA</span>
                  <Badge className="ml-auto bg-yellow-400/20 text-yellow-300 border-yellow-400/30 text-xs">
                    {result.bestPlay.market}
                  </Badge>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className="flex-1">
                    <p className="text-2xl font-bold text-white">{result.bestPlay.recommendation}</p>
                    <p className="text-sm text-muted-foreground mt-1">{result.bestPlay.reason}</p>
                  </div>
                  <div className="flex gap-4 shrink-0">
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Señal</p>
                      <Badge className={`${signalColor(result.bestPlay.signal)} text-sm px-3 py-1`}>
                        {result.bestPlay.signal}
                      </Badge>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Edge</p>
                      <p className="text-lg font-bold font-mono text-green-400">{result.bestPlay.edgeLabel}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Confianza</p>
                      <p className={`text-lg font-bold font-mono ${confidenceColor(result.bestPlay.confidence)}`}>
                        {result.bestPlay.confidence}%
                      </p>
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <Progress value={result.bestPlay.confidence} className="h-2 [&>div]:bg-yellow-400" />
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-red-500/30">
              <CardContent className="p-4 flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-red-400 shrink-0" />
                <p className="text-sm text-red-400 font-medium">
                  Ningún mercado tiene ventaja suficiente — <span className="font-bold">NO APOSTAR</span>
                </p>
              </CardContent>
            </Card>
          )}

          {/* Injury notice */}
          {(result.homeInjuryAdj !== 0 || result.awayInjuryAdj !== 0) && (
            <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
              <p className="text-xs text-amber-300">
                Ajuste por lesiones aplicado:
                {result.homeInjuryAdj !== 0 && ` Local ${result.homeInjuryAdj > 0 ? "+" : ""}${result.homeInjuryAdj} pts`}
                {result.awayInjuryAdj !== 0 && ` · Visitante ${result.awayInjuryAdj > 0 ? "+" : ""}${result.awayInjuryAdj} pts`}
              </p>
            </div>
          )}

          {/* ML */}
          <Card className="border-blue-500/30">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-medium text-blue-400">Moneyline (ML)</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-4">
              <div>
                <div className="flex justify-between text-xs mb-2">
                  <span className="text-blue-400 font-medium">{result.homeTeam} — {result.homeProb.toFixed(1)}%</span>
                  <span className="text-amber-400 font-medium">{result.awayTeam} — {result.awayProb.toFixed(1)}%</span>
                </div>
                <Progress value={result.homeProb} className="h-3 [&>div]:bg-blue-500" />
                {result.factorBreakdown && result.factorBreakdown.notes.length > 0 && (
                  <div className="mt-2 text-[11px] text-purple-300/90 bg-purple-500/5 border border-purple-500/20 rounded px-2 py-1">
                    <span className="font-medium">Factores Élite aplicados: </span>
                    {result.factorBreakdown.notes.join(" · ")}
                    <span className="text-muted-foreground"> (base {result.factorBreakdown.baseProb.toFixed(1)}% → final {result.factorBreakdown.finalProb.toFixed(1)}%)</span>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">Lado</p>
                  <p className={`text-base font-bold ${result.pickedSide === "home" ? "text-blue-400" : "text-amber-400"}`}>
                    {result.pickedSide === "home" ? result.homeTeam : result.awayTeam}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    @ {result.odds > 0 ? "+" : ""}{result.odds}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">Señal</p>
                  <div className="flex items-center justify-center gap-1">
                    <Badge className={`${signalColor(result.signal)} text-sm px-3 py-1`} data-testid="badge-signal">
                      {result.signal}
                    </Badge>
                    {(() => {
                      const badge = sharpBadgeFor(result.pickedSide ?? null, sharpDir, "ml");
                      return badge ? (
                        <Badge variant="outline" className={`text-sm px-1 ${badge.className}`} title={badge.tooltip}>
                          {badge.label}
                        </Badge>
                      ) : null;
                    })()}
                  </div>
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">Edge</p>
                  <p className={`text-lg font-bold font-mono ${result.edge > 0 ? "text-green-400" : "text-red-400"}`}>
                    {result.edge > 0 ? "+" : ""}{result.edge.toFixed(2)}%
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">Prob. Implícita</p>
                  <p className="text-lg font-bold font-mono">{result.impliedProb.toFixed(1)}%</p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">Stake Kelly</p>
                  <p className="text-lg font-bold font-mono text-green-400">${result.stake.toFixed(2)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Spread */}
          {result.spread && (
            <Card className="border-purple-500/30">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-medium text-purple-400">Spread</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Señal</p>
                    <Badge className={`${signalColor(result.spread.signal)} text-sm px-3 py-1`}>
                      {result.spread.signal}
                    </Badge>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Prob. cubrir</p>
                    <p className={`text-lg font-bold font-mono ${
                      (result.spread.coverProb ?? 0) >= 0.60 ? "text-green-400" :
                      (result.spread.coverProb ?? 0) >= 0.52 ? "text-amber-400" : "text-red-400"
                    }`}>
                      {((result.spread.coverProb ?? 0) * 100).toFixed(1)}%
                    </p>
                    <p className="text-[10px] text-muted-foreground">{result.spread.confidence}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Margen esperado</p>
                    <p className="text-lg font-bold font-mono text-blue-400">
                      {result.spread.expectedMargin > 0 ? "+" : ""}{result.spread.expectedMargin.toFixed(1)} pts
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Edge vs línea</p>
                    <p className={`text-lg font-bold font-mono ${result.spread.edgeVsSpread > 0 ? "text-green-400" : "text-red-400"}`}>
                      {result.spread.edgeVsSpread > 0 ? "+" : ""}{result.spread.edgeVsSpread.toFixed(1)} pts
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Recomendación</p>
                    <p className={`text-sm font-bold ${result.spread.pickedSide === "home" ? "text-blue-400" : "text-amber-400"}`}>
                      {result.spread.pickedSide === "home" ? result.homeTeam : result.awayTeam} {result.spread.side.replace(/^Local |^Visitante /, "")}
                    </p>
                  </div>
                </div>
                {(() => {
                  // CRÍTICO: cuota del LADO recomendado, no siempre del local
                  const sOdds = result.spread.pickedSide === "away" ? (parseInt(spreadOddsAway) || -110) : (parseInt(spreadOdds) || -110);
                  const sImpl = americanToProb(sOdds);
                  const absEdge = Math.abs(result.spread.edgeVsSpread);
                  const sProb = result.spread.coverProb ?? Math.min(0.85, Math.max(0.15, 0.5 + absEdge / 30));
                  const sEdgePct = (sProb - sImpl) * 100;
                  const b = sOdds > 0 ? sOdds / 100 : 100 / Math.abs(sOdds);
                  const bk = state.bankrollInitial + state.picks.reduce((s, p) => s + p.profit, 0);
                  const kelly = Math.max(0, (b * sProb - (1 - sProb)) / b) * 0.25 * bk;
                  return (
                    <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-purple-500/10">
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">Cuota</p>
                        <p className="text-sm font-mono">{sOdds > 0 ? "+" : ""}{sOdds}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">Edge vs Cuota</p>
                        <p className={`text-lg font-bold font-mono ${sEdgePct > 0 ? "text-green-400" : "text-red-400"}`}>{sEdgePct > 0 ? "+" : ""}{sEdgePct.toFixed(1)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">Stake Kelly</p>
                        <p className="text-lg font-bold font-mono text-green-400">${kelly.toFixed(2)}</p>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          {/* O/U */}
          {result.total && (
            <Card className="border-amber-500/30">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-medium text-amber-400">Over / Under</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Señal</p>
                    <Badge className={`${signalColor(result.total.signal)} text-sm px-3 py-1`}>
                      {result.total.signal}
                    </Badge>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Prob. acierto</p>
                    <p className={`text-lg font-bold font-mono ${
                      (result.total.hitProb ?? 0) >= 0.60 ? "text-green-400" :
                      (result.total.hitProb ?? 0) >= 0.52 ? "text-amber-400" : "text-red-400"
                    }`}>
                      {((result.total.hitProb ?? 0) * 100).toFixed(1)}%
                    </p>
                    <p className="text-[10px] text-muted-foreground">{result.total.confidence}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Total estimado</p>
                    <p className="text-lg font-bold font-mono text-amber-400">
                      {result.total.estimatedTotal.toFixed(1)} pts
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">vs línea O/U</p>
                    <p className={`text-lg font-bold font-mono ${result.total.edge > 0 ? "text-green-400" : "text-red-400"}`}>
                      {result.total.edge > 0 ? "+" : ""}{result.total.edge.toFixed(1)} pts
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Recomendación</p>
                    <p className={`text-lg font-bold ${result.total.side === "OVER" ? "text-green-400" : "text-blue-400"}`}>
                      {result.total.side}
                    </p>
                  </div>
                </div>
                {(() => {
                  const oOdds = parseInt(result.total.side === "OVER" ? overOdds : underOdds) || -110;
                  const oImpl = americanToProb(oOdds);
                  const absEdge = Math.abs(result.total.edge);
                  const oProb = result.total.hitProb ?? Math.min(0.85, Math.max(0.15, 0.5 + absEdge / 40));
                  const oEdgePct = (oProb - oImpl) * 100;
                  const b = oOdds > 0 ? oOdds / 100 : 100 / Math.abs(oOdds);
                  const bk = state.bankrollInitial + state.picks.reduce((s, p) => s + p.profit, 0);
                  const kelly = Math.max(0, (b * oProb - (1 - oProb)) / b) * 0.25 * bk;
                  return (
                    <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-amber-500/10">
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">Cuota</p>
                        <p className="text-sm font-mono">{oOdds > 0 ? "+" : ""}{oOdds}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">Edge vs Cuota</p>
                        <p className={`text-lg font-bold font-mono ${oEdgePct > 0 ? "text-green-400" : "text-red-400"}`}>{oEdgePct > 0 ? "+" : ""}{oEdgePct.toFixed(1)}%</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">Stake Kelly</p>
                        <p className="text-lg font-bold font-mono text-green-400">${kelly.toFixed(2)}</p>
                      </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          )}

          {/* GUARDAR PICKS */}
          <Card className="border border-slate-600/30">
            <CardContent className="p-4">
              <p className="text-sm font-medium text-slate-300 mb-3">
                <Save className="h-4 w-4 inline mr-2" />
                Guardar picks en historial NBA
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="border-blue-500/30 text-blue-400"
                  onClick={() => {
                    if (!homeTeam || !awayTeam) return;
                    const favTeam = result.homeProb > 50 ? homeTeam : awayTeam;
                    dispatch({ type: "ADD_PICK", payload: {
                      date: new Date().toISOString().split("T")[0], sport: "NBA",
                      team: homeTeam, opponent: awayTeam, market: "ML",
                      pick: `${favTeam} ML`, odds: result.odds,
                      modelProb: Math.max(result.homeProb, result.awayProb),
                      stake: Math.round(result.stake * 100) / 100, result: "P",
                    }});
                    toast({ title: "Pick ML guardado" });
                  }}>
                  <Check className="h-3 w-3 mr-1" /> ML
                </Button>
                {result.spread && (
                  <Button size="sm" variant="outline" className="border-purple-500/30 text-purple-400"
                    onClick={() => {
                      const isAway = result.spread!.pickedSide === "away";
                      const sOdds = isAway ? (parseInt(spreadOddsAway) || -110) : (parseInt(spreadOdds) || -110);
                      const teamPicked = isAway ? awayTeam : homeTeam;
                      const sideClean = result.spread!.side.replace(/^Local |^Visitante /, "");
                      dispatch({ type: "ADD_PICK", payload: {
                        date: new Date().toISOString().split("T")[0], sport: "NBA",
                        team: homeTeam, opponent: awayTeam, market: "Spread",
                        pick: `${teamPicked} ${sideClean}`, odds: sOdds,
                        modelProb: Math.round((result.spread!.coverProb ?? 0.5) * 100),
                        stake: 25, result: "P",
                      }});
                      toast({ title: "Pick Spread guardado" });
                    }}>
                    <Check className="h-3 w-3 mr-1" /> Spread
                  </Button>
                )}
                {result.total && (
                  <Button size="sm" variant="outline" className="border-amber-500/30 text-amber-400"
                    onClick={() => {
                      const oOdds = parseInt(result.total!.side === "OVER" ? overOdds : underOdds) || -110;
                      dispatch({ type: "ADD_PICK", payload: {
                        date: new Date().toISOString().split("T")[0], sport: "NBA",
                        team: homeTeam, opponent: awayTeam, market: "O/U",
                        pick: `${result.total!.side} ${ouLine}`, odds: oOdds,
                        modelProb: 55,
                        stake: 25, result: "P",
                      }});
                      toast({ title: "Pick O/U guardado" });
                    }}>
                    <Check className="h-3 w-3 mr-1" /> {result.total.side}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2">Solo se guardan los mercados que selecciones</p>
            </CardContent>
          </Card>
        </div>
      )}
      <PrintFab />
    </div>
  );
}

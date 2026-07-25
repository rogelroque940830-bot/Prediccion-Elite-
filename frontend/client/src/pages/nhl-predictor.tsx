import { useState, useCallback } from "react";
import { getAwayTravelDistance, travelPenalty } from "@/lib/travel";
import {
  predictNHL,
  predictNHLTotal,
  evaluatePuckLine,
  nhlEvaluateTotal,
  nhlGetSignal,
  nhlGetBestPlay,
  nhlPoissonTotal,
  nhlFindSafePlay,
  americanToProb,
  calcNHLInjuryImpact,
  regressToMarket,
  nhlCalibrate,
  applyConfirmedGoalieAdjustment,
  type NHLConfirmedGoalie,
  type NHLTeamStats,
  type NHLGoalie,
  type NHLGameContext,
  type NHLBestPlay,
  type NHLPoissonResult,
  type NHLSafePlay,
  type NHLRosterPlayer,
  NHL_TEAMS,
} from "@/lib/nhl-model";
import { useAppContext } from "@/lib/context";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import { DatePickerFL, todayFL } from "@/components/date-picker-fl";
import { NHLGoalieCard, EliteBanner, SharpSignalsCard, sharpBadgeFor, type SharpDirection } from "@/components/elite-factors";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Brain, Star, AlertTriangle, RefreshCw, Zap, Save, Check } from "lucide-react";
import { PrintFab } from "@/components/print-fab";

// ── Types ────────────────────────────────────────────────────────────────────
interface NHLPredictionResult {
  homeProb: number;
  awayProb: number;
  estimatedTotal: number;
  mlEdge: number;
  mlSignal: "BET" | "LEAN" | "PASS";
  mlStake: number;
  pickedSide?: "home" | "away";
  recommendedOdds?: number;
  puckLineResult: { expectedMargin: number; signal: "BET" | "LEAN" | "PASS"; side: string; pickedSide?: "home" | "away"; coverProb?: number; confidence?: string } | null;
  totalResult: { edge: number; signal: "BET" | "LEAN" | "PASS"; side: "OVER" | "UNDER"; hitProb?: number; confidence?: string } | null;
  bestPlay: NHLBestPlay | null;
  homeTeam: string;
  awayTeam: string;
  poisson: NHLPoissonResult | null;
  safePlay: NHLSafePlay | null;
  factorBreakdown?: {
    baseProb: number;
    finalProb: number;
    notes: string[];
    goalieUnconfirmed?: boolean;
  };
}

interface NHLManualTeam {
  teamName: string;
  abbr: string;
  seasonId: string;
  gamesPlayed?: number;
  goalsFor: number;
  goalsAgainst: number;
  ppPct?: number;
  pkPct?: number;
  shotsFor?: number;
  shotsAgainst?: number;
  corsi?: number;
  winRate10: number;
  streak?: number;
  recentGF?: number;
  recentGA?: number;
  daysRest?: number;
  isB2B?: boolean;
  gamesLast7Days?: number;
  xGF?: number;
  xGA?: number;
  cf5v5?: number;
  shPct?: number;
  hdCF?: number;
  hdCA?: number;
  ppGF?: number;
  pkGA?: number;
  scoreAdjXGF?: number;
  scoreAdjXGA?: number;
}

function normalizeNhlTeamName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ── Helpers (pure) ───────────────────────────────────────────────────────────
function signalColor(s: string) {
  if (s === "BET") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "LEAN") return "bg-amber-500/20 text-amber-400 border-amber-500/30";
  return "bg-red-500/20 text-red-400 border-red-500/30";
}

function signalLabel(s: string) {
  if (s === "BET") return "APOSTAR";
  if (s === "LEAN") return "INCLINAR";
  return "PASAR";
}

function kellyFraction(prob: number, odds: number): number {
  const decOdds = odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
  const b = decOdds - 1;
  const q = 1 - prob;
  const kelly = (b * prob - q) / b;
  return Math.max(0, Math.min(kelly * 0.25, 0.05));
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function NHLPredictor() {
  const { state, dispatch } = useAppContext();
  const { toast } = useToast();

  const [homeRecentGF, setHomeRecentGF] = useState("");
  const [awayRecentGF, setAwayRecentGF] = useState("");
  const [homeRecentSvPct, setHomeRecentSvPct] = useState("");
  const [awayRecentSvPct, setAwayRecentSvPct] = useState("");
  const [recentGAA, setRecentGAA] = useState("");
  const [record, setRecord] = useState("");
  const [homeOppGF, setHomeOppGF] = useState("");
  const [awayOppGF, setAwayOppGF] = useState("");
  const [homeSOS, setHomeSOS] = useState("");
  const [awaySOS, setAwaySOS] = useState("");
  const [homeGoalieOptions, setHomeGoalieOptions] = useState<{name:string;svPct:number;gaa:number;record:string;gp:number;gsax?:number}[]>([]);
  const [awayGoalieOptions, setAwayGoalieOptions] = useState<{name:string;svPct:number;gaa:number;record:string;gp:number;gsax?:number}[]>([]);
  // Advanced analytics (MoneyPuck) — auto-filled
  const [homeXGF, setHomeXGF] = useState("");
  const [homeXGA, setHomeXGA] = useState("");
  const [awayXGF, setAwayXGF] = useState("");
  const [awayXGA, setAwayXGA] = useState("");
  const [homeCF5v5, setHomeCF5v5] = useState("");
  const [awayCF5v5, setAwayCF5v5] = useState("");
  const [homeSHPct, setHomeSHPct] = useState("");
  const [awaySHPct, setAwaySHPct] = useState("");
  const [homeHDCF, setHomeHDCF] = useState("");
  const [homeHDCA, setHomeHDCA] = useState("");
  const [awayHDCF, setAwayHDCF] = useState("");
  const [awayHDCA, setAwayHDCA] = useState("");
  const [homePPGF, setHomePPGF] = useState("");
  const [awayPPGF, setAwayPPGF] = useState("");
  const [homePKGA, setHomePKGA] = useState("");
  const [awayPKGA, setAwayPKGA] = useState("");
  const [homeGSAx, setHomeGSAx] = useState("");
  const [awayGSAx, setAwayGSAx] = useState("");
  const [homeScoreAdjXGF, setHomeScoreAdjXGF] = useState("");
  const [homeScoreAdjXGA, setHomeScoreAdjXGA] = useState("");
  const [awayScoreAdjXGF, setAwayScoreAdjXGF] = useState("");
  const [awayScoreAdjXGA, setAwayScoreAdjXGA] = useState("");
  // H2H season series
  const [h2hLabel, setH2hLabel] = useState("");
  const [h2hHomeWins, setH2hHomeWins] = useState(0);
  const [h2hAwayWins, setH2hAwayWins] = useState(0);
  // Home/Away splits
  const [homeHomeSplitGF, setHomeHomeSplitGF] = useState("");
  const [homeHomeSplitGA, setHomeHomeSplitGA] = useState("");
  const [homeAwaySpGF, setHomeAwaySpGF] = useState("");
  const [homeAwaySpGA, setHomeAwaySpGA] = useState("");
  const [homeHomeSplitRec, setHomeHomeSplitRec] = useState("");
  const [homeAwaySplitRec, setHomeAwaySplitRec] = useState("");
  const [awayHomeSplitGF, setAwayHomeSplitGF] = useState("");
  const [awayHomeSplitGA, setAwayHomeSplitGA] = useState("");
  const [awayAwaySpGF, setAwayAwaySpGF] = useState("");
  const [awayAwaySpGA, setAwayAwaySpGA] = useState("");
  const [awayHomeSplitRec, setAwayHomeSplitRec] = useState("");
  const [awayAwaySplitRec, setAwayAwaySplitRec] = useState("");
  // Roster / Injury state
  const [homeRecentOpps, setHomeRecentOpps] = useState<{opp:string;result:string;score:string;venue:string}[]>([]);
  const [awayRecentOpps, setAwayRecentOpps] = useState<{opp:string;result:string;score:string;venue:string}[]>([]);
  const [homeRoster, setHomeRoster] = useState<NHLRosterPlayer[]>([]);
  const [awayRoster, setAwayRoster] = useState<NHLRosterPlayer[]>([]);
  const [homeMissing, setHomeMissing] = useState<Set<string>>(new Set());
  const [awayMissing, setAwayMissing] = useState<Set<string>>(new Set());
  const [homeGamesOut, setHomeGamesOut] = useState<Record<string, number>>({});
  const [awayGamesOut, setAwayGamesOut] = useState<Record<string, number>>({});

  // Auto-fill NHL
  const [selNHLGame, setSelNHLGame] = useState("");
  const [selectedDate, setSelectedDate] = useState<string>(todayFL()); // YYYY-MM-DD Florida
  const [sharpGameKey, setSharpGameKey] = useState<string | null>(null);
  const [goalieData, setGoalieData] = useState<{ confirmed: boolean; home: NHLConfirmedGoalie | null; away: NHLConfirmedGoalie | null } | null>(null);
  const [sharpDir, setSharpDir] = useState<SharpDirection | null>(null);
  const [homeManualStatus, setHomeManualStatus] = useState<"idle" | "verified" | "manual">("idle");
  const [awayManualStatus, setAwayManualStatus] = useState<"idle" | "verified" | "manual">("idle");
  const { data: nhlData, isLoading: nhlLoading, refetch: refetchNHL, error: nhlError } = useQuery<{ success: boolean; games: any[] }>({
    queryKey: ["/api/nhl/all", selectedDate],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/nhl/all?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: false, staleTime: 30 * 60 * 1000, retry: 1,
  });
  const nhlGames = nhlData?.games ?? [];

  const {
    data: manualTeamPayload,
    isLoading: manualTeamsLoading,
    error: manualTeamsError,
  } = useQuery<{ success: boolean; data: NHLManualTeam[]; source: string; seasonId: string }>({
    queryKey: ["/api/nhl/manual-teams", selectedDate],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/nhl/manual-teams?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
  const manualTeams: NHLManualTeam[] = manualTeamPayload?.data ?? [];

  const applyManualNHLTeam = (side: "home" | "away", teamName: string) => {
    const isHome = side === "home";
    const setters = {
      team: isHome ? setHomeTeam : setAwayTeam,
      abbr: isHome ? setHomeAbbr : setAwayAbbr,
      gf: isHome ? setHomeGF : setAwayGF,
      ga: isHome ? setHomeGA : setAwayGA,
      pp: isHome ? setHomePP : setAwayPP,
      pk: isHome ? setHomePK : setAwayPK,
      corsi: isHome ? setHomeCorsi : setAwayCorsi,
      shotsFor: isHome ? setHomeShotsFor : setAwayShotsFor,
      shotsAgainst: isHome ? setHomeShotsAgainst : setAwayShotsAgainst,
      streak: isHome ? setHomeStreak : setAwayStreak,
      winRate: isHome ? setHomeWinRate10 : setAwayWinRate10,
      b2b: isHome ? setHomeB2B : setAwayB2B,
      rest: isHome ? setHomeDaysRest : setAwayDaysRest,
      recentGF: isHome ? setHomeRecentGF : setAwayRecentGF,
      recentGA: isHome ? setHomeRecentGA : setAwayRecentGA,
      sos: isHome ? setHomeSOS : setAwaySOS,
      xGF: isHome ? setHomeXGF : setAwayXGF,
      xGA: isHome ? setHomeXGA : setAwayXGA,
      cf5v5: isHome ? setHomeCF5v5 : setAwayCF5v5,
      shPct: isHome ? setHomeSHPct : setAwaySHPct,
      hdCF: isHome ? setHomeHDCF : setAwayHDCF,
      hdCA: isHome ? setHomeHDCA : setAwayHDCA,
      ppGF: isHome ? setHomePPGF : setAwayPPGF,
      pkGA: isHome ? setHomePKGA : setAwayPKGA,
      scoreAdjXGF: isHome ? setHomeScoreAdjXGF : setAwayScoreAdjXGF,
      scoreAdjXGA: isHome ? setHomeScoreAdjXGA : setAwayScoreAdjXGA,
      goalieName: isHome ? setHomeGoalieName : setAwayGoalieName,
      savePct: isHome ? setHomeSavePct : setAwaySavePct,
      gaa: isHome ? setHomeGAA : setAwayGAA,
      goalieRecord: isHome ? setHomeRecord : setAwayRecord,
      recentGAA: isHome ? setHomeRecentGAA : setAwayRecentGAA,
      recentSvPct: isHome ? setHomeRecentSvPct : setAwayRecentSvPct,
      gsax: isHome ? setHomeGSAx : setAwayGSAx,
      goalieOptions: isHome ? setHomeGoalieOptions : setAwayGoalieOptions,
      roster: isHome ? setHomeRoster : setAwayRoster,
      recentOpps: isHome ? setHomeRecentOpps : setAwayRecentOpps,
      status: isHome ? setHomeManualStatus : setAwayManualStatus,
    };

    setters.team(teamName);
    setResult(null);
    setSelNHLGame("");
    setSharpGameKey(null);
    setGoalieData(null);
    setH2hLabel("");
    setH2hHomeWins(0);
    setH2hAwayWins(0);

    setters.abbr("");
    setters.gf(""); setters.ga(""); setters.pp(""); setters.pk(""); setters.corsi("");
    setters.shotsFor(""); setters.shotsAgainst(""); setters.streak("0"); setters.winRate("");
    setters.b2b(false); setters.rest(""); setters.recentGF(""); setters.recentGA(""); setters.sos("");
    setters.xGF(""); setters.xGA(""); setters.cf5v5(""); setters.shPct("");
    setters.hdCF(""); setters.hdCA(""); setters.ppGF(""); setters.pkGA("");
    setters.scoreAdjXGF(""); setters.scoreAdjXGA("");
    setters.goalieName(""); setters.savePct(""); setters.gaa(""); setters.goalieRecord("");
    setters.recentGAA(""); setters.recentSvPct(""); setters.gsax(""); setters.goalieOptions([]);
    setters.roster([]); setters.recentOpps([]);
    if (isHome) {
      setHomeHomeSplitGF(""); setHomeHomeSplitGA(""); setHomeAwaySpGF(""); setHomeAwaySpGA("");
      setHomeHomeSplitRec(""); setHomeAwaySplitRec(""); setHomeMissing(new Set()); setHomeGamesOut({});
    } else {
      setAwayHomeSplitGF(""); setAwayHomeSplitGA(""); setAwayAwaySpGF(""); setAwayAwaySpGA("");
      setAwayHomeSplitRec(""); setAwayAwaySplitRec(""); setAwayMissing(new Set()); setAwayGamesOut({});
    }

    const team = manualTeams.find(
      (row) => normalizeNhlTeamName(row.teamName) === normalizeNhlTeamName(teamName),
    );
    if (!team) {
      setters.status("manual");
      toast({
        title: manualTeamsLoading ? "Cargando estadísticas NHL" : "Entrada manual NHL",
        description: manualTeamsLoading
          ? "Espera a que termine la carga y vuelve a seleccionar el equipo."
          : "No hay estadísticas verificadas disponibles; los campos permanecen vacíos.",
      });
      return;
    }

    setters.abbr(team.abbr);
    setters.gf(team.goalsFor.toFixed(2));
    setters.ga(team.goalsAgainst.toFixed(2));
    setters.pp(team.ppPct !== undefined ? team.ppPct.toFixed(1) : "");
    setters.pk(team.pkPct !== undefined ? team.pkPct.toFixed(1) : "");
    setters.corsi(team.corsi !== undefined ? team.corsi.toFixed(1) : "");
    setters.shotsFor(team.shotsFor !== undefined ? team.shotsFor.toFixed(1) : "");
    setters.shotsAgainst(team.shotsAgainst !== undefined ? team.shotsAgainst.toFixed(1) : "");
    setters.winRate(team.winRate10.toFixed(2));
    setters.streak(team.streak !== undefined ? String(team.streak) : "0");
    setters.rest(team.daysRest !== undefined ? String(team.daysRest) : "");
    setters.b2b(team.isB2B ?? false);
    setters.recentGF(team.recentGF !== undefined ? team.recentGF.toFixed(2) : "");
    setters.recentGA(team.recentGA !== undefined ? team.recentGA.toFixed(2) : "");
    setters.xGF(team.xGF !== undefined ? String(team.xGF) : "");
    setters.xGA(team.xGA !== undefined ? String(team.xGA) : "");
    setters.cf5v5(team.cf5v5 !== undefined ? String(team.cf5v5) : "");
    setters.shPct(team.shPct !== undefined ? String(team.shPct) : "");
    setters.hdCF(team.hdCF !== undefined ? String(team.hdCF) : "");
    setters.hdCA(team.hdCA !== undefined ? String(team.hdCA) : "");
    setters.ppGF(team.ppGF !== undefined ? String(team.ppGF) : "");
    setters.pkGA(team.pkGA !== undefined ? String(team.pkGA) : "");
    setters.scoreAdjXGF(team.scoreAdjXGF !== undefined ? String(team.scoreAdjXGF) : "");
    setters.scoreAdjXGA(team.scoreAdjXGA !== undefined ? String(team.scoreAdjXGA) : "");
    setters.status("verified");

    toast({
      title: `✅ ${teamName} cargado`,
      description: team.daysRest === undefined
        ? "Stats de equipo verificadas. Descanso y portero pendientes porque no hay partido activo."
        : "Stats y descanso cargados. Confirma o introduce el portero probable.",
    });
  };

  const autoFillNHL = async (gameId: string) => {
    let games = nhlGames;
    if (games.length === 0) {
      const result = await refetchNHL();
      games = (result.data as any)?.games ?? [];
    }
    const game = games.find(g => String(g.gameId) === gameId);
    if (!game) return;
    const hs = game.homeStats;
    const as_ = game.awayStats;

    setHomeTeam(game.homeTeam.name);
    setHomeAbbr(game.homeTeam.abbr || "");
    setAwayAbbr(game.awayTeam.abbr || "");
    if (hs) {
      setHomeGF(String(hs.goalsFor)); setHomeGA(String(hs.goalsAgainst));
      setHomeWinRate10(String(hs.winRate)); setHomeStreak(String(hs.streak));
      if (hs.ppPct) setHomePP(String(hs.ppPct));
      if (hs.pkPct) setHomePK(String(hs.pkPct));
      if (hs.shotsFor) setHomeShotsFor(String(hs.shotsFor));
      if (hs.shotsAgainst) setHomeShotsAgainst(String(hs.shotsAgainst));
      if (hs.l10GF) setHomeRecentGF(String(hs.l10GF));
      if (hs.l10GA) setHomeRecentGA(String(hs.l10GA));
    }
    // Home goalie
    const hg = game.homeGoalie;
    if (hg) {
      setHomeGoalieName(hg.name || "");
      setHomeSavePct(String(hg.savePct));
      setHomeGAA(String(hg.gaa));
      setHomeRecord(hg.record);
      if (hg.recentGAA !== undefined) setHomeRecentGAA(String(hg.recentGAA));
      if (hg.recentSvPct !== undefined) setHomeRecentSvPct(String(hg.recentSvPct));
    }

    setAwayTeam(game.awayTeam.name);
    if (as_) {
      setAwayGF(String(as_.goalsFor)); setAwayGA(String(as_.goalsAgainst));
      setAwayWinRate10(String(as_.winRate)); setAwayStreak(String(as_.streak));
      if (as_.ppPct) setAwayPP(String(as_.ppPct));
      if (as_.pkPct) setAwayPK(String(as_.pkPct));
      if (as_.shotsFor) setAwayShotsFor(String(as_.shotsFor));
      if (as_.shotsAgainst) setAwayShotsAgainst(String(as_.shotsAgainst));
      if (as_.l10GF) setAwayRecentGF(String(as_.l10GF));
      if (as_.l10GA) setAwayRecentGA(String(as_.l10GA));
    }
    // Away goalie
    const ag = game.awayGoalie;
    if (ag) {
      setAwayGoalieName(ag.name || "");
      setAwaySavePct(String(ag.savePct));
      setAwayGAA(String(ag.gaa));
      setAwayRecord(ag.record);
      if (ag.recentGAA !== undefined) setAwayRecentGAA(String(ag.recentGAA));
      if (ag.recentSvPct !== undefined) setAwayRecentSvPct(String(ag.recentSvPct));
    }
    // SOS: opponent quality — the rival's GF tells us how strong the opponents were
    // SOS = opponent avg GF / league avg GF (>1 = tough schedule, <1 = easy)
    const leagueAvgGF = 3.10;
    if (hs?.goalsFor) {
      setAwayOppGF(String(hs.goalsFor));
    }
    if (as_?.goalsFor) {
      setHomeOppGF(String(as_.goalsFor));
    }
    // Auto-compute SOS from API if available
    if (game.homeSOS !== undefined) setHomeSOS(String(game.homeSOS));
    else if (hs?.sosScore !== undefined) setHomeSOS(String(hs.sosScore));
    if (game.awaySOS !== undefined) setAwaySOS(String(game.awaySOS));
    else if (as_?.sosScore !== undefined) setAwaySOS(String(as_.sosScore));

    // Store goalie options for manual switching
    if (game.homeGoalieOptions) setHomeGoalieOptions(game.homeGoalieOptions);
    if (game.awayGoalieOptions) setAwayGoalieOptions(game.awayGoalieOptions);

    // Advanced analytics (MoneyPuck) — auto-fill
    if (hs?.xGF !== undefined) setHomeXGF(String(hs.xGF));
    if (hs?.xGA !== undefined) setHomeXGA(String(hs.xGA));
    if (as_?.xGF !== undefined) setAwayXGF(String(as_.xGF));
    if (as_?.xGA !== undefined) setAwayXGA(String(as_.xGA));
    if (hs?.cf5v5 !== undefined) setHomeCF5v5(String(hs.cf5v5));
    if (as_?.cf5v5 !== undefined) setAwayCF5v5(String(as_.cf5v5));
    if (hs?.shPct !== undefined) setHomeSHPct(String(hs.shPct));
    if (as_?.shPct !== undefined) setAwaySHPct(String(as_.shPct));
    if (hs?.hdCF !== undefined) setHomeHDCF(String(hs.hdCF));
    if (hs?.hdCA !== undefined) setHomeHDCA(String(hs.hdCA));
    if (as_?.hdCF !== undefined) setAwayHDCF(String(as_.hdCF));
    if (as_?.hdCA !== undefined) setAwayHDCA(String(as_.hdCA));
    if (hs?.ppGF !== undefined) setHomePPGF(String(hs.ppGF));
    if (as_?.ppGF !== undefined) setAwayPPGF(String(as_.ppGF));
    if (hs?.pkGA !== undefined) setHomePKGA(String(hs.pkGA));
    if (as_?.pkGA !== undefined) setAwayPKGA(String(as_.pkGA));
    // GSAx from goalie data
    if (hg?.gsax !== undefined) setHomeGSAx(String(hg.gsax));
    if (ag?.gsax !== undefined) setAwayGSAx(String(ag.gsax));
    // Score-adjusted xG
    if (hs?.scoreAdjXGF !== undefined) setHomeScoreAdjXGF(String(hs.scoreAdjXGF));
    if (hs?.scoreAdjXGA !== undefined) setHomeScoreAdjXGA(String(hs.scoreAdjXGA));
    if (as_?.scoreAdjXGF !== undefined) setAwayScoreAdjXGF(String(as_.scoreAdjXGF));
    if (as_?.scoreAdjXGA !== undefined) setAwayScoreAdjXGA(String(as_.scoreAdjXGA));

    // H2H season series
    setH2hLabel(game.h2h || "");
    setH2hHomeWins(game.h2hHomeWins || 0);
    setH2hAwayWins(game.h2hAwayWins || 0);

    // Home/Away splits
    if (hs?.homeGF !== undefined) setHomeHomeSplitGF(String(hs.homeGF));
    if (hs?.homeGA !== undefined) setHomeHomeSplitGA(String(hs.homeGA));
    if (hs?.awayGF !== undefined) setHomeAwaySpGF(String(hs.awayGF));
    if (hs?.awayGA !== undefined) setHomeAwaySpGA(String(hs.awayGA));
    if (hs?.homeRecord) setHomeHomeSplitRec(hs.homeRecord);
    if (hs?.awayRecord) setHomeAwaySplitRec(hs.awayRecord);
    if (as_?.homeGF !== undefined) setAwayHomeSplitGF(String(as_.homeGF));
    if (as_?.homeGA !== undefined) setAwayHomeSplitGA(String(as_.homeGA));
    if (as_?.awayGF !== undefined) setAwayAwaySpGF(String(as_.awayGF));
    if (as_?.awayGA !== undefined) setAwayAwaySpGA(String(as_.awayGA));
    if (as_?.homeRecord) setAwayHomeSplitRec(as_.homeRecord);
    if (as_?.awayRecord) setAwayAwaySplitRec(as_.awayRecord);

    // Roster data for injury/lineup system
    if (game.homeRoster) setHomeRoster(game.homeRoster);
    if (game.awayRoster) setAwayRoster(game.awayRoster);
    if (game.homeRecentOpps) setHomeRecentOpps(game.homeRecentOpps);
    if (game.awayRecentOpps) setAwayRecentOpps(game.awayRecentOpps);
    setHomeMissing(new Set());
    setAwayMissing(new Set());
    setHomeGamesOut({});
    setAwayGamesOut({});

    if (game.isPlayoffs !== undefined) setIsPlayoffs(game.isPlayoffs);
    toast({ title: "📊 Datos NHL + MoneyPuck cargados" });
  };


  // ── Home goalie ──────────────────────────────────────────────────────────
  const [homeSavePct, setHomeSavePct] = useState("");
  const [homeGAA, setHomeGAA] = useState("");
  const [homeRecord, setHomeRecord] = useState("");
  const [homeGoalieName, setHomeGoalieName] = useState("");
  const [awayGoalieName, setAwayGoalieName] = useState("");
  const [homeRecentGA, setHomeRecentGA] = useState("");
  const [awayRecentGA, setAwayRecentGA] = useState("");
  const [homeRecentGAA, setHomeRecentGAA] = useState("");

  // ── Home team ────────────────────────────────────────────────────────────
  const [homeTeam, setHomeTeam] = useState("");
  const [homeAbbr, setHomeAbbr] = useState("");
  const [awayAbbr, setAwayAbbr] = useState("");
  const [homeGF, setHomeGF] = useState("");
  const [homeGA, setHomeGA] = useState("");
  const [homePP, setHomePP] = useState("");
  const [homePK, setHomePK] = useState("");
  const [homeCorsi, setHomeCorsi] = useState("");
  const [homeShotsFor, setHomeShotsFor] = useState("");
  const [homeShotsAgainst, setHomeShotsAgainst] = useState("");

  // ── Home momentum ────────────────────────────────────────────────────────
  const [homeStreak, setHomeStreak] = useState("0");
  const [homeWinRate10, setHomeWinRate10] = useState("");
  const [homeB2B, setHomeB2B] = useState(false);
  const [homeDaysRest, setHomeDaysRest] = useState("");

  // ── Away goalie ──────────────────────────────────────────────────────────
  const [awaySavePct, setAwaySavePct] = useState("");
  const [awayGAA, setAwayGAA] = useState("");
  const [awayRecord, setAwayRecord] = useState("");
  const [awayRecentGAA, setAwayRecentGAA] = useState("");

  // ── Away team ────────────────────────────────────────────────────────────
  const [awayTeam, setAwayTeam] = useState("");
  const [awayGF, setAwayGF] = useState("");
  const [awayGA, setAwayGA] = useState("");
  const [awayPP, setAwayPP] = useState("");
  const [awayPK, setAwayPK] = useState("");
  const [awayCorsi, setAwayCorsi] = useState("");
  const [awayShotsFor, setAwayShotsFor] = useState("");
  const [awayShotsAgainst, setAwayShotsAgainst] = useState("");

  // ── Away momentum ────────────────────────────────────────────────────────
  const [awayStreak, setAwayStreak] = useState("0");
  const [awayWinRate10, setAwayWinRate10] = useState("");
  const [awayB2B, setAwayB2B] = useState(false);
  const [awayDaysRest, setAwayDaysRest] = useState("");

  // ── Context ──────────────────────────────────────────────────────────────
  const [isPlayoffs, setIsPlayoffs] = useState(false);

  // ── Lines ────────────────────────────────────────────────────────────────
  const [mlOddsHome, setMlOddsHome] = useState("-150");
  const [mlOddsAway, setMlOddsAway] = useState("+130");
  const [puckLine, setPuckLine] = useState("-1.5");
  const [puckLineOddsHome, setPuckLineOddsHome] = useState("+140");
  const [puckLineOddsAway, setPuckLineOddsAway] = useState("-160");
  const [ouLine, setOuLine] = useState("6.0");
  const [overOdds, setOverOdds] = useState("-110");
  const [underOdds, setUnderOdds] = useState("-110");

  // ── Result ───────────────────────────────────────────────────────────────
  const [result, setResult] = useState<NHLPredictionResult | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  // ── numInput helper ──────────────────────────────────────────────────────
  const numInput = (
    label: string,
    value: string,
    setter: (v: string) => void,
    testid: string,
    mode: "decimal" | "numeric" = "decimal",
    placeholder?: string
  ) => (
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

  // ── Team card (inline helper) ────────────────────────────────────────────
  const teamCard = (side: "home" | "away") => {
    const isHome = side === "home";
    const teamLabel = isHome ? "🏠 Local" : "✈️ Visitante";
    const borderColor = isHome ? "border-blue-500/30" : "border-amber-500/30";
    const titleColor = isHome ? "text-blue-400" : "text-amber-400";

    // Goalie fields
    const goalieName = isHome ? homeGoalieName : awayGoalieName;
    const savePct = isHome ? homeSavePct : awaySavePct;
    const gaa = isHome ? homeGAA : awayGAA;
    const record = isHome ? homeRecord : awayRecord;
    const recentGAA = isHome ? homeRecentGAA : awayRecentGAA;
    const recentSvPct = isHome ? homeRecentSvPct : awayRecentSvPct;
    const setSavePct = isHome ? setHomeSavePct : setAwaySavePct;
    const setGaa = isHome ? setHomeGAA : setAwayGAA;
    const setRecord = isHome ? setHomeRecord : setAwayRecord;
    const setRecentGAA = isHome ? setHomeRecentGAA : setAwayRecentGAA;
    const setRecentSvPct = isHome ? setHomeRecentSvPct : setAwayRecentSvPct;

    // Goalie options for switching
    const goalieOpts = isHome ? homeGoalieOptions : awayGoalieOptions;
    const setGoalieName = isHome ? setHomeGoalieName : setAwayGoalieName;

    // Recent form / SOS
    const recentGFVal = isHome ? homeRecentGF : awayRecentGF;
    const recentGAVal = isHome ? homeRecentGA : awayRecentGA;
    const oppGF = isHome ? homeOppGF : awayOppGF;
    const sosScore = isHome ? homeSOS : awaySOS;
    const setRecentGFVal = isHome ? setHomeRecentGF : setAwayRecentGF;
    const setRecentGAVal = isHome ? setHomeRecentGA : setAwayRecentGA;
    const setOppGF = isHome ? setHomeOppGF : setAwayOppGF;
    const setSosScore = isHome ? setHomeSOS : setAwaySOS;

    // Advanced analytics
    const xGF = isHome ? homeXGF : awayXGF;
    const xGA = isHome ? homeXGA : awayXGA;
    const cf5v5 = isHome ? homeCF5v5 : awayCF5v5;
    const shPctVal = isHome ? homeSHPct : awaySHPct;
    const hdCF = isHome ? homeHDCF : awayHDCF;
    const hdCA = isHome ? homeHDCA : awayHDCA;
    const ppGFVal = isHome ? homePPGF : awayPPGF;
    const pkGAVal = isHome ? homePKGA : awayPKGA;
    const gsaxVal = isHome ? homeGSAx : awayGSAx;
    const setXGF = isHome ? setHomeXGF : setAwayXGF;
    const setXGA = isHome ? setHomeXGA : setAwayXGA;
    const setCF5v5 = isHome ? setHomeCF5v5 : setAwayCF5v5;
    const setSHPct = isHome ? setHomeSHPct : setAwaySHPct;
    const setHDCF = isHome ? setHomeHDCF : setAwayHDCF;
    const setHDCA = isHome ? setHomeHDCA : setAwayHDCA;
    const setPPGF = isHome ? setHomePPGF : setAwayPPGF;
    const setPKGA = isHome ? setHomePKGA : setAwayPKGA;
    const setGSAx = isHome ? setHomeGSAx : setAwayGSAx;

    // Team fields
    const team = isHome ? homeTeam : awayTeam;
    const gf = isHome ? homeGF : awayGF;
    const ga = isHome ? homeGA : awayGA;
    const pp = isHome ? homePP : awayPP;
    const pk = isHome ? homePK : awayPK;
    const corsi = isHome ? homeCorsi : awayCorsi;
    const shotsFor = isHome ? homeShotsFor : awayShotsFor;
    const shotsAgainst = isHome ? homeShotsAgainst : awayShotsAgainst;
    const setTeam = isHome ? setHomeTeam : setAwayTeam;
    const setGf = isHome ? setHomeGF : setAwayGF;
    const setGa = isHome ? setHomeGA : setAwayGA;
    const setPp = isHome ? setHomePP : setAwayPP;
    const setPk = isHome ? setHomePK : setAwayPK;
    const setCorsi = isHome ? setHomeCorsi : setAwayCorsi;
    const setShotsFor = isHome ? setHomeShotsFor : setAwayShotsFor;
    const setShotsAgainst = isHome ? setHomeShotsAgainst : setAwayShotsAgainst;

    // Momentum fields
    const streak = isHome ? homeStreak : awayStreak;
    const winRate10 = isHome ? homeWinRate10 : awayWinRate10;
    const b2b = isHome ? homeB2B : awayB2B;
    const daysRest = isHome ? homeDaysRest : awayDaysRest;
    const setStreak = isHome ? setHomeStreak : setAwayStreak;
    const setWinRate10 = isHome ? setHomeWinRate10 : setAwayWinRate10;
    const setB2B = isHome ? setHomeB2B : setAwayB2B;
    const setDaysRest = isHome ? setHomeDaysRest : setAwayDaysRest;

    return (
      <Card className={`border ${borderColor} bg-card/50`} key={side}>
        <CardHeader className="pb-2 px-4 pt-4">
          <CardTitle className={`text-sm font-semibold ${titleColor}`}>{teamLabel}</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* Team selector */}
          <div>
            <Label className="text-xs text-muted-foreground">Equipo</Label>
            <Select value={team} onValueChange={(value) => applyManualNHLTeam(side, value)}>
              <SelectTrigger className="mt-1" data-testid={`select-${side}-team`}>
                <SelectValue placeholder="Seleccionar equipo" />
              </SelectTrigger>
              <SelectContent>
                {NHL_TEAMS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {team && (
              <p className={`mt-1 text-[11px] ${(isHome ? homeManualStatus : awayManualStatus) === "verified" ? "text-green-400" : "text-amber-400"}`}>
                {(isHome ? homeManualStatus : awayManualStatus) === "verified"
                  ? "Autollenado verificado · fuente directa"
                  : manualTeamsLoading
                    ? "Cargando estadísticas verificadas…"
                    : "Entrada manual · no usar valores sin verificar"}
              </p>
            )}
            {team && (isHome ? homeManualStatus : awayManualStatus) === "verified" && !daysRest.trim() && (
              <p className="mt-1 text-[11px] text-amber-400">Descanso pendiente · no hay partido activo en la fecha seleccionada.</p>
            )}
            {team && (isHome ? homeManualStatus : awayManualStatus) === "verified" && !goalieName.trim() && (
              <p className="mt-1 text-[11px] text-cyan-400">Portero pendiente · debe confirmarse antes de generar una predicción.</p>
            )}
          </div>

          {/* PORTERO section */}
          <div className="border border-cyan-500/30 rounded-lg p-3 bg-cyan-500/5 space-y-3">
            <p className="text-xs font-semibold text-cyan-400 uppercase tracking-wider mb-2">🥅 Portero Probable</p>
            <div>
              <Label className="text-xs text-muted-foreground">Nombre del portero</Label>
              <Input
                type="text"
                value={goalieName}
                onChange={(e) => setGoalieName(e.target.value)}
                data-testid={`input-${side}-goalie-name`}
                placeholder="Nombre del portero"
                className="mt-1 border-cyan-500/40 text-white font-bold text-base bg-cyan-500/10"
              />
            </div>
            {goalieOpts.length > 1 && (
              <div>
                <Label className="text-xs text-amber-400">⚠️ Cambiar portero:</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {goalieOpts.map((opt) => (
                    <button
                      key={opt.name}
                      type="button"
                      onClick={() => {
                        setGoalieName(opt.name);
                        setSavePct(String(opt.svPct));
                        setGaa(String(opt.gaa));
                        setRecord(opt.record);
                        setRecentGAA("");
                        setRecentSvPct("");
                        if (opt.gsax !== undefined) setGSAx(String(opt.gsax));
                        toast({ title: `Portero cambiado a ${opt.name}` });
                      }}
                      className={`text-xs px-2 py-1 rounded border transition-colors ${
                        goalieName === opt.name
                          ? "bg-cyan-500/30 border-cyan-400 text-cyan-300 font-bold"
                          : "bg-slate-700/50 border-slate-600 text-slate-300 hover:bg-slate-600/50"
                      }`}
                    >
                      {opt.name} ({opt.gp}GP{opt.gsax !== undefined ? `, GSAx ${opt.gsax > 0 ? "+" : ""}${opt.gsax}` : `, ${opt.svPct} SV%`})
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {numInput("Save% (ej: 0.910)", savePct, setSavePct, `input-${side}-savepct`, "decimal", "0.910")}
              {numInput("GAA", gaa, setGaa, `input-${side}-gaa`, "decimal", "2.80")}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Registro (ej: 25-10-3)</Label>
              <Input
                type="text"
                value={record}
                onChange={(e) => setRecord(e.target.value)}
                data-testid={`input-${side}-record`}
                placeholder="25-10-3"
                className="mt-1 border-cyan-500/30"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">GAA últ. 5</Label>
                <Input type="text" inputMode="decimal" value={recentGAA}
                  onChange={(e) => setRecentGAA(e.target.value)}
                  data-testid={`input-${side}-recent-gaa`} placeholder="2.20"
                  className="mt-1 border-cyan-500/30" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">SV% últ. 5</Label>
                <Input type="text" inputMode="decimal" value={recentSvPct}
                  onChange={(e) => setRecentSvPct(e.target.value)}
                  data-testid={`input-${side}-recent-svpct`} placeholder="0.920"
                  className="mt-1 border-cyan-500/30" />
              </div>
            </div>
          </div>

          {/* FORMA RECIENTE + SOS section */}
          <div className="border border-emerald-500/30 rounded-lg p-3 bg-emerald-500/5 space-y-3">
            <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">📊 Forma Reciente (Últ. 10)</p>
            <div className="grid grid-cols-2 gap-3">
              {numInput("GF/partido últ. 10", recentGFVal, setRecentGFVal, `input-${side}-recent-gf`, "decimal", "3.20")}
              {numInput("GA/partido últ. 10", recentGAVal, setRecentGAVal, `input-${side}-recent-ga`, "decimal", "2.80")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("GF rivales (SOS)", oppGF, setOppGF, `input-${side}-opp-gf`, "decimal", "3.10")}
              {numInput("SOS Score", sosScore, setSosScore, `input-${side}-sos`, "decimal", "1.00")}
            </div>
            {sosScore && parseFloat(sosScore) > 0 && (
              <p className={`text-xs font-medium ${
                parseFloat(sosScore) > 1.05 ? "text-green-400" :
                parseFloat(sosScore) < 0.95 ? "text-amber-400" : "text-slate-400"
              }`}>
                {parseFloat(sosScore) > 1.05 ? "🔥 Calendario difícil — forma reciente vale más" :
                 parseFloat(sosScore) < 0.95 ? "⚠️ Calendario fácil — forma reciente vale menos" :
                 "📊 Calendario promedio"}
              </p>
            )}
          </div>

          {/* EQUIPO section */}
          <div className="border border-blue-500/30 rounded-lg p-3 bg-blue-500/5 space-y-3">
            <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider">🏒 Equipo</p>
            <div className="grid grid-cols-2 gap-3">
              {numInput("Goles/partido (GF)", gf, setGf, `input-${side}-gf`, "decimal", "3.2")}
              {numInput("Goles contra (GA)", ga, setGa, `input-${side}-ga`, "decimal", "2.9")}
              {numInput("PP%", pp, setPp, `input-${side}-pp`, "decimal", "22")}
              {numInput("PK%", pk, setPk, `input-${side}-pk`, "decimal", "80")}
              {numInput("Corsi%", corsi, setCorsi, `input-${side}-corsi`, "decimal", "51")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("Tiros a puerta", shotsFor, setShotsFor, `input-${side}-shots-for`, "numeric", "32")}
              {numInput("Tiros en contra", shotsAgainst, setShotsAgainst, `input-${side}-shots-against`, "numeric", "29")}
            </div>
          </div>

          {/* ANALYTICS AVANZADO section (MoneyPuck) */}
          <div className="border border-purple-500/30 rounded-lg p-3 bg-purple-500/5 space-y-3">
            <p className="text-xs font-semibold text-purple-400 uppercase tracking-wider">🧠 Analytics Avanzado (5v5)</p>
            <div className="grid grid-cols-2 gap-3">
              {numInput("xGF/partido", xGF, setXGF, `input-${side}-xgf`, "decimal", "2.10")}
              {numInput("xGA/partido", xGA, setXGA, `input-${side}-xga`, "decimal", "2.10")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("Corsi% 5v5", cf5v5, setCF5v5, `input-${side}-cf5v5`, "decimal", "50.0")}
              {numInput("SH% 5v5", shPctVal, setSHPct, `input-${side}-shpct`, "decimal", "9.0")}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {numInput("HD chances F", hdCF, setHDCF, `input-${side}-hdcf`, "decimal", "1.80")}
              {numInput("HD chances A", hdCA, setHDCA, `input-${side}-hdca`, "decimal", "1.80")}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {numInput("PP GF/g", ppGFVal, setPPGF, `input-${side}-ppgf`, "decimal", "0.60")}
              {numInput("PK GA/g", pkGAVal, setPKGA, `input-${side}-pkga`, "decimal", "0.65")}
              {numInput("GSAx/g", gsaxVal, setGSAx, `input-${side}-gsax`, "decimal", "0.00")}
            </div>
            {gsaxVal && parseFloat(gsaxVal) !== 0 && (
              <p className={`text-xs font-medium ${parseFloat(gsaxVal) > 0.2 ? "text-green-400" : parseFloat(gsaxVal) < -0.2 ? "text-red-400" : "text-slate-400"}`}>
                {parseFloat(gsaxVal) > 0.2 ? `🛡️ Portero elite: salva ${parseFloat(gsaxVal).toFixed(2)} goles extra/partido` :
                 parseFloat(gsaxVal) < -0.2 ? `⚠️ Portero por debajo: cede ${Math.abs(parseFloat(gsaxVal)).toFixed(2)} goles extra/partido` :
                 `📊 Portero promedio`}
              </p>
            )}
          </div>

          {/* MOMENTO section */}
          <div className="border border-amber-500/30 rounded-lg p-3 bg-amber-500/5 space-y-3">
            <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">⚡ Momento</p>
            <div className="grid grid-cols-2 gap-3">
              {numInput("Racha", streak, setStreak, `input-${side}-streak`, "numeric", "0")}
              {numInput("Win Rate últ. 10", winRate10, setWinRate10, `input-${side}-winrate`, "decimal", "0.6")}
            </div>
            {parseInt(streak) !== 0 && (
              <p className={`text-xs font-medium ${parseInt(streak) > 0 ? "text-green-400" : "text-red-400"}`}>
                {parseInt(streak) > 0 ? `Racha ${streak}V 🔥` : `Racha ${Math.abs(parseInt(streak))}D ❄️`}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Switch
                checked={b2b}
                onCheckedChange={setB2B}
                data-testid={`switch-${side}-b2b`}
              />
              <Label className="text-xs text-muted-foreground">Back-to-Back (B2B)</Label>
            </div>
            {numInput("Días descanso", daysRest, setDaysRest, `input-${side}-rest`, "numeric", "2")}
          </div>
        </CardContent>
      </Card>
    );
  };

  // ── Run Prediction ───────────────────────────────────────────────────────
  const runPrediction = useCallback(() => {
    const requiredNumeric = [
      { label: "SV% Portero Local", value: homeSavePct },
      { label: "GAA Portero Local", value: homeGAA },
      { label: "GF Local", value: homeGF },
      { label: "GA Local", value: homeGA },
      { label: "PP% Local", value: homePP },
      { label: "PK% Local", value: homePK },
      { label: "Corsi Local", value: homeCorsi },
      { label: "Tiros Local", value: homeShotsFor },
      { label: "Tiros contra Local", value: homeShotsAgainst },
      { label: "Win Rate Local", value: homeWinRate10 },
      { label: "Descanso Local", value: homeDaysRest },
      { label: "SV% Portero Visitante", value: awaySavePct },
      { label: "GAA Portero Visitante", value: awayGAA },
      { label: "GF Visitante", value: awayGF },
      { label: "GA Visitante", value: awayGA },
      { label: "PP% Visitante", value: awayPP },
      { label: "PK% Visitante", value: awayPK },
      { label: "Corsi Visitante", value: awayCorsi },
      { label: "Tiros Visitante", value: awayShotsFor },
      { label: "Tiros contra Visitante", value: awayShotsAgainst },
      { label: "Win Rate Visitante", value: awayWinRate10 },
      { label: "Descanso Visitante", value: awayDaysRest },
    ];
    const missing = requiredNumeric
      .filter(({ value }) => value.trim() === "" || !Number.isFinite(Number(value)))
      .map(({ label }) => label);
    if (!homeGoalieName.trim()) missing.unshift("Portero Local");
    if (!awayGoalieName.trim()) missing.push("Portero Visitante");

    const invalidRanges: string[] = [];
    const homeSv = Number(homeSavePct);
    const awaySv = Number(awaySavePct);
    const homeWr = Number(homeWinRate10);
    const awayWr = Number(awayWinRate10);
    if (homeSavePct.trim() && (homeSv < 0.8 || homeSv > 1)) invalidRanges.push("SV% Local fuera de rango");
    if (awaySavePct.trim() && (awaySv < 0.8 || awaySv > 1)) invalidRanges.push("SV% Visitante fuera de rango");
    if (homeWinRate10.trim() && (homeWr < 0 || homeWr > 1)) invalidRanges.push("Win Rate Local fuera de rango");
    if (awayWinRate10.trim() && (awayWr < 0 || awayWr > 1)) invalidRanges.push("Win Rate Visitante fuera de rango");

    if (!homeTeam || !awayTeam || homeTeam === awayTeam || missing.length > 0 || invalidRanges.length > 0) {
      const description = !homeTeam || !awayTeam
        ? "Selecciona el equipo Local y el Visitante."
        : homeTeam === awayTeam
          ? "Selecciona dos equipos diferentes."
          : missing.length > 0
            ? `Faltan: ${missing.join(", ")}.`
            : invalidRanges.join(", ");
      toast({ title: "Faltan datos NHL", description });
      return;
    }
    const homeGoalie: NHLGoalie = {
      savesPct: parseFloat(homeSavePct) || 0.910,
      gaa: parseFloat(homeGAA) || 2.80,
      record: homeRecord || "0-0-0",
      recentGAA: homeRecentGAA.trim() ? parseFloat(homeRecentGAA) || undefined : undefined,
      recentSvPct: homeRecentSvPct.trim() ? parseFloat(homeRecentSvPct) || undefined : undefined,
      gsax: homeGSAx.trim() ? parseFloat(homeGSAx) || undefined : undefined,
    };

    const awayGoalie: NHLGoalie = {
      savesPct: parseFloat(awaySavePct) || 0.910,
      gaa: parseFloat(awayGAA) || 2.80,
      record: awayRecord || "0-0-0",
      recentGAA: awayRecentGAA.trim() ? parseFloat(awayRecentGAA) || undefined : undefined,
      recentSvPct: awayRecentSvPct.trim() ? parseFloat(awayRecentSvPct) || undefined : undefined,
      gsax: awayGSAx.trim() ? parseFloat(awayGSAx) || undefined : undefined,
    };

    // Calculate injury impact
    const homeInjury = calcNHLInjuryImpact(homeRoster, homeMissing, homeGamesOut);
    const awayInjury = calcNHLInjuryImpact(awayRoster, awayMissing, awayGamesOut);

    const home: NHLTeamStats = {
      name: homeTeam || "Local",
      goalsFor: parseFloat(homeGF) || 3.2,
      goalsAgainst: parseFloat(homeGA) || 2.9,
      ppPct: parseFloat(homePP) || 22,
      pkPct: parseFloat(homePK) || 80,
      corsi: parseFloat(homeCorsi) || 51,
      shotsFor: parseFloat(homeShotsFor) || 32,
      shotsAgainst: parseFloat(homeShotsAgainst) || 29,
      winRate: parseFloat(homeWinRate10) || 0.6,
      streak: parseInt(homeStreak) || 0,
      isB2B: homeB2B,
      daysRest: parseInt(homeDaysRest) || 2,
      goalie: homeGoalie,
      recentGF: homeRecentGF.trim() ? parseFloat(homeRecentGF) || undefined : undefined,
      recentGA: homeRecentGA.trim() ? parseFloat(homeRecentGA) || undefined : undefined,
      sosScore: homeSOS.trim() ? parseFloat(homeSOS) || undefined : undefined,
      // Advanced analytics (MoneyPuck)
      xGF: homeXGF.trim() ? parseFloat(homeXGF) || undefined : undefined,
      xGA: homeXGA.trim() ? parseFloat(homeXGA) || undefined : undefined,
      cf5v5: homeCF5v5.trim() ? parseFloat(homeCF5v5) || undefined : undefined,
      shPct: homeSHPct.trim() ? parseFloat(homeSHPct) || undefined : undefined,
      hdCF: homeHDCF.trim() ? parseFloat(homeHDCF) || undefined : undefined,
      hdCA: homeHDCA.trim() ? parseFloat(homeHDCA) || undefined : undefined,
      ppGF: homePPGF.trim() ? parseFloat(homePPGF) || undefined : undefined,
      pkGA: homePKGA.trim() ? parseFloat(homePKGA) || undefined : undefined,
      scoreAdjXGF: homeScoreAdjXGF.trim() ? parseFloat(homeScoreAdjXGF) || undefined : undefined,
      scoreAdjXGA: homeScoreAdjXGA.trim() ? parseFloat(homeScoreAdjXGA) || undefined : undefined,
      missingPlayerImpact: homeInjury.adj || undefined,
      missingOffFactor: homeInjury.offFactor,
      missingDefFactor: homeInjury.defFactor,
      // H2H
      h2hWins: h2hHomeWins || undefined,
      h2hLosses: h2hAwayWins || undefined,
      // Home/Away splits
      homeGF: homeHomeSplitGF.trim() ? parseFloat(homeHomeSplitGF) || undefined : undefined,
      homeGA: homeHomeSplitGA.trim() ? parseFloat(homeHomeSplitGA) || undefined : undefined,
      awayGF: homeAwaySpGF.trim() ? parseFloat(homeAwaySpGF) || undefined : undefined,
      awayGA: homeAwaySpGA.trim() ? parseFloat(homeAwaySpGA) || undefined : undefined,
    };

    const away: NHLTeamStats = {
      name: awayTeam || "Visitante",
      goalsFor: parseFloat(awayGF) || 3.2,
      goalsAgainst: parseFloat(awayGA) || 2.9,
      ppPct: parseFloat(awayPP) || 22,
      pkPct: parseFloat(awayPK) || 80,
      corsi: parseFloat(awayCorsi) || 49,
      shotsFor: parseFloat(awayShotsFor) || 30,
      shotsAgainst: parseFloat(awayShotsAgainst) || 31,
      winRate: parseFloat(awayWinRate10) || 0.5,
      streak: parseInt(awayStreak) || 0,
      isB2B: awayB2B,
      daysRest: parseInt(awayDaysRest) || 2,
      travelPenalty: travelPenalty(getAwayTravelDistance(awayAbbr, homeAbbr, "nhl")),
      goalie: awayGoalie,
      recentGF: awayRecentGF.trim() ? parseFloat(awayRecentGF) || undefined : undefined,
      recentGA: awayRecentGA.trim() ? parseFloat(awayRecentGA) || undefined : undefined,
      sosScore: awaySOS.trim() ? parseFloat(awaySOS) || undefined : undefined,
      // Advanced analytics (MoneyPuck)
      xGF: awayXGF.trim() ? parseFloat(awayXGF) || undefined : undefined,
      xGA: awayXGA.trim() ? parseFloat(awayXGA) || undefined : undefined,
      cf5v5: awayCF5v5.trim() ? parseFloat(awayCF5v5) || undefined : undefined,
      shPct: awaySHPct.trim() ? parseFloat(awaySHPct) || undefined : undefined,
      hdCF: awayHDCF.trim() ? parseFloat(awayHDCF) || undefined : undefined,
      hdCA: awayHDCA.trim() ? parseFloat(awayHDCA) || undefined : undefined,
      ppGF: awayPPGF.trim() ? parseFloat(awayPPGF) || undefined : undefined,
      pkGA: awayPKGA.trim() ? parseFloat(awayPKGA) || undefined : undefined,
      scoreAdjXGF: awayScoreAdjXGF.trim() ? parseFloat(awayScoreAdjXGF) || undefined : undefined,
      scoreAdjXGA: awayScoreAdjXGA.trim() ? parseFloat(awayScoreAdjXGA) || undefined : undefined,
      missingPlayerImpact: awayInjury.adj || undefined,
      missingOffFactor: awayInjury.offFactor,
      missingDefFactor: awayInjury.defFactor,
      // H2H (from away perspective)
      h2hWins: h2hAwayWins || undefined,
      h2hLosses: h2hHomeWins || undefined,
      // Home/Away splits
      homeGF: awayHomeSplitGF.trim() ? parseFloat(awayHomeSplitGF) || undefined : undefined,
      homeGA: awayHomeSplitGA.trim() ? parseFloat(awayHomeSplitGA) || undefined : undefined,
      awayGF: awayAwaySpGF.trim() ? parseFloat(awayAwaySpGF) || undefined : undefined,
      awayGA: awayAwaySpGA.trim() ? parseFloat(awayAwaySpGA) || undefined : undefined,
    };

    const ctx: NHLGameContext = {
      isPlayoffs,
      homeIceAdv: isPlayoffs ? 1.05 : 1.0,
    };

    // Model probability, then regress toward market
    const mlOddsHomeNum = parseInt(mlOddsHome) || -150;
    const marketProb = americanToProb(mlOddsHomeNum);
    const rawHomeProb = predictNHL(home, away, ctx);
    const baseProb = rawHomeProb;
    // Calibration (backtested k=1.5 on 464 games) then market regression
    const calibratedProb = nhlCalibrate(rawHomeProb);
    let homeProb = regressToMarket(calibratedProb, marketProb, 0.25);
    const estimatedTotal = predictNHLTotal(home, away);

    // ÉLITE: aplicar ajuste por goalie confirmado
    const factorNotes: string[] = [];
    let goalieUnconfirmed = false;
    if (goalieData) {
      const probPre = homeProb;
      const adj = applyConfirmedGoalieAdjustment(
        homeProb, goalieData.home, goalieData.away, goalieData.confirmed
      );
      homeProb = adj.adjustedProb;
      if (!goalieData.confirmed) {
        goalieUnconfirmed = true;
        factorNotes.push("⚠️ Goalie sin confirmar — BET bloqueado");
      } else {
        const delta = (homeProb - probPre) * 100;
        if (Math.abs(delta) >= 0.2) {
          factorNotes.push(`Goalies ${delta > 0 ? "+" : ""}${delta.toFixed(1)}pp`);
        } else {
          factorNotes.push("Goalies confirmados (impacto mínimo)");
        }
      }
    }

    // Evaluar edge en AMBOS lados ML (no solo local)
    const mlOddsAwayNum = parseInt(mlOddsAway) || 130;
    const impliedHome = americanToProb(mlOddsHomeNum);
    const impliedAway = americanToProb(mlOddsAwayNum);
    const edgeHome = (homeProb - impliedHome) * 100;
    const edgeAway = ((1 - homeProb) - impliedAway) * 100;
    const pickedSide: "home" | "away" = edgeHome >= edgeAway ? "home" : "away";
    const mlEdge = pickedSide === "home" ? edgeHome : edgeAway;
    const recommendedOdds = pickedSide === "home" ? mlOddsHomeNum : mlOddsAwayNum;
    const mlPickProb = pickedSide === "home" ? homeProb : (1 - homeProb);
    // ÉLITE: 70% confianza mínimo para BET + bloqueo si goalie no confirmado
    let mlSignal = nhlGetSignal(mlEdge, mlPickProb);
    if (goalieUnconfirmed && mlSignal === "BET") mlSignal = "LEAN";

    const bankroll =
      state.bankrollInitial + state.mlbPicks.reduce((s, p) => s + p.profit, 0);
    const mlStake = kellyFraction(mlPickProb, recommendedOdds) * bankroll;

    const puckLineNum = parseFloat(puckLine) || -1.5;
    const puckLineResult = evaluatePuckLine(homeProb, puckLineNum);

    const ouLineNum = parseFloat(ouLine) || 6.0;
    const totalResult = nhlEvaluateTotal(estimatedTotal, ouLineNum);

    const plays: NHLBestPlay[] = [
      {
        market: "ML",
        recommendation: pickedSide === "home"
          ? `${homeTeam || "Local"} ML`
          : `${awayTeam || "Visitante"} ML`,
        signal: mlSignal,
        edgeLabel: `${mlEdge.toFixed(2)}%`,
        confidence: mlPickProb * 100,
      },
      {
        market: "Puck Line",
        recommendation: puckLineResult.side,
        signal: puckLineResult.signal,
        edgeLabel: `Margen ${puckLineResult.expectedMargin.toFixed(2)}`,
        confidence: homeProb > 0.5 ? homeProb * 100 : (1 - homeProb) * 100,
      },
      {
        market: "O/U",
        recommendation: `${totalResult.side} ${ouLineNum}`,
        signal: totalResult.signal,
        edgeLabel: `${estimatedTotal.toFixed(1)} vs ${ouLineNum}`,
        confidence: 50 + Math.min(Math.abs(totalResult.edge) * 10, 25),
      },
    ];

    const bestPlay = nhlGetBestPlay(plays);

    // Poisson distribution for O/U
    const poisson = nhlPoissonTotal(home, away, ouLineNum);

    // Safe Play 90%+
    const safePlay = nhlFindSafePlay(home, away, ctx, homeProb, poisson, ouLineNum);

    setResult({
      homeProb: homeProb * 100,
      awayProb: (1 - homeProb) * 100,
      estimatedTotal,
      mlEdge,
      mlSignal,
      mlStake,
      pickedSide,
      recommendedOdds,
      puckLineResult,
      totalResult,
      bestPlay,
      homeTeam: homeTeam || "Local",
      awayTeam: awayTeam || "Visitante",
      poisson,
      safePlay,
      factorBreakdown: {
        baseProb: baseProb * 100,
        finalProb: homeProb * 100,
        notes: factorNotes,
        goalieUnconfirmed,
      },
    });
    setSaved({});
    toast({ title: "🏒 Predicción NHL v3 generada", description: "Poisson + GSAx + Score-Adj" });
  }, [
    homeSavePct, homeGAA, homeRecord, homeRecentGAA,
    homeTeam, homeGF, homeGA, homePP, homePK, homeCorsi, homeShotsFor, homeShotsAgainst,
    homeStreak, homeWinRate10, homeB2B, homeDaysRest,
    homeRecentGF, homeRecentGA, homeSOS,
    awaySavePct, awayGAA, awayRecord, awayRecentGAA,
    awayTeam, awayGF, awayGA, awayPP, awayPK, awayCorsi, awayShotsFor, awayShotsAgainst,
    awayStreak, awayWinRate10, awayB2B, awayDaysRest,
    awayRecentGF, awayRecentGA, awaySOS,
    isPlayoffs,
    mlOddsHome, mlOddsAway, puckLine, puckLineOddsHome, puckLineOddsAway,
    ouLine, overOdds, underOdds,
    state,
    homeRoster, homeMissing, homeGamesOut,
    awayRoster, awayMissing, awayGamesOut,
    h2hHomeWins, h2hAwayWins,
    homeHomeSplitGF, homeHomeSplitGA, homeAwaySpGF, homeAwaySpGA,
    awayHomeSplitGF, awayHomeSplitGA, awayAwaySpGF, awayAwaySpGA,
    goalieData,
  ]);

  // ── Save Pick (reuse mlbPicks for NHL) ───────────────────────────────────
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

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1200px] mx-auto">
      {/* Title */}
      <div className="flex items-center gap-3">
        <Brain className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-display font-bold" data-testid="text-nhl-predictor-title">
          🏒 Predictor NHL
        </h1>
        <Badge variant="outline" className="ml-auto text-xs border-green-500/40 text-green-400">
          v3.0 — Poisson + GSAx + xG
        </Badge>
      </div>

      {/* AUTO-FILL NHL */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold text-primary">Auto-llenar desde NHL</span>
          </div>
          <DatePickerFL value={selectedDate} onChange={setSelectedDate} />
          <div className="flex flex-col sm:flex-row gap-3">
            <Button variant="outline" size="sm" onClick={() => refetchNHL()} disabled={nhlLoading}
              className="shrink-0 border-primary/30 text-primary">
              {nhlLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              {nhlLoading ? "Cargando..." : "Cargar partidos"}
            </Button>
            {nhlGames.length > 0 && (
              <Select value={selNHLGame} onValueChange={setSelNHLGame}>
                <SelectTrigger className="flex-1 border-primary/30"><SelectValue placeholder="Selecciona partido..." /></SelectTrigger>
                <SelectContent>
                  {nhlGames.map(g => (
                    <SelectItem key={g.gameId} value={String(g.gameId)}>
                      {g.awayTeam.name} @ {g.homeTeam.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selNHLGame && (
              <Button size="sm" onClick={() => autoFillNHL(selNHLGame)} className="shrink-0">
                <Zap className="h-4 w-4 mr-2" /> Auto-llenar
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
                    const res = await apiRequest("GET", `/api/odds/nhl?date=${encodeURIComponent(selectedDate)}`);
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
                    if (matched.ml) { setMlOddsHome(String(matched.ml.home)); setMlOddsAway(String(matched.ml.away)); }
                    if (matched.spread) { setPuckLine(String(matched.spread.line)); setPuckLineOddsHome(String(matched.spread.homeOdds)); setPuckLineOddsAway(String(matched.spread.awayOdds)); }
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
          {nhlError && manualTeams.length > 0 && (
            <p className="text-xs text-amber-400">
              ⚠️ No hay partidos NHL disponibles para esta fecha o el calendario no respondió. El selector manual sigue disponible con estadísticas verificadas.
            </p>
          )}
          {!nhlError && nhlData?.success && nhlGames.length === 0 && (
            <p className="text-xs text-amber-400">
              ℹ️ No hay partidos NHL programados para esta fecha. Puedes usar el selector manual con estadísticas verificadas.
            </p>
          )}
          {manualTeamsError && !manualTeamsLoading && (
            <p className="text-xs text-red-400">
              ⚠️ No se pudieron cargar las estadísticas verificadas NHL. Los campos permanecerán vacíos.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Selector manual:</span> GF/GA · PP/PK · Corsi · tiros · forma L10 · analytics disponibles.
            <span className="text-amber-400"> Tú agregas: portero confirmado · descanso si no hay partido activo · líneas.</span>
          </p>

          <EliteBanner sport="NHL" />
          {selNHLGame && <NHLGoalieCard gameId={selNHLGame} onData={(d) => setGoalieData({ confirmed: d.confirmed, home: d.home || null, away: d.away || null })} />}
          {sharpGameKey && <SharpSignalsCard sport="nhl" gameKey={sharpGameKey} onDirection={setSharpDir} />}
        </CardContent>
      </Card>

      {/* Team Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {teamCard("home")}
        {teamCard("away")}
      </div>

      {/* Context card */}
      <Card className="border-violet-500/30 bg-violet-500/5">
        <CardHeader className="pb-2 px-4 pt-4">
          <CardTitle className="text-sm font-semibold text-violet-400">🏆 Contexto del Partido</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={isPlayoffs}
              onCheckedChange={setIsPlayoffs}
              data-testid="switch-playoffs"
            />
            <div>
              <Label className="text-sm font-medium text-white">Playoffs</Label>
              <p className="text-xs text-muted-foreground">
                Ajusta la ventaja de local y los coeficientes del modelo para playoffs
              </p>
            </div>
            {isPlayoffs && (
              <Badge className="ml-auto border-violet-500/40 bg-violet-500/20 text-violet-400">
                PLAYOFFS
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* H2H Season Series + Home/Away Splits */}
      {(h2hLabel || homeHomeSplitGF || awayAwaySpGF) && (
        <Card className="border-teal-500/30 bg-teal-500/5">
          <CardHeader className="pb-2 px-4 pt-4">
            <CardTitle className="text-sm font-semibold text-teal-400">🤝 H2H y Rendimiento Local/Visitante</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-4">
            {/* H2H Badge */}
            {h2hLabel && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-teal-500/10 border border-teal-500/20">
                <span className="text-xs font-semibold text-teal-400">H2H esta temporada:</span>
                <Badge className="bg-teal-500/20 text-teal-300 border-teal-500/40 text-sm px-3">
                  {h2hLabel}
                </Badge>
                {(h2hHomeWins + h2hAwayWins >= 2) && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {h2hHomeWins > h2hAwayWins ? `${homeTeam} domina la serie` :
                     h2hAwayWins > h2hHomeWins ? `${awayTeam} domina la serie` :
                     "Serie igualada"}
                  </span>
                )}
              </div>
            )}
            {/* Home/Away Splits */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Home team splits */}
              {(homeHomeSplitGF || homeAwaySpGF) && (
                <div className="border border-blue-500/20 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider">🏠 {homeTeam || "Local"}</p>
                  {homeHomeSplitGF && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">En casa:</span>
                      <span className="text-xs text-white font-medium">{homeHomeSplitGF} GF / {homeHomeSplitGA} GA</span>
                      {homeHomeSplitRec && <Badge className="bg-blue-500/15 text-blue-300 border-blue-500/30 text-[10px]">{homeHomeSplitRec}</Badge>}
                    </div>
                  )}
                  {homeAwaySpGF && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Fuera:</span>
                      <span className="text-xs text-white font-medium">{homeAwaySpGF} GF / {homeAwaySpGA} GA</span>
                      {homeAwaySplitRec && <Badge className="bg-slate-600/30 text-slate-300 border-slate-500/30 text-[10px]">{homeAwaySplitRec}</Badge>}
                    </div>
                  )}
                </div>
              )}
              {/* Away team splits */}
              {(awayHomeSplitGF || awayAwaySpGF) && (
                <div className="border border-amber-500/20 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">✈️ {awayTeam || "Visitante"}</p>
                  {awayHomeSplitGF && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">En casa:</span>
                      <span className="text-xs text-white font-medium">{awayHomeSplitGF} GF / {awayHomeSplitGA} GA</span>
                      {awayHomeSplitRec && <Badge className="bg-slate-600/30 text-slate-300 border-slate-500/30 text-[10px]">{awayHomeSplitRec}</Badge>}
                    </div>
                  )}
                  {awayAwaySpGF && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Fuera:</span>
                      <span className="text-xs text-white font-medium">{awayAwaySpGF} GF / {awayAwaySpGA} GA</span>
                      {awayAwaySplitRec && <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 text-[10px]">{awayAwaySplitRec}</Badge>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agenda SOS — Oponentes Recientes */}
      {(homeRecentOpps.length > 0 || awayRecentOpps.length > 0) && (
        <Card className="border-cyan-500/30 bg-cyan-500/5">
          <CardHeader className="pb-2 px-4 pt-4">
            <CardTitle className="text-sm font-semibold text-cyan-400">📊 Agenda L10 (Fuerza de Calendario)</CardTitle>
            <p className="text-[10px] text-muted-foreground">Ultimos 10 partidos de cada equipo — contra quien jugaron y resultado</p>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-4">
            {[
              { label: "🏠 Local", team: homeTeam, opps: homeRecentOpps, sos: homeSOS, color: "text-blue-400" },
              { label: "✈️ Visitante", team: awayTeam, opps: awayRecentOpps, sos: awaySOS, color: "text-amber-400" },
            ].map(({ label, team, opps, sos, color }) => {
              const wins = opps.filter(o => o.result === "W").length;
              const losses = opps.length - wins;
              const sosNum = parseFloat(sos) || 1.0;
              const sosLabel = sosNum >= 1.1 ? "Agenda dificil" : sosNum <= 0.92 ? "Agenda facil" : "Agenda normal";
              const sosColor = sosNum >= 1.1 ? "text-red-400" : sosNum <= 0.92 ? "text-green-400" : "text-yellow-400";
              return (
                <div key={label} className="border border-slate-700/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className={`text-xs font-semibold ${color} uppercase tracking-wider`}>{label} — {team}</p>
                    <div className="flex items-center gap-2">
                      <Badge className={`border ${sosColor} bg-transparent text-[10px]`}>{sosLabel}</Badge>
                      <span className="text-xs text-muted-foreground">SOS: {sosNum.toFixed(2)}</span>
                      <span className="text-xs font-bold text-white">{wins}V-{losses}D</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {opps.map((o, i) => (
                      <span
                        key={i}
                        className={`text-[11px] px-2 py-0.5 rounded border ${
                          o.result === "W"
                            ? "bg-green-500/15 border-green-500/30 text-green-400"
                            : "bg-red-500/15 border-red-500/30 text-red-400"
                        }`}
                      >
                        {o.venue} {o.opp} {o.score}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Lesiones / Alineación */}
      {(homeRoster.length > 0 || awayRoster.length > 0) && (
        <Card className="border-rose-500/30 bg-rose-500/5">
          <CardHeader className="pb-2 px-4 pt-4">
            <CardTitle className="text-sm font-semibold text-rose-400">🏥 Lesiones / Alineación</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-6">
            {[
              { side: "home" as const, label: "🏠 Local", roster: homeRoster, missing: homeMissing, setMissing: setHomeMissing, gamesOut: homeGamesOut, setGamesOut: setHomeGamesOut, borderColor: "border-blue-500/30", titleColor: "text-blue-400" },
              { side: "away" as const, label: "✈️ Visitante", roster: awayRoster, missing: awayMissing, setMissing: setAwayMissing, gamesOut: awayGamesOut, setGamesOut: setAwayGamesOut, borderColor: "border-amber-500/30", titleColor: "text-amber-400" },
            ].map(({ side, label, roster, missing, setMissing, gamesOut, setGamesOut, borderColor, titleColor }) => {
              // Sort: D first, then forwards (C/L/R), by points DESC within each group. Top 20 skaters + all goalies.
              const dPlayers = roster.filter(p => p.position === "D").sort((a, b) => b.points - a.points);
              const fPlayers = roster.filter(p => ["C", "L", "R"].includes(p.position)).sort((a, b) => b.points - a.points);
              const gPlayers = roster.filter(p => p.position === "G");
              const sortedSkaters = [...dPlayers, ...fPlayers].slice(0, 20);
              const displayPlayers = [...sortedSkaters, ...gPlayers];

              const injResult = calcNHLInjuryImpact(roster, missing, gamesOut);

              return (
                <div key={side} className={`border ${borderColor} rounded-lg p-3 space-y-3`}>
                  <p className={`text-xs font-semibold ${titleColor} uppercase tracking-wider`}>{label} — {homeTeam && side === "home" ? homeTeam : awayTeam && side === "away" ? awayTeam : ""}</p>
                  <p className="text-[10px] text-muted-foreground mb-1">Toca un jugador para marcarlo como lesionado/fuera</p>
                  <div className="flex flex-wrap gap-1.5">
                    {displayPlayers.map((p) => {
                      const isOut = missing.has(p.name);
                      const adapted = isOut && (gamesOut[p.name] ?? 0) >= 10;
                      return (
                        <button
                          key={p.name}
                          type="button"
                          onClick={() => {
                            const next = new Set(missing);
                            if (next.has(p.name)) { next.delete(p.name); } else { next.add(p.name); }
                            setMissing(next);
                          }}
                          className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                            isOut
                              ? adapted
                                ? "bg-slate-700/60 border-slate-500 text-slate-500 line-through"
                                : "bg-red-500/20 border-red-500/40 text-red-400"
                              : "bg-slate-700/40 border-slate-600 text-slate-200 hover:bg-slate-600/50"
                          }`}
                        >
                          {p.sweaterNumber ? `#${p.sweaterNumber} ` : ""}{p.name} ({p.position}) — {p.points} pts
                        </button>
                      );
                    })}
                  </div>

                  {/* Games-out inputs for each injured player */}
                  {missing.size > 0 && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs font-semibold text-rose-400">Jugadores fuera — ingresa partidos perdidos:</p>
                      {displayPlayers.filter(p => missing.has(p.name)).map((p) => {
                        const adapted = (gamesOut[p.name] ?? 0) >= 10;
                        return (
                          <div key={p.name} className="flex items-center gap-2 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                            <span className="text-xs text-red-400 font-medium flex-1">
                              {p.name} ({p.position}) — {p.points} pts
                            </span>
                            {!adapted ? (
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-muted-foreground">Partidos fuera:</span>
                                <Input
                                  type="text"
                                  inputMode="numeric"
                                  placeholder="0"
                                  value={gamesOut[p.name] !== undefined ? String(gamesOut[p.name]) : ""}
                                  onChange={(e) => {
                                    const v = parseInt(e.target.value) || 0;
                                    setGamesOut((prev) => ({ ...prev, [p.name]: v }));
                                  }}
                                  className="w-14 h-7 text-xs px-2 text-center border-red-500/30"
                                />
                              </div>
                            ) : (
                              <Badge className="bg-slate-600/50 text-slate-400 border-slate-500 text-[10px]">10+ fuera — Adaptado (0 impacto)</Badge>
                            )}
                          </div>
                        );
                      })}

                      {/* Adjustment summary - prominent */}
                      <div className="mt-2 p-3 rounded-lg bg-rose-500/15 border-2 border-rose-500/30">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold text-rose-400">Ajuste total por lesiones</span>
                          <span className="text-lg font-bold text-white">{injResult.adj.toFixed(1)} pts</span>
                        </div>
                        <div className="mt-1 space-y-0.5">
                          {injResult.details.map((d, i) => (
                            <p key={i} className="text-xs text-rose-300/70">{d}</p>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Lines Section */}
      <Card className="border-slate-700/50 bg-card/50">
        <CardHeader className="pb-2 px-4 pt-4">
          <CardTitle className="text-sm font-semibold text-slate-300">📊 Líneas del Partido</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-4">
          {/* ML */}
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-2">Money Line</p>
            <div className="grid grid-cols-2 gap-3">
              {numInput("ML Local", mlOddsHome, setMlOddsHome, "input-ml-home", "numeric", "-150")}
              {numInput("ML Visitante", mlOddsAway, setMlOddsAway, "input-ml-away", "numeric", "+130")}
            </div>
          </div>

          {/* Puck Line */}
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-2">Puck Line</p>
            <div className="grid grid-cols-3 gap-3">
              {numInput("Puck Line", puckLine, setPuckLine, "input-puckline", "decimal", "-1.5")}
              {numInput("Cuota Local", puckLineOddsHome, setPuckLineOddsHome, "input-puckline-home", "numeric", "+140")}
              {numInput("Cuota Visitante", puckLineOddsAway, setPuckLineOddsAway, "input-puckline-away", "numeric", "-160")}
            </div>
          </div>

          {/* O/U */}
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-2">Total (O/U)</p>
            <div className="grid grid-cols-3 gap-3">
              {numInput("Línea O/U", ouLine, setOuLine, "input-ou-line", "decimal", "6.0")}
              {numInput("Cuota OVER", overOdds, setOverOdds, "input-over-odds", "numeric", "-110")}
              {numInput("Cuota UNDER", underOdds, setUnderOdds, "input-under-odds", "numeric", "-110")}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Generate Button */}
      <Button
        className="w-full h-12 text-base font-bold"
        onClick={runPrediction}
        data-testid="button-generate"
      >
        <Brain className="h-5 w-5 mr-2" />
        Generar Predicción NHL
      </Button>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* JUGADA SEGURA 90%+ */}
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

          {/* Poisson O/U Analysis */}
          {result.poisson && (
            <Card className="border-indigo-500/30 bg-indigo-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-indigo-400">🎲 Análisis Poisson (O/U)</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="p-2 rounded bg-indigo-500/10">
                    <p className="text-xs text-muted-foreground">Goles Local</p>
                    <p className="text-lg font-bold text-white">{result.poisson.homeExpGoals}</p>
                  </div>
                  <div className="p-2 rounded bg-indigo-500/10">
                    <p className="text-xs text-muted-foreground">Goles Visit</p>
                    <p className="text-lg font-bold text-white">{result.poisson.awayExpGoals}</p>
                  </div>
                  <div className="p-2 rounded bg-indigo-500/10">
                    <p className="text-xs text-muted-foreground">Total</p>
                    <p className="text-lg font-bold text-white">{result.poisson.totalExpGoals}</p>
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
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Marcadores más probables:</p>
                  <div className="flex flex-wrap gap-2">
                    {result.poisson.exactScoreProbs.map((s) => (
                      <span key={s.score} className="text-xs px-2 py-0.5 rounded bg-slate-700/50 text-slate-300">
                        {s.score} ({(s.prob * 100).toFixed(1)}%)
                      </span>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Jugada Estrella */}
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

          {/* ML Card */}
          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-semibold text-blue-400">💰 Money Line</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center p-3 rounded-lg bg-blue-500/10">
                  <p className="text-xs text-muted-foreground truncate">{result.homeTeam}</p>
                  <p className="text-2xl font-bold text-white mt-1">{result.homeProb.toFixed(1)}%</p>
                  <p className="text-xs text-blue-400">Prob. Modelo</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-slate-700/30">
                  <p className="text-xs text-muted-foreground truncate">{result.awayTeam}</p>
                  <p className="text-2xl font-bold text-white mt-1">{result.awayProb.toFixed(1)}%</p>
                  <p className="text-xs text-slate-400">Prob. Modelo</p>
                </div>
              </div>

              {result.factorBreakdown && result.factorBreakdown.notes.length > 0 && (
                <div className={`text-[11px] rounded px-2 py-1 border ${result.factorBreakdown.goalieUnconfirmed ? "border-amber-500/40 bg-amber-500/5 text-amber-300" : "border-purple-500/30 bg-purple-500/5 text-purple-300/90"}`}>
                  <span className="font-medium">Factores Élite: </span>
                  {result.factorBreakdown.notes.join(" · ")}
                  <span className="text-muted-foreground"> (base {result.factorBreakdown.baseProb.toFixed(1)}% → final {result.factorBreakdown.finalProb.toFixed(1)}%)</span>
                </div>
              )}

              {result.pickedSide && (
                <div className="flex items-center justify-between p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/30">
                  <div>
                    <p className="text-xs text-muted-foreground">Lado recomendado</p>
                    <p className={`text-base font-bold ${result.pickedSide === "home" ? "text-blue-400" : "text-amber-400"}`}>
                      {result.pickedSide === "home" ? result.homeTeam : result.awayTeam} ML
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Cuota</p>
                    <p className="text-base font-mono font-bold text-white">
                      {(result.recommendedOdds ?? 0) > 0 ? "+" : ""}{result.recommendedOdds}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-700/30">
                <div>
                  <p className="text-xs text-muted-foreground">Edge (lado recomendado)</p>
                  <p className={`text-lg font-bold ${result.mlEdge > 0 ? "text-green-400" : "text-red-400"}`}>
                    {result.mlEdge > 0 ? "+" : ""}{result.mlEdge.toFixed(2)}%
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Implícita: {(americanToProb(result.recommendedOdds ?? (parseInt(mlOddsHome) || -150)) * 100).toFixed(1)}%
                  </p>
                </div>
                <div className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Badge className={`border ${signalColor(result.mlSignal)}`}>
                      {signalLabel(result.mlSignal)}
                    </Badge>
                    {(() => {
                      const badge = sharpBadgeFor(result.pickedSide ?? null, sharpDir, "ml");
                      return badge ? (
                        <Badge variant="outline" className={`text-xs px-1.5 ${badge.className}`} title={badge.tooltip}>
                          {badge.label}
                        </Badge>
                      ) : null;
                    })()}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Kelly: <span className="text-white font-medium">${result.mlStake.toFixed(2)}</span>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Puck Line Card */}
          {result.puckLineResult && (
            <Card className="border-purple-500/30 bg-purple-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-purple-400">🏒 Puck Line</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-700/30">
                  <div>
                    <p className="text-xs text-muted-foreground">Lado recomendado</p>
                    <p className={`text-base font-bold mt-1 ${result.puckLineResult.pickedSide === "home" ? "text-blue-400" : "text-amber-400"}`}>
                      {result.puckLineResult.pickedSide === "home" ? result.homeTeam : result.awayTeam} {result.puckLineResult.side.replace(/^Local |^Visitante /, "")}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Margen esperado: <span className="text-purple-400">{result.puckLineResult.expectedMargin.toFixed(2)}</span>
                      {" · "}Línea: <span className="text-purple-400">{puckLine}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <Badge className={`border ${signalColor(result.puckLineResult.signal)}`}>
                      {signalLabel(result.puckLineResult.signal)}
                    </Badge>
                    {result.puckLineResult.coverProb !== undefined && (
                      <p className={`text-sm font-bold mt-1 ${
                        result.puckLineResult.coverProb >= 0.60 ? "text-green-400" :
                        result.puckLineResult.coverProb >= 0.52 ? "text-amber-400" : "text-red-400"
                      }`}>
                        {(result.puckLineResult.coverProb * 100).toFixed(1)}% cubre
                        <span className="text-[10px] text-muted-foreground ml-1">({result.puckLineResult.confidence})</span>
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      Cuota: <span className="text-white font-medium">{result.puckLineResult.pickedSide === "away" ? puckLineOddsAway : puckLineOddsHome}</span>
                    </p>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Prob. implícita puck line ({result.puckLineResult.pickedSide === "home" ? "local" : "visitante"})</span>
                    <span>{(americanToProb(parseInt(result.puckLineResult.pickedSide === "away" ? puckLineOddsAway : puckLineOddsHome) || 140) * 100).toFixed(1)}%</span>
                  </div>
                  <Progress
                    value={americanToProb(parseInt(result.puckLineResult.pickedSide === "away" ? puckLineOddsAway : puckLineOddsHome) || 140) * 100}
                    className="h-1.5"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* O/U Card */}
          {result.totalResult && (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-amber-400">🥅 Total (O/U)</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-700/30">
                  <div>
                    <p className="text-xs text-muted-foreground">Goles estimados</p>
                    <p className="text-2xl font-bold text-white mt-1">{result.estimatedTotal.toFixed(1)}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Línea: <span className="text-amber-400">{ouLine}</span>
                      {" · "}Edge: <span className={result.totalResult.edge > 0 ? "text-green-400" : "text-red-400"}>
                        {result.totalResult.edge > 0 ? "+" : ""}{result.totalResult.edge.toFixed(2)}
                      </span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-amber-400">{result.totalResult.side}</p>
                    <Badge className={`border ${signalColor(result.totalResult.signal)} mt-1`}>
                      {signalLabel(result.totalResult.signal)}
                    </Badge>
                    {result.totalResult.hitProb !== undefined && (
                      <p className={`text-sm font-bold mt-1 ${
                        result.totalResult.hitProb >= 0.60 ? "text-green-400" :
                        result.totalResult.hitProb >= 0.52 ? "text-amber-400" : "text-red-400"
                      }`}>
                        {(result.totalResult.hitProb * 100).toFixed(1)}%
                        <span className="text-[10px] text-muted-foreground ml-1">({result.totalResult.confidence})</span>
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      Cuota: <span className="text-white font-medium">
                        {result.totalResult.side === "OVER" ? overOdds : underOdds}
                      </span>
                    </p>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Prob. implícita O/U</span>
                    <span>
                      {(americanToProb(
                        parseInt(result.totalResult.side === "OVER" ? overOdds : underOdds) || -110
                      ) * 100).toFixed(1)}%
                    </span>
                  </div>
                  <Progress
                    value={americanToProb(
                      parseInt(result.totalResult.side === "OVER" ? overOdds : underOdds) || -110
                    ) * 100}
                    className="h-1.5"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Save Picks Section */}
          <Card className="border-green-500/30 bg-green-500/5">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-semibold text-green-400 flex items-center gap-2">
                <Save className="h-4 w-4" />
                Guardar Picks NHL
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="flex flex-wrap gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="border-blue-500/40 text-blue-400 hover:bg-blue-500/10"
                  onClick={() =>
                    savePick(
                      "ML",
                      `${result.homeProb > 50 ? result.homeTeam : result.awayTeam} ML`,
                      result.homeProb > 50
                        ? parseInt(mlOddsHome) || -150
                        : parseInt(mlOddsAway) || 130,
                      Math.max(result.homeProb, result.awayProb),
                      "ml"
                    )
                  }
                  disabled={saved["ml"]}
                  data-testid="button-save-ml"
                >
                  {saved["ml"] ? <Check className="h-4 w-4 mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                  ML
                </Button>

                {result.puckLineResult && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-purple-500/40 text-purple-400 hover:bg-purple-500/10"
                    onClick={() =>
                      savePick(
                        "Puck Line",
                        `${result.puckLineResult!.side} (${result.puckLineResult!.pickedSide === "home" ? result.homeTeam : result.awayTeam})`,
                        result.puckLineResult!.pickedSide === "away" ? (parseInt(puckLineOddsAway) || -160) : (parseInt(puckLineOddsHome) || 140),
                        result.homeProb,
                        "puckline"
                      )
                    }
                    disabled={saved["puckline"]}
                    data-testid="button-save-puckline"
                  >
                    {saved["puckline"] ? <Check className="h-4 w-4 mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                    Puck Line
                  </Button>
                )}

                {result.totalResult && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                    onClick={() =>
                      savePick(
                        "O/U",
                        `${result.totalResult!.side} ${ouLine}`,
                        parseInt(result.totalResult!.side === "OVER" ? overOdds : underOdds) || -110,
                        55,
                        "ou"
                      )
                    }
                    disabled={saved["ou"]}
                    data-testid="button-save-ou"
                  >
                    {saved["ou"] ? <Check className="h-4 w-4 mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                    O/U
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Los picks NHL se guardan en el historial MLB. Resultado pendiente (P) hasta que lo actualices.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      <PrintFab />
    </div>
  );
}

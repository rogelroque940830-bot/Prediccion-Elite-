import { useState, useCallback } from "react";
import {
  predictWNBA,
  predictWNBATotal,
  wnbaEvaluateSpread,
  wnbaEvaluateTotal,
  wnbaGetSignal,
  wnbaGetBestPlay,
  americanToProb,
  wnbaStarPower,
  wnbaPickQuality,
  type WNBATeamStats,
  type WNBABestPlay,
  type WNBAPlayer,
  type WNBAPickQuality,
  WNBA_TEAMS,
} from "@/lib/wnba-model";
import { getAwayTravelDistance } from "@/lib/travel";
import { useAppContext } from "@/lib/context";
import { useQuery } from "@tanstack/react-query";
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
interface WNBAPredictionResult {
  homeProb: number;
  awayProb: number;
  estimatedTotal: number;
  mlEdge: number;
  mlSignal: "BET" | "LEAN" | "PASS";
  mlStake: number;
  spreadResult: { expectedMargin: number; signal: "BET" | "LEAN" | "PASS"; side: string } | null;
  totalResult: { edge: number; signal: "BET" | "LEAN" | "PASS"; side: "OVER" | "UNDER" } | null;
  bestPlay: WNBABestPlay | null;
  homeTeam: string;
  awayTeam: string;
  pickQualities?: WNBAPickQuality[];
  injuryImpact?: {
    home: { delta: number; tiers: { name: string; tier: string; score: number; impact: number }[] };
    away: { delta: number; tiers: { name: string; tier: string; score: number; impact: number }[] };
  };
}

// ── Helpers (pure — no React components) ────────────────────────────────────
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
  return Math.max(0, Math.min(kelly * 0.25, 0.05)); // quarter Kelly, capped 5%
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function WNBAPredictor() {
  const { state, dispatch } = useAppContext();
  const { toast } = useToast();

  // Fecha para schedule (formato YYYY-MM-DD en zona ET)
  const todayET = (() => {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  })();
  const [selectedDate, setSelectedDate] = useState(todayET);
  const [selGame, setSelGame] = useState("");

  // 📅 Schedule WNBA del día — lista los partidos disponibles
  const { data: wnbaSchedule } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: [`/api/wnba/games?date=${selectedDate}`], staleTime: 5 * 60 * 1000, retry: 1,
  });
  const wnbaGames = wnbaSchedule?.data ?? [];

  // 🏀 Stats de todos los equipos — carga automática al montar (no on-demand)
  const { data: wnbaData, isLoading: wnbaLoading, isError: wnbaError, refetch: refetchWNBA } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["/api/wnba/all"], staleTime: 30 * 60 * 1000, retry: 0,
  });
  const wnbaTeams = wnbaData?.data ?? [];
  const manualTeamOptions = wnbaTeams.length > 0
    ? wnbaTeams.map((team: any) => ({ teamId: String(team.teamId), teamName: team.teamName }))
    : WNBA_TEAMS.map((teamName, index) => ({ teamId: `manual-${index}`, teamName }));
  const hasVerifiedWNBAStats = wnbaTeams.length > 0 && !wnbaError;

  // Roster de jugadores WNBA — para selector de lesionadas con Star Power Index
  const { data: wnbaPlayersData } = useQuery<{ success: boolean; data: Record<string, any[]> }>({
    queryKey: ["/api/wnba/players"], staleTime: 30 * 60 * 1000, retry: 1,
  });
  const wnbaPlayersByTeam = wnbaPlayersData?.data ?? {};

  // 📊 SOS (Strength of Schedule) por equipo — NetRtg promedio últimos 10 oponentes
  const { data: wnbaSosData } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["/api/wnba/sos"], staleTime: 30 * 60 * 1000, retry: 1,
  });
  const sosByTeam: Record<number, { oppAvgNetRtg: number; sosLabel: string }> = {};
  for (const s of wnbaSosData?.data ?? []) sosByTeam[s.teamId] = s;

  // 📆 Fatigue (B2B granular + games last 7 days + streak)
  const { data: wnbaFatigueData } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["/api/wnba/fatigue"], staleTime: 15 * 60 * 1000, retry: 1,
  });
  const fatigueByTeam: Record<number, { daysRest: number; isB2B: boolean; b2bWasRoad: boolean; gamesLast7Days: number; streak: number }> = {};
  for (const f of wnbaFatigueData?.data ?? []) fatigueByTeam[f.teamId] = f;

  // 🩺 Injuries auto-fill desde ESPN con decay por días fuera
  const { data: wnbaInjData } = useQuery<{ success: boolean; data: any[] }>({
    queryKey: ["/api/wnba/injuries"], staleTime: 30 * 60 * 1000, retry: 1,
  });
  const injuriesByTeamName: Record<string, any> = {};
  for (const t of wnbaInjData?.data ?? []) {
    const key = (t.teamName || "").toLowerCase();
    injuriesByTeamName[key] = t;
    // También indexar por palabra final (Liberty, Aces, etc.)
    const last = key.split(" ").pop();
    if (last) injuriesByTeamName[last] = t;
  }

  // Mapeo nombre → ESPN team ID (para shot-profile y h2h)
  const ESPN_TEAM_IDS: Record<string, number> = {
    "Atlanta Dream": 20, "Chicago Sky": 19, "Connecticut Sun": 18, "Dallas Wings": 3,
    "Golden State Valkyries": 129689, "Indiana Fever": 5, "Las Vegas Aces": 17, "Los Angeles Sparks": 6,
    "Minnesota Lynx": 8, "New York Liberty": 9, "Phoenix Mercury": 11, "Seattle Storm": 14,
    "Washington Mystics": 16, "Toronto Tempo": 130000,
  };

  const autoFillWNBA = (teamName: string, side: "home" | "away") => {
    const t = wnbaTeams.find(x => x.teamName === teamName);
    if (!t) {
      if (side === "home") {
        setHomeTeam(teamName);
        setHomeNetRtg(""); setHomeOffRtg(""); setHomeDefRtg(""); setHomePace("");
        setHomeDaysRest(""); setHomeWinRate(""); setHomeB2B(false); setHomeStreak("0");
        setHomeRecentPace(""); setHomeRecentPPG("");
        setHomeRecentNetRtg(undefined); setHomeRecentOffRtg(undefined); setHomeRecentDefRtg(undefined);
        setHomeRecentWinRate(undefined); setHomeGamesPlayed(undefined); setHomeTeamId(undefined);
        setHomeInactives([]);
      } else {
        setAwayTeam(teamName);
        setAwayNetRtg(""); setAwayOffRtg(""); setAwayDefRtg(""); setAwayPace("");
        setAwayDaysRest(""); setAwayWinRate(""); setAwayB2B(false); setAwayStreak("0");
        setAwayRecentPace(""); setAwayRecentPPG("");
        setAwayRecentNetRtg(undefined); setAwayRecentOffRtg(undefined); setAwayRecentDefRtg(undefined);
        setAwayRecentWinRate(undefined); setAwayGamesPlayed(undefined); setAwayTeamId(undefined);
        setAwayInactives([]);
      }
      toast({
        title: "Modo manual WNBA",
        description: "Equipo seleccionado. Introduce estadísticas verificadas antes de generar la predicción.",
      });
      return;
    }
    const setters = side === "home"
      ? { team: setHomeTeam, net: setHomeNetRtg, off: setHomeOffRtg, def: setHomeDefRtg, pace: setHomePace, wr: setHomeWinRate, ppg: setHomeRecentPPG, rPace: setHomeRecentPace, rNet: setHomeRecentNetRtg, rOff: setHomeRecentOffRtg, rDef: setHomeRecentDefRtg, rWr: setHomeRecentWinRate, gp: setHomeGamesPlayed }
      : { team: setAwayTeam, net: setAwayNetRtg, off: setAwayOffRtg, def: setAwayDefRtg, pace: setAwayPace, wr: setAwayWinRate, ppg: setAwayRecentPPG, rPace: setAwayRecentPace, rNet: setAwayRecentNetRtg, rOff: setAwayRecentOffRtg, rDef: setAwayRecentDefRtg, rWr: setAwayRecentWinRate, gp: setAwayGamesPlayed };
    setters.team(t.teamName);
    setters.net(String(t.netRtg));
    setters.off(String(t.offRtg));
    setters.def(String(t.defRtg));
    setters.pace(String(t.pace));
    setters.wr(String(t.winPct));
    if (t.ppg) setters.ppg(String(t.ppg));
    // L10 (forma reciente) y GP — invisibles pero usados por el modelo
    if (typeof t.recentPace === "number") setters.rPace(String(t.recentPace));
    if (typeof t.recentPpg === "number") setters.ppg(String(t.recentPpg)); // recentPPG ya estaba usado para L10
    setters.rNet(typeof t.recentNetRtg === "number" ? t.recentNetRtg : undefined);
    setters.rOff(typeof t.recentOffRtg === "number" ? t.recentOffRtg : undefined);
    setters.rDef(typeof t.recentDefRtg === "number" ? t.recentDefRtg : undefined);
    setters.rWr(typeof t.recentWinPct === "number" ? t.recentWinPct : undefined);
    setters.gp(typeof t.gamesPlayed === "number" ? t.gamesPlayed : undefined);
    // Guardar teamId para resolver roster
    if (side === "home") setHomeTeamId(t.teamId); else setAwayTeamId(t.teamId);
    // Reset inactives + auto-cargar OUT/DOUBTFUL desde ESPN injury feed
    const teamInjKey = t.teamName.toLowerCase();
    const teamInj = injuriesByTeamName[teamInjKey] || injuriesByTeamName[teamInjKey.split(" ").pop() || ""];
    const autoInactives: string[] = [];
    if (teamInj?.injuries) {
      for (const inj of teamInj.injuries) {
        if (inj.severityTier === "OUT" || inj.severityTier === "DOUBTFUL") {
          autoInactives.push(inj.name);
        }
      }
    }
    if (side === "home") setHomeInactives(autoInactives); else setAwayInactives(autoInactives);
    // Auto-aplicar fatiga real si hay datos
    const fat = fatigueByTeam[t.teamId];
    if (fat) {
      if (side === "home") {
        setHomeDaysRest(String(fat.daysRest));
        setHomeB2B(fat.isB2B);
        setHomeStreak(String(fat.streak));
      } else {
        setAwayDaysRest(String(fat.daysRest));
        setAwayB2B(fat.isB2B);
        setAwayStreak(String(fat.streak));
      }
    }
    toast({ title: "Datos WNBA cargados", description: fat ? `Fatiga real: ${fat.daysRest}d descanso, B2B: ${fat.isB2B ? "SÍ" : "NO"}` : undefined });
  };


  // ── Home state ──────────────────────────────────────────────────────────
  const [homeTeam, setHomeTeam] = useState("");
  const [homeNetRtg, setHomeNetRtg] = useState("");
  const [homeOffRtg, setHomeOffRtg] = useState("");
  const [homeDefRtg, setHomeDefRtg] = useState("");
  const [homePace, setHomePace] = useState("");
  const [homeDaysRest, setHomeDaysRest] = useState("");
  const [homeWinRate, setHomeWinRate] = useState("");
  const [homeB2B, setHomeB2B] = useState(false);
  const [homeStreak, setHomeStreak] = useState("0");
  const [homeInjury, setHomeInjury] = useState("0");
  const [homeRecentPace, setHomeRecentPace] = useState("");
  const [homeRecentPPG, setHomeRecentPPG] = useState("");
  // Auto-cargado del backend (últimos 10 juegos + GP) — invisibles en UI
  const [homeRecentNetRtg, setHomeRecentNetRtg] = useState<number | undefined>(undefined);
  const [homeRecentOffRtg, setHomeRecentOffRtg] = useState<number | undefined>(undefined);
  const [homeRecentDefRtg, setHomeRecentDefRtg] = useState<number | undefined>(undefined);
  const [homeRecentWinRate, setHomeRecentWinRate] = useState<number | undefined>(undefined);
  const [homeGamesPlayed, setHomeGamesPlayed] = useState<number | undefined>(undefined);
  const [homeTeamId, setHomeTeamId] = useState<number | undefined>(undefined);
  const [homeInactives, setHomeInactives] = useState<string[]>([]);

  // ── Away state ──────────────────────────────────────────────────────────
  const [awayTeam, setAwayTeam] = useState("");
  const [awayNetRtg, setAwayNetRtg] = useState("");
  const [awayOffRtg, setAwayOffRtg] = useState("");
  const [awayDefRtg, setAwayDefRtg] = useState("");
  const [awayPace, setAwayPace] = useState("");
  const [awayDaysRest, setAwayDaysRest] = useState("");
  const [awayWinRate, setAwayWinRate] = useState("");
  const [awayB2B, setAwayB2B] = useState(false);
  const [awayStreak, setAwayStreak] = useState("0");
  const [awayInjury, setAwayInjury] = useState("0");
  const [awayRecentPace, setAwayRecentPace] = useState("");
  const [awayRecentPPG, setAwayRecentPPG] = useState("");
  const [awayRecentNetRtg, setAwayRecentNetRtg] = useState<number | undefined>(undefined);
  const [awayRecentOffRtg, setAwayRecentOffRtg] = useState<number | undefined>(undefined);
  const [awayRecentDefRtg, setAwayRecentDefRtg] = useState<number | undefined>(undefined);
  const [awayRecentWinRate, setAwayRecentWinRate] = useState<number | undefined>(undefined);
  const [awayGamesPlayed, setAwayGamesPlayed] = useState<number | undefined>(undefined);
  const [awayTeamId, setAwayTeamId] = useState<number | undefined>(undefined);
  const [awayInactives, setAwayInactives] = useState<string[]>([]);

  // 🎯 Shot Profile (3PA rate, FTA rate, eFG%) por equipo — DESPUÉS de declarar homeTeam/awayTeam
  const homeEspnId = homeTeam ? ESPN_TEAM_IDS[homeTeam] : undefined;
  const awayEspnId = awayTeam ? ESPN_TEAM_IDS[awayTeam] : undefined;
  const { data: homeShotProfile } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/wnba/shot-profile/${homeEspnId}`],
    enabled: !!homeEspnId,
    staleTime: 60 * 60 * 1000, retry: 1,
  });
  const { data: awayShotProfile } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/wnba/shot-profile/${awayEspnId}`],
    enabled: !!awayEspnId,
    staleTime: 60 * 60 * 1000, retry: 1,
  });

  // 📊 H2H 2-year cuando ambos equipos están seleccionados
  const { data: h2hData } = useQuery<{ success: boolean; data: any }>({
    queryKey: [`/api/wnba/h2h?home=${homeEspnId}&away=${awayEspnId}`],
    enabled: !!(homeEspnId && awayEspnId),
    staleTime: 60 * 60 * 1000, retry: 1,
  });

  // ── Lines state ─────────────────────────────────────────────────────────
  const [mlOddsHome, setMlOddsHome] = useState("-150");
  const [mlOddsAway, setMlOddsAway] = useState("+130");
  const [spreadLine, setSpreadLine] = useState("-5");
  const [spreadOddsHome, setSpreadOddsHome] = useState("-110");
  const [spreadOddsAway, setSpreadOddsAway] = useState("-110");
  const [ouLine, setOuLine] = useState("155");
  const [overOdds, setOverOdds] = useState("-110");
  const [underOdds, setUnderOdds] = useState("-110");

  // ── Result ──────────────────────────────────────────────────────────────
  const [result, setResult] = useState<WNBAPredictionResult | null>(null);
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
    const color = isHome ? "text-blue-400" : "text-amber-400";
    const borderColor = isHome ? "border-blue-500/30" : "border-amber-500/30";
    const label = isHome ? "🏠 Local" : "✈️ Visitante";

    const team = isHome ? homeTeam : awayTeam;
    const netRtg = isHome ? homeNetRtg : awayNetRtg;
    const offRtg = isHome ? homeOffRtg : awayOffRtg;
    const defRtg = isHome ? homeDefRtg : awayDefRtg;
    const pace = isHome ? homePace : awayPace;
    const daysRest = isHome ? homeDaysRest : awayDaysRest;
    const winRate = isHome ? homeWinRate : awayWinRate;
    const b2b = isHome ? homeB2B : awayB2B;
    const streak = isHome ? homeStreak : awayStreak;
    const injury = isHome ? homeInjury : awayInjury;
    const recentPace = isHome ? homeRecentPace : awayRecentPace;
    const recentPPG = isHome ? homeRecentPPG : awayRecentPPG;
    const teamId = isHome ? homeTeamId : awayTeamId;
    const inactives = isHome ? homeInactives : awayInactives;
    const setInactives = isHome ? setHomeInactives : setAwayInactives;
    const roster: any[] = teamId ? ((wnbaPlayersByTeam as any)[String(teamId)] ?? (wnbaPlayersByTeam as any)[teamId] ?? []) : [];
    // 🔍 Contexto élite — SOS + Fatiga + Travel para visualización
    const teamSos = teamId ? sosByTeam[teamId] : undefined;
    const teamFat = teamId ? fatigueByTeam[teamId] : undefined;
    const teamName = isHome ? homeTeam : awayTeam;
    const oppName = isHome ? awayTeam : homeTeam;
    const travelMi = (!isHome && teamName && oppName) ? getAwayTravelDistance(teamName, oppName, "wnba") : 0;

    const setTeam = isHome ? setHomeTeam : setAwayTeam;
    const setNetRtg = isHome ? setHomeNetRtg : setAwayNetRtg;
    const setOffRtg = isHome ? setHomeOffRtg : setAwayOffRtg;
    const setDefRtg = isHome ? setHomeDefRtg : setAwayDefRtg;
    const setPace = isHome ? setHomePace : setAwayPace;
    const setDaysRest = isHome ? setHomeDaysRest : setAwayDaysRest;
    const setWinRate = isHome ? setHomeWinRate : setAwayWinRate;
    const setB2B = isHome ? setHomeB2B : setAwayB2B;
    const setStreak = isHome ? setHomeStreak : setAwayStreak;
    const setInjury = isHome ? setHomeInjury : setAwayInjury;
    const setRecentPace = isHome ? setHomeRecentPace : setAwayRecentPace;
    const setRecentPPG = isHome ? setHomeRecentPPG : setAwayRecentPPG;

    return (
      <Card className={`border ${borderColor} bg-card/50`} key={side}>
        <CardHeader className="pb-2 px-4 pt-4">
          <CardTitle className={`text-sm font-semibold ${color}`}>{label}</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          {/* Team selector */}
          <div>
            <Label className="text-xs text-muted-foreground">Equipo</Label>
            <Select value={team} onValueChange={(value) => autoFillWNBA(value, side)} disabled={wnbaLoading}>
              <SelectTrigger className="mt-1" data-testid={`select-${side}-team`}>
                <SelectValue placeholder="Seleccionar equipo" />
              </SelectTrigger>
              <SelectContent>
                {manualTeamOptions.map((t) => (
                  <SelectItem key={t.teamId} value={t.teamName}>
                    {t.teamName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            {numInput("NetRtg", netRtg, setNetRtg, `input-${side}-netrtg`, "decimal", "3.0")}
            {numInput("OffRtg", offRtg, setOffRtg, `input-${side}-offrtg`, "decimal", "102")}
            {numInput("DefRtg", defRtg, setDefRtg, `input-${side}-defrtg`, "decimal", "99")}
            {numInput("Pace", pace, setPace, `input-${side}-pace`, "decimal", "80")}
            {numInput("Días Descanso", daysRest, setDaysRest, `input-${side}-rest`, "numeric", "2")}
            {numInput("Win Rate (0-1)", winRate, setWinRate, `input-${side}-winrate`, "decimal", "0.55")}
          </div>

          {/* B2B */}
          <div className="flex items-center gap-2 py-1">
            <Switch
              checked={b2b}
              onCheckedChange={setB2B}
              data-testid={`switch-${side}-b2b`}
            />
            <Label className="text-xs text-muted-foreground">Back-to-Back (B2B)</Label>
          </div>

          {/* Racha */}
          <div className="border border-blue-500/20 rounded-lg p-3 bg-blue-500/5 space-y-2">
            <Label className="text-xs text-blue-400 font-medium">Racha actual</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={streak}
              onChange={(e) => setStreak(e.target.value)}
              placeholder="0 (positivo=victorias, negativo=derrotas)"
              data-testid={`input-${side}-streak`}
              className="border-blue-500/30"
            />
            {parseInt(streak) !== 0 && (
              <p className={`text-xs font-medium ${parseInt(streak) > 0 ? "text-green-400" : "text-red-400"}`}>
                {parseInt(streak) > 0 ? `Racha ${streak}V 🔥` : `Racha ${Math.abs(parseInt(streak))}D ❄️`}
              </p>
            )}
          </div>

          {/* Ajuste Lesión */}
          <div className="border border-amber-500/20 rounded-lg p-3 bg-amber-500/5 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              <Label className="text-xs text-amber-400 font-medium">Ajuste Lesión</Label>
            </div>
            <Input
              type="text"
              inputMode="numeric"
              value={injury}
              onChange={(e) => setInjury(e.target.value)}
              placeholder="0 (negativo = jugadora OUT)"
              data-testid={`input-${side}-injury`}
              className="border-amber-500/30"
            />
            <div className="text-xs text-muted-foreground space-y-0.5">
              <p>Estrella OUT: <span className="text-red-400">-5 a -7</span></p>
              <p>Jugadora clave OUT: <span className="text-amber-400">-2 a -4</span></p>
              <p>Regresa hoy: <span className="text-green-400">+3 a +5</span></p>
            </div>
          </div>

          {/* 🔍 Contexto Élite WNBA — SOS + Fatiga + Travel (visualización) */}
          {teamId && (teamSos || teamFat) && (
            <div className="border border-cyan-500/20 rounded-lg p-3 bg-cyan-500/5 space-y-2">
              <div className="flex items-center gap-2">
                <Zap className="h-3.5 w-3.5 text-cyan-400" />
                <Label className="text-xs text-cyan-400 font-medium">Contexto élite (auto-aplicado)</Label>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                {teamSos && (
                  <div className={`p-1.5 rounded border ${teamSos.oppAvgNetRtg > 1.5 ? "bg-red-500/10 border-red-500/30 text-red-200" : teamSos.oppAvgNetRtg < -1.5 ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200" : "bg-slate-700/30 border-slate-600/30 text-slate-300"}`}>
                    <p className="font-semibold">📊 SOS últimos 10</p>
                    <p>{teamSos.sosLabel}</p>
                    <p className="opacity-70">oppNet {teamSos.oppAvgNetRtg > 0 ? "+" : ""}{teamSos.oppAvgNetRtg.toFixed(1)}</p>
                  </div>
                )}
                {teamFat && (
                  <div className={`p-1.5 rounded border ${teamFat.isB2B ? "bg-amber-500/10 border-amber-500/30 text-amber-200" : "bg-slate-700/30 border-slate-600/30 text-slate-300"}`}>
                    <p className="font-semibold">📆 Fatiga</p>
                    <p>{teamFat.isB2B ? (teamFat.b2bWasRoad ? "B2B road-prev" : "B2B home-prev") : "Sin B2B"}</p>
                    <p className="opacity-70">{teamFat.daysRest}d descanso · {teamFat.gamesLast7Days}j L7d</p>
                  </div>
                )}
                {!isHome && travelMi > 0 && (
                  <div className={`p-1.5 rounded border col-span-2 ${travelMi > 2000 ? "bg-red-500/10 border-red-500/30 text-red-200" : travelMi > 1000 ? "bg-amber-500/10 border-amber-500/30 text-amber-200" : "bg-slate-700/30 border-slate-600/30 text-slate-300"}`}>
                    <p className="font-semibold">✈️ Travel: {Math.round(travelMi)} millas</p>
                    <p className="opacity-70">Penalty visitante: {travelMi < 500 ? "sin penalty" : travelMi < 1000 ? "-0.007 logit" : travelMi < 2000 ? "-0.014 logit" : travelMi < 2500 ? "-0.020 logit" : "-0.028 logit"}</p>
                  </div>
                )}
              </div>
              <p className="text-[9px] text-cyan-300/60 italic">Todos estos factores se aplican automáticamente al modelo (igual que en NBA).</p>
            </div>
          )}

          {/* ⭐ Star Power Inactives — selector automático de lesionadas */}
          {roster.length > 0 && (
            <div className="border border-purple-500/20 rounded-lg p-3 bg-purple-500/5 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-purple-400 font-medium flex items-center gap-1">
                  <Star className="h-3.5 w-3.5" /> Inactivas (Star Power)
                </Label>
                {inactives.length > 0 && (
                  <button type="button" onClick={() => setInactives([])} className="text-[10px] text-purple-300 underline">limpiar</button>
                )}
              </div>
              <Select value="" onValueChange={(name: string) => {
                if (name && !inactives.includes(name)) setInactives([...inactives, name]);
              }}>
                <SelectTrigger className="text-xs"><SelectValue placeholder="+ Agregar jugadora fuera" /></SelectTrigger>
                <SelectContent>
                  {roster.filter((p: any) => !inactives.includes(p.name)).slice(0, 12).map((p: any) => {
                    const sp = wnbaStarPower(p as WNBAPlayer);
                    return (
                      <SelectItem key={p.playerId} value={p.name}>
                        <span className="flex items-center gap-2">
                          <span className={`text-[10px] px-1 rounded ${sp.tier === "SUPERSTAR" ? "bg-red-500/30 text-red-300" : sp.tier === "STAR" ? "bg-amber-500/30 text-amber-300" : sp.tier === "STARTER" ? "bg-blue-500/30 text-blue-300" : "bg-slate-500/30 text-slate-300"}`}>{sp.tier} ★{sp.score}</span>
                          {p.name} — {p.ppg.toFixed(1)}p/{p.apg.toFixed(1)}a/{p.rpg.toFixed(1)}r
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {inactives.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {inactives.map((name) => {
                    const player = roster.find((p: any) => p.name === name);
                    if (!player) return null;
                    const sp = wnbaStarPower(player as WNBAPlayer);
                    return (
                      <button key={name} type="button"
                        onClick={() => setInactives(inactives.filter(n => n !== name))}
                        className={`text-[10px] px-2 py-0.5 rounded border flex items-center gap-1 ${sp.tier === "SUPERSTAR" ? "bg-red-500/15 border-red-500/40 text-red-200" : sp.tier === "STAR" ? "bg-amber-500/15 border-amber-500/40 text-amber-200" : sp.tier === "STARTER" ? "bg-blue-500/15 border-blue-500/40 text-blue-200" : "bg-slate-500/15 border-slate-500/40 text-slate-300"}`}>
                        ★{sp.score} {name} ×
                      </button>
                    );
                  })}
                </div>
              )}
              {inactives.length > 0 && (
                <p className="text-[10px] text-purple-300/80">
                  Impacto NetRtg: <span className="font-semibold">-{inactives.reduce((acc, name) => { const pl = roster.find((p:any) => p.name === name); return acc + (pl ? wnbaStarPower(pl as WNBAPlayer).netRtgImpact : 0); }, 0).toFixed(1)}</span> pts (auto-aplicado al modelo)
                </p>
              )}
            </div>
          )}

          {/* Factor Dinámico O/U — opcional */}
          <div className="border border-teal-500/20 rounded-lg p-3 bg-teal-500/5 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-teal-400 font-medium">Factor Dinámico O/U</Label>
              <span className="text-xs text-muted-foreground italic">opcional</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Pace reciente</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={recentPace}
                  onChange={(e) => setRecentPace(e.target.value)}
                  placeholder="Ej: 82.5"
                  data-testid={`input-${side}-recent-pace`}
                  className="border-teal-500/30 mt-1"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">PPG reciente</Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={recentPPG}
                  onChange={(e) => setRecentPPG(e.target.value)}
                  placeholder="Ej: 85.2"
                  data-testid={`input-${side}-recent-ppg`}
                  className="border-teal-500/30 mt-1"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  // ── Run Prediction ───────────────────────────────────────────────────────
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
      toast({ title: "Faltan datos WNBA", description });
      return;
    }
    // ── Star Power Index: calcula impacto automático de inactives ──
    // El usuario marca quien está fuera; el modelo deriva NetRtg perdido por tier real.
    const calcInjuryImpact = (teamId: number | undefined, inactives: string[], teamName: string): { delta: number; tiers: { name: string; tier: string; score: number; impact: number; days?: number; decay?: number }[] } => {
      if (!teamId || inactives.length === 0) return { delta: 0, tiers: [] };
      const roster = (wnbaPlayersByTeam as any)[String(teamId)] ?? (wnbaPlayersByTeam as any)[teamId] ?? [];
      // Lookup de days-out por nombre via ESPN injury feed
      const teamInj = injuriesByTeamName[(teamName || "").toLowerCase()] || injuriesByTeamName[(teamName || "").toLowerCase().split(" ").pop() || ""];
      const daysOutByName: Record<string, number> = {};
      const decayByName: Record<string, number> = {};
      for (const inj of teamInj?.injuries ?? []) {
        if (inj.name) {
          daysOutByName[inj.name.toLowerCase()] = inj.daysOut;
          decayByName[inj.name.toLowerCase()] = inj.decayFactor;
        }
      }
      let total = 0;
      const tiers: { name: string; tier: string; score: number; impact: number; days?: number; decay?: number }[] = [];
      for (const playerName of inactives) {
        const player = roster.find((p: any) => p.name === playerName);
        if (!player) continue;
        const sp = wnbaStarPower(player as WNBAPlayer);
        // Aplicar decay según días fuera (si tenemos info ESPN)
        const decay = decayByName[playerName.toLowerCase()] ?? 1.0;
        const adjustedImpact = sp.netRtgImpact * decay;
        total += adjustedImpact;
        tiers.push({
          name: player.name, tier: sp.tier, score: sp.score, impact: adjustedImpact,
          days: daysOutByName[playerName.toLowerCase()],
          decay,
        });
      }
      return { delta: total, tiers };
    };
    const homeInjResult = calcInjuryImpact(homeTeamId, homeInactives, homeTeam);
    const awayInjResult = calcInjuryImpact(awayTeamId, awayInactives, awayTeam);
    // Manual override (homeInjury/awayInjury) se suma encima del auto-calc
    const manualHomeAdj = parseFloat(homeInjury) || 0;
    const manualAwayAdj = parseFloat(awayInjury) || 0;
    // Negativo porque NetRtg pierde (lesionados quitan capacidad)
    const homeInjAdj = -homeInjResult.delta + manualHomeAdj;
    const awayInjAdj = -awayInjResult.delta + manualAwayAdj;

    // SOS + fatiga (auto-cargados desde queries)
    const hSos = homeTeamId ? sosByTeam[homeTeamId] : undefined;
    const aSos = awayTeamId ? sosByTeam[awayTeamId] : undefined;
    const hFat = homeTeamId ? fatigueByTeam[homeTeamId] : undefined;
    const aFat = awayTeamId ? fatigueByTeam[awayTeamId] : undefined;

    // Travel: distancia del visitante al estadio local
    const travelMiles = (homeTeam && awayTeam) ? getAwayTravelDistance(awayTeam, homeTeam, "wnba") : 0;

    const home: WNBATeamStats = {
      netRtg: (parseFloat(homeNetRtg) || 0) + homeInjAdj,
      offRtg: (parseFloat(homeOffRtg) || 0) + homeInjAdj,
      defRtg: (parseFloat(homeDefRtg) || 0) - homeInjAdj,
      pace: parseFloat(homePace) || 80,
      daysRest: parseInt(homeDaysRest) || 2,
      winRate: parseFloat(homeWinRate) || 0.5,
      isB2B: homeB2B,
      streak: parseInt(homeStreak) || 0,
      injuryAdj: homeInjAdj,
      recentPace: homeRecentPace.trim() ? parseFloat(homeRecentPace) || undefined : undefined,
      recentPPG: homeRecentPPG.trim() ? parseFloat(homeRecentPPG) || undefined : undefined,
      recentNetRtg: homeRecentNetRtg,
      recentOffRtg: homeRecentOffRtg,
      recentDefRtg: homeRecentDefRtg,
      recentWinRate: homeRecentWinRate,
      gamesPlayed: homeGamesPlayed,
      oppAvgNetRtg: hSos?.oppAvgNetRtg,
      b2bWasRoad: hFat?.b2bWasRoad,
      gamesLast7Days: hFat?.gamesLast7Days,
      travelMiles: 0,  // local no viaja
    };

    const away: WNBATeamStats = {
      netRtg: (parseFloat(awayNetRtg) || 0) + awayInjAdj,
      offRtg: (parseFloat(awayOffRtg) || 0) + awayInjAdj,
      defRtg: (parseFloat(awayDefRtg) || 0) - awayInjAdj,
      pace: parseFloat(awayPace) || 80,
      daysRest: parseInt(awayDaysRest) || 2,
      winRate: parseFloat(awayWinRate) || 0.5,
      isB2B: awayB2B,
      streak: parseInt(awayStreak) || 0,
      injuryAdj: awayInjAdj,
      recentPace: awayRecentPace.trim() ? parseFloat(awayRecentPace) || undefined : undefined,
      recentPPG: awayRecentPPG.trim() ? parseFloat(awayRecentPPG) || undefined : undefined,
      recentNetRtg: awayRecentNetRtg,
      recentOffRtg: awayRecentOffRtg,
      recentDefRtg: awayRecentDefRtg,
      recentWinRate: awayRecentWinRate,
      gamesPlayed: awayGamesPlayed,
      oppAvgNetRtg: aSos?.oppAvgNetRtg,
      b2bWasRoad: aFat?.b2bWasRoad,
      gamesLast7Days: aFat?.gamesLast7Days,
      travelMiles,
    };

    // Calibración vs mercado: pasamos la implied prob de la línea ML al modelo
    const mlOddsHomeNum = parseInt(mlOddsHome) || -150;
    const mlOddsAwayNum = parseInt(mlOddsAway) || 130;
    const impliedProb = americanToProb(mlOddsHomeNum);
    const homeProb = predictWNBA(home, away, impliedProb);
    const estimatedTotal = predictWNBATotal(home, away);

    // ── Pick Quality Score por mercado ──
    const spreadOddsHomeNum = parseInt(spreadOddsHome) || -110;
    const spreadOddsAwayNum = parseInt(spreadOddsAway) || -110;
    const overOddsNum = parseInt(overOdds) || -110;
    const underOddsNum = parseInt(underOdds) || -110;
    const lowSample = (homeGamesPlayed !== undefined && homeGamesPlayed < 15) || (awayGamesPlayed !== undefined && awayGamesPlayed < 15);
    const superstarOut = homeInjResult.tiers.some(t => t.tier === "SUPERSTAR" || t.tier === "STAR") ||
                         awayInjResult.tiers.some(t => t.tier === "SUPERSTAR" || t.tier === "STAR");
    // ML PQS
    const mlPickHome = homeProb >= 0.5;
    const mlPickedProb = mlPickHome ? homeProb : (1 - homeProb);
    const mlPickedOdds = mlPickHome ? mlOddsHomeNum : mlOddsAwayNum;
    // FIX: prob implícita del LADO ELEGIDO con sus PROPIAS odds (incluye vig real).
    // La fórmula vieja (1 - impliedProb_home) ignoraba el vig del visitante y daba un edge ML inflado o reducido por 3-5pp.
    const mlPickedImplied = americanToProb(mlPickedOdds);
    const mlPickedLabel = mlPickHome ? (homeTeam || "Local") : (awayTeam || "Visitante");
    const mlPQS = wnbaPickQuality({
      market: "ML", modelProb: mlPickedProb, marketImpliedProb: mlPickedImplied, oddsAmerican: mlPickedOdds,
      pickedSideLabel: `${mlPickedLabel} ML`, sampleConcern: lowSample, injurySignificant: superstarOut,
      marketGap: Math.abs(mlPickedProb - mlPickedImplied),
    });
    // Spread PQS: convertimos margen esperado vs línea a prob implícita aproximada
    const spreadLineNumEarly = parseFloat(spreadLine) || -5;
    const spreadResultEarly = wnbaEvaluateSpread(homeProb, spreadLineNumEarly);
    const spreadCoversHome = spreadResultEarly.edge > 0;
    const spreadOddsPicked = spreadCoversHome ? spreadOddsHomeNum : spreadOddsAwayNum;
    const spreadImplied = americanToProb(spreadOddsPicked);
    // FIX: prob del LADO ELEGIDO (no siempre del lado HOME). |edge| garantiza prob >50% del lado picado.
    const spreadEdgeForPick = Math.abs(spreadResultEarly.edge);
    const spreadProbCover = 0.5 + Math.min(0.45, spreadEdgeForPick / 25);
    const spreadPQS = wnbaPickQuality({
      market: "Spread", modelProb: spreadProbCover, marketImpliedProb: spreadImplied,
      oddsAmerican: spreadOddsPicked, pickedSideLabel: `${spreadCoversHome ? (homeTeam || "Local") : (awayTeam || "Visitante")} ${spreadLineNumEarly}`,
      sampleConcern: lowSample, injurySignificant: superstarOut,
      marketGap: Math.abs(spreadProbCover - spreadImplied),
    });
    // O/U PQS
    const ouLineNumEarly = parseFloat(ouLine) || 155;
    const totalResultEarly = wnbaEvaluateTotal(estimatedTotal, ouLineNumEarly);
    const ouSideOver = totalResultEarly.edge > 0;
    const ouOddsPicked = ouSideOver ? overOddsNum : underOddsNum;
    const ouImplied = americanToProb(ouOddsPicked);
    // FIX: probabilidad del LADO ELEGIDO. Si edge>0 elegimos OVER y su prob crece con +edge.
    // Si edge<0 elegimos UNDER y su prob crece con |edge|. La fórmula vieja siempre asumía OVER
    // y le daba prob 10% al UNDER cuando en realidad era el lado fuerte.
    const ouEdgeForPick = Math.abs(totalResultEarly.edge);
    const ouProbHit = 0.5 + Math.min(0.40, ouEdgeForPick / 14);
    const ouPQS = wnbaPickQuality({
      market: "O/U", modelProb: ouProbHit, marketImpliedProb: ouImplied,
      oddsAmerican: ouOddsPicked, pickedSideLabel: `${ouSideOver ? "OVER" : "UNDER"} ${ouLineNumEarly}`,
      sampleConcern: lowSample, injurySignificant: superstarOut,
      marketGap: Math.abs(ouProbHit - ouImplied),
    });
    const pickQualities: WNBAPickQuality[] = [mlPQS, spreadPQS, ouPQS];
    // FIX consistencia: mlEdge = edge del lado ELEGIDO por el modelo (no siempre HOME).
    // Antes mostraba siempre el edge del HOME (negativo si el modelo prefería AWAY),
    // lo que contradecía al Pick Quality Score que sí mostraba el lado correcto.
    const mlEdge = (mlPickedProb - mlPickedImplied) * 100;
    const mlSignal = wnbaGetSignal(mlEdge);

    const bankroll =
      state.bankrollInitial +
      state.picks.reduce((s, p) => s + p.profit, 0);
    const mlStake = kellyFraction(homeProb, mlOddsHomeNum) * bankroll;

    const spreadLineNum = parseFloat(spreadLine) || -5;
    const spreadResult = wnbaEvaluateSpread(homeProb, spreadLineNum);

    const ouLineNum = parseFloat(ouLine) || 155;
    const totalResult = wnbaEvaluateTotal(estimatedTotal, ouLineNum);

    const plays: WNBABestPlay[] = [
      {
        market: "ML",
        recommendation: homeProb > 0.5
          ? `${homeTeam || "Local"} ML`
          : `${awayTeam || "Visitante"} ML`,
        signal: mlSignal,
        edgeLabel: `${mlEdge.toFixed(1)}%`,
        confidence: homeProb > 0.5 ? homeProb * 100 : (1 - homeProb) * 100,
      },
      {
        market: "Spread",
        recommendation: spreadResult.side,
        signal: spreadResult.signal,
        edgeLabel: `Margen ${spreadResult.expectedMargin.toFixed(1)} pts`,
        confidence: homeProb > 0.5 ? homeProb * 100 : (1 - homeProb) * 100,
      },
      {
        market: "O/U",
        recommendation: `${totalResult.side} ${ouLineNum}`,
        signal: totalResult.signal,
        edgeLabel: `${estimatedTotal.toFixed(1)} vs ${ouLineNum}`,
        confidence: 55 + Math.min(Math.abs(totalResult.edge) * 2, 20),
      },
    ];

    const bestPlay = wnbaGetBestPlay(plays);

    setResult({
      pickQualities,
      injuryImpact: { home: homeInjResult, away: awayInjResult },
      homeProb: homeProb * 100,
      awayProb: (1 - homeProb) * 100,
      estimatedTotal,
      mlEdge,
      mlSignal,
      mlStake,
      spreadResult,
      totalResult,
      bestPlay,
      homeTeam: homeTeam || "Local",
      awayTeam: awayTeam || "Visitante",
    });
    setSaved({});
    toast({ title: "🏀 Predicción WNBA generada", description: "Análisis completado" });
  }, [
    homeNetRtg, homeOffRtg, homeDefRtg, homePace, homeDaysRest, homeWinRate,
    homeB2B, homeStreak, homeInjury, homeRecentPace, homeRecentPPG,
    homeRecentNetRtg, homeRecentOffRtg, homeRecentDefRtg, homeRecentWinRate, homeGamesPlayed,
    homeTeamId, homeInactives,
    awayNetRtg, awayOffRtg, awayDefRtg, awayPace, awayDaysRest, awayWinRate,
    awayB2B, awayStreak, awayInjury, awayRecentPace, awayRecentPPG,
    awayRecentNetRtg, awayRecentOffRtg, awayRecentDefRtg, awayRecentWinRate, awayGamesPlayed,
    awayTeamId, awayInactives, wnbaPlayersByTeam, sosByTeam, fatigueByTeam,
    mlOddsHome, mlOddsAway, spreadLine, spreadOddsHome, spreadOddsAway,
    ouLine, overOdds, underOdds, homeTeam, awayTeam, state,
  ]);

  // ── Save Pick ────────────────────────────────────────────────────────────
  const savePick = (market: string, pick: string, odds: number, modelProb: number, key: string) => {
    if (!result) return;
    const bankroll =
      state.bankrollInitial + state.picks.reduce((s, p) => s + p.profit, 0);
    const stake = Math.round(kellyFraction(modelProb / 100, odds) * bankroll * 100) / 100;

    dispatch({
      type: "ADD_WNBA_PICK",
      payload: {
        date: new Date().toISOString().split("T")[0],
        sport: "WNBA", // reuse NBA picks for WNBA
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
    toast({ title: `✅ Pick WNBA guardado — ${pick}` });
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 space-y-6 max-w-[1200px] mx-auto">
      {/* Title */}
      <div className="flex items-center gap-3">
        <Brain className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-display font-bold" data-testid="text-wnba-predictor-title">
          🏀 Predictor WNBA
        </h1>
        <Badge variant="outline" className="ml-auto text-xs border-purple-500/40 text-purple-400">
          Modelo v1.0
        </Badge>
      </div>

      {/* AUTO-FILL WNBA — Schedule + Auto-llenar ambos equipos */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              <span className="text-sm font-bold text-primary">Partidos WNBA del día</span>
            </div>
            <Input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}
              className="w-auto h-7 text-xs border-primary/30 bg-transparent" />
          </div>
          {wnbaGames.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No hay partidos programados para esta fecha. Selecciona otra o usa el selector manual de equipos abajo.</p>
          ) : (
            <div>
              <Label className="text-xs">Selecciona un partido para auto-llenar ambos equipos</Label>
              <Select value={selGame} onValueChange={(v) => {
                setSelGame(v);
                const game = wnbaGames.find((g: any) => g.gameId === v);
                if (!game) return;
                autoFillWNBA(game.homeTeam.name, "home");
                autoFillWNBA(game.awayTeam.name, "away");
                toast({ title: "Partido cargado", description: `${game.awayTeam.name} @ ${game.homeTeam.name}` });
              }}>
                <SelectTrigger className="border-primary/30"><SelectValue placeholder="Elegir partido..." /></SelectTrigger>
                <SelectContent>
                  {wnbaGames.map((g: any) => {
                    const t = g.gameTimeUTC ? new Date(g.gameTimeUTC).toLocaleTimeString("es-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
                    return (
                      <SelectItem key={g.gameId} value={g.gameId}>
                        {g.awayTeam.tricode} @ {g.homeTeam.tricode} — {g.awayTeam.name} en {g.homeTeam.name} {t ? `(${t} ET)` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}
          {/* Selector manual fallback — always available */}
          <div className="rounded-md border border-primary/20 bg-background/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-primary">Selector manual de equipos</span>
              <Badge variant="outline" className={`text-[10px] ${hasVerifiedWNBAStats ? "border-green-500/40 text-green-400" : "border-amber-500/40 text-amber-300"}`}>
                {hasVerifiedWNBAStats ? "Autollenado verificado" : "Entrada manual"}
              </Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Equipo Local</Label>
                <Select value={homeTeam} onValueChange={(v) => autoFillWNBA(v, "home")} disabled={wnbaLoading}>
                  <SelectTrigger className="border-primary/30"><SelectValue placeholder="Local..." /></SelectTrigger>
                  <SelectContent>{manualTeamOptions.map(t => <SelectItem key={t.teamId} value={t.teamName}>{t.teamName}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Equipo Visitante</Label>
                <Select value={awayTeam} onValueChange={(v) => autoFillWNBA(v, "away")} disabled={wnbaLoading}>
                  <SelectTrigger className="border-primary/30"><SelectValue placeholder="Visitante..." /></SelectTrigger>
                  <SelectContent>{manualTeamOptions.map(t => <SelectItem key={t.teamId} value={t.teamName}>{t.teamName}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            {!hasVerifiedWNBAStats && !wnbaLoading && (
              <p className="text-[11px] text-amber-200/80">
                Autollenado no disponible. Selecciona los equipos y completa manualmente las estadísticas verificadas en las tarjetas inferiores.
              </p>
            )}
          </div>
          {wnbaLoading && <p className="text-xs text-muted-foreground italic"><RefreshCw className="h-3 w-3 inline animate-spin mr-1" /> Cargando stats de equipos...</p>}
          {wnbaError && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-red-300">
              <span>No se pudieron cargar estadísticas WNBA verificadas. El modo manual permanece disponible y los campos no usarán valores predeterminados.</span>
              <Button size="sm" variant="outline" onClick={() => refetchWNBA()} className="h-7 border-red-500/30 text-red-300">
                <RefreshCw className="h-3 w-3 mr-1" /> Reintentar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Team Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {teamCard("home")}
        {teamCard("away")}
      </div>

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

          {/* Spread */}
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-2">Spread</p>
            <div className="grid grid-cols-3 gap-3">
              {numInput("Línea Spread", spreadLine, setSpreadLine, "input-spread-line", "decimal", "-5")}
              {numInput("Cuota Local", spreadOddsHome, setSpreadOddsHome, "input-spread-home", "numeric", "-110")}
              {numInput("Cuota Visitante", spreadOddsAway, setSpreadOddsAway, "input-spread-away", "numeric", "-110")}
            </div>
          </div>

          {/* O/U */}
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-2">Total (O/U)</p>
            <div className="grid grid-cols-3 gap-3">
              {numInput("Línea O/U", ouLine, setOuLine, "input-ou-line", "decimal", "155")}
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
        Generar Predicción WNBA
      </Button>

      {/* Results */}
      {result && (
        <div className="space-y-4">
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
                    <span>Confianza</span>
                    <span>{result.bestPlay.confidence.toFixed(0)}%</span>
                  </div>
                  <Progress value={result.bestPlay.confidence} className="h-2" />
                </div>
              </CardContent>
            </Card>
          )}

          {/* ✨ Pick Quality Score por mercado */}
          {result.pickQualities && result.pickQualities.length > 0 && (
            <Card className="border-purple-500/30 bg-purple-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-purple-400 flex items-center gap-2">
                  <Zap className="h-4 w-4" /> Pick Quality Score — 4 mercados
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                  {result.pickQualities.map((pq) => {
                    const recColor = pq.recommendation === "BET_FUERTE" ? "bg-green-500/20 border-green-500/50 text-green-300"
                      : pq.recommendation === "BET" ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                      : pq.recommendation === "LEAN" ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                      : "bg-slate-700/30 border-slate-600/40 text-slate-400";
                    const tierColor = pq.tier === "S+" || pq.tier === "S" ? "text-green-300" : pq.tier === "A" || pq.tier === "B" ? "text-emerald-300" : pq.tier === "C" ? "text-amber-300" : "text-slate-400";
                    return (
                      <div key={pq.market} className={`flex-shrink-0 w-[200px] rounded-lg border p-2 space-y-1 ${recColor}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold uppercase">{pq.market}</span>
                          <span className={`text-[10px] font-bold ${tierColor}`}>Tier {pq.tier}</span>
                        </div>
                        <p className="text-xs font-bold text-white truncate">{pq.pickedSideLabel}</p>
                        <div className="flex items-center justify-between text-[10px]">
                          <span>Score {pq.score.toFixed(1)}/10</span>
                          <span>{pq.edgeReal >= 0 ? "+" : ""}{pq.edgeReal.toFixed(1)}pp</span>
                        </div>
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="font-bold">{pq.recommendation}</span>
                          <span>{pq.stakeUnits.toFixed(1)}u</span>
                        </div>
                        {pq.warnings.length > 0 && (
                          <p className="text-[9px] text-amber-200/80 truncate" title={pq.warnings.join("; ")}>⚠ {pq.warnings[0]}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* 🎯 Shot Profile + Defense Bucket Matchup */}
          {(homeShotProfile?.data || awayShotProfile?.data) && (
            <Card className="border-teal-500/30 bg-teal-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-teal-400 flex items-center gap-2">
                  🎯 Shot Profile + Defense Matchup
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                {[
                  { side: "home" as const, label: result.homeTeam, profile: homeShotProfile?.data, oppDefRtg: parseFloat(awayDefRtg) || 100 },
                  { side: "away" as const, label: result.awayTeam, profile: awayShotProfile?.data, oppDefRtg: parseFloat(homeDefRtg) || 100 },
                ].map(s => {
                  const p = s.profile;
                  if (!p) return null;
                  const oppTier = s.oppDefRtg < 97 ? "ELITE" : s.oppDefRtg > 103 ? "FLOJA" : "MEDIA";
                  const tierColor = oppTier === "ELITE" ? "text-red-300" : oppTier === "FLOJA" ? "text-emerald-300" : "text-slate-300";
                  const tierMult = oppTier === "ELITE" ? "−2.5%" : oppTier === "FLOJA" ? "+2.5%" : "×1.0";
                  return (
                    <div key={s.side} className="p-2 rounded border border-teal-500/20 bg-slate-800/30">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-[11px] font-medium text-teal-200">{s.label}</p>
                        <span className={`text-[10px] ${tierColor}`}>vs Defensa <b>{oppTier}</b> ({tierMult})</span>
                      </div>
                      <div className="grid grid-cols-4 gap-1 text-[10px]">
                        <div className="text-center bg-slate-900/40 rounded p-1">
                          <p className="text-muted-foreground">3PA rate</p>
                          <p className="font-mono font-bold">{(p.fg3aRate * 100).toFixed(1)}%</p>
                        </div>
                        <div className="text-center bg-slate-900/40 rounded p-1">
                          <p className="text-muted-foreground">FTA rate</p>
                          <p className="font-mono font-bold">{(p.ftaRate * 100).toFixed(1)}%</p>
                        </div>
                        <div className="text-center bg-slate-900/40 rounded p-1">
                          <p className="text-muted-foreground">eFG%</p>
                          <p className="font-mono font-bold">{(p.efgPct * 100).toFixed(1)}%</p>
                        </div>
                        <div className="text-center bg-slate-900/40 rounded p-1">
                          <p className="text-muted-foreground">Style</p>
                          <p className="font-mono font-bold text-[9px]">{p.styleTier}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <p className="text-[9px] text-muted-foreground border-t border-teal-500/20 pt-2">
                  Defensa ELITE (DefRtg menor a 97) suprime ofensiva −2.5%. FLOJA (mayor a 103) infla +2.5%. Aplica multiplicador a offRtg en el modelo.
                </p>
              </CardContent>
            </Card>
          )}

          {/* 📊 H2H 2-year */}
          {h2hData?.data && (
            <Card className="border-indigo-500/30 bg-indigo-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-indigo-400 flex items-center gap-2">
                  📊 H2H últimos 2 años
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="text-center p-2 bg-slate-800/30 rounded">
                    <p className="text-muted-foreground text-[10px]">Juegos</p>
                    <p className="text-base font-bold">{h2hData.data.gamesAnalyzed}</p>
                  </div>
                  <div className="text-center p-2 bg-slate-800/30 rounded">
                    <p className="text-muted-foreground text-[10px]">Record</p>
                    <p className="text-base font-bold">{result.homeTeam.split(" ").pop()} {h2hData.data.homeWins}-{h2hData.data.awayWins}</p>
                  </div>
                  <div className="text-center p-2 bg-slate-800/30 rounded">
                    <p className="text-muted-foreground text-[10px]">Promedio</p>
                    <p className="text-base font-bold">{h2hData.data.avgHomeScore}–{h2hData.data.avgAwayScore}</p>
                  </div>
                </div>
                <p className="text-[10px] text-center mt-2 text-indigo-300">
                  Margen promedio para {result.homeTeam.split(" ").pop()}: <b>{h2hData.data.homeNetMargin > 0 ? "+" : ""}{h2hData.data.homeNetMargin}</b>
                </p>
              </CardContent>
            </Card>
          )}

          {/* Inactivas reportadas (Star Power detalle) */}
          {result.injuryImpact && (result.injuryImpact.home.tiers.length > 0 || result.injuryImpact.away.tiers.length > 0) && (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" /> Inactivas — Impacto Star Power
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2">
                {result.injuryImpact.home.tiers.length > 0 && (
                  <div>
                    <p className="text-[11px] text-blue-300 font-medium mb-1">🏠 {result.homeTeam} (−{result.injuryImpact.home.delta.toFixed(1)} NetRtg)</p>
                    <div className="flex flex-wrap gap-1">
                      {result.injuryImpact.home.tiers.map((t: any) => (
                        <span key={t.name} className="text-[10px] px-2 py-0.5 rounded bg-slate-800/50 border border-slate-600/30 text-slate-200">
                          ★{t.score} {t.name} ({t.tier}) −{t.impact.toFixed(1)}
                          {t.days !== undefined && t.decay !== undefined && t.decay < 1 && (
                            <span className="text-blue-300/70 ml-1">· {t.days}d fuera · decay {(t.decay*100).toFixed(0)}%</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {result.injuryImpact.away.tiers.length > 0 && (
                  <div>
                    <p className="text-[11px] text-amber-300 font-medium mb-1">✈️ {result.awayTeam} (−{result.injuryImpact.away.delta.toFixed(1)} NetRtg)</p>
                    <div className="flex flex-wrap gap-1">
                      {result.injuryImpact.away.tiers.map((t: any) => (
                        <span key={t.name} className="text-[10px] px-2 py-0.5 rounded bg-slate-800/50 border border-slate-600/30 text-slate-200">
                          ★{t.score} {t.name} ({t.tier}) −{t.impact.toFixed(1)}
                          {t.days !== undefined && t.decay !== undefined && t.decay < 1 && (
                            <span className="text-amber-300/70 ml-1">· {t.days}d fuera · decay {(t.decay*100).toFixed(0)}%</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
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
                  <p className="text-xs text-muted-foreground">{result.homeTeam}</p>
                  <p className="text-2xl font-bold text-white mt-1">{result.homeProb.toFixed(1)}%</p>
                  <p className="text-xs text-blue-400">Prob. Modelo</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-slate-700/30">
                  <p className="text-xs text-muted-foreground">{result.awayTeam}</p>
                  <p className="text-2xl font-bold text-white mt-1">{result.awayProb.toFixed(1)}%</p>
                  <p className="text-xs text-slate-400">Prob. Modelo</p>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg bg-slate-700/30">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Edge {result.homeProb >= 50 ? result.homeTeam : result.awayTeam} ML
                  </p>
                  <p className={`text-lg font-bold ${result.mlEdge > 0 ? "text-green-400" : "text-red-400"}`}>
                    {result.mlEdge > 0 ? "+" : ""}{result.mlEdge.toFixed(2)}%
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Implícita: {(americanToProb(result.homeProb >= 50 ? (parseInt(mlOddsHome) || -150) : (parseInt(mlOddsAway) || 130)) * 100).toFixed(1)}%
                  </p>
                </div>
                <div className="text-right">
                  <Badge className={`border ${signalColor(result.mlSignal)}`}>
                    {signalLabel(result.mlSignal)}
                  </Badge>
                  <p className="text-xs text-muted-foreground mt-2">
                    Kelly: <span className="text-white font-medium">${result.mlStake.toFixed(2)}</span>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Spread Card */}
          {result.spreadResult && (
            <Card className="border-purple-500/30 bg-purple-500/5">
              <CardHeader className="pb-2 px-4 pt-4">
                <CardTitle className="text-sm font-semibold text-purple-400">📐 Spread</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-700/30">
                  <div>
                    <p className="text-xs text-muted-foreground">Lado recomendado</p>
                    <p className="text-base font-bold text-white mt-1">{result.spreadResult.side}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Margen esperado: <span className="text-purple-400">{result.spreadResult.expectedMargin.toFixed(1)} pts</span>
                      {" · "}Línea: <span className="text-purple-400">{spreadLine}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <Badge className={`border ${signalColor(result.spreadResult.signal)}`}>
                      {signalLabel(result.spreadResult.signal)}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-2">
                      Cuota: <span className="text-white font-medium">{spreadOddsHome}</span>
                    </p>
                  </div>
                </div>
                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Probabilidad implícita spread</span>
                    <span>{(americanToProb(parseInt(spreadOddsHome) || -110) * 100).toFixed(1)}%</span>
                  </div>
                  <Progress
                    value={americanToProb(parseInt(spreadOddsHome) || -110) * 100}
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
                <CardTitle className="text-sm font-semibold text-amber-400">🏀 Total (O/U)</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg bg-slate-700/30">
                  <div>
                    <p className="text-xs text-muted-foreground">Total estimado</p>
                    <p className="text-2xl font-bold text-white mt-1">{result.estimatedTotal.toFixed(1)}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Línea: <span className="text-amber-400">{ouLine}</span>
                      {" · "}Edge: <span className={result.totalResult.edge > 0 ? "text-green-400" : "text-red-400"}>
                        {result.totalResult.edge > 0 ? "+" : ""}{result.totalResult.edge.toFixed(1)}
                      </span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-amber-400">{result.totalResult.side}</p>
                    <Badge className={`border ${signalColor(result.totalResult.signal)} mt-1`}>
                      {signalLabel(result.totalResult.signal)}
                    </Badge>
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
                Guardar Picks WNBA
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

                {result.spreadResult && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-purple-500/40 text-purple-400 hover:bg-purple-500/10"
                    onClick={() =>
                      savePick(
                        "Spread",
                        `${result.spreadResult!.side} ${spreadLine}`,
                        parseInt(spreadOddsHome) || -110,
                        result.homeProb,
                        "spread"
                      )
                    }
                    disabled={saved["spread"]}
                    data-testid="button-save-spread"
                  >
                    {saved["spread"] ? <Check className="h-4 w-4 mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                    Spread
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
                Los picks WNBA se guardan en el historial NBA. Resultado pendiente (P) hasta que lo actualices.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
      <PrintFab />
    </div>
  );
}

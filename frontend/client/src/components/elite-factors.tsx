import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { API_BASE } from "@/lib/queryClient";
import { Gavel, Shield, UserCheck, AlertCircle, Sparkles, Wind, TrendingUp, CloudSun, Flame, ArrowUp, ArrowDown, Activity, Target, Eye, Moon, Brain } from "lucide-react";

// ═══════════════════════════════════════════════════════════════════════════
// NBA REFEREE FACTOR CARD
// ═══════════════════════════════════════════════════════════════════════════
interface NBARefsPayload {
  success: boolean;
  officials?: Array<{
    name: string;
    assignment: string;
    homeWinPct: number;
    overPct: number;
    paceBoost: number;
    foulRate: number;
    notes?: string;
  }>;
  composite?: {
    homeWinPct: number;
    overPct: number;
    paceBoost: number;
    foulRate: number;
  } | null;
}

export function NBARefsCard({ gameId, onComposite }: { gameId: string | null; onComposite?: (c: NBARefsPayload["composite"]) => void }) {
  const [data, setData] = useState<NBARefsPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!gameId) return;
    setLoading(true);
    fetch(`${API_BASE}/api/nba/refs/${gameId}`)
      .then(r => r.json())
      .then((d: NBARefsPayload) => {
        setData(d);
        onComposite?.(d.composite);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  if (!gameId) return null;

  return (
    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Gavel className="h-4 w-4 text-purple-400" />
        <span className="text-sm font-bold text-purple-300">Árbitros (Factor Élite)</span>
        {loading && <span className="text-xs text-muted-foreground ml-auto">Cargando...</span>}
      </div>
      {!loading && (!data?.officials || data.officials.length === 0) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          No anunciados aún (salen ~90 min antes del partido)
        </div>
      )}
      {data?.officials && data.officials.length > 0 && (
        <div className="space-y-1.5">
          {data.officials.slice(0, 3).map((o, i) => (
            <div key={i} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">{o.name}</span>
                <span className="text-muted-foreground">{o.assignment}</span>
              </div>
              <div className="flex gap-2 text-[11px] text-muted-foreground">
                <span>Home {(o.homeWinPct * 100).toFixed(1)}%</span>
                <span>·</span>
                <span>O/U {(o.overPct * 100).toFixed(1)}%</span>
                <span>·</span>
                <span className={o.paceBoost > 0 ? "text-green-400" : o.paceBoost < 0 ? "text-red-400" : ""}>
                  {o.paceBoost > 0 ? "+" : ""}{o.paceBoost.toFixed(1)} pts
                </span>
              </div>
              {o.notes && <div className="text-[11px] text-purple-300/80">{o.notes}</div>}
            </div>
          ))}
          {data.composite && (
            <div className="pt-1.5 border-t border-purple-500/20 text-[11px]">
              <span className="text-purple-300 font-medium">Composite: </span>
              <span>Home {(data.composite.homeWinPct * 100).toFixed(1)}%</span>
              <span className="mx-1">·</span>
              <span>Total {data.composite.paceBoost > 0 ? "+" : ""}{data.composite.paceBoost.toFixed(1)} pts</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MLB UMPIRE FACTOR CARD
// ═══════════════════════════════════════════════════════════════════════════
interface MLBUmpPayload {
  success: boolean;
  umpire?: {
    name: string;
    kZoneSize: number;
    overPct: number;
    runAdj: number;
    favor: "pitcher" | "hitter" | "neutral";
    accuracy: number;
    notes?: string;
  } | null;
  note?: string;
}

export function MLBUmpireCard({ gamePk, onUmpire }: { gamePk: string | number | null; onUmpire?: (u: MLBUmpPayload["umpire"]) => void }) {
  const [data, setData] = useState<MLBUmpPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!gamePk) return;
    setLoading(true);
    fetch(`${API_BASE}/api/mlb/umpire/${gamePk}`)
      .then(r => r.json())
      .then((d: MLBUmpPayload) => {
        setData(d);
        onUmpire?.(d.umpire);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamePk]);

  if (!gamePk) return null;

  return (
    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-purple-400" />
        <span className="text-sm font-bold text-purple-300">Umpire HP (Factor Élite)</span>
        {loading && <span className="text-xs text-muted-foreground ml-auto">Cargando...</span>}
      </div>
      {!loading && !data?.umpire && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          Aún no anunciado (~2h antes del partido)
        </div>
      )}
      {data?.umpire && (
        <div className="text-xs space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{data.umpire.name}</span>
            <Badge
              variant="outline"
              className={
                data.umpire.favor === "pitcher"
                  ? "border-blue-500/40 text-blue-300"
                  : data.umpire.favor === "hitter"
                  ? "border-orange-500/40 text-orange-300"
                  : "border-zinc-500/40 text-zinc-300"
              }
            >
              {data.umpire.favor === "pitcher" ? "Favorece pitcher" : data.umpire.favor === "hitter" ? "Favorece bateador" : "Neutral"}
            </Badge>
          </div>
          <div className="flex gap-2 text-[11px] text-muted-foreground">
            <span>Zona {(data.umpire.kZoneSize * 100).toFixed(0)}%</span>
            <span>·</span>
            <span>O/U {(data.umpire.overPct * 100).toFixed(1)}%</span>
            <span>·</span>
            <span className={data.umpire.runAdj > 0 ? "text-green-400" : data.umpire.runAdj < 0 ? "text-red-400" : ""}>
              {data.umpire.runAdj > 0 ? "+" : ""}{data.umpire.runAdj.toFixed(1)} runs
            </span>
            <span>·</span>
            <span>{(data.umpire.accuracy * 100).toFixed(1)}% precisión</span>
          </div>
          {data.umpire.notes && <div className="text-[11px] text-purple-300/80">{data.umpire.notes}</div>}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// NHL CONFIRMED GOALIE CARD
// ═══════════════════════════════════════════════════════════════════════════
interface NHLGoaliePayload {
  success: boolean;
  confirmed: boolean;
  minutesUntilGame?: number;
  home?: { name: string; svPct: number; gaa: number } | null;
  away?: { name: string; svPct: number; gaa: number } | null;
}

export function NHLGoalieCard({ gameId, onData }: { gameId: string | number | null; onData?: (d: NHLGoaliePayload) => void }) {
  const [data, setData] = useState<NHLGoaliePayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!gameId) return;
    setLoading(true);
    fetch(`${API_BASE}/api/nhl/goalies/${gameId}`)
      .then(r => r.json())
      .then((d: NHLGoaliePayload) => {
        setData(d);
        onData?.(d);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  if (!gameId) return null;

  return (
    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <UserCheck className="h-4 w-4 text-purple-400" />
        <span className="text-sm font-bold text-purple-300">Goalie Confirmado (Factor Élite)</span>
        {data && (
          <Badge variant="outline" className={`ml-auto ${data.confirmed ? "border-green-500/40 text-green-300" : "border-amber-500/40 text-amber-300"}`}>
            {data.confirmed ? "Confirmado" : "Sin confirmar"}
          </Badge>
        )}
      </div>
      {loading && <div className="text-xs text-muted-foreground">Cargando...</div>}
      {data && !data.confirmed && (
        <div className="flex items-center gap-2 text-xs text-amber-300">
          <AlertCircle className="h-3 w-3" />
          Espera anuncio oficial antes de apostar (~30 min pregame)
        </div>
      )}
      {data?.confirmed && data.home && data.away && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground text-[11px]">Local</div>
            <div className="font-medium">{data.home.name}</div>
            <div className="text-[11px] text-muted-foreground">
              sv% {data.home.svPct?.toFixed(3) ?? "?"} · GAA {data.home.gaa?.toFixed(2) ?? "?"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-[11px]">Visitante</div>
            <div className="font-medium">{data.away.name}</div>
            <div className="text-[11px] text-muted-foreground">
              sv% {data.away.svPct?.toFixed(3) ?? "?"} · GAA {data.away.gaa?.toFixed(2) ?? "?"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MLB ADVANCED — Park + Weather + Opener detection
// ════════════════════════════════════════════════════════════════════════════
interface MLBAdvancedPayload {
  success: boolean;
  park?: {
    name: string; runs: number; hrLHB: number; hrRHB: number;
    roof: "open" | "retractable" | "dome"; elevation: number; notes?: string;
  } | null;
  weather?: {
    tempF: number; windMph: number; windDirection: string; condition: string;
    tempAdj: number; windAdj: number; notes: string;
  };
  homePitcher?: { name: string; confidenceLabel: string; expectedIP: number; runAdj: number; notes: string };
  awayPitcher?: { name: string; confidenceLabel: string; expectedIP: number; runAdj: number; notes: string };
  totalAdjustment?: number;
  breakdown?: { park: number; temp: number; wind: number; homePitcher: number; awayPitcher: number };
}

export function MLBAdvancedCard({ gamePk, onAdvanced }: { gamePk: string | number | null; onAdvanced?: (d: MLBAdvancedPayload) => void }) {
  const [data, setData] = useState<MLBAdvancedPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!gamePk) return;
    setLoading(true);
    fetch(`${API_BASE}/api/mlb/advanced/${gamePk}`)
      .then(r => r.json())
      .then((d: MLBAdvancedPayload) => { setData(d); onAdvanced?.(d); })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamePk]);

  if (!gamePk) return null;

  return (
    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-emerald-400" />
        <span className="text-sm font-bold text-emerald-300">Factores Avanzados MLB</span>
        {data?.totalAdjustment !== undefined && data.totalAdjustment !== 0 && (
          <Badge variant="outline" className={`ml-auto ${data.totalAdjustment > 0 ? "border-green-500/40 text-green-300" : "border-red-500/40 text-red-300"}`}>
            Total {data.totalAdjustment > 0 ? "+" : ""}{data.totalAdjustment} runs
          </Badge>
        )}
        {loading && <span className="text-xs text-muted-foreground ml-auto">Cargando...</span>}
      </div>

      {data?.park && (
        <div className="text-xs space-y-0.5">
          <div className="flex items-center gap-2 font-medium">
            <span className="text-emerald-400">🏟️ Parque</span>
            <span>{data.park.name}</span>
            <Badge variant="outline" className="text-[10px]">
              {data.park.roof === "dome" ? "Domo" : data.park.roof === "retractable" ? "Techo retráctil" : "Abierto"}
            </Badge>
          </div>
          <div className="text-[11px] text-muted-foreground">
            Runs {data.park.runs} · HR-LHB {data.park.hrLHB} · HR-RHB {data.park.hrRHB} · Alt {data.park.elevation}ft
          </div>
          {data.park.notes && <div className="text-[11px] text-emerald-300/80">{data.park.notes}</div>}
        </div>
      )}

      {data?.weather && (
        <div className="text-xs space-y-0.5">
          <div className="flex items-center gap-2 font-medium">
            <CloudSun className="h-3.5 w-3.5 text-emerald-400" />
            <span>{data.weather.condition} · {data.weather.tempF}°F</span>
            <Wind className="h-3.5 w-3.5 text-emerald-400" />
            <span>{data.weather.windMph} mph {data.weather.windDirection}</span>
          </div>
          <div className="text-[11px] text-emerald-300/80">{data.weather.notes}</div>
        </div>
      )}

      {(data?.homePitcher || data?.awayPitcher) && (
        <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-emerald-500/20">
          {data.homePitcher && (
            <div>
              <div className="text-muted-foreground text-[11px]">Local</div>
              <div className="font-medium truncate">{data.homePitcher.name || "TBD"}</div>
              <Badge variant="outline" className={`text-[10px] ${
                data.homePitcher.confidenceLabel === "Starter" ? "border-green-500/40 text-green-300"
                : data.homePitcher.confidenceLabel === "Opener" ? "border-amber-500/40 text-amber-300"
                : data.homePitcher.confidenceLabel === "Bullpen Game" ? "border-red-500/40 text-red-300"
                : "border-zinc-500/40 text-zinc-300"
              }`}>
                {data.homePitcher.confidenceLabel}
              </Badge>
              <div className="text-[11px] text-emerald-300/80">{data.homePitcher.notes}</div>
            </div>
          )}
          {data.awayPitcher && (
            <div>
              <div className="text-muted-foreground text-[11px]">Visitante</div>
              <div className="font-medium truncate">{data.awayPitcher.name || "TBD"}</div>
              <Badge variant="outline" className={`text-[10px] ${
                data.awayPitcher.confidenceLabel === "Starter" ? "border-green-500/40 text-green-300"
                : data.awayPitcher.confidenceLabel === "Opener" ? "border-amber-500/40 text-amber-300"
                : data.awayPitcher.confidenceLabel === "Bullpen Game" ? "border-red-500/40 text-red-300"
                : "border-zinc-500/40 text-zinc-300"
              }`}>
                {data.awayPitcher.confidenceLabel}
              </Badge>
              <div className="text-[11px] text-emerald-300/80">{data.awayPitcher.notes}</div>
            </div>
          )}
        </div>
      )}

      {data?.breakdown && (
        <div className="text-[11px] text-muted-foreground pt-1 border-t border-emerald-500/20">
          Parque {data.breakdown.park > 0 ? "+" : ""}{data.breakdown.park} ·
          Temp {data.breakdown.temp > 0 ? " +" : " "}{data.breakdown.temp} ·
          Viento {data.breakdown.wind > 0 ? " +" : " "}{data.breakdown.wind} ·
          P-Local {data.breakdown.homePitcher > 0 ? " +" : " "}{data.breakdown.homePitcher} ·
          P-Vis {data.breakdown.awayPitcher > 0 ? " +" : " "}{data.breakdown.awayPitcher}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SHARP SIGNALS — Line movement, Steam, Reverse Line Movement
// ════════════════════════════════════════════════════════════════════════════
interface SharpPayload {
  success: boolean;
  snapshots: number;
  note?: string;
  earliestTs?: number;
  latestTs?: number;
  booksTracked?: string[];
  movements?: Array<{
    market: string; side: string;
    opening: number; current: number; delta: number;
    magnitude: "none" | "small" | "moderate" | "big";
    direction: string;
    notes: string;
  }>;
  steam?: Array<{
    market: string; direction: string; booksMoved: string[]; magnitude: number; notes: string;
  }>;
  rlm?: Array<{ market: string; suspectedSharpSide: string; notes: string }>;
}

/**
 * Sharp direction summary
 * - mlSide: "home" | "away" | null  (where sharp money is on moneyline/spread)
 * - totalSide: "over" | "under" | null
 * - strength: "none" | "weak" | "strong" (strong = steam move)
 */
export interface SharpDirection {
  mlSide: "home" | "away" | null;
  totalSide: "over" | "under" | null;
  strength: "none" | "weak" | "strong";
}

function deriveSharpDirection(data: SharpPayload | null): SharpDirection {
  if (!data) return { mlSide: null, totalSide: null, strength: "none" };
  let mlSide: "home" | "away" | null = null;
  let totalSide: "over" | "under" | null = null;
  let strength: "none" | "weak" | "strong" = "none";

  // Steam moves are strongest
  for (const s of data.steam || []) {
    if (s.market === "Spread" || s.market === "ML") {
      if (s.direction === "home" || s.direction === "away") mlSide = s.direction as any;
    }
    if (s.market === "Total") {
      if (s.direction === "over" || s.direction === "under") totalSide = s.direction as any;
    }
    strength = "strong";
  }

  // If no steam, look at moderate+ movements
  if (strength === "none") {
    for (const m of data.movements || []) {
      if (m.magnitude !== "moderate" && m.magnitude !== "big") continue;
      if (m.market === "Spread" || m.market === "ML") {
        // Spread delta < 0 = home getting more favored (sharp on home)
        if (!mlSide) mlSide = m.delta < 0 ? "home" : "away";
      }
      if (m.market === "Total") {
        if (!totalSide) totalSide = m.delta > 0 ? "over" : "under";
      }
      strength = "weak";
    }
  }

  return { mlSide, totalSide, strength };
}

export function SharpSignalsCard({ sport, gameKey, onDirection }: {
  sport: string;
  gameKey: string | null;
  onDirection?: (dir: SharpDirection) => void;
}) {
  const [data, setData] = useState<SharpPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!gameKey) return;
    setLoading(true);
    fetch(`${API_BASE}/api/sharp/${sport.toLowerCase()}/${encodeURIComponent(gameKey)}`)
      .then(r => r.json())
      .then((d: SharpPayload) => {
        setData(d);
        onDirection?.(deriveSharpDirection(d));
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport, gameKey]);

  if (!gameKey) return null;

  const hasMovement = (data?.movements?.length || 0) > 0;
  const hasSteam = (data?.steam?.length || 0) > 0;
  const hasRLM = (data?.rlm?.length || 0) > 0;
  const hasAny = hasMovement || hasSteam || hasRLM;

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-cyan-400" />
        <span className="text-sm font-bold text-cyan-300">Sharp Signals</span>
        {data && (
          <Badge variant="outline" className={`ml-auto text-[10px] ${data.snapshots > 0 ? "border-cyan-500/40 text-cyan-300" : "border-zinc-500/40 text-zinc-400"}`}>
            {data.snapshots} snapshot{data.snapshots === 1 ? "" : "s"}
          </Badge>
        )}
        {loading && <span className="text-xs text-muted-foreground ml-auto">Cargando...</span>}
      </div>

      {data?.snapshots === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertCircle className="h-3 w-3" />
          {data.note || "Presiona '⚡ Cuotas HR' varias veces (cada ~30 min) para que aparezcan movimientos"}
        </div>
      )}

      {data && data.snapshots > 0 && !hasAny && (
        <div className="text-xs text-muted-foreground">
          Línea estable — sin movimientos significativos detectados ({data.booksTracked?.length || 0} casas trackeadas)
        </div>
      )}

      {/* STEAM MOVES */}
      {hasSteam && data?.steam?.map((s, i) => (
        <div key={`s${i}`} className="rounded border border-orange-500/40 bg-orange-500/10 p-2">
          <div className="flex items-center gap-2">
            <Flame className="h-3.5 w-3.5 text-orange-400" />
            <span className="text-xs font-bold text-orange-300">STEAM MOVE</span>
            <span className="text-xs">{s.market} → {s.direction.toUpperCase()}</span>
          </div>
          <div className="text-[11px] text-orange-200/80 mt-0.5">
            {s.booksMoved.length} casas ({s.booksMoved.slice(0, 3).join(", ")}) · {s.magnitude.toFixed(1)} pts
          </div>
        </div>
      ))}

      {/* LINE MOVEMENTS */}
      {hasMovement && (
        <div className="space-y-1">
          {data?.movements?.map((m, i) => (
            <div key={`m${i}`} className="text-xs flex items-center gap-2">
              {m.delta > 0 ? <ArrowUp className="h-3 w-3 text-red-400" /> : <ArrowDown className="h-3 w-3 text-green-400" />}
              <Badge variant="outline" className={`text-[10px] ${
                m.magnitude === "big" ? "border-red-500/40 text-red-300"
                : m.magnitude === "moderate" ? "border-amber-500/40 text-amber-300"
                : "border-zinc-500/40 text-zinc-300"
              }`}>
                {m.magnitude}
              </Badge>
              <span className="text-muted-foreground">{m.notes}</span>
            </div>
          ))}
        </div>
      )}

      {/* RLM */}
      {hasRLM && (
        <div className="space-y-1 pt-1 border-t border-cyan-500/20">
          {data?.rlm?.slice(0, 3).map((r, i) => (
            <div key={`r${i}`} className="text-[11px] text-cyan-200/90">
              <span className="font-medium text-cyan-300">🧠 Posible RLM: </span>
              {r.notes}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ÉLITE BANNER — explains the new threshold
// ═══════════════════════════════════════════════════════════════════════════
export interface NBAContextualPayload {
  success: boolean;
  revenge?: { applies: boolean; team: "home" | "away" | null; type: string; adjustmentPp: number; notes: string };
  lookAhead?: { applies: boolean; team: "home" | "away" | null; nextOpponent: string; adjustmentPp: number; notes: string };
  b2b?: { applies: boolean; team: "home" | "away" | null; direction: string; altitudeConcern: boolean; adjustmentPp: number; notes: string };
  loadMgmt?: { applies: boolean; team: "home" | "away" | null; restLikely: boolean; adjustmentPp: number; notes: string };
  series?: { applies: boolean; team: "home" | "away" | null; situation: string; adjustmentPp: number; notes: string };
  isPlayoff?: boolean;
  homeProbAdjPp?: number;
  notes?: string[];
}

export function NBAContextualCard({
  homeTri, awayTri, gameDate, onContext,
}: {
  homeTri: string | null;
  awayTri: string | null;
  gameDate: string | null;
  onContext?: (homeProbAdjPp: number) => void;
}) {
  const [data, setData] = useState<NBAContextualPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!homeTri || !awayTri || !gameDate) return;
    setLoading(true);
    const qs = new URLSearchParams({ home: homeTri, away: awayTri, date: gameDate });
    fetch(`${API_BASE}/api/nba/context?${qs.toString()}`)
      .then(r => r.json())
      .then((d: NBAContextualPayload) => {
        setData(d);
        onContext?.(d.homeProbAdjPp || 0);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeTri, awayTri, gameDate]);

  if (!homeTri || !awayTri || !gameDate) return null;

  const anySignal = data && (data.revenge?.applies || data.lookAhead?.applies || data.b2b?.applies || data.loadMgmt?.applies || data.series?.applies);

  return (
    <div className="rounded-lg border border-pink-500/30 bg-pink-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-pink-400" />
        <span className="text-sm font-bold text-pink-300">NBA Contextual</span>
        {data?.isPlayoff && (
          <Badge variant="outline" className="text-[10px] border-pink-500/40 text-pink-300">Playoffs</Badge>
        )}
        {data?.homeProbAdjPp !== undefined && data.homeProbAdjPp !== 0 && (
          <Badge variant="outline" className={`ml-auto ${data.homeProbAdjPp > 0 ? "border-green-500/40 text-green-300" : "border-red-500/40 text-red-300"}`}>
            Home {data.homeProbAdjPp > 0 ? "+" : ""}{data.homeProbAdjPp}pp
          </Badge>
        )}
        {loading && <span className="text-xs text-muted-foreground ml-auto">Cargando...</span>}
      </div>

      {!loading && data && !anySignal && (
        <div className="text-xs text-muted-foreground">Sin señales contextuales detectadas</div>
      )}

      {data?.revenge?.applies && (
        <div className="text-xs flex items-start gap-2">
          <Target className="h-3.5 w-3.5 text-pink-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium text-pink-300">Revancha {data.revenge.team === "home" ? "LOCAL" : "VISITANTE"}: </span>
            <span className="text-muted-foreground">{data.revenge.notes}</span>
          </div>
        </div>
      )}

      {data?.lookAhead?.applies && (
        <div className="text-xs flex items-start gap-2">
          <Eye className="h-3.5 w-3.5 text-pink-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium text-pink-300">Trap {data.lookAhead.team === "home" ? "LOCAL" : "VISITANTE"}: </span>
            <span className="text-muted-foreground">{data.lookAhead.notes}</span>
          </div>
        </div>
      )}

      {data?.b2b?.applies && (
        <div className="text-xs flex items-start gap-2">
          <Moon className="h-3.5 w-3.5 text-pink-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium text-pink-300">B2B: </span>
            <span className="text-muted-foreground">{data.b2b.notes}</span>
            {data.b2b.altitudeConcern && <Badge variant="outline" className="ml-1 text-[10px] border-amber-500/40 text-amber-300">altitud</Badge>}
          </div>
        </div>
      )}

      {data?.loadMgmt?.applies && (
        <div className="text-xs flex items-start gap-2">
          <UserCheck className="h-3.5 w-3.5 text-pink-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium text-pink-300">Load Mgmt: </span>
            <span className="text-muted-foreground">{data.loadMgmt.notes}</span>
          </div>
        </div>
      )}

      {data?.series?.applies && (
        <div className="text-xs flex items-start gap-2">
          <Flame className="h-3.5 w-3.5 text-pink-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium text-pink-300">
              Serie ({data.series.situation === "elimination" ? "ELIMINACION" : data.series.situation === "closeout" ? "CIERRE" : data.series.situation}): 
            </span>
            <span className="text-muted-foreground"> {data.series.notes}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function EliteBanner({ sport }: { sport: "NBA" | "NHL" | "MLB" }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-gradient-to-r from-amber-500/5 to-purple-500/5 p-2.5 flex items-center gap-2">
      <Sparkles className="h-4 w-4 text-amber-400 shrink-0" />
      <div className="text-xs">
        <span className="font-bold text-amber-300">Modelo Élite v2: </span>
        <span className="text-muted-foreground">
          BET requiere 70%+ confianza {sport === "NBA" ? "+ árbitros" : sport === "MLB" ? "+ umpire HP" : "+ goalie confirmado"}
        </span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SHARP BADGE — visual confirmation for a specific pick
// ════════════════════════════════════════════════════════════════════════════
export function sharpBadgeFor(
  pickSide: "home" | "away" | "over" | "under" | null,
  direction: SharpDirection | null,
  market: "ml" | "total"
): { label: string; className: string; tooltip: string } | null {
  if (!pickSide || !direction || direction.strength === "none") return null;
  const sharpSide = market === "ml" ? direction.mlSide : direction.totalSide;
  if (!sharpSide) return null;

  const aligned = sharpSide === pickSide;
  const strong = direction.strength === "strong";

  if (aligned) {
    return {
      label: strong ? "⭐⭐" : "⭐",
      className: "border-green-400/60 text-green-300 bg-green-500/10",
      tooltip: strong
        ? "Steam move confirma tu pick — dinero sharp del mismo lado"
        : "Movimiento de línea confirma tu pick",
    };
  }
  return {
    label: strong ? "⚠️⚠️" : "⚠️",
    className: "border-amber-500/60 text-amber-300 bg-amber-500/10",
    tooltip: strong
      ? "STEAM contra tu pick — sharps apuestan al lado opuesto"
      : "Línea se movió al lado opuesto de tu pick",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MLB CONTEXTUAL — Series, Divisional, Hot Rivalry
// ════════════════════════════════════════════════════════════════════════════
export interface MLBContextualPayload {
  success: boolean;
  series?: { applies: boolean; team: "home" | "away" | null; situation: string; adjustmentPp: number; notes: string };
  divisional?: { applies: boolean; isDivisional: boolean; isHotRivalry: boolean; notes: string; homeProbAdjPp: number; totalAdj: number };
  homeProbAdjPp?: number;
  totalAdj?: number;
  notes?: string[];
}

export function MLBContextualCard({
  homeTri, awayTri, gameDate, onContext,
}: {
  homeTri: string | null;
  awayTri: string | null;
  gameDate: string | null;
  onContext?: (payload: { homeProbAdjPp: number; totalAdj: number }) => void;
}) {
  const [data, setData] = useState<MLBContextualPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!homeTri || !awayTri || !gameDate) return;
    setLoading(true);
    const qs = new URLSearchParams({ home: homeTri, away: awayTri, date: gameDate });
    fetch(`${API_BASE}/api/mlb/context?${qs.toString()}`)
      .then(r => r.json())
      .then((d: MLBContextualPayload) => {
        setData(d);
        onContext?.({ homeProbAdjPp: d.homeProbAdjPp || 0, totalAdj: d.totalAdj || 0 });
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeTri, awayTri, gameDate]);

  if (!homeTri || !awayTri || !gameDate) return null;

  const anySignal = data && (data.series?.applies || data.divisional?.applies);

  return (
    <div className="rounded-lg border border-pink-500/30 bg-pink-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-pink-400" />
        <span className="text-sm font-bold text-pink-300">MLB Contextual</span>
        {data?.divisional?.isHotRivalry && (
          <Badge variant="outline" className="text-[10px] border-orange-500/40 text-orange-300">🔥 Rivalidad</Badge>
        )}
        {data?.homeProbAdjPp !== undefined && data.homeProbAdjPp !== 0 && (
          <Badge variant="outline" className={`ml-auto ${data.homeProbAdjPp > 0 ? "border-green-500/40 text-green-300" : "border-red-500/40 text-red-300"}`}>
            Local {data.homeProbAdjPp > 0 ? "+" : ""}{data.homeProbAdjPp}pp
          </Badge>
        )}
        {loading && <span className="text-xs text-muted-foreground ml-auto">Cargando...</span>}
      </div>

      {!loading && data && !anySignal && (
        <div className="text-xs text-muted-foreground">Sin contexto especial detectado</div>
      )}

      {data?.series?.applies && (
        <div className="text-xs flex items-start gap-2">
          <Target className="h-3.5 w-3.5 text-pink-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium text-pink-300">
              {data.series.situation === "sweep-avoidance" ? "Evita barrida " : "Serie "}
              ({data.series.team === "home" ? "LOCAL" : data.series.team === "away" ? "VISITANTE" : "—"}):
            </span>
            <span className="text-muted-foreground"> {data.series.notes}</span>
          </div>
        </div>
      )}

      {data?.divisional?.applies && (
        <div className="text-xs flex items-start gap-2">
          <Flame className="h-3.5 w-3.5 text-pink-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium text-pink-300">
              {data.divisional.isHotRivalry ? "Rivalidad: " : "Divisional: "}
            </span>
            <span className="text-muted-foreground">{data.divisional.notes}</span>
            {data.divisional.totalAdj !== 0 && (
              <span className="text-pink-300/80 ml-1">· total {data.divisional.totalAdj > 0 ? "+" : ""}{data.divisional.totalAdj} runs</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

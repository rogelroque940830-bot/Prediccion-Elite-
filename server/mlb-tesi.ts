// ── Team Early Scoring Index (TESI) v2 — MLB ──────────────────────────────
// 7 componentes de early scoring para predicción YRFI/NRFI/F5 y momentum.
//
// EQUIPO:
//   1. earlyOff (runs/g innings 1-3)
//   2. earlyDef (runs/g permitidas innings 1-3)
//   3. f5Runs (runs/g innings 1-5)
//   4. probFirstInn (% partidos anotando en inning 1)
//   5. opsVsHand (OPS del equipo vs mano del pitcher rival, si disponible)
//   6. lineupTop3 (OBP y K% promedio de los 3 primeros bateadores)
//
// PITCHER:
//   7. pitcher1stInnERA (ERA del pitcher en inning 1, últimos 10 starts)
//   8. pitcherTTO1xwOBA (xwOBA permitido en primeros 9 batters cara enfrentados)
//
// Sample windows: 30 juegos equipo, 10 starts pitcher.

// Node 20+ provides global fetch natively; no need to import node-fetch.

export interface TesiResult {
  teamId: number;
  teamName: string;
  gamesAnalyzed: number;

  // Team metrics
  earlyOff: number;
  earlyDef: number;
  f5Runs: number;
  netTesi: number;
  probFirstInn: number;
  probNoFirstInn: number;

  // OPS vs hand (vs pitcher rival)
  opsVsHand?: number;
  opsVsHandLabel?: string;     // "vs RHP" or "vs LHP"

  // Lineup top-3
  lineupTop3Obp?: number;
  lineupTop3K?: number;
  lineupConfirmed?: boolean;   // true=lineup confirmado, false=proyectado

  // Pitcher metrics (opposing pitcher de este partido)
  pitcher1stInnEra?: number;   // ERA del rival en inning 1
  pitcherTto1xwoba?: number;   // xwOBA permitido en TTO1
  pitcherName?: string;

  // Scores normalizados
  scoreOff: number;            // 0-100
  scoreDef: number;
  scoreNet: number;
  scoreLineup?: number;        // top-3 quality
  scorePitcherVuln?: number;   // qué tan vulnerable es el pitcher rival

  signal: string;
  recommendation: string;
}

const LEAGUE_BASELINE_EARLY = 1.4;
const LEAGUE_BASELINE_F5 = 2.5;
const LEAGUE_BASELINE_OBP = 0.320;
const LEAGUE_BASELINE_K_PCT = 0.225;
const LEAGUE_BASELINE_TTO1_XWOBA = 0.305;
const LEAGUE_BASELINE_1ST_INN_ERA = 4.20;

interface TesiInput {
  teamId: number;
  teamName: string;
  gamePk?: number;             // si se pasa, podemos buscar lineup confirmado
  opposingPitcherId?: number;  // para 1st inn ERA y TTO1 xwOBA
  opposingPitcherHand?: "R" | "L";
}

export async function computeMlbTesi(input: TesiInput): Promise<TesiResult> {
  const { teamId, teamName, gamePk, opposingPitcherId, opposingPitcherHand } = input;

  // ── 1. Team early stats (innings 1-3, F5, prob 1st inn) ────────────────
  const teamMetrics = await computeTeamEarlyMetrics(teamId);

  // ── 2. OPS vs hand del rival ────────────────────────────────────────────
  let opsVsHand: number | undefined;
  let opsVsHandLabel: string | undefined;
  if (opposingPitcherHand) {
    opsVsHand = await computeOpsVsHand(teamId, opposingPitcherHand);
    opsVsHandLabel = opposingPitcherHand === "R" ? "vs RHP" : "vs LHP";
  }

  // ── 3. Lineup top-3 (OBP + K%) ──────────────────────────────────────────
  let lineupTop3Obp: number | undefined;
  let lineupTop3K: number | undefined;
  let lineupConfirmed: boolean | undefined;
  if (gamePk) {
    const lineupData = await computeLineupTop3(gamePk, teamId);
    lineupTop3Obp = lineupData.obp;
    lineupTop3K = lineupData.k;
    lineupConfirmed = lineupData.confirmed;
  }

  // ── 4. Pitcher metrics (1st inning ERA + TTO1 xwOBA) ────────────────────
  let pitcher1stInnEra: number | undefined;
  let pitcherTto1xwoba: number | undefined;
  let pitcherName: string | undefined;
  if (opposingPitcherId) {
    const pm = await computePitcherEarlyMetrics(opposingPitcherId);
    pitcher1stInnEra = pm.firstInnEra;
    pitcherTto1xwoba = pm.tto1xwoba;
    pitcherName = pm.name;
  }

  // ── Scores normalizados ─────────────────────────────────────────────────
  const scoreOff = Math.max(0, Math.min(100, 50 + (teamMetrics.earlyOff - LEAGUE_BASELINE_EARLY) * 25));
  const scoreDef = Math.max(0, Math.min(100, 50 + (LEAGUE_BASELINE_EARLY - teamMetrics.earlyDef) * 25));
  const scoreNet = Math.round((scoreOff + scoreDef) / 2);

  let scoreLineup: number | undefined;
  if (lineupTop3Obp !== undefined && lineupTop3K !== undefined) {
    // OBP alta + K% baja = mejor lineup early scoring
    const obpScore = 50 + (lineupTop3Obp - LEAGUE_BASELINE_OBP) * 200;
    const kScore = 50 + (LEAGUE_BASELINE_K_PCT - lineupTop3K) * 150;
    scoreLineup = Math.max(0, Math.min(100, Math.round((obpScore + kScore) / 2)));
  }

  let scorePitcherVuln: number | undefined;
  if (pitcher1stInnEra !== undefined || pitcherTto1xwoba !== undefined) {
    let parts = 0; let sum = 0;
    if (pitcher1stInnEra !== undefined) {
      // ERA alta en inning 1 = pitcher más vulnerable = mejor para nuestra ofensiva
      sum += 50 + (pitcher1stInnEra - LEAGUE_BASELINE_1ST_INN_ERA) * 8;
      parts++;
    }
    if (pitcherTto1xwoba !== undefined) {
      sum += 50 + (pitcherTto1xwoba - LEAGUE_BASELINE_TTO1_XWOBA) * 200;
      parts++;
    }
    scorePitcherVuln = Math.max(0, Math.min(100, Math.round(sum / parts)));
  }

  // ── Signal y recomendación ──────────────────────────────────────────────
  const { signal, recommendation } = classifyTesi({
    scoreOff, scoreDef, scoreLineup, scorePitcherVuln,
    probFirstInn: teamMetrics.probFirstInn,
  });

  return {
    teamId,
    teamName,
    gamesAnalyzed: teamMetrics.gamesAnalyzed,
    earlyOff: teamMetrics.earlyOff,
    earlyDef: teamMetrics.earlyDef,
    f5Runs: teamMetrics.f5Runs,
    netTesi: Math.round((teamMetrics.earlyOff - teamMetrics.earlyDef) * 100) / 100,
    probFirstInn: teamMetrics.probFirstInn,
    probNoFirstInn: Math.round((1 - teamMetrics.probFirstInn) * 100) / 100,
    opsVsHand,
    opsVsHandLabel,
    lineupTop3Obp,
    lineupTop3K,
    lineupConfirmed,
    pitcher1stInnEra,
    pitcherTto1xwoba,
    pitcherName,
    scoreOff: Math.round(scoreOff),
    scoreDef: Math.round(scoreDef),
    scoreNet,
    scoreLineup,
    scorePitcherVuln,
    signal,
    recommendation,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: team early metrics (innings 1-3 + F5)
// ──────────────────────────────────────────────────────────────────────────
async function computeTeamEarlyMetrics(teamId: number) {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${fmt(start)}&endDate=${fmt(end)}&gameType=R`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
  const j: any = await r.json();
  const gamePks: number[] = [];
  // BUG FIX: /linescore NO devuelve team.id, mapeamos desde el schedule.
  const gameTeamMap = new Map<number, { homeId: number; awayId: number }>();
  for (const dd of j.dates ?? []) {
    for (const g of dd.games ?? []) {
      if (g.status?.detailedState === "Final") {
        gamePks.push(g.gamePk);
        gameTeamMap.set(g.gamePk, {
          homeId: g.teams?.home?.team?.id,
          awayId: g.teams?.away?.team?.id,
        });
      }
    }
  }
  const recent = gamePks.slice(-30);

  const linescores = await Promise.all(
    recent.map(async (pk) => {
      try {
        const lr = await fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/linescore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
        const data = await lr.json() as any;
        const ids = gameTeamMap.get(pk);
        if (ids && data.teams) {
          if (data.teams.home) data.teams.home.__teamId = ids.homeId;
          if (data.teams.away) data.teams.away.__teamId = ids.awayId;
        }
        return data;
      } catch { return null; }
    })
  );

  let totalEarlyOff = 0, totalEarlyDef = 0, totalF5 = 0;
  let firstInnScored = 0, gamesAnalyzed = 0;

  for (const ls of linescores) {
    if (!ls) continue;
    const isHome = ls.teams?.home?.__teamId === teamId;
    const isAway = ls.teams?.away?.__teamId === teamId;
    if (!isHome && !isAway) continue;
    const innings = ls.innings ?? [];
    if (innings.length < 3) continue;

    let earlyOffG = 0, earlyDefG = 0, f5G = 0;
    for (let i = 0; i < Math.min(5, innings.length); i++) {
      const inn = innings[i];
      const myRuns = isHome ? (inn.home?.runs ?? 0) : (inn.away?.runs ?? 0);
      if (i < 3) {
        const oppRuns = isHome ? (inn.away?.runs ?? 0) : (inn.home?.runs ?? 0);
        earlyOffG += myRuns;
        earlyDefG += oppRuns;
        if (i === 0 && myRuns > 0) firstInnScored++;
      }
      f5G += myRuns;
    }
    totalEarlyOff += earlyOffG;
    totalEarlyDef += earlyDefG;
    totalF5 += f5G;
    gamesAnalyzed++;
  }

  const g = Math.max(1, gamesAnalyzed);
  return {
    gamesAnalyzed,
    earlyOff: Math.round((totalEarlyOff / g) * 100) / 100,
    earlyDef: Math.round((totalEarlyDef / g) * 100) / 100,
    f5Runs: Math.round((totalF5 / g) * 100) / 100,
    probFirstInn: Math.round((firstInnScored / g) * 100) / 100,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: OPS del equipo vs mano del pitcher rival
// ──────────────────────────────────────────────────────────────────────────
async function computeOpsVsHand(teamId: number, hand: "R" | "L"): Promise<number | undefined> {
  try {
    // Team splits vs hand
    const sit = hand === "R" ? "vr" : "vl";
    const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?season=2026&stats=statSplits&group=hitting&sitCodes=${sit}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const stat = j.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return undefined;
    return parseFloat(stat.ops) || undefined;
  } catch {
    return undefined;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: Top-3 lineup OBP y K%
// ──────────────────────────────────────────────────────────────────────────
async function computeLineupTop3(gamePk: number, teamId: number): Promise<{ obp?: number; k?: number; confirmed: boolean }> {
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const homeId = j.teams?.home?.team?.id;
    const side = homeId === teamId ? "home" : "away";
    const battingOrder: number[] = j.teams?.[side]?.battingOrder ?? [];

    // battingOrder vacío = no hay lineup confirmado todavía
    const confirmed = battingOrder.length >= 3;
    let playerIds: number[];

    if (confirmed) {
      playerIds = battingOrder.slice(0, 3).map((id: any) => typeof id === "string" ? parseInt(id, 10) : id);
    } else {
      // Proyectar: tomar los 3 más usados últimos 10 GP
      // Fallback: usar los players del boxscore con más PA
      const players = j.teams?.[side]?.players || {};
      const list = Object.values(players)
        .filter((p: any) => p?.stats?.batting?.plateAppearances)
        .sort((a: any, b: any) => (b.stats.batting.plateAppearances || 0) - (a.stats.batting.plateAppearances || 0))
        .slice(0, 3)
        .map((p: any) => p.person?.id);
      playerIds = list.filter(Boolean);
    }

    if (playerIds.length === 0) return { confirmed: false };

    // Pedir OBP y K% de cada uno (season stats)
    const players = await Promise.all(
      playerIds.map(async (pid) => {
        try {
          const pr = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2026&group=hitting`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
          const pj: any = await pr.json();
          const s = pj.stats?.[0]?.splits?.[0]?.stat;
          if (!s) return null;
          const obp = parseFloat(s.obp) || 0;
          const pa = parseInt(s.plateAppearances) || 0;
          const so = parseInt(s.strikeOuts) || 0;
          const kpct = pa > 0 ? so / pa : 0;
          return { obp, kpct, pa };
        } catch { return null; }
      })
    );

    const valid = players.filter((p): p is NonNullable<typeof p> => p !== null && p.pa >= 20);
    if (valid.length === 0) return { confirmed };

    const avgObp = valid.reduce((a, b) => a + b.obp, 0) / valid.length;
    const avgK = valid.reduce((a, b) => a + b.kpct, 0) / valid.length;

    return {
      obp: Math.round(avgObp * 1000) / 1000,
      k: Math.round(avgK * 1000) / 1000,
      confirmed,
    };
  } catch {
    return { confirmed: false };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: Pitcher 1st inning ERA + TTO1 xwOBA
// ──────────────────────────────────────────────────────────────────────────
async function computePitcherEarlyMetrics(pitcherId: number) {
  let firstInnEra: number | undefined;
  let tto1xwoba: number | undefined;
  let name: string | undefined;

  // 1st inning ERA: pitching splits sitCodes=i1 (inning 1)
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&season=2026&group=pitching&sitCodes=i01`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const stat = j.stats?.[0]?.splits?.[0]?.stat;
    if (stat) {
      const er = parseInt(stat.earnedRuns) || 0;
      const ipStr = String(stat.inningsPitched || "0");
      const ipParts = ipStr.split(".");
      const ipFull = parseFloat(ipStr) || 0;
      if (ipFull > 0) {
        firstInnEra = Math.round((er / ipFull) * 9 * 100) / 100;
      }
    }
    name = j.stats?.[0]?.splits?.[0]?.player?.fullName;
  } catch { /* ignore */ }

  // TTO1 xwOBA: Savant CSV con hfInn=1
  try {
    const savantUrl = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=2026%7C&player_type=pitcher&hfInn=1%7C&min_pitches=0&min_results=0&group_by=name&sort_col=xwoba&min_pas=10&pitchers_lookup%5B%5D=${pitcherId}`;
    const r = await fetch(savantUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const csv = await r.text();
    const lines = csv.split("\n");
    if (lines.length >= 2) {
      const header = lines[0].split(",").map(s => s.replace(/"/g, "").trim());
      const xwobaIdx = header.indexOf("xwoba");
      const row = lines[1].split(",");
      if (xwobaIdx >= 0 && row[xwobaIdx]) {
        const v = parseFloat(row[xwobaIdx]);
        if (!isNaN(v) && v > 0) tto1xwoba = Math.round(v * 1000) / 1000;
      }
    }
  } catch { /* ignore */ }

  return { firstInnEra, tto1xwoba, name };
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: clasificación
// ──────────────────────────────────────────────────────────────────────────
function classifyTesi(args: {
  scoreOff: number; scoreDef: number;
  scoreLineup?: number; scorePitcherVuln?: number;
  probFirstInn: number;
}): { signal: string; recommendation: string } {
  const { scoreOff, scoreDef, scoreLineup, scorePitcherVuln, probFirstInn } = args;

  // Composite: si tenemos lineup + pitcherVuln, ponderamos
  const components = [scoreOff];
  if (scoreLineup !== undefined) components.push(scoreLineup);
  if (scorePitcherVuln !== undefined) components.push(scorePitcherVuln);
  const offBundle = components.reduce((a, b) => a + b, 0) / components.length;

  if (offBundle >= 70 && probFirstInn >= 0.55) {
    return { signal: "ELITE_OFF", recommendation: "Ofensiva temprana ELITE + alta prob YRFI — fuerte favorito para anotar inning 1 y F5" };
  }
  if (offBundle >= 65) {
    return { signal: "STRONG_OFF", recommendation: "Ofensiva temprana fuerte — YRFI viable, F5 ML/Total favorable" };
  }
  if (scoreDef >= 70 && offBundle < 50) {
    return { signal: "ELITE_DEF", recommendation: "Defensa temprana ELITE — NRFI y F5 Under con valor" };
  }
  if (scoreDef >= 60) {
    return { signal: "STRONG_DEF", recommendation: "Defensa temprana fuerte — NRFI viable" };
  }
  if (offBundle < 40) {
    return { signal: "WEAK_OFF", recommendation: "Ofensiva temprana débil — evitar YRFI" };
  }
  if (scoreDef < 40) {
    return { signal: "WEAK_DEF", recommendation: "Defensa temprana vulnerable — riesgo YRFI rival" };
  }
  return { signal: "BALANCED", recommendation: "Early scoring promedio — sin edge claro" };
}

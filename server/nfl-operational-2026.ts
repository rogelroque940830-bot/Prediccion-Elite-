import { getNflEliteIntegrationStatus, type NflEliteIntegrationState } from "./nfl-elite-integration-gate";
import { hydrateNflPregameMaterializer } from "./nfl-pregame-checkpoint";
import {
  type NflCompletedObservation,
  type NflPregameMaterialization,
  type NflQbGameMetrics,
  type NflReplayGame,
  type NflTeamGameMetrics,
  type NflTimestampedDepthSnapshot,
} from "./nfl-pregame-materializer";
import {
  getNflR5H20End2025Checkpoint,
  NFL_R5H20_END_2025_CHECKPOINT_DIGEST,
} from "./nfl-r5h20-checkpoint";
import { scoreNflR5H8Pregame, type NflR5H8Score } from "./nfl-r5h8-scorer";

export const NFL_OPERATIONAL_2026_SCHEMA = "courtedge-nfl-operational-2026.v1" as const;
export const NFL_OPERATIONAL_SEASON = 2026 as const;
export const NFL_OPERATIONAL_SCHEDULE_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv" as const;
export const NFL_OPERATIONAL_DEPTH_URL = "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.csv" as const;
export const NFL_OPERATIONAL_PBP_URL = "https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.csv" as const;

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const TEAM_MAP: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA", LAR: "LA", JAC: "JAX", WSH: "WAS" };

function normalizeTeam(team: string): string {
  const value = String(team).trim().toUpperCase();
  return TEAM_MAP[value] ?? value;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function dateIso(value: string): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function rowsFromCsvText(text: string): Array<Record<string, string>> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""]));
  });
}

export type NflOperationalScheduleGame = {
  gameId: string;
  season: 2026;
  week: number;
  gameday: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  completed: boolean;
};

export function parseNflOperationalScheduleCsv(text: string): NflOperationalScheduleGame[] {
  const out: NflOperationalScheduleGame[] = [];
  for (const row of rowsFromCsvText(text)) {
    if (Number(row.season) !== NFL_OPERATIONAL_SEASON || String(row.game_type).trim().toUpperCase() !== "REG") continue;
    const week = Number(row.week);
    const gameday = dateIso(row.gameday);
    if (!row.game_id || !Number.isInteger(week) || !gameday || !row.home_team || !row.away_team) continue;
    const homeScore = finite(row.home_score);
    const awayScore = finite(row.away_score);
    out.push({
      gameId: String(row.game_id),
      season: NFL_OPERATIONAL_SEASON,
      week,
      gameday,
      homeTeam: normalizeTeam(row.home_team),
      awayTeam: normalizeTeam(row.away_team),
      homeScore,
      awayScore,
      completed: homeScore !== null && awayScore !== null,
    });
  }
  return out.sort((a, b) => a.gameday.localeCompare(b.gameday) || a.gameId.localeCompare(b.gameId));
}

function timestampIso(value: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseNflOperationalDepthCsv(text: string): NflTimestampedDepthSnapshot[] {
  const grouped = new Map<string, { season: number; at: string; team: string; qbs: Array<{ qbId: string; rank: number }> }>();
  for (const row of rowsFromCsvText(text)) {
    const pos = `${row.pos_abb ?? ""} ${row.pos_name ?? ""}`.toUpperCase();
    if (!/(^|\s)QB(\s|$)|QUARTERBACK/.test(pos)) continue;
    const team = normalizeTeam(row.team);
    const qbId = String(row.gsis_id ?? "").trim();
    const at = timestampIso(row.dt);
    if (!team || !qbId || !at) continue;
    const rankRaw = finite(row.pos_rank);
    const rank = rankRaw === null ? 99 : Math.max(1, Math.trunc(rankRaw));
    const key = `${team}\u0000${at}`;
    const current = grouped.get(key) ?? { season: NFL_OPERATIONAL_SEASON, at, team, qbs: [] };
    if (!current.qbs.some((qb) => qb.qbId === qbId)) current.qbs.push({ qbId, rank });
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((row) => ({ ...row, qbs: row.qbs.sort((a, b) => a.rank - b.rank || a.qbId.localeCompare(b.qbId)) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.team.localeCompare(b.team));
}

type MeanAgg = { sum: number; n: number };
type TeamAgg = {
  offEpa: MeanAgg;
  offSuccess: MeanAgg;
  plays: number;
  drives: Set<string>;
  passEpa: MeanAgg;
  passSuccess: MeanAgg;
  rushEpa: MeanAgg;
  rushSuccess: MeanAgg;
  sackRate: MeanAgg;
  explosivePass: MeanAgg;
  explosiveRush: MeanAgg;
};
type QbAgg = { epa: MeanAgg; cpoe: MeanAgg; sackRate: MeanAgg; dropbacks: number; team: string; qbId: string };

function meanAgg(): MeanAgg { return { sum: 0, n: 0 }; }
function teamAgg(): TeamAgg {
  return {
    offEpa: meanAgg(), offSuccess: meanAgg(), plays: 0, drives: new Set<string>(),
    passEpa: meanAgg(), passSuccess: meanAgg(), rushEpa: meanAgg(), rushSuccess: meanAgg(),
    sackRate: meanAgg(), explosivePass: meanAgg(), explosiveRush: meanAgg(),
  };
}
function addMean(agg: MeanAgg, value: unknown): void {
  const n = finite(value);
  if (n === null) return;
  agg.sum += n;
  agg.n += 1;
}
function meanValue(agg: MeanAgg): number | null { return agg.n ? agg.sum / agg.n : null; }

export type NflPbpAggregates = {
  rowsRead: number;
  observations: Map<string, { teams: Map<string, NflTeamGameMetrics>; qbs: NflQbGameMetrics[] }>;
};

class PbpAccumulator {
  rowsRead = 0;
  private readonly teams = new Map<string, TeamAgg>();
  private readonly qbs = new Map<string, QbAgg>();

  add(row: Record<string, string>): void {
    this.rowsRead += 1;
    if (String(row.season_type ?? "").trim().toUpperCase() !== "REG") return;
    if (finite(row.no_play) === 1 || finite(row.qb_kneel) === 1 || finite(row.qb_spike) === 1) return;
    const gameId = String(row.game_id ?? "").trim();
    const team = normalizeTeam(row.posteam);
    const defense = normalizeTeam(row.defteam);
    const epa = finite(row.epa);
    const passAttempt = finite(row.pass_attempt) === 1;
    const rushAttempt = finite(row.rush_attempt) === 1;
    if (!gameId || !team || !defense || epa === null || (!passAttempt && !rushAttempt)) return;
    const pass = finite(row.qb_dropback) === 1 || passAttempt;
    const rush = rushAttempt;
    const key = `${gameId}\u0000${team}`;
    const t = this.teams.get(key) ?? teamAgg();
    addMean(t.offEpa, epa);
    addMean(t.offSuccess, row.success);
    t.plays += 1;
    const drive = String(row.drive ?? "").trim();
    if (drive) t.drives.add(drive);
    if (pass) {
      addMean(t.passEpa, epa);
      addMean(t.passSuccess, row.success);
      addMean(t.sackRate, row.sack);
      const yards = finite(row.yards_gained);
      addMean(t.explosivePass, yards !== null && yards >= 20 ? 1 : 0);
    }
    if (rush) {
      addMean(t.rushEpa, epa);
      addMean(t.rushSuccess, row.success);
      const yards = finite(row.yards_gained);
      addMean(t.explosiveRush, yards !== null && yards >= 10 ? 1 : 0);
    }
    this.teams.set(key, t);

    const qbId = String(row.passer_player_id ?? "").trim();
    if (finite(row.qb_dropback) === 1 && qbId) {
      const qkey = `${gameId}\u0000${team}\u0000${qbId}`;
      const q = this.qbs.get(qkey) ?? { epa: meanAgg(), cpoe: meanAgg(), sackRate: meanAgg(), dropbacks: 0, team, qbId };
      addMean(q.epa, epa);
      addMean(q.cpoe, row.cpoe);
      addMean(q.sackRate, row.sack);
      q.dropbacks += 1;
      this.qbs.set(qkey, q);
    }
  }

  finish(): NflPbpAggregates {
    const observations = new Map<string, { teams: Map<string, NflTeamGameMetrics>; qbs: NflQbGameMetrics[] }>();
    for (const [key, agg] of this.teams) {
      const split = key.indexOf("\u0000");
      const gameId = key.slice(0, split);
      const team = key.slice(split + 1);
      const game = observations.get(gameId) ?? { teams: new Map<string, NflTeamGameMetrics>(), qbs: [] };
      game.teams.set(team, {
        off_epa: meanValue(agg.offEpa), off_success: meanValue(agg.offSuccess),
        plays: agg.plays, drives: agg.drives.size,
        pass_epa: meanValue(agg.passEpa), pass_success: meanValue(agg.passSuccess),
        rush_epa: meanValue(agg.rushEpa), rush_success: meanValue(agg.rushSuccess),
        sack_rate: meanValue(agg.sackRate), explosive_pass: meanValue(agg.explosivePass),
        explosive_rush: meanValue(agg.explosiveRush),
      });
      observations.set(gameId, game);
    }
    for (const [key, agg] of this.qbs) {
      const gameId = key.slice(0, key.indexOf("\u0000"));
      const game = observations.get(gameId) ?? { teams: new Map<string, NflTeamGameMetrics>(), qbs: [] };
      game.qbs.push({
        team: agg.team,
        qbId: agg.qbId,
        qbEpa: meanValue(agg.epa),
        qbCpoe: meanValue(agg.cpoe),
        qbSackRate: meanValue(agg.sackRate),
        qbDropbacks: agg.dropbacks,
      });
      observations.set(gameId, game);
    }
    for (const game of observations.values()) {
      game.qbs.sort((a, b) => b.qbDropbacks - a.qbDropbacks || a.qbId.localeCompare(b.qbId));
    }
    return { rowsRead: this.rowsRead, observations };
  }
}

export function aggregateNflPbpCsvText(text: string): NflPbpAggregates {
  const rows = rowsFromCsvText(text);
  const acc = new PbpAccumulator();
  for (const row of rows) acc.add(row);
  return acc.finish();
}

async function aggregateNflPbpResponse(response: Response): Promise<NflPbpAggregates> {
  if (!response.body) return aggregateNflPbpCsvText(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let header: string[] | null = null;
  const acc = new PbpAccumulator();
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) {
        if (!header) header = parseCsvLine(line.replace(/^\uFEFF/, ""));
        else {
          const values = parseCsvLine(line);
          acc.add(Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
        }
      }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.trim()) {
    if (!header) header = parseCsvLine(buffer.replace(/^\uFEFF/, ""));
    else {
      const values = parseCsvLine(buffer.replace(/\r$/, ""));
      acc.add(Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
    }
  }
  return acc.finish();
}

function replayObservation(game: NflOperationalScheduleGame, pbp: NflPbpAggregates): NflCompletedObservation | null {
  if (!game.completed || game.homeScore === null || game.awayScore === null) return null;
  const observation = pbp.observations.get(game.gameId);
  if (!observation) return null;
  const homeMetrics = observation.teams.get(normalizeTeam(game.homeTeam));
  const awayMetrics = observation.teams.get(normalizeTeam(game.awayTeam));
  if (!homeMetrics || !awayMetrics) return null;
  return {
    homeScore: game.homeScore,
    awayScore: game.awayScore,
    homeMetrics,
    awayMetrics,
    quarterbacks: observation.qbs,
  };
}

export type NflOperationalEliteCard = {
  gameId: string;
  season: 2026;
  week: number;
  gameday: string;
  homeTeam: string;
  awayTeam: string;
  state: "NFL_ELITE" | "NO_ELITE" | "BLOCKED";
  modelDecision: NflR5H8Score["decision"] | null;
  predictedSide: NflR5H8Score["predictedSide"] | null;
  predictedTeam: string | null;
  predictedSideProbability: number | null;
  referenceHomeWinProbability: number | null;
  integrationState: NflEliteIntegrationState;
  materialization: NflPregameMaterialization | null;
  score: NflR5H8Score | null;
  reasons: string[];
};

export type NflOperational2026Snapshot = {
  schemaVersion: typeof NFL_OPERATIONAL_2026_SCHEMA;
  sport: "NFL";
  season: 2026;
  generatedAt: string;
  state: "READY" | "NO_GAMES" | "BLOCKED";
  scheduleGames: number;
  completedGames: number;
  completedGamesApplied: number;
  upcomingGames: number;
  activeWeek: number | null;
  checkpointDigest: typeof NFL_R5H20_END_2025_CHECKPOINT_DIGEST;
  sources: {
    schedule: { url: typeof NFL_OPERATIONAL_SCHEDULE_URL; state: "AVAILABLE"; rows: number };
    depth: { url: typeof NFL_OPERATIONAL_DEPTH_URL; state: "AVAILABLE"; snapshots: number };
    pbp: { url: typeof NFL_OPERATIONAL_PBP_URL; state: "AVAILABLE" | "NOT_PUBLISHED"; rows: number };
  };
  cards: NflOperationalEliteCard[];
  reasons: string[];
  safety: {
    pregameOnly: true;
    sameGameOutcomeUsed: false;
    targetGamedayUpdatesAllowed: false;
    marketDataUsedAsModelFeature: false;
    automaticBetPlacement: false;
  };
};

export function buildNflOperational2026SnapshotFromData(args: {
  scheduleCsv: string;
  depthCsv: string;
  pbp: NflPbpAggregates | null;
  generatedAt?: string;
}): NflOperational2026Snapshot {
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const schedule = parseNflOperationalScheduleCsv(args.scheduleCsv);
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new Error(`NFL operational generatedAt is invalid: ${generatedAt}`);
  const depth = parseNflOperationalDepthCsv(args.depthCsv)
    .filter((snapshot) => Date.parse(snapshot.at) <= generatedAtMs);
  const checkpoint = getNflR5H20End2025Checkpoint();
  const integration = getNflEliteIntegrationStatus();
  const reasons: string[] = [];
  const cards: NflOperationalEliteCard[] = [];
  if (!schedule.length) {
    return {
      schemaVersion: NFL_OPERATIONAL_2026_SCHEMA, sport: "NFL", season: NFL_OPERATIONAL_SEASON,
      generatedAt, state: "NO_GAMES", scheduleGames: 0, completedGames: 0, completedGamesApplied: 0,
      upcomingGames: 0, activeWeek: null, checkpointDigest: NFL_R5H20_END_2025_CHECKPOINT_DIGEST,
      sources: {
        schedule: { url: NFL_OPERATIONAL_SCHEDULE_URL, state: "AVAILABLE", rows: 0 },
        depth: { url: NFL_OPERATIONAL_DEPTH_URL, state: "AVAILABLE", snapshots: depth.length },
        pbp: { url: NFL_OPERATIONAL_PBP_URL, state: args.pbp ? "AVAILABLE" : "NOT_PUBLISHED", rows: args.pbp?.rowsRead ?? 0 },
      },
      cards, reasons: ["No 2026 NFL regular-season games are published in the certified schedule source."],
      safety: { pregameOnly: true, sameGameOutcomeUsed: false, targetGamedayUpdatesAllowed: false, marketDataUsedAsModelFeature: false, automaticBetPlacement: false },
    };
  }

  const incomplete = schedule.filter((game) => !game.completed);
  const activeWeek = incomplete.length ? Math.min(...incomplete.map((game) => game.week)) : null;
  if (activeWeek === null) {
    return {
      schemaVersion: NFL_OPERATIONAL_2026_SCHEMA, sport: "NFL", season: NFL_OPERATIONAL_SEASON,
      generatedAt, state: "NO_GAMES", scheduleGames: schedule.length,
      completedGames: schedule.filter((game) => game.completed).length, completedGamesApplied: 0,
      upcomingGames: 0, activeWeek: null, checkpointDigest: NFL_R5H20_END_2025_CHECKPOINT_DIGEST,
      sources: {
        schedule: { url: NFL_OPERATIONAL_SCHEDULE_URL, state: "AVAILABLE", rows: schedule.length },
        depth: { url: NFL_OPERATIONAL_DEPTH_URL, state: "AVAILABLE", snapshots: depth.length },
        pbp: { url: NFL_OPERATIONAL_PBP_URL, state: args.pbp ? "AVAILABLE" : "NOT_PUBLISHED", rows: args.pbp?.rowsRead ?? 0 },
      },
      cards: [], reasons: ["All published 2026 NFL regular-season games are completed; no upcoming Elite card is eligible."],
      safety: { pregameOnly: true, sameGameOutcomeUsed: false, targetGamedayUpdatesAllowed: false, marketDataUsedAsModelFeature: false, automaticBetPlacement: false },
    };
  }

  const materializer = hydrateNflPregameMaterializer(checkpoint, { timestampedDepth: depth });
  const byDay = new Map<string, NflOperationalScheduleGame[]>();
  for (const game of schedule) byDay.set(game.gameday, [...(byDay.get(game.gameday) ?? []), game]);
  let blockedFromDay: string | null = null;
  let completedGamesApplied = 0;

  for (const day of [...byDay.keys()].sort()) {
    const games = (byDay.get(day) ?? []).sort((a, b) => a.gameId.localeCompare(b.gameId));
    for (const game of games) {
      if (game.completed || game.week !== activeWeek) continue;
      const cardReasons: string[] = [];
      if (blockedFromDay && day > blockedFromDay) cardReasons.push(`Pregame state is blocked by an incomplete completed-game observation on ${blockedFromDay}.`);
      let materialization: NflPregameMaterialization | null = null;
      let score: NflR5H8Score | null = null;
      if (!cardReasons.length) {
        materialization = materializer.materializePregame(game);
        if (materialization.provenance.homeDepthSource !== "timestamped_depth" || materialization.provenance.awayDepthSource !== "timestamped_depth") {
          cardReasons.push("Current timestamped QB depth data is unavailable for one or both teams before the strict gameday cutoff.");
        } else if (integration.state === "BLOCKED") {
          cardReasons.push(...integration.reasons);
        } else {
          score = scoreNflR5H8Pregame(materialization);
        }
      }
      const predictedTeam = score?.predictedSide === "HOME" ? game.homeTeam : score?.predictedSide === "AWAY" ? game.awayTeam : null;
      cards.push({
        gameId: game.gameId, season: NFL_OPERATIONAL_SEASON, week: game.week, gameday: game.gameday,
        homeTeam: game.homeTeam, awayTeam: game.awayTeam,
        state: cardReasons.length ? "BLOCKED" : score?.decision === "NFL_ELITE" ? "NFL_ELITE" : "NO_ELITE",
        modelDecision: score?.decision ?? null,
        predictedSide: score?.predictedSide ?? null,
        predictedTeam,
        predictedSideProbability: score?.predictedSideProbability ?? null,
        referenceHomeWinProbability: score?.referenceHomeWinProbability ?? null,
        integrationState: integration.state,
        materialization,
        score,
        reasons: cardReasons,
      });
    }

    const completed = games.filter((game) => game.completed && game.week <= activeWeek);
    if (!completed.length) continue;
    if (!args.pbp) {
      blockedFromDay ??= day;
      reasons.push(`2026 nflverse PBP is not published but ${completed.length} completed REG game(s) exist on ${day}.`);
      continue;
    }
    for (const game of completed) {
      const observation = replayObservation(game, args.pbp);
      if (!observation) {
        blockedFromDay ??= day;
        reasons.push(`Certified PBP observation is incomplete for completed game ${game.gameId}; future cards fail closed.`);
        continue;
      }
      const replay: NflReplayGame = { ...game, observation };
      materializer.applyCompletedGame(replay);
      completedGamesApplied += 1;
    }
  }

  const completedGames = schedule.filter((game) => game.completed).length;
  const blockedCards = cards.filter((card) => card.state === "BLOCKED").length;
  if (!depth.length) reasons.push("No 2026 timestamped depth snapshots are available.");
  const state = blockedCards > 0 || (completedGames > completedGamesApplied && completedGames > 0) ? "BLOCKED" : "READY";
  return {
    schemaVersion: NFL_OPERATIONAL_2026_SCHEMA, sport: "NFL", season: NFL_OPERATIONAL_SEASON,
    generatedAt, state, scheduleGames: schedule.length, completedGames, completedGamesApplied,
    upcomingGames: cards.length, activeWeek, checkpointDigest: NFL_R5H20_END_2025_CHECKPOINT_DIGEST,
    sources: {
      schedule: { url: NFL_OPERATIONAL_SCHEDULE_URL, state: "AVAILABLE", rows: schedule.length },
      depth: { url: NFL_OPERATIONAL_DEPTH_URL, state: "AVAILABLE", snapshots: depth.length },
      pbp: { url: NFL_OPERATIONAL_PBP_URL, state: args.pbp ? "AVAILABLE" : "NOT_PUBLISHED", rows: args.pbp?.rowsRead ?? 0 },
    },
    cards, reasons,
    safety: { pregameOnly: true, sameGameOutcomeUsed: false, targetGamedayUpdatesAllowed: false, marketDataUsedAsModelFeature: false, automaticBetPlacement: false },
  };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: "text/csv,*/*", "User-Agent": "CourtEdge/1.0 NFL certified pregame adapter" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requiredText(url: string): Promise<string> {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`NFL certified source HTTP ${response.status}: ${url}`);
  return response.text();
}

async function optionalPbp(): Promise<NflPbpAggregates | null> {
  const response = await fetchWithTimeout(NFL_OPERATIONAL_PBP_URL);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`NFL PBP source HTTP ${response.status}`);
  return aggregateNflPbpResponse(response);
}

let cached: { expiresAt: number; value: NflOperational2026Snapshot } | null = null;
let inflight: Promise<NflOperational2026Snapshot> | null = null;

export async function getNflOperational2026Snapshot(force = false): Promise<NflOperational2026Snapshot> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    const [scheduleCsv, depthCsv, pbp] = await Promise.all([
      requiredText(NFL_OPERATIONAL_SCHEDULE_URL),
      requiredText(NFL_OPERATIONAL_DEPTH_URL),
      optionalPbp(),
    ]);
    const value = buildNflOperational2026SnapshotFromData({ scheduleCsv, depthCsv, pbp });
    cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
    return value;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

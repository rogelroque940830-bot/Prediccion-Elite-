import {
  getNflOperational2026Snapshot,
  NFL_OPERATIONAL_PBP_URL,
  NFL_OPERATIONAL_SCHEDULE_URL,
  parseCsvLine,
  parseNflOperationalScheduleCsv,
  type NflOperational2026Snapshot,
  type NflOperationalEliteCard,
} from "./nfl-operational-2026";
import { getNflEliteIntegrationStatus } from "./nfl-elite-integration-gate";
import {
  NflR5H21LateDownRuntime,
  scoreNflR5H21LateDownPregame,
  type NflLateDownCompletedMetrics,
  type NflLateDownFeatureMap,
  type NflR5H21LateDownScore,
} from "./nfl-r5h21-late-down-runtime";

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

function normalizeTeam(team: string): string {
  const value = String(team).trim().toUpperCase();
  return ({ OAK: "LV", SD: "LAC", STL: "LA", LAR: "LA", JAC: "JAX", WSH: "WAS" } as Record<string, string>)[value] ?? value;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function flag(value: unknown): boolean {
  return finite(value) === 1;
}

type MeanAgg = { sum: number; n: number };
type TeamLateAgg = { off: MeanAgg; def: MeanAgg };
function meanAgg(): MeanAgg { return { sum: 0, n: 0 }; }
function meanValue(agg: MeanAgg): number | null { return agg.n ? agg.sum / agg.n : null; }
function add(agg: MeanAgg, value: number): void { agg.sum += value; agg.n += 1; }

export type NflLateDownPbpAggregates = {
  rowsRead: number;
  observations: Map<string, Map<string, { offLateDownConversion: number | null; defLateDownConversionAllowed: number | null }>>;
};

class LateDownAccumulator {
  rowsRead = 0;
  private readonly teams = new Map<string, TeamLateAgg>();

  private team(gameId: string, team: string): TeamLateAgg {
    const key = `${gameId}\u0000${team}`;
    const current = this.teams.get(key) ?? { off: meanAgg(), def: meanAgg() };
    this.teams.set(key, current);
    return current;
  }

  add(row: Record<string, string>): void {
    this.rowsRead += 1;
    if (String(row.season_type ?? "").trim().toUpperCase() !== "REG") return;
    if (flag(row.no_play) || flag(row.qb_kneel) || flag(row.qb_spike)) return;
    const gameId = String(row.game_id ?? "").trim();
    const offense = normalizeTeam(row.posteam);
    const defense = normalizeTeam(row.defteam);
    if (!gameId || !offense || !defense) return;
    const pass = flag(row.pass_attempt);
    const rush = flag(row.rush_attempt);
    if (!pass && !rush) return;

    const off = this.team(gameId, offense);
    const def = this.team(gameId, defense);
    const down = finite(row.down);
    if (down === null || down < 3) return;
    const firstDown = finite(row.first_down) ?? 0;
    const touchdown = finite(row.touchdown) ?? 0;
    const conversion = Math.max(firstDown, touchdown);
    add(off.off, conversion);
    add(def.def, conversion);
  }

  finish(): NflLateDownPbpAggregates {
    const observations = new Map<string, Map<string, { offLateDownConversion: number | null; defLateDownConversionAllowed: number | null }>>();
    for (const [key, agg] of this.teams) {
      const split = key.indexOf("\u0000");
      const gameId = key.slice(0, split);
      const team = key.slice(split + 1);
      const game = observations.get(gameId) ?? new Map();
      game.set(team, {
        offLateDownConversion: meanValue(agg.off),
        defLateDownConversionAllowed: meanValue(agg.def),
      });
      observations.set(gameId, game);
    }
    return { rowsRead: this.rowsRead, observations };
  }
}

export function aggregateNflLateDownPbpCsvText(text: string): NflLateDownPbpAggregates {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return { rowsRead: 0, observations: new Map() };
  const header = parseCsvLine(lines[0]);
  const acc = new LateDownAccumulator();
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    acc.add(Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
  }
  return acc.finish();
}

async function aggregateNflLateDownPbpResponse(response: Response): Promise<NflLateDownPbpAggregates> {
  if (!response.body) return aggregateNflLateDownPbpCsvText(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let header: string[] | null = null;
  const acc = new LateDownAccumulator();
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

function completedMetrics(
  gameId: string,
  homeTeam: string,
  awayTeam: string,
  pbp: NflLateDownPbpAggregates,
): NflLateDownCompletedMetrics | null {
  const game = pbp.observations.get(gameId);
  if (!game) return null;
  const home = game.get(normalizeTeam(homeTeam));
  const away = game.get(normalizeTeam(awayTeam));
  if (!home || !away) return null;
  return { home, away };
}

export type NflFullEliteCard = NflOperationalEliteCard & {
  eliteRoute: "R5H8_CORE" | "LATE_DOWN" | null;
  lateDownFeatures: NflLateDownFeatureMap | null;
  lateDownScore: NflR5H21LateDownScore | null;
};

export type NflFullElite2026Snapshot = Omit<NflOperational2026Snapshot, "cards" | "schemaVersion"> & {
  schemaVersion: "courtedge-nfl-full-elite-operational-2026.v1";
  cards: NflFullEliteCard[];
  lateDown: {
    enabled: boolean;
    rowsRead: number;
    processedCompletedGames: number;
    artifactPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING";
  };
};

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: "text/csv,*/*", "User-Agent": "CourtEdge/1.0 NFL R5H21 late-down adapter" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLateDownSources(): Promise<{ scheduleCsv: string; pbp: NflLateDownPbpAggregates | null }> {
  const [scheduleResponse, pbpResponse] = await Promise.all([
    fetchWithTimeout(NFL_OPERATIONAL_SCHEDULE_URL),
    fetchWithTimeout(NFL_OPERATIONAL_PBP_URL),
  ]);
  if (!scheduleResponse.ok) throw new Error(`NFL R5H21 schedule source HTTP ${scheduleResponse.status}`);
  const scheduleCsv = await scheduleResponse.text();
  if (pbpResponse.status === 404) return { scheduleCsv, pbp: null };
  if (!pbpResponse.ok) throw new Error(`NFL R5H21 PBP source HTTP ${pbpResponse.status}`);
  return { scheduleCsv, pbp: await aggregateNflLateDownPbpResponse(pbpResponse) };
}

export function combineNflFullEliteSnapshot(args: {
  core: NflOperational2026Snapshot;
  scheduleCsv: string;
  lateDownPbp: NflLateDownPbpAggregates | null;
}): NflFullElite2026Snapshot {
  const integration = getNflEliteIntegrationStatus();
  const schedule = parseNflOperationalScheduleCsv(args.scheduleCsv);
  const runtime = new NflR5H21LateDownRuntime();
  const coreByGame = new Map(args.core.cards.map((card) => [card.gameId, card]));
  const cards: NflFullEliteCard[] = [];
  const reasons = [...args.core.reasons];
  const activeWeek = args.core.activeWeek;
  let blockedFromDay: string | null = null;

  const byDay = new Map<string, typeof schedule>();
  for (const game of schedule) byDay.set(game.gameday, [...(byDay.get(game.gameday) ?? []), game]);
  for (const day of [...byDay.keys()].sort()) {
    const games = (byDay.get(day) ?? []).sort((a, b) => a.gameId.localeCompare(b.gameId));
    if (activeWeek !== null) {
      for (const game of games.filter((row) => !row.completed && row.week === activeWeek)) {
        const coreCard = coreByGame.get(game.gameId);
        if (!coreCard) continue;
        const lateDownFeatures = runtime.materializePregame(game);
        let lateDownScore: NflR5H21LateDownScore | null = null;
        const cardReasons = [...coreCard.reasons];
        if (blockedFromDay && day > blockedFromDay) cardReasons.push(`R5H21 late-down state is blocked by an incomplete completed-game observation on ${blockedFromDay}.`);
        if (!cardReasons.length && integration.lateDownEnabled && coreCard.score) {
          lateDownScore = scoreNflR5H21LateDownPregame({
            gameId: game.gameId,
            season: game.season,
            week: game.week,
            gameday: game.gameday,
            features: lateDownFeatures,
            referenceHomeWinProbability: coreCard.score.referenceHomeWinProbability,
            coreSelected: coreCard.score.decision === "NFL_ELITE",
          });
        }
        const coreElite = coreCard.score?.decision === "NFL_ELITE";
        const lateElite = Boolean(lateDownScore?.thresholdOnlySelected);
        cards.push({
          ...coreCard,
          state: cardReasons.length ? "BLOCKED" : coreElite || lateElite ? "NFL_ELITE" : "NO_ELITE",
          modelDecision: cardReasons.length ? null : coreElite || lateElite ? "NFL_ELITE" : "NO_ELITE",
          eliteRoute: cardReasons.length ? null : coreElite ? "R5H8_CORE" : lateElite ? "LATE_DOWN" : null,
          lateDownFeatures,
          lateDownScore,
          reasons: cardReasons,
        });
      }
    }

    const completed = games.filter((game) => game.completed && (activeWeek === null || game.week <= activeWeek));
    if (!completed.length) continue;
    if (!args.lateDownPbp) {
      blockedFromDay ??= day;
      reasons.push(`2026 nflverse PBP is not published but ${completed.length} completed REG game(s) require R5H21 state updates on ${day}.`);
      continue;
    }
    for (const game of completed) {
      const metrics = completedMetrics(game.gameId, game.homeTeam, game.awayTeam, args.lateDownPbp);
      if (!metrics) {
        blockedFromDay ??= day;
        reasons.push(`R5H21 late-down PBP observation is incomplete for completed game ${game.gameId}; future cards fail closed.`);
        continue;
      }
      runtime.applyCompletedGame(game, metrics);
    }
  }

  const blockedCards = cards.filter((card) => card.state === "BLOCKED").length;
  const state = args.core.state === "BLOCKED" || blockedCards > 0 ? "BLOCKED" : args.core.state;
  return {
    ...args.core,
    schemaVersion: "courtedge-nfl-full-elite-operational-2026.v1",
    state,
    cards,
    reasons,
    lateDown: {
      enabled: integration.lateDownEnabled,
      rowsRead: args.lateDownPbp?.rowsRead ?? 0,
      processedCompletedGames: runtime.snapshot().processedCompletedGames,
      artifactPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING",
    },
  };
}

let cached: { expiresAt: number; value: NflFullElite2026Snapshot } | null = null;
let inflight: Promise<NflFullElite2026Snapshot> | null = null;

export async function getNflFullElite2026Snapshot(force = false): Promise<NflFullElite2026Snapshot> {
  const now = Date.now();
  if (!force && cached && cached.expiresAt > now) return cached.value;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    const [core, late] = await Promise.all([getNflOperational2026Snapshot(force), fetchLateDownSources()]);
    const value = combineNflFullEliteSnapshot({ core, scheduleCsv: late.scheduleCsv, lateDownPbp: late.pbp });
    cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
    return value;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

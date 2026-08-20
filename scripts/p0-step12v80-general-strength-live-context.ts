import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildMlbFull13LiveFeatures,
  MLB_FULL13_LIVE_FEATURE_BUILDER_VERSION,
} from "../server/mlb-full13-live-feature-builder";
import {
  classifyMlbFrozenAPlusAndF5,
  MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION,
} from "../server/mlb-frozen-a-plus-classifier";
import {
  auditValid,
  emptyReplayState,
  updateReplayStateForGame,
  type Json,
} from "./p0-full13-live-parity-state";
import { mergeV80AuditHistoryRows } from "./p0-step12v80-history-merge";

const STATE_SCHEMA = "courtedge-p0-step12v80-general-strength-live-state.v1";
const SOURCE_SCHEMA = "courtedge-p0-step12v80-general-strength-live-context.v1";
const FIRST_ELIGIBLE_DATE = "2026-08-18";
const MIN_STRENGTH_GAMES = 20;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

function arg(name: string, required = true): string | null {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) {
    if (required) throw new Error(`V80_LIVE_CONTEXT_MISSING_ARG:${name}`);
    return null;
  }
  return process.argv[i + 1];
}

function load(file: string): Json {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      return Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b)));
    }
    return child;
  });
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function isoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function previousDate(value: string): string {
  const d = new Date(`${value}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function parseTime(value: unknown): Date {
  const d = new Date(String(value ?? ""));
  if (!Number.isFinite(d.getTime())) throw new Error(`V80_LIVE_CONTEXT_INVALID_TIME:${String(value)}`);
  return d;
}

async function fetchJson(url: string, label: string): Promise<Json> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "CourtEdge-V80-Prospective/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return await response.json() as Json;
      last = new Error(`HTTP_${response.status}`);
      if (response.status < 500 && ![408, 425, 429].includes(response.status)) break;
    } catch (error) {
      last = error;
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
  }
  throw new Error(`V80_LIVE_CONTEXT_FETCH_FAILED:${label}:${String(last)}`);
}

function mergeUnique<T extends Json>(left: T[], right: T[], label: string): T[] {
  const out = new Map<number, T>();
  for (const row of [...left, ...right]) {
    const gp = Number(row.gamePk);
    if (!Number.isInteger(gp) || gp <= 0) throw new Error(`V80_LIVE_CONTEXT_INVALID_GAME_PK:${label}`);
    const existing = out.get(gp);
    if (existing && digest(existing) !== digest(row)) throw new Error(`V80_LIVE_CONTEXT_IMMUTABLE_CONFLICT:${label}:${gp}`);
    if (!existing) out.set(gp, row);
  }
  return [...out.values()].sort((a, b) => String(a.officialDate).localeCompare(String(b.officialDate)) || Number(a.gamePk) - Number(b.gamePk));
}

function readHistory(baseRoot: string, gapRoot: string): { official: Json[]; starters: Json[]; lineups: Json[]; audits: Json[] } {
  const baseOfficial = load(path.join(baseRoot, "cohort", "official-acquisition.json")).games ?? [];
  const baseStarters = load(path.join(baseRoot, "cohort", "starting-pitcher-history.json")).games ?? [];
  const baseLineups = load(path.join(baseRoot, "cohort", "pregame-lineup-history.json")).snapshots ?? [];
  const baseAudits = load(path.join(baseRoot, "t5-audit", "t5-starter-identity-audit.json")).rows ?? [];
  const gapOfficial = load(path.join(gapRoot, "official-acquisition.json")).games ?? [];
  const gapStarters = load(path.join(gapRoot, "starting-pitcher-history.json")).games ?? [];
  const gapLineups = load(path.join(gapRoot, "pregame-lineup-history.json")).snapshots ?? [];
  const gapAudits = load(path.join(gapRoot, "t5-starter-identity-audit.json")).rows ?? [];
  return {
    official: mergeUnique(baseOfficial, gapOfficial, "OFFICIAL"),
    starters: mergeUnique(baseStarters, gapStarters, "STARTER"),
    lineups: mergeUnique(baseLineups, gapLineups, "LINEUP"),
    audits: mergeV80AuditHistoryRows(baseAudits, gapAudits),
  };
}

function averageRankPercentile(metric: Map<number, number>): Map<number, number> {
  const entries = [...metric.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  if (entries.length < 2) throw new Error("V80_LIVE_CONTEXT_STRENGTH_UNIVERSE_TOO_SMALL");
  const out = new Map<number, number>();
  let i = 0;
  while (i < entries.length) {
    let j = i + 1;
    while (j < entries.length && entries[j][1] === entries[i][1]) j += 1;
    const averageRank1Based = ((i + 1) + j) / 2;
    const pct = (averageRank1Based - 1) / (entries.length - 1);
    for (let k = i; k < j; k += 1) out.set(entries[k][0], pct);
    i = j;
  }
  return out;
}

function tier(score: number): "BOTTOM" | "MID" | "TOP" {
  if (score < 1 / 3) return "BOTTOM";
  if (score < 2 / 3) return "MID";
  return "TOP";
}

function buildStrength(official: Json[], targetDate: string): Record<string, Json> {
  const stats = new Map<number, { games: number; wins: number; rf: number; ra: number }>();
  for (const g of official) {
    if (String(g.officialDate) >= targetDate || String(g.gameType) !== "R" || String(g.finalState) !== "Final") continue;
    const home = Number(g.homeTeamId), away = Number(g.awayTeamId);
    const hr = Number(g.homeFinalRuns), ar = Number(g.awayFinalRuns);
    if (![home, away, hr, ar].every(Number.isFinite) || hr === ar) throw new Error(`V80_LIVE_CONTEXT_STRENGTH_SOURCE_INVALID:${g.gamePk}`);
    for (const [tid, rf, ra] of [[home, hr, ar], [away, ar, hr]] as const) {
      const z = stats.get(tid) ?? { games: 0, wins: 0, rf: 0, ra: 0 };
      z.games += 1; z.wins += rf > ra ? 1 : 0; z.rf += rf; z.ra += ra; stats.set(tid, z);
    }
  }
  const eligible = [...stats.entries()].filter(([, z]) => z.games >= MIN_STRENGTH_GAMES);
  if (eligible.length < 24) throw new Error(`V80_LIVE_CONTEXT_TOO_FEW_STRENGTH_TEAMS:${eligible.length}`);
  const winPct = new Map<number, number>();
  const rdpg = new Map<number, number>();
  for (const [tid, z] of eligible) {
    winPct.set(tid, z.wins / z.games);
    rdpg.set(tid, (z.rf - z.ra) / z.games);
  }
  const wp = averageRankPercentile(winPct), rd = averageRankPercentile(rdpg);
  const out: Record<string, Json> = {};
  for (const [tid, z] of eligible.sort((a, b) => a[0] - b[0])) {
    const score = 0.5 * ((wp.get(tid) as number) + (rd.get(tid) as number));
    out[String(tid)] = {
      games: z.games,
      wins: z.wins,
      winPct: winPct.get(tid),
      runDifferentialPerGame: rdpg.get(tid),
      winPctPercentile: wp.get(tid),
      runDifferentialPercentile: rd.get(tid),
      strengthScore: score,
      primaryTier: tier(score),
    };
  }
  return out;
}

function validOrder(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const order = raw.map(Number);
  if (order.length !== 9 || new Set(order).size !== 9 || order.some((x) => !Number.isInteger(x) || x <= 0)) return null;
  return order;
}

function pregame(feed: Json): boolean {
  const status = feed?.gameData?.status ?? {};
  const coded = String(status.codedGameState ?? "").toUpperCase();
  const abstract = String(status.abstractGameState ?? "").toLowerCase();
  const detailed = String(status.detailedState ?? "").toLowerCase();
  return !["I", "F", "O"].includes(coded)
    && !["live", "final"].includes(abstract)
    && !["in progress", "final", "game over", "completed early"].some((x) => detailed.includes(x));
}

function exactIdentity(feed: Json, scheduleGame: Json, targetDate: string, now: Date, maxLeadMinutes: number): Json | null {
  const gd = feed?.gameData ?? {};
  const gamePk = Number(feed?.gamePk ?? scheduleGame?.gamePk ?? 0);
  const officialDate = String(gd?.datetime?.officialDate ?? scheduleGame?.officialDate ?? "");
  if (!Number.isInteger(gamePk) || gamePk <= 0 || officialDate !== targetDate || !pregame(feed)) return null;
  const startTime = String(gd?.datetime?.dateTime ?? scheduleGame?.gameDate ?? "");
  const start = parseTime(startTime);
  const lead = (start.getTime() - now.getTime()) / 60_000;
  if (!(lead > 0 && lead <= maxLeadMinutes)) return null;
  const homeTeamId = Number(gd?.teams?.home?.id ?? 0), awayTeamId = Number(gd?.teams?.away?.id ?? 0);
  const homePitcherId = Number(gd?.probablePitchers?.home?.id ?? 0), awayPitcherId = Number(gd?.probablePitchers?.away?.id ?? 0);
  const homeBattingOrder = validOrder(feed?.liveData?.boxscore?.teams?.home?.battingOrder);
  const awayBattingOrder = validOrder(feed?.liveData?.boxscore?.teams?.away?.battingOrder);
  if ([homeTeamId, awayTeamId, homePitcherId, awayPitcherId].some((x) => !Number.isInteger(x) || x <= 0) || !homeBattingOrder || !awayBattingOrder) return null;
  return { gamePk, officialDate, homeTeamId, awayTeamId, homePitcherId, awayPitcherId, homeBattingOrder, awayBattingOrder, startTime, leadMinutes: lead };
}

function bullpenSide(teamBlob: Json, teamId: number, starterId: number | null): { complete: boolean; pitches: number } {
  const pitchers = Array.isArray(teamBlob?.pitchers) ? teamBlob.pitchers.map(Number).filter((x: number) => Number.isInteger(x) && x > 0) : [];
  const starterPresent = starterId !== null && pitchers.includes(starterId);
  if (!starterPresent) return { complete: false, pitches: 0 };
  let pitches = 0;
  for (const pid of pitchers) {
    if (pid === starterId) continue;
    const raw = Number(teamBlob?.players?.[`ID${pid}`]?.stats?.pitching?.pitchesThrown ?? 0);
    pitches += Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }
  if (!Number.isInteger(teamId) || teamId <= 0) throw new Error("V80_LIVE_CONTEXT_BULLPEN_TEAM_INVALID");
  return { complete: true, pitches };
}

async function buildBullpenD1(official: Json[], audits: Json[], targetDate: string): Promise<{ byTeam: Record<string, number>; diagnostics: Json }> {
  const priorDate = previousDate(targetDate);
  const auditMap = new Map<number, Json>(audits.map((row) => [Number(row.gamePk), row]));
  const byTeam: Record<string, number> = {};
  let gamesConsidered = 0, identityCompleteGames = 0;
  for (const g of official.filter((row) => String(row.officialDate) === priorDate && String(row.gameType) === "R" && String(row.finalState) === "Final")) {
    gamesConsidered += 1;
    const gp = Number(g.gamePk), audit = auditMap.get(gp);
    const hp = auditValid(audit) && audit?.probableBothKnown ? Number(audit?.homeProbablePitcherId) : null;
    const ap = auditValid(audit) && audit?.probableBothKnown ? Number(audit?.awayProbablePitcherId) : null;
    const box = await fetchJson(`https://statsapi.mlb.com/api/v1/game/${gp}/boxscore`, `bullpen:${gp}`);
    const home = bullpenSide(box?.teams?.home ?? {}, Number(g.homeTeamId), hp);
    const away = bullpenSide(box?.teams?.away ?? {}, Number(g.awayTeamId), ap);
    if (!home.complete || !away.complete) continue;
    identityCompleteGames += 1;
    byTeam[String(g.homeTeamId)] = (byTeam[String(g.homeTeamId)] ?? 0) + home.pitches;
    byTeam[String(g.awayTeamId)] = (byTeam[String(g.awayTeamId)] ?? 0) + away.pitches;
  }
  return { byTeam, diagnostics: { priorDate, gamesConsidered, identityCompleteGames, semantic: "V66_AWAY_MINUS_HOME_PRIOR_CALENDAR_DAY_RELIEVER_PITCHES" } };
}

function serializeReplay(state: ReturnType<typeof emptyReplayState>): Json {
  return {
    teamHistory: Object.fromEntries([...state.teamHistory.entries()].map(([k, v]) => [String(k), v])),
    pitcherHistory: Object.fromEntries([...state.pitcherHistory.entries()].map(([k, v]) => [String(k), v])),
    leagueStarterHistory: state.leagueStarterHistory,
    priorLineups: Object.fromEntries([...state.priorLineups.entries()].map(([k, v]) => [String(k), v])),
  };
}

async function prepare(): Promise<void> {
  const baseRoot = arg("--base-root") as string;
  const gapRoot = arg("--gap-root") as string;
  const targetDate = arg("--target-date") as string;
  const out = arg("--out") as string;
  if (!isoDate(targetDate) || targetDate < FIRST_ELIGIBLE_DATE) throw new Error(`V80_LIVE_CONTEXT_PRE_FREEZE_DATE:${targetDate}`);
  const h = readHistory(baseRoot, gapRoot);
  const official = h.official.filter((g) => String(g.officialDate) < targetDate && String(g.gameType) === "R" && String(g.finalState) === "Final");
  const starterMap = new Map<number, Json>(h.starters.map((g) => [Number(g.gamePk), g]));
  const lineupMap = new Map<number, Json>(h.lineups.map((g) => [Number(g.gamePk), g]));
  const auditMap = new Map<number, Json>(h.audits.map((g) => [Number(g.gamePk), g]));
  const replay = emptyReplayState();
  for (const g of official.sort((a, b) => String(a.officialDate).localeCompare(String(b.officialDate)) || Number(a.gamePk) - Number(b.gamePk))) {
    const mapped = { ...g, homeRuns: Number(g.homeFinalRuns), awayRuns: Number(g.awayFinalRuns) };
    updateReplayStateForGame(replay, mapped, starterMap.get(Number(g.gamePk)), lineupMap.get(Number(g.gamePk)), auditMap.get(Number(g.gamePk)));
  }
  const strengthSnapshot = buildStrength(official, targetDate);
  const bullpen = await buildBullpenD1(official, h.audits, targetDate);
  const payload: Json = {
    schemaVersion: STATE_SCHEMA,
    scientificStatus: "IMMUTABLE_PRIOR_DATE_ONLY_V80_LIVE_CONTEXT_STATE",
    targetOfficialDate: targetDate,
    generatedAt: new Date().toISOString(),
    chronology: {
      historyStrictlyBeforeTargetDate: true,
      wholeOfficialDatePriorStateOnly: true,
      sameDateCompletedGamesUsed: false,
      latestHistoricalOfficialDate: official.length ? String(official[official.length - 1].officialDate) : null,
    },
    formulaLock: {
      full13BuilderVersion: MLB_FULL13_LIVE_FEATURE_BUILDER_VERSION,
      classifierVersion: MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION,
      strengthMinimumPriorGames: MIN_STRENGTH_GAMES,
      strengthScore: "0.5*average_rank_percentile(winPct)+0.5*average_rank_percentile(runDifferentialPerGame)",
      strengthTiers: "BOTTOM_lt_1over3_MID_lt_2over3_TOP",
      bullpenPitches1dAdv: "away_prior_calendar_day_reliever_pitches_minus_home_prior_calendar_day_reliever_pitches",
    },
    replay: serializeReplay(replay),
    strengthSnapshot,
    bullpenPitches1dByTeam: bullpen.byTeam,
    diagnostics: {
      historicalOfficialGames: official.length,
      historicalStarterGames: h.starters.filter((g) => String(g.officialDate) < targetDate).length,
      historicalLineupSnapshots: h.lineups.filter((g) => String(g.officialDate) < targetDate).length,
      rankedTeams: Object.keys(strengthSnapshot).length,
      bullpen: bullpen.diagnostics,
    },
    policy: {
      researchOnly: true,
      containsCurrentGameOutcome: false,
      containsMarketPrice: false,
      oddsUsedAsFeatures: false,
      productionChanged: false,
      rankingChanged: false,
      routingChanged: false,
      stakingChanged: false,
      betEliteAllowed: false,
      realFinancialExposure: 0,
    },
  };
  payload.stateDigest = digest(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "stateDigest")));
  writeJson(out, payload);
  console.log(JSON.stringify({ targetDate, stateDigest: payload.stateDigest, diagnostics: payload.diagnostics }, null, 2));
}

async function live(): Promise<void> {
  const stateFile = arg("--state") as string;
  const targetDate = arg("--target-date") as string;
  const out = arg("--out") as string;
  const maxLead = Number(arg("--max-lead-minutes", false) ?? "20");
  const nowArg = arg("--now", false);
  const fixedNow = nowArg ? parseTime(nowArg) : null;
  const state = load(stateFile);
  if (state.schemaVersion !== STATE_SCHEMA || state.targetOfficialDate !== targetDate) throw new Error("V80_LIVE_CONTEXT_STATE_DATE_OR_SCHEMA_INVALID");
  if (state?.chronology?.wholeOfficialDatePriorStateOnly !== true || state?.chronology?.sameDateCompletedGamesUsed !== false) throw new Error("V80_LIVE_CONTEXT_STATE_CHRONOLOGY_INVALID");
  if (!(maxLead > 0 && maxLead <= 60)) throw new Error("V80_LIVE_CONTEXT_CAPTURE_WINDOW_INVALID");
  const schedule = await fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R&date=${targetDate}`, "schedule");
  const games = (schedule.dates ?? []).flatMap((d: Json) => d.games ?? []);
  const rows: Json[] = [];
  for (const game of games) {
    const gp = Number(game.gamePk);
    if (!Number.isInteger(gp) || gp <= 0) continue;
    const feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gp}/feed/live`, `feed:${gp}`);
    const observedAt = fixedNow ?? new Date();
    const identity = exactIdentity(feed, game, targetDate, observedAt, maxLead);
    if (!identity) continue;
    const capturedAt = observedAt.toISOString();
    const homeStrength = state.strengthSnapshot?.[String(identity.homeTeamId)];
    const awayStrength = state.strengthSnapshot?.[String(identity.awayTeamId)];
    if (!homeStrength || !awayStrength) throw new Error(`V80_LIVE_CONTEXT_STRENGTH_MISSING:${gp}`);
    const full13 = buildMlbFull13LiveFeatures({
      officialDate: targetDate,
      gamePk: gp,
      homeTeamId: identity.homeTeamId,
      awayTeamId: identity.awayTeamId,
      homeTeamHistory: state.replay.teamHistory?.[String(identity.homeTeamId)] ?? [],
      awayTeamHistory: state.replay.teamHistory?.[String(identity.awayTeamId)] ?? [],
      leagueStarterHistory: state.replay.leagueStarterHistory ?? [],
      homeStarterHistory: state.replay.pitcherHistory?.[String(identity.homePitcherId)] ?? [],
      awayStarterHistory: state.replay.pitcherHistory?.[String(identity.awayPitcherId)] ?? [],
      homeStarterId: identity.homePitcherId,
      awayStarterId: identity.awayPitcherId,
      homePriorLineups: state.replay.priorLineups?.[String(identity.homeTeamId)] ?? [],
      awayPriorLineups: state.replay.priorLineups?.[String(identity.awayTeamId)] ?? [],
      homeBattingOrder: identity.homeBattingOrder,
      awayBattingOrder: identity.awayBattingOrder,
    });
    const classifier = classifyMlbFrozenAPlusAndF5(full13.featureVector);
    const homeBp = Number(state.bullpenPitches1dByTeam?.[String(identity.homeTeamId)] ?? 0);
    const awayBp = Number(state.bullpenPitches1dByTeam?.[String(identity.awayTeamId)] ?? 0);
    const evidence = {
      stateDigest: state.stateDigest,
      capturedAt,
      identity,
      full13FeatureVector: full13.featureVector,
      classifier,
      homeStrength,
      awayStrength,
      homeBullpenPitches1d: homeBp,
      awayBullpenPitches1d: awayBp,
    };
    rows.push({
      ...identity,
      capturedAt,
      sourceCutoffAt: capturedAt,
      exactPregameLineupSemantics: true,
      exactPregameProbableStarterSemantics: true,
      wholeOfficialDatePriorStateOnly: true,
      full13BuilderVersion: full13.builderVersion,
      full13Features: full13.featureVector,
      full13Diagnostics: full13.diagnostics,
      frozenClassifier: classifier,
      homeStrength,
      awayStrength,
      homeBullpenPitches1d: homeBp,
      awayBullpenPitches1d: awayBp,
      bullpenPitches1dAdv: awayBp - homeBp,
      sourceEvidenceDigest: digest(evidence),
      containsOutcome: false,
      containsMarketPrice: false,
    });
  }
  const capturedAt = (fixedNow ?? new Date()).toISOString();
  const payload = {
    schemaVersion: SOURCE_SCHEMA,
    targetOfficialDate: targetDate,
    capturedAt,
    stateDigest: state.stateDigest,
    rows,
    diagnostics: { scheduleGames: games.length, exactReadyGamesInCaptureWindow: rows.length, maxLeadMinutes: maxLead },
    policy: { researchOnly: true, outcomesRead: false, pricesRead: false, oddsUsedAsFeatures: false, realFinancialExposure: 0 },
  };
  writeJson(out, payload);
  console.log(JSON.stringify({ rows: rows.length, diagnostics: payload.diagnostics }, null, 2));
}

const mode = arg("--mode") as string;
if (mode === "prepare") await prepare();
else if (mode === "live") await live();
else throw new Error(`V80_LIVE_CONTEXT_UNKNOWN_MODE:${mode}`);

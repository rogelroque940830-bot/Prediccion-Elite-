import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildC4LiveFeatures,
  C4_FEATURE_NAMES,
  C4_LIVE_FEATURE_BUILDER_VERSION,
  type C4PriorLineupSnapshot,
  type C4PriorPitcherLine,
  type C4PriorTeamGame,
} from "../server/mlb-c4-live-feature-builder";
import {
  adaptCertifiedFinalC4ToR1bV16Baseline,
  MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA,
} from "../server/mlb-r1b-v16-final-baseline-adapter";
import { MLB_V16_RUNTIME_MODEL_LOCK } from "../server/mlb-pure-settlement-scorer";

const LINEUP_SCHEMA = "courtedge-p0-step12m-cohort-pregame-lineups.v1";
const STARTER_SCHEMA = "courtedge-p0-step12v60-pregame-starter-hands.v1";
const ROWSET_SCHEMA = "courtedge-mlb-r1b-v16-baseline-historical-row.v1";
const FEATURE_SCHEMA = "courtedge-mlb-r1b-v16-baseline-c4-feature-row.v1";
const PRIOR_SCHEMA = "courtedge-mlb-r1b-v16-prior-history-pack-row.v1";
const COVERAGE_SCHEMA = "courtedge-mlb-r1b-v16-baseline-coverage.v1";
const MANIFEST_SCHEMA = "courtedge-mlb-r1b-v16-baseline-season-manifest.v1";
const API_BASE = "https://statsapi.mlb.com/api";

type Json = Record<string, any>;

interface ParsedGame {
  officialDate: string;
  gamePk: number;
  homeTeamId: number;
  awayTeamId: number;
  homeRuns: number;
  awayRuns: number;
  homeLineup: number[] | null;
  awayLineup: number[] | null;
  homeStarter: C4PriorPitcherLine;
  awayStarter: C4PriorPitcherLine;
}
interface ScheduledIdentity { gamePk: number; officialDate: string; }
interface PriorHardFailure extends ScheduledIdentity { reason: string; }

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`MLB_R1B_V16_FULL_ARG_MISSING:${name}`);
}
function load(path: string): Json { return JSON.parse(readFileSync(path, "utf8")); }
function shaBytes(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function shaFile(path: string): string { return shaBytes(readFileSync(path)); }
function clean(v: unknown): string { return String(v ?? "").trim(); }
function positiveInt(v: unknown): number | null { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; }
function nonNegative(v: unknown): number | null { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }
function validDate(v: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T12:00:00Z`)); }
function validTimecode(v: string): boolean { return /^\d{8}_\d{6}$/.test(v); }
function validSha(v: unknown): boolean { return /^[a-f0-9]{64}$/i.test(String(v ?? "")); }
function previousDate(v: string): string { return new Date(Date.parse(`${v}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10); }
function timecodeIso(v: string): string {
  if (!validTimecode(v)) throw new Error(`MLB_R1B_V16_FULL_TIMECODE_INVALID:${v}`);
  const x = v.replace("_", "");
  return `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}T${x.slice(8, 10)}:${x.slice(10, 12)}:${x.slice(12, 14)}.000Z`;
}
function isFinal(status: any): boolean {
  const abstract = clean(status?.abstractGameState).toLowerCase();
  const detailed = clean(status?.detailedState).toLowerCase();
  return abstract === "final" || /final|game over|completed early/.test(detailed);
}
function order(feed: any, side: "home" | "away"): number[] | null {
  const raw = feed?.liveData?.boxscore?.teams?.[side]?.battingOrder;
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(positiveInt).filter((x): x is number => x !== null);
  return ids.length === 9 && new Set(ids).size === 9 ? ids : null;
}
function starter(feed: any, side: "home" | "away", officialDate: string, gamePk: number): C4PriorPitcherLine {
  const pitchers = feed?.liveData?.boxscore?.teams?.[side]?.pitchers;
  const pitcherId = Array.isArray(pitchers) ? positiveInt(pitchers[0]) : null;
  if (!pitcherId) throw new Error(`MLB_R1B_V16_FULL_PRIOR_STARTER_MISSING:${gamePk}:${side}`);
  const pitching = feed?.liveData?.boxscore?.teams?.[side]?.players?.[`ID${pitcherId}`]?.stats?.pitching;
  const battersFaced = nonNegative(pitching?.battersFaced);
  const strikeOuts = nonNegative(pitching?.strikeOuts);
  const baseOnBalls = nonNegative(pitching?.baseOnBalls);
  if (battersFaced === null || strikeOuts === null || baseOnBalls === null) {
    throw new Error(`MLB_R1B_V16_FULL_PRIOR_STARTER_STATS_MISSING:${gamePk}:${side}:${pitcherId}`);
  }
  return { officialDate, gamePk, pitcherId, battersFaced, strikeOuts, baseOnBalls };
}
function parseFeed(feed: any, expectedPk: number, expectedDate: string): ParsedGame {
  const gamePk = positiveInt(feed?.gamePk ?? feed?.gameData?.game?.pk) ?? expectedPk;
  const officialDate = clean(feed?.gameData?.datetime?.officialDate) || expectedDate;
  if (gamePk !== expectedPk || officialDate !== expectedDate) throw new Error(`MLB_R1B_V16_FULL_PRIOR_IDENTITY_MISMATCH:${expectedPk}`);
  if (!isFinal(feed?.gameData?.status)) throw new Error(`MLB_R1B_V16_FULL_PRIOR_NOT_FINAL:${gamePk}`);
  const homeTeamId = positiveInt(feed?.gameData?.teams?.home?.id);
  const awayTeamId = positiveInt(feed?.gameData?.teams?.away?.id);
  const homeRuns = nonNegative(feed?.liveData?.linescore?.teams?.home?.runs);
  const awayRuns = nonNegative(feed?.liveData?.linescore?.teams?.away?.runs);
  if (!homeTeamId || !awayTeamId || homeRuns === null || awayRuns === null) throw new Error(`MLB_R1B_V16_FULL_PRIOR_RESULT_INCOMPLETE:${gamePk}`);
  return {
    officialDate,
    gamePk,
    homeTeamId,
    awayTeamId,
    homeRuns,
    awayRuns,
    homeLineup: order(feed, "home"),
    awayLineup: order(feed, "away"),
    homeStarter: starter(feed, "home", officialDate, gamePk),
    awayStarter: starter(feed, "away", officialDate, gamePk),
  };
}
async function mapConcurrent<T, R>(values: readonly T[], n: number, fn: (v: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(n, Math.max(1, values.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await fn(values[index]);
    }
  }));
  return output;
}
function writeJsonl(path: string, rows: readonly unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(path, text, "utf8");
  return shaBytes(text);
}
function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text, "utf8");
  return shaBytes(text);
}
function sameFrozenIdentity(lineup: Json, starterRow: Json): boolean {
  return Number(lineup.gamePk) === Number(starterRow.gamePk)
    && String(lineup.officialDate) === String(starterRow.officialDate)
    && Number(lineup.homeTeamId) === Number(starterRow.homeTeamId)
    && Number(lineup.awayTeamId) === Number(starterRow.awayTeamId)
    && String(lineup.requestedTimecode) === String(starterRow.requestedTimecode);
}
function validateFrozen(lineup: Json, starterRow: Json, year: number): string | null {
  if (!sameFrozenIdentity(lineup, starterRow)) return "FROZEN_IDENTITY_MISMATCH";
  if (!validDate(String(lineup.officialDate)) || String(lineup.officialDate).slice(0, 4) !== String(year)) return "FROZEN_DATE_INVALID";
  if (lineup.complete !== true || lineup.availability !== "COMPLETE") return "FROZEN_LINEUP_NOT_COMPLETE";
  if (starterRow.usable !== true || starterRow.reason !== null) return "FROZEN_STARTER_NOT_USABLE";
  if (!positiveInt(lineup.gamePk) || !positiveInt(lineup.homeTeamId) || !positiveInt(lineup.awayTeamId)
      || !positiveInt(starterRow.homePitcherId) || !positiveInt(starterRow.awayPitcherId)) return "FROZEN_ID_INVALID";
  if (!Array.isArray(lineup.homeBattingOrder) || lineup.homeBattingOrder.length !== 9 || new Set(lineup.homeBattingOrder).size !== 9) return "FROZEN_HOME_LINEUP_INVALID";
  if (!Array.isArray(lineup.awayBattingOrder) || lineup.awayBattingOrder.length !== 9 || new Set(lineup.awayBattingOrder).size !== 9) return "FROZEN_AWAY_LINEUP_INVALID";
  if (!validTimecode(String(lineup.requestedTimecode)) || !validTimecode(String(starterRow.requestedTimecode))) return "FROZEN_TIMECODE_INVALID";
  if (!validTimecode(String(lineup.sourceMetadataTimecode)) || String(lineup.sourceMetadataTimecode) > String(lineup.requestedTimecode)) return "FROZEN_LINEUP_SOURCE_AFTER_CUTOFF";
  if (!validTimecode(String(starterRow.sourceMetadataTimecode)) || String(starterRow.sourceMetadataTimecode) > String(starterRow.requestedTimecode)) return "FROZEN_STARTER_SOURCE_AFTER_CUTOFF";
  if (!validSha(lineup.sourceDigest) || !validSha(starterRow.sourceDigest)) return "FROZEN_SOURCE_DIGEST_INVALID";
  return null;
}
function history(parsed: readonly ParsedGame[], lineup: Json, starterRow: Json) {
  const prior = parsed.filter((g) => g.officialDate < String(lineup.officialDate));
  const homeTeamHistory: C4PriorTeamGame[] = [];
  const awayTeamHistory: C4PriorTeamGame[] = [];
  const leagueStarterHistory: C4PriorPitcherLine[] = [];
  const homeStarterHistory: C4PriorPitcherLine[] = [];
  const awayStarterHistory: C4PriorPitcherLine[] = [];
  const homePriorLineups: C4PriorLineupSnapshot[] = [];
  const awayPriorLineups: C4PriorLineupSnapshot[] = [];
  for (const game of prior) {
    leagueStarterHistory.push(game.homeStarter, game.awayStarter);
    if (game.homeStarter.pitcherId === Number(starterRow.homePitcherId)) homeStarterHistory.push(game.homeStarter);
    if (game.awayStarter.pitcherId === Number(starterRow.homePitcherId)) homeStarterHistory.push(game.awayStarter);
    if (game.homeStarter.pitcherId === Number(starterRow.awayPitcherId)) awayStarterHistory.push(game.homeStarter);
    if (game.awayStarter.pitcherId === Number(starterRow.awayPitcherId)) awayStarterHistory.push(game.awayStarter);
    if (game.homeTeamId === Number(lineup.homeTeamId)) {
      homeTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.homeRuns, runsAgainst: game.awayRuns });
      if (game.homeLineup) homePriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.homeLineup });
    } else if (game.awayTeamId === Number(lineup.homeTeamId)) {
      homeTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.awayRuns, runsAgainst: game.homeRuns });
      if (game.awayLineup) homePriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.awayLineup });
    }
    if (game.homeTeamId === Number(lineup.awayTeamId)) {
      awayTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.homeRuns, runsAgainst: game.awayRuns });
      if (game.homeLineup) awayPriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.homeLineup });
    } else if (game.awayTeamId === Number(lineup.awayTeamId)) {
      awayTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.awayRuns, runsAgainst: game.homeRuns });
      if (game.awayLineup) awayPriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.awayLineup });
    }
  }
  return { homeTeamHistory, awayTeamHistory, leagueStarterHistory, homeStarterHistory, awayStarterHistory, homePriorLineups, awayPriorLineups };
}
function rowIdentity(row: any): string { return `${row.officialDate}|${row.gamePk}|${row.side}|${row.market}|${row.horizon}`; }
function reasonCounts(rows: any[]): Record<string, number> {
  return Object.fromEntries([...rows.reduce((m: Map<string, number>, row: any) => m.set(String(row.reason), (m.get(String(row.reason)) ?? 0) + 1), new Map()).entries()].sort());
}

async function main(): Promise<void> {
  const seasonLabel = arg("season");
  const year = Number(seasonLabel.slice(0, 4));
  if (!Number.isInteger(year)) throw new Error(`MLB_R1B_V16_FULL_SEASON_INVALID:${seasonLabel}`);
  const root = arg("root", "artifacts/v16-full");
  const outDir = arg("out-dir", join(root, "out", seasonLabel));
  const concurrency = Math.max(1, Math.min(18, Number(arg("concurrency", "10"))));
  const lineupPath = join(root, "step12v3", seasonLabel, "cohort", "pregame-lineup-history.json");
  const starterPath = join(root, "v60", `pregame-hands-${seasonLabel}.json`);
  const lineupDoc = load(lineupPath);
  const starterDoc = load(starterPath);
  if (lineupDoc.schemaVersion !== LINEUP_SCHEMA) throw new Error("MLB_R1B_V16_FULL_LINEUP_SCHEMA_INVALID");
  if (starterDoc.schemaVersion !== STARTER_SCHEMA) throw new Error("MLB_R1B_V16_FULL_STARTER_SCHEMA_INVALID");
  const lineupSha = shaFile(lineupPath);
  const starterSha = shaFile(starterPath);
  const lineupByPk = new Map<number, Json>((lineupDoc.snapshots ?? []).map((row: Json) => [Number(row.gamePk), row]));
  const starterByPk = new Map<number, Json>((starterDoc.snapshots ?? []).map((row: Json) => [Number(row.gamePk), row]));
  const union = [...new Set([...lineupByPk.keys(), ...starterByPk.keys()])].sort((a, b) => a - b);
  const sourceExcluded: any[] = [];
  const frozenTargets: { lineup: Json; starter: Json }[] = [];
  for (const gamePk of union) {
    const lineup = lineupByPk.get(gamePk);
    const starterRow = starterByPk.get(gamePk);
    if (!lineup) { sourceExcluded.push({ gamePk, officialDate: starterRow?.officialDate ?? null, reason: "MISSING_LINEUP_SNAPSHOT" }); continue; }
    if (!starterRow) { sourceExcluded.push({ gamePk, officialDate: lineup.officialDate ?? null, reason: "MISSING_STARTER_SNAPSHOT" }); continue; }
    const reason = validateFrozen(lineup, starterRow, year);
    if (reason) { sourceExcluded.push({ gamePk, officialDate: lineup.officialDate ?? null, reason }); continue; }
    frozenTargets.push({ lineup, starter: starterRow });
  }
  frozenTargets.sort((a, b) => String(a.lineup.officialDate).localeCompare(String(b.lineup.officialDate)) || Number(a.lineup.gamePk) - Number(b.lineup.gamePk));
  if (!frozenTargets.length) throw new Error(`MLB_R1B_V16_FULL_NO_FROZEN_TARGETS:${seasonLabel}`);
  const maxTargetDate = String(frozenTargets[frozenTargets.length - 1].lineup.officialDate);

  const fetchJson = async (url: string, label: string): Promise<any> => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`MLB_R1B_V16_FULL_FETCH_FAILED:${label}:${lastError instanceof Error ? lastError.message : String(lastError)}`);
  };

  const schedule = await fetchJson(`${API_BASE}/v1/schedule?sportId=1&gameType=R&startDate=${year}-03-01&endDate=${previousDate(maxTargetDate)}`, "schedule");
  const identities: ScheduledIdentity[] = [];
  for (const dateEntry of Array.isArray(schedule?.dates) ? schedule.dates : []) {
    for (const raw of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
      const gamePk = positiveInt(raw?.gamePk);
      const officialDate = clean(raw?.officialDate ?? dateEntry?.date);
      if (gamePk && validDate(officialDate) && officialDate < maxTargetDate && officialDate.slice(0, 4) === String(year) && isFinal(raw?.status)) {
        identities.push({ gamePk, officialDate });
      }
    }
  }
  const unique = [...new Map(identities.sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk).map((x) => [x.gamePk, x])).values()];
  const attempts = await mapConcurrent(unique, concurrency, async (identity) => {
    const feed = await fetchJson(`${API_BASE}/v1.1/game/${identity.gamePk}/feed/live`, `prior-${identity.gamePk}`);
    try {
      return { kind: "PARSED" as const, identity, game: parseFeed(feed, identity.gamePk, identity.officialDate) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === `MLB_R1B_V16_FULL_PRIOR_NOT_FINAL:${identity.gamePk}`) {
        return { kind: "SKIPPED_NOT_FINAL" as const, identity, reason };
      }
      if (reason.startsWith("MLB_R1B_V16_FULL_PRIOR_")) {
        return { kind: "HARD_FAILURE" as const, identity, reason };
      }
      throw error;
    }
  });
  const parsed = attempts.filter((x): x is Extract<(typeof attempts)[number], { kind: "PARSED" }> => x.kind === "PARSED").map((x) => x.game)
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  const skippedNotFinal = attempts.filter((x) => x.kind === "SKIPPED_NOT_FINAL").map((x) => ({ ...x.identity, reason: x.reason }));
  const priorHardFailures: PriorHardFailure[] = attempts.filter((x) => x.kind === "HARD_FAILURE").map((x) => ({ ...x.identity, reason: x.reason }))
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);

  const priorRows = parsed.map((game) => ({
    schemaVersion: PRIOR_SCHEMA,
    officialDate: game.officialDate,
    gamePk: game.gamePk,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    homeRuns: game.homeRuns,
    awayRuns: game.awayRuns,
    homeLineup: game.homeLineup,
    awayLineup: game.awayLineup,
    homeStarter: game.homeStarter,
    awayStarter: game.awayStarter,
  }));
  const priorPath = join(outDir, `prior-history-${seasonLabel}.jsonl`);
  const priorSha = writeJsonl(priorPath, priorRows);

  const c4Excluded: any[] = [];
  const featureRows: any[] = [];
  const baselineRows: any[] = [];
  for (const target of frozenTargets) {
    const targetDate = String(target.lineup.officialDate);
    const fatalPrior = priorHardFailures.find((failure) => failure.officialDate < targetDate);
    if (fatalPrior) {
      c4Excluded.push({ gamePk: Number(target.lineup.gamePk), officialDate: targetDate, reason: `C4_PRIOR_HISTORY_UNMATERIALIZABLE:${fatalPrior.officialDate}:${fatalPrior.gamePk}:${fatalPrior.reason}` });
      continue;
    }
    const h = history(parsed, target.lineup, target.starter);
    let reason: string | null = null;
    if (h.homePriorLineups.length !== h.homeTeamHistory.length) reason = `C4_HOME_LINEUP_HISTORY_INCOMPLETE:${h.homePriorLineups.length}:${h.homeTeamHistory.length}`;
    else if (h.awayPriorLineups.length !== h.awayTeamHistory.length) reason = `C4_AWAY_LINEUP_HISTORY_INCOMPLETE:${h.awayPriorLineups.length}:${h.awayTeamHistory.length}`;
    if (reason) {
      c4Excluded.push({ gamePk: Number(target.lineup.gamePk), officialDate: targetDate, reason });
      continue;
    }
    try {
      const assessment = buildC4LiveFeatures({
        officialDate: targetDate,
        gamePk: Number(target.lineup.gamePk),
        homeTeamId: Number(target.lineup.homeTeamId),
        awayTeamId: Number(target.lineup.awayTeamId),
        homeTeamHistory: h.homeTeamHistory,
        awayTeamHistory: h.awayTeamHistory,
        leagueStarterHistory: h.leagueStarterHistory,
        homeStarterHistory: h.homeStarterHistory,
        awayStarterHistory: h.awayStarterHistory,
        homeStarterId: Number(target.starter.homePitcherId),
        awayStarterId: Number(target.starter.awayPitcherId),
        homePriorLineups: h.homePriorLineups,
        awayPriorLineups: h.awayPriorLineups,
        homeBattingOrder: [...target.lineup.homeBattingOrder],
        awayBattingOrder: [...target.lineup.awayBattingOrder],
      });
      const missing = C4_FEATURE_NAMES.find((name) => assessment.featureVector[name] === null || !Number.isFinite(assessment.featureVector[name] as number));
      if (missing) {
        c4Excluded.push({ gamePk: Number(target.lineup.gamePk), officialDate: targetDate, reason: `C4_FEATURE_INCOMPLETE:${missing}` });
        continue;
      }
      const generatedAt = timecodeIso(String(target.lineup.requestedTimecode));
      featureRows.push({
        schemaVersion: FEATURE_SCHEMA,
        officialDate: targetDate,
        gamePk: Number(target.lineup.gamePk),
        generatedAt,
        featureVector: assessment.featureVector,
        diagnostics: assessment.diagnostics,
        custody: {
          lineupArtifactSha256: lineupSha,
          starterArtifactSha256: starterSha,
          lineupSnapshotDigest: String(target.lineup.sourceDigest).toLowerCase(),
          starterSnapshotDigest: String(target.starter.sourceDigest).toLowerCase(),
          requestedTimecode: String(target.lineup.requestedTimecode),
          priorHistoryPackSha256: priorSha,
        },
      });
      const scored = adaptCertifiedFinalC4ToR1bV16Baseline({
        officialDate: targetDate,
        gamePk: Number(target.lineup.gamePk),
        generatedAt,
        inputStage: "FINAL",
        c4: assessment,
      });
      for (const row of scored) {
        baselineRows.push({
          schemaVersion: ROWSET_SCHEMA,
          officialDate: row.officialDate,
          gamePk: row.gamePk,
          side: row.side,
          market: row.market,
          horizon: row.horizon,
          stage: "FINAL",
          probability: row.probability,
          pushProbability: row.pushProbability,
          provenance: {
            lineupArtifactSha256: lineupSha,
            starterArtifactSha256: starterSha,
            lineupSnapshotDigest: String(target.lineup.sourceDigest).toLowerCase(),
            starterSnapshotDigest: String(target.starter.sourceDigest).toLowerCase(),
            requestedTimecode: String(target.lineup.requestedTimecode),
            priorHistoryPackSha256: priorSha,
            c4BuilderVersion: C4_LIVE_FEATURE_BUILDER_VERSION,
            v16AdapterSchema: MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA,
            v16ModelVersion: MLB_V16_RUNTIME_MODEL_LOCK.modelVersion,
            v16ManifestSha256: MLB_V16_RUNTIME_MODEL_LOCK.manifestSha256,
          },
        });
      }
    } catch (error) {
      c4Excluded.push({ gamePk: Number(target.lineup.gamePk), officialDate: targetDate, reason: `C4_BUILD_ERROR:${error instanceof Error ? error.message : String(error)}` });
    }
  }

  featureRows.sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  baselineRows.sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)));
  const ids = baselineRows.map(rowIdentity);
  const duplicateCount = ids.length - new Set(ids).size;
  if (duplicateCount !== 0) throw new Error(`MLB_R1B_V16_FULL_DUPLICATE_ROWS:${duplicateCount}`);
  if (baselineRows.length !== featureRows.length * 4) throw new Error(`MLB_R1B_V16_FULL_ROW_COUNT_MISMATCH:${baselineRows.length}:${featureRows.length}`);
  if (sourceExcluded.length + frozenTargets.length !== union.length) throw new Error("MLB_R1B_V16_FULL_SOURCE_COVERAGE_ACCOUNTING_MISMATCH");
  if (c4Excluded.length + featureRows.length !== frozenTargets.length) throw new Error("MLB_R1B_V16_FULL_C4_COVERAGE_ACCOUNTING_MISMATCH");

  const featurePath = join(outDir, `c4-features-${seasonLabel}.jsonl`);
  const rowsetPath = join(outDir, `v16-baseline-${seasonLabel}.jsonl`);
  const featureSha = writeJsonl(featurePath, featureRows);
  const rowsetSha = writeJsonl(rowsetPath, baselineRows);
  const coverage = {
    schemaVersion: COVERAGE_SCHEMA,
    season: seasonLabel,
    status: "COMPLETE_FAIL_CLOSED_COVERAGE",
    sourceUniverse: {
      lineupSnapshotCount: lineupByPk.size,
      starterSnapshotCount: starterByPk.size,
      unionGameCount: union.length,
      frozenT5EligibleCount: frozenTargets.length,
      sourceExcludedCount: sourceExcluded.length,
      sourceExcludedByReason: reasonCounts(sourceExcluded),
    },
    priorHistoryAcquisition: {
      scheduledFinalCount: unique.length,
      parsedFinalCount: parsed.length,
      feedNotFinalSkippedCount: skippedNotFinal.length,
      feedNotFinalSkipped: skippedNotFinal,
      hardFailureCount: priorHardFailures.length,
      hardFailures: priorHardFailures,
      hardFailurePolicy: "MATCH_CERTIFIED_PER_TARGET_FAIL_CLOSED_SEMANTICS_FOR_ALL_LATER_TARGET_DATES",
    },
    currentC4: {
      eligibleGameCount: featureRows.length,
      structurallyIneligibleGameCount: c4Excluded.length,
      ineligibleByReason: reasonCounts(c4Excluded),
    },
    rowset: {
      rowCount: baselineRows.length,
      rowsPerEligibleGame: 4,
      duplicateCount,
      dateRange: featureRows.length ? { start: featureRows[0].officialDate, end: featureRows[featureRows.length - 1].officialDate } : null,
    },
    exclusions: { source: sourceExcluded, c4: c4Excluded },
    policy: {
      eligibilityDefinedBeforeOutcomeEvaluation:true,
      targetIdentityFromFrozenT5Only:true,
      strictlyPriorOfficialDateHistory:true,
      sameDateHistoryAllowed:false,
      targetOutcomeUsedAsFeature:false,
      historicalPriorResultsReadForTeamForm:true,
      malformedPriorFinalFeedFailsAllLaterTargetsExactlyLikeCertifiedC4:true,
      marketPricesRead:false,
      modelRefit:false,
      newWeightsCreated:false,
      thresholdSearch:false,
      productionChanged:false,
    },
  };
  const coveragePath = join(outDir, `coverage-${seasonLabel}.json`);
  const coverageSha = writeJson(coveragePath, coverage);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    season: seasonLabel,
    status: "MATERIALIZED_AND_DIGEST_PINNED",
    source: {
      lineupArtifact: { path: lineupPath, sha256: lineupSha },
      starterArtifact: { path: starterPath, sha256: starterSha },
      officialHistoricalSource: "MLB_STATS_API_FINAL_PRIOR_GAMES_ONLY",
    },
    files: {
      priorHistory: { name: `prior-history-${seasonLabel}.jsonl`, sha256: priorSha, rowCount: priorRows.length },
      c4Features: { name: `c4-features-${seasonLabel}.jsonl`, sha256: featureSha, rowCount: featureRows.length },
      v16Baseline: { name: `v16-baseline-${seasonLabel}.jsonl`, sha256: rowsetSha, rowCount: baselineRows.length },
      coverage: { name: `coverage-${seasonLabel}.json`, sha256: coverageSha },
    },
    locks: {
      c4BuilderVersion: C4_LIVE_FEATURE_BUILDER_VERSION,
      v16AdapterSchema: MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA,
      v16ModelVersion: MLB_V16_RUNTIME_MODEL_LOCK.modelVersion,
      v16ManifestSha256: MLB_V16_RUNTIME_MODEL_LOCK.manifestSha256,
    },
    coverageSummary: {
      sourceUniverseGameCount: union.length,
      frozenT5EligibleGameCount: frozenTargets.length,
      sourceExcludedGameCount: sourceExcluded.length,
      priorHistoryHardFailureCount: priorHardFailures.length,
      c4EligibleGameCount: featureRows.length,
      c4IneligibleGameCount: c4Excluded.length,
      rowCount: baselineRows.length,
      duplicateCount,
    },
    policy: {
      researchOnly:true,
      outcomesUsedOnlyWhenStrictlyPriorToTarget:true,
      targetOutcomeUsedAsFeature:false,
      explicitFailClosedMissingnessPreserved:true,
      marketPricesRead:false,
      modelRefit:false,
      newWeightsCreated:false,
      productionChanged:false,
    },
  };
  const manifestPath = join(outDir, `manifest-${seasonLabel}.json`);
  writeJson(manifestPath, manifest);
  console.log(JSON.stringify({
    season: seasonLabel,
    status: manifest.status,
    coverage: manifest.coverageSummary,
    priorHardFailures,
    digests: { priorSha, featureSha, rowsetSha, coverageSha },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

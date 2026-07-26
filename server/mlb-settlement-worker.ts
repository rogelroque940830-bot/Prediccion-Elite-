import type { LedgerPrediction, MlbLedgerStore } from "./mlb-ledger-store";

const MLB_API = "https://statsapi.mlb.com/api";
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const START_DELAY_MS = 20 * 1000;

interface OfficialInning {
  num: number;
  home: number;
  away: number;
}

export interface OfficialMlbGame {
  gamePk: number;
  gameDate: string;
  final: boolean;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  innings: OfficialInning[];
}

export interface GradedMlbPrediction {
  result: "WIN" | "LOSS" | "PUSH";
  outcomeValue: number;
  notes: string;
}

export interface SettlementRunResult {
  checked: number;
  settled: number;
  pendingFinal: number;
  unsupported: number;
  unresolvedGame: number;
  errors: Array<{ predictionId: string; error: string }>;
}

function normalize(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseLine(selection: string, storedLine: number | null): number | null {
  if (storedLine != null && Number.isFinite(storedLine)) return storedLine;
  const signed = selection.match(/[+-]\d+(?:\.\d+)?/g);
  if (signed?.length) {
    const value = Number(signed[signed.length - 1]);
    if (Number.isFinite(value)) return value;
  }
  const all = selection.match(/\d+(?:\.\d+)?/g);
  if (!all?.length) return null;
  const value = Number(all[all.length - 1]);
  return Number.isFinite(value) ? value : null;
}

function selectedTeam(prediction: LedgerPrediction): "HOME" | "AWAY" | null {
  const selection = normalize(prediction.market.selection);
  const home = normalize(prediction.game.homeTeam);
  const away = normalize(prediction.game.awayTeam);

  if (home && selection.includes(home)) return "HOME";
  if (away && selection.includes(away)) return "AWAY";
  if (selection.includes("home") || selection.includes("local")) return "HOME";
  if (selection.includes("away") || selection.includes("visitante") || selection.includes("visitor")) return "AWAY";
  return null;
}

function totalDirection(selection: string): "OVER" | "UNDER" | null {
  const value = selection.toLowerCase();
  if (value.includes("over") || value.includes("más") || value.includes("mas")) return "OVER";
  if (value.includes("under") || value.includes("menos")) return "UNDER";
  return null;
}

function compare(value: number, line: number, direction: "OVER" | "UNDER"): "WIN" | "LOSS" | "PUSH" {
  if (value === line) return "PUSH";
  if (direction === "OVER") return value > line ? "WIN" : "LOSS";
  return value < line ? "WIN" : "LOSS";
}

function firstN(game: OfficialMlbGame, innings: number): { home: number; away: number; complete: boolean } {
  const included = game.innings.filter((inning) => inning.num >= 1 && inning.num <= innings);
  const numbers = new Set(included.map((inning) => inning.num));
  return {
    home: included.reduce((sum, inning) => sum + inning.home, 0),
    away: included.reduce((sum, inning) => sum + inning.away, 0),
    complete: numbers.size >= innings,
  };
}

export function gradeMlbPrediction(prediction: LedgerPrediction, game: OfficialMlbGame): GradedMlbPrediction | null {
  if (!game.final) return null;
  const market = prediction.market.type;
  const selectionTeam = selectedTeam(prediction);
  const line = parseLine(prediction.market.selection, prediction.market.line);
  const direction = totalDirection(prediction.market.selection);

  if (market === "ML") {
    if (!selectionTeam) return null;
    if (game.homeScore === game.awayScore) return { result: "PUSH", outcomeValue: 0, notes: "Official full-game tie" };
    const winner = game.homeScore > game.awayScore ? "HOME" : "AWAY";
    return {
      result: winner === selectionTeam ? "WIN" : "LOSS",
      outcomeValue: selectionTeam === "HOME" ? game.homeScore - game.awayScore : game.awayScore - game.homeScore,
      notes: `Official final score ${game.awayTeam} ${game.awayScore}-${game.homeScore} ${game.homeTeam}`,
    };
  }

  if (market === "F5_ML") {
    if (!selectionTeam) return null;
    const f5 = firstN(game, 5);
    if (!f5.complete) return null;
    if (f5.home === f5.away) return { result: "PUSH", outcomeValue: 0, notes: `Official F5 tie ${f5.away}-${f5.home}` };
    const winner = f5.home > f5.away ? "HOME" : "AWAY";
    return {
      result: winner === selectionTeam ? "WIN" : "LOSS",
      outcomeValue: selectionTeam === "HOME" ? f5.home - f5.away : f5.away - f5.home,
      notes: `Official F5 score ${game.awayTeam} ${f5.away}-${f5.home} ${game.homeTeam}`,
    };
  }

  if (market === "RUN_LINE") {
    if (!selectionTeam || line == null) return null;
    const selectedScore = selectionTeam === "HOME" ? game.homeScore : game.awayScore;
    const rivalScore = selectionTeam === "HOME" ? game.awayScore : game.homeScore;
    const adjusted = selectedScore + line;
    const result = adjusted === rivalScore ? "PUSH" : adjusted > rivalScore ? "WIN" : "LOSS";
    return {
      result,
      outcomeValue: adjusted - rivalScore,
      notes: `Official run line settlement: selected score ${selectedScore} ${line >= 0 ? "+" : ""}${line} vs rival ${rivalScore}`,
    };
  }

  if (market === "TOTAL") {
    if (!direction || line == null) return null;
    const total = game.homeScore + game.awayScore;
    return {
      result: compare(total, line, direction),
      outcomeValue: total,
      notes: `Official full-game total ${total} vs ${direction} ${line}`,
    };
  }

  if (market === "F5_TOTAL") {
    if (!direction || line == null) return null;
    const f5 = firstN(game, 5);
    if (!f5.complete) return null;
    const total = f5.home + f5.away;
    return {
      result: compare(total, line, direction),
      outcomeValue: total,
      notes: `Official F5 total ${total} vs ${direction} ${line}`,
    };
  }

  if (market === "TEAM_TOTAL" || market === "TT_OVER_15_F5" || market === "TT_UNDER_25_F5") {
    if (!selectionTeam) return null;
    const useF5 = market === "TT_OVER_15_F5" || market === "TT_UNDER_25_F5" || prediction.market.selection.toLowerCase().includes("f5");
    const teamDirection = market === "TT_OVER_15_F5" ? "OVER" : market === "TT_UNDER_25_F5" ? "UNDER" : direction;
    const teamLine = line ?? (market === "TT_OVER_15_F5" ? 1.5 : market === "TT_UNDER_25_F5" ? 2.5 : null);
    if (!teamDirection || teamLine == null) return null;

    let runs: number;
    if (useF5) {
      const f5 = firstN(game, 5);
      if (!f5.complete) return null;
      runs = selectionTeam === "HOME" ? f5.home : f5.away;
    } else {
      runs = selectionTeam === "HOME" ? game.homeScore : game.awayScore;
    }
    return {
      result: compare(runs, teamLine, teamDirection),
      outcomeValue: runs,
      notes: `Official ${useF5 ? "F5 " : ""}team total ${runs} vs ${teamDirection} ${teamLine}`,
    };
  }

  if (market === "INNING_1_ML") {
    if (!selectionTeam) return null;
    const inning = game.innings.find((item) => item.num === 1);
    if (!inning) return null;
    if (inning.home === inning.away) return { result: "PUSH", outcomeValue: 0, notes: `Official inning 1 tie ${inning.away}-${inning.home}` };
    const winner = inning.home > inning.away ? "HOME" : "AWAY";
    return {
      result: winner === selectionTeam ? "WIN" : "LOSS",
      outcomeValue: selectionTeam === "HOME" ? inning.home - inning.away : inning.away - inning.home,
      notes: `Official inning 1 score ${inning.away}-${inning.home}`,
    };
  }

  if (market === "NRFI" || market === "YRFI") {
    const inning = game.innings.find((item) => item.num === 1);
    if (!inning) return null;
    const runs = inning.home + inning.away;
    const won = market === "NRFI" ? runs === 0 : runs > 0;
    return {
      result: won ? "WIN" : "LOSS",
      outcomeValue: runs,
      notes: `Official inning 1 total ${runs}`,
    };
  }

  return null;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { "User-Agent": "CourtEdge-MLB-Ledger/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`MLB API ${response.status}: ${url}`);
  return response.json();
}

function gameFromFeed(gamePk: number, payload: any): OfficialMlbGame | null {
  const status = payload?.gameData?.status;
  const final = status?.abstractGameState === "Final" || status?.codedGameState === "F" || status?.detailedState === "Final";
  if (!final) return null;

  const linescore = payload?.liveData?.linescore;
  const innings = (linescore?.innings ?? []).map((inning: any) => ({
    num: Number(inning.num),
    home: Number(inning.home?.runs ?? 0),
    away: Number(inning.away?.runs ?? 0),
  })).filter((inning: OfficialInning) => Number.isFinite(inning.num));

  const homeScore = Number(linescore?.teams?.home?.runs ?? innings.reduce((sum: number, inning: OfficialInning) => sum + inning.home, 0));
  const awayScore = Number(linescore?.teams?.away?.runs ?? innings.reduce((sum: number, inning: OfficialInning) => sum + inning.away, 0));

  return {
    gamePk,
    gameDate: String(payload?.gameData?.datetime?.officialDate || payload?.gameData?.datetime?.dateTime || "").slice(0, 10),
    final,
    homeTeam: payload?.gameData?.teams?.home?.name || "Home",
    awayTeam: payload?.gameData?.teams?.away?.name || "Away",
    homeScore,
    awayScore,
    innings,
  };
}

async function fetchOfficialGame(gamePk: number): Promise<OfficialMlbGame | null> {
  const payload = await fetchJson(`${MLB_API}/v1.1/game/${gamePk}/feed/live`);
  return gameFromFeed(gamePk, payload);
}

const scheduleCache = new Map<string, Promise<any[]>>();

async function gamesForDate(date: string): Promise<any[]> {
  let promise = scheduleCache.get(date);
  if (!promise) {
    promise = fetchJson(`${MLB_API}/v1/schedule?sportId=1&date=${encodeURIComponent(date)}`)
      .then((payload) => (payload?.dates ?? []).flatMap((entry: any) => entry.games ?? []));
    scheduleCache.set(date, promise);
  }
  return promise;
}

async function resolveGamePk(prediction: LedgerPrediction): Promise<number | null> {
  if (prediction.game.gamePk) return prediction.game.gamePk;
  const games = await gamesForDate(prediction.game.gameDate);
  const expectedHome = normalize(prediction.game.homeTeam);
  const expectedAway = normalize(prediction.game.awayTeam);
  const aliases = (value: string) => value.replace(/^oakland/, "").replace(/^athletics/, "");

  const matched = games.find((game: any) => {
    const home = normalize(game?.teams?.home?.team?.name || "");
    const away = normalize(game?.teams?.away?.team?.name || "");
    return (home === expectedHome || aliases(home) === aliases(expectedHome)) &&
      (away === expectedAway || aliases(away) === aliases(expectedAway));
  });
  return Number(matched?.gamePk) || null;
}

export async function runMlbAutoSettlement(store: MlbLedgerStore): Promise<SettlementRunResult> {
  scheduleCache.clear();
  const pending = store.listRecords({ settled: false, limit: 10_000 });
  const result: SettlementRunResult = {
    checked: pending.length,
    settled: 0,
    pendingFinal: 0,
    unsupported: 0,
    unresolvedGame: 0,
    errors: [],
  };

  for (const record of pending) {
    try {
      const gamePk = await resolveGamePk(record.prediction);
      if (!gamePk) {
        result.unresolvedGame++;
        continue;
      }
      const game = await fetchOfficialGame(gamePk);
      if (!game) {
        result.pendingFinal++;
        continue;
      }
      const graded = gradeMlbPrediction(record.prediction, game);
      if (!graded) {
        result.unsupported++;
        continue;
      }

      store.appendSettlement(record.prediction.id, {
        clientRequestId: `auto-settle:${record.prediction.id}:official-v1`,
        result: graded.result,
        outcomeValue: graded.outcomeValue,
        finalScore: { home: game.homeScore, away: game.awayScore },
        source: "official",
        notes: `${graded.notes} · MLB gamePk ${game.gamePk}`,
      });
      result.settled++;
    } catch (error) {
      result.errors.push({
        predictionId: record.prediction.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

let workerStarted = false;
let workerRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;
let startHandle: NodeJS.Timeout | null = null;

export function startMlbSettlementWorker(store: MlbLedgerStore): void {
  if (workerStarted || process.env.MLB_LEDGER_AUTO_SETTLE === "false") return;
  workerStarted = true;
  const intervalMsRaw = Number(process.env.MLB_LEDGER_SETTLEMENT_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(intervalMsRaw) && intervalMsRaw >= 60_000 ? intervalMsRaw : DEFAULT_INTERVAL_MS;

  const run = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const summary = await runMlbAutoSettlement(store);
      if (summary.checked > 0 || summary.errors.length > 0) {
        console.log(`[mlb-ledger] settlement worker ${JSON.stringify(summary)}`);
      }
    } catch (error) {
      console.error("[mlb-ledger] settlement worker failed", error);
    } finally {
      workerRunning = false;
    }
  };

  startHandle = setTimeout(() => void run(), START_DELAY_MS);
  startHandle.unref();
  intervalHandle = setInterval(() => void run(), intervalMs);
  intervalHandle.unref();
}

export function stopMlbSettlementWorkerForTests(): void {
  if (startHandle) clearTimeout(startHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startHandle = null;
  intervalHandle = null;
  workerStarted = false;
  workerRunning = false;
}

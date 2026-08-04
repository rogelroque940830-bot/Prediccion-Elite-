import path from "node:path";
import { getMlbClosingLineStore, getMlbLedgerStore } from "./mlb-ledger";
import {
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import type { LedgerPrediction } from "./mlb-ledger-store";
import { activeMlbLedgerRecords } from "./mlb-active-records";
import {
  OperationalReprocessingService,
} from "./operational-reprocessing";
import { createActiveOperationalIncidentCenterProvider } from "./operational-incident-center-active";
import type { OfficialMlbGame } from "./mlb-settlement-worker";

const MLB_API = "https://statsapi.mlb.com/api";

function normalize(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function teamAlias(value: string): string {
  return value
    .replace(/^oakland/, "")
    .replace(/^athletics/, "")
    .replace(/^theathletics/, "");
}

function sameTeam(left: string, right: string): boolean {
  return left === right || teamAlias(left) === teamAlias(right);
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "CourtEdge-O3-Active-Reprocessing/1.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`MLB API ${response.status}: ${url}`);
  return response.json();
}

function gameFromFeed(gamePk: number, payload: any): OfficialMlbGame | null {
  const status = payload?.gameData?.status;
  const final =
    status?.abstractGameState === "Final"
    || status?.codedGameState === "F"
    || status?.detailedState === "Final";
  if (!final) return null;

  const linescore = payload?.liveData?.linescore;
  const innings = (linescore?.innings ?? [])
    .map((inning: any) => ({
      num: Number(inning.num),
      home: Number(inning.home?.runs ?? 0),
      away: Number(inning.away?.runs ?? 0),
    }))
    .filter((inning: { num: number }) => Number.isFinite(inning.num));
  const homeScore = Number(
    linescore?.teams?.home?.runs
      ?? innings.reduce((sum: number, inning: { home: number }) => sum + inning.home, 0),
  );
  const awayScore = Number(
    linescore?.teams?.away?.runs
      ?? innings.reduce((sum: number, inning: { away: number }) => sum + inning.away, 0),
  );

  return {
    gamePk,
    gameDate: String(
      payload?.gameData?.datetime?.officialDate
        || payload?.gameData?.datetime?.dateTime
        || "",
    ).slice(0, 10),
    final,
    homeTeam: payload?.gameData?.teams?.home?.name || "Home",
    awayTeam: payload?.gameData?.teams?.away?.name || "Away",
    homeScore,
    awayScore,
    innings,
  };
}

async function officialGameForPrediction(
  prediction: LedgerPrediction,
): Promise<OfficialMlbGame | null> {
  let gamePk = prediction.game.gamePk;
  if (!gamePk) {
    const payload = await fetchJson(
      `${MLB_API}/v1/schedule?sportId=1&date=${encodeURIComponent(prediction.game.gameDate)}`,
    );
    const games = (payload?.dates ?? []).flatMap((entry: any) => entry.games ?? []);
    const expectedHome = normalize(prediction.game.homeTeam);
    const expectedAway = normalize(prediction.game.awayTeam);
    const candidates = games.filter((game: any) => {
      const officialHome = normalize(game?.teams?.home?.team?.name || "");
      const officialAway = normalize(game?.teams?.away?.team?.name || "");
      return sameTeam(officialHome, expectedHome) && sameTeam(officialAway, expectedAway);
    });
    if (candidates.length === 1) {
      gamePk = Number(candidates[0]?.gamePk) || null;
    } else if (candidates.length > 1 && prediction.game.commenceTime) {
      const expectedStart = Date.parse(prediction.game.commenceTime);
      const ranked = candidates
        .map((game: any) => ({
          gamePk: Number(game?.gamePk) || 0,
          distance: Math.abs(Date.parse(game?.gameDate || "") - expectedStart),
        }))
        .filter((entry: { gamePk: number; distance: number }) => entry.gamePk > 0 && Number.isFinite(entry.distance))
        .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance);
      if (ranked.length && !(ranked.length > 1 && ranked[0].distance === ranked[1].distance)) {
        gamePk = ranked[0].gamePk;
      }
    }
  }
  if (!gamePk) return null;
  return gameFromFeed(gamePk, await fetchJson(`${MLB_API}/v1.1/game/${gamePk}/feed/live`));
}

export function createActiveOperationalReprocessingService(
  systemOwnerUserId: number,
  dataRoot: string,
): OperationalReprocessingService {
  const ledger = getMlbLedgerStore();
  const ownership = getMlbLedgerOwnershipStore();
  const closing = getMlbClosingLineStore();
  return new OperationalReprocessingService({
    rootDir: path.join(dataRoot, "operational-reprocessing-v1"),
    incidentProvider: createActiveOperationalIncidentCenterProvider(systemOwnerUserId),
    recordsProvider: (ownerUserId) => activeMlbLedgerRecords(ownedRecordsForUser(
      ledger,
      ownership,
      ownerUserId,
      { limit: 10_000 },
    )),
    officialGameProvider: officialGameForPrediction,
    appendSettlement: (predictionId, input) => ledger.appendSettlement(predictionId, input),
    latestSettlement: (predictionId) => ledger.latestSettlement(predictionId),
    closingProvider: (predictionId, commenceTime) => {
      const observation = closing.latestBeforeCommence(predictionId, commenceTime);
      return observation
        ? {
            oddsAmerican: observation.oddsAmerican,
            line: observation.line,
            matchMode: observation.matchMode,
            comparable: observation.comparable,
          }
        : null;
    },
  });
}

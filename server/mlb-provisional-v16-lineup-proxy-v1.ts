import {
  buildC4LiveFeatures,
  type C4LiveFeatureAssessment,
  type C4PriorLineupSnapshot,
  type C4PriorTeamGame,
} from "./mlb-c4-live-feature-builder";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import type { MlbFull13PriorPitcherLine } from "./mlb-full13-live-feature-builder";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";
import type { MlbV16SettlementEvidence } from "./mlb-pure-settlement-evidence-adapter";

export const MLB_PROVISIONAL_V16_LINEUP_PROXY_SCHEMA =
  "courtedge-mlb-provisional-v16-lineup-proxy.v1" as const;
export const MLB_PROVISIONAL_V16_LINEUP_PROXY_METHOD =
  "LAST_VALID_PRIOR_OFFICIAL_DATE_LINEUP" as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface HistoricalSnapshotLike {
  season: number;
  cutoffDate: string;
  teamHistoryByTeam: Map<number, C4PriorTeamGame[]>;
  lineupHistoryByTeam: Map<number, C4PriorLineupSnapshot[]>;
  starterHistoryByPitcher: Map<number, MlbFull13PriorPitcherLine[]>;
  leagueStarterHistory: MlbFull13PriorPitcherLine[];
}

export interface MlbProvisionalV16HistoricalSnapshotSource {
  getHistoricalSnapshot(season: number, cutoffDate: string): Promise<HistoricalSnapshotLike>;
}

export interface MlbProvisionalV16LineupProxyResult {
  schemaVersion: typeof MLB_PROVISIONAL_V16_LINEUP_PROXY_SCHEMA;
  gamePk: number;
  officialDate: string;
  generatedAt: string;
  projection: {
    method: typeof MLB_PROVISIONAL_V16_LINEUP_PROXY_METHOD;
    homeSourceGamePk: number;
    homeSourceOfficialDate: string;
    awaySourceGamePk: number;
    awaySourceOfficialDate: string;
    homeProjectedBattingOrder: readonly number[];
    awayProjectedBattingOrder: readonly number[];
  };
  c4Assessment: C4LiveFeatureAssessment;
  v16Evidence: MlbV16SettlementEvidence;
  policy: {
    currentGameOfficialLineupRead: false;
    thirdPartyProjectionClaimed: false;
    strictlyPriorOfficialDateLineupOnly: true;
    sameDateHistoryAllowed: false;
    futureLineupAllowed: false;
    outcomesRead: false;
    marketPricesRead: false;
    modelRefit: false;
    recalibration: false;
    v68Changed: false;
    v80Changed: false;
    productionDailyBestPickChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export interface MlbProvisionalV16LineupProxyDependencies {
  snapshotSource?: MlbProvisionalV16HistoricalSnapshotSource;
  certifiedMaterializer?: MlbC4CertifiedMaterializer;
  fetchImpl?: FetchLike;
  generatedAt?: string;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function latestPriorLineup(rows: readonly C4PriorLineupSnapshot[], cutoffDate: string): C4PriorLineupSnapshot | null {
  const eligible = rows.filter((row) => row.officialDate < cutoffDate && row.battingOrder.length === 9);
  eligible.sort((a, b) =>
    a.officialDate === b.officialDate ? a.gamePk - b.gamePk : a.officialDate.localeCompare(b.officialDate),
  );
  const latest = eligible[eligible.length - 1];
  if (!latest || new Set(latest.battingOrder).size !== 9) return null;
  return latest;
}

function snapshotSourceFromCertifiedMaterializer(
  materializer: MlbC4CertifiedMaterializer,
): MlbProvisionalV16HistoricalSnapshotSource {
  // The certified materializer already owns the exact prior-date historical state used
  // by FINAL C4/FULL13. Until that state accessor is promoted to a public API, this
  // adapter uses the existing runtime method fail-closed rather than rebuilding a second
  // season history with subtly different semantics.
  const runtime = materializer as unknown as {
    getHistoricalSnapshot?: (season: number, cutoffDate: string) => Promise<HistoricalSnapshotLike>;
  };
  if (typeof runtime.getHistoricalSnapshot !== "function") {
    throw new Error("MLB_PROVISIONAL_V16_CERTIFIED_HISTORY_BRIDGE_UNAVAILABLE");
  }
  return {
    getHistoricalSnapshot: (season, cutoffDate) => runtime.getHistoricalSnapshot!(season, cutoffDate),
  };
}

async function fetchJson(fetchImpl: FetchLike, url: string, label: string): Promise<any> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${label}:HTTP_${response.status}`);
  return response.json();
}

function assertCurrentIdentity(feed: any, game: MlbP1SlateGame): void {
  const feedPk = positiveInt(feed?.gamePk ?? feed?.gameData?.game?.pk);
  const feedDate = clean(feed?.gameData?.datetime?.officialDate);
  const feedHome = positiveInt(feed?.gameData?.teams?.home?.id);
  const feedAway = positiveInt(feed?.gameData?.teams?.away?.id);
  const feedHomeStarter = positiveInt(feed?.gameData?.probablePitchers?.home?.id);
  const feedAwayStarter = positiveInt(feed?.gameData?.probablePitchers?.away?.id);
  if (
    feedPk !== game.gamePk
    || feedDate !== game.officialDate
    || feedHome !== positiveInt(game.homeTeam.id)
    || feedAway !== positiveInt(game.awayTeam.id)
    || feedHomeStarter !== positiveInt(game.homePitcher.id)
    || feedAwayStarter !== positiveInt(game.awayPitcher.id)
  ) {
    throw new Error(`MLB_PROVISIONAL_V16_CURRENT_IDENTITY_MISMATCH:${game.gamePk}`);
  }
}

export async function assessMlbProvisionalV16LineupProxy(
  game: MlbP1SlateGame,
  deps: MlbProvisionalV16LineupProxyDependencies = {},
): Promise<MlbProvisionalV16LineupProxyResult> {
  if (!positiveInt(game.gamePk)) throw new Error("MLB_PROVISIONAL_V16_GAME_PK_INVALID");
  if (!validIsoDate(game.officialDate)) throw new Error(`MLB_PROVISIONAL_V16_DATE_INVALID:${game.officialDate}`);
  if (game.analysisStage !== "PROVISIONAL") {
    throw new Error(`MLB_PROVISIONAL_V16_STAGE_REQUIRED:${game.gamePk}:${game.analysisStage}`);
  }
  if (game.lineupState === "CONFIRMED") {
    throw new Error(`MLB_PROVISIONAL_V16_CONFIRMED_LINEUP_FORBIDDEN:${game.gamePk}`);
  }

  const homeTeamId = positiveInt(game.homeTeam.id);
  const awayTeamId = positiveInt(game.awayTeam.id);
  const homeStarterId = positiveInt(game.homePitcher.id);
  const awayStarterId = positiveInt(game.awayPitcher.id);
  if (!homeTeamId || !awayTeamId) throw new Error(`MLB_PROVISIONAL_V16_TEAM_ID_MISSING:${game.gamePk}`);
  if (!homeStarterId || !awayStarterId) throw new Error(`MLB_PROVISIONAL_V16_STARTER_MISSING:${game.gamePk}`);

  const materializer = deps.certifiedMaterializer ?? new MlbC4CertifiedMaterializer();
  const snapshotSource = deps.snapshotSource ?? snapshotSourceFromCertifiedMaterializer(materializer);
  const snapshot = await snapshotSource.getHistoricalSnapshot(Number(game.officialDate.slice(0, 4)), game.officialDate);
  if (snapshot.season !== Number(game.officialDate.slice(0, 4)) || snapshot.cutoffDate !== game.officialDate) {
    throw new Error(`MLB_PROVISIONAL_V16_HISTORY_BOUNDARY_MISMATCH:${game.gamePk}`);
  }

  const homeTeamHistory = snapshot.teamHistoryByTeam.get(homeTeamId) ?? [];
  const awayTeamHistory = snapshot.teamHistoryByTeam.get(awayTeamId) ?? [];
  const homePriorLineups = snapshot.lineupHistoryByTeam.get(homeTeamId) ?? [];
  const awayPriorLineups = snapshot.lineupHistoryByTeam.get(awayTeamId) ?? [];
  if (homePriorLineups.length !== homeTeamHistory.length) {
    throw new Error(`MLB_PROVISIONAL_V16_HOME_LINEUP_HISTORY_INCOMPLETE:${game.gamePk}`);
  }
  if (awayPriorLineups.length !== awayTeamHistory.length) {
    throw new Error(`MLB_PROVISIONAL_V16_AWAY_LINEUP_HISTORY_INCOMPLETE:${game.gamePk}`);
  }

  const homeProjection = latestPriorLineup(homePriorLineups, game.officialDate);
  const awayProjection = latestPriorLineup(awayPriorLineups, game.officialDate);
  if (!homeProjection || !awayProjection) {
    throw new Error(`MLB_PROVISIONAL_V16_PRIOR_LINEUP_UNAVAILABLE:${game.gamePk}`);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const currentFeed = await fetchJson(
    fetchImpl,
    `https://statsapi.mlb.com/api/v1.1/game/${game.gamePk}/feed/live`,
    `MLB provisional V16 game ${game.gamePk}`,
  );
  assertCurrentIdentity(currentFeed, game);

  const c4Assessment = buildC4LiveFeatures({
    officialDate: game.officialDate,
    gamePk: game.gamePk,
    homeTeamId,
    awayTeamId,
    homeTeamHistory,
    awayTeamHistory,
    leagueStarterHistory: snapshot.leagueStarterHistory,
    homeStarterHistory: snapshot.starterHistoryByPitcher.get(homeStarterId) ?? [],
    awayStarterHistory: snapshot.starterHistoryByPitcher.get(awayStarterId) ?? [],
    homeStarterId,
    awayStarterId,
    homePriorLineups,
    awayPriorLineups,
    homeBattingOrder: [...homeProjection.battingOrder],
    awayBattingOrder: [...awayProjection.battingOrder],
  });
  if (Object.values(c4Assessment.featureVector).some((value) => value === null || !Number.isFinite(value))) {
    throw new Error(`MLB_PROVISIONAL_V16_FEATURE_VECTOR_INCOMPLETE:${game.gamePk}`);
  }

  const generatedAt = deps.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("MLB_PROVISIONAL_V16_GENERATED_AT_INVALID");
  const v16Evidence = scoreMlbV16SettlementEvidence(game.gamePk, generatedAt, c4Assessment);

  return Object.freeze({
    schemaVersion: MLB_PROVISIONAL_V16_LINEUP_PROXY_SCHEMA,
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    generatedAt,
    projection: Object.freeze({
      method: MLB_PROVISIONAL_V16_LINEUP_PROXY_METHOD,
      homeSourceGamePk: homeProjection.gamePk,
      homeSourceOfficialDate: homeProjection.officialDate,
      awaySourceGamePk: awayProjection.gamePk,
      awaySourceOfficialDate: awayProjection.officialDate,
      homeProjectedBattingOrder: Object.freeze([...homeProjection.battingOrder]),
      awayProjectedBattingOrder: Object.freeze([...awayProjection.battingOrder]),
    }),
    c4Assessment,
    v16Evidence,
    policy: Object.freeze({
      currentGameOfficialLineupRead: false as const,
      thirdPartyProjectionClaimed: false as const,
      strictlyPriorOfficialDateLineupOnly: true as const,
      sameDateHistoryAllowed: false as const,
      futureLineupAllowed: false as const,
      outcomesRead: false as const,
      marketPricesRead: false as const,
      modelRefit: false as const,
      recalibration: false as const,
      v68Changed: false as const,
      v80Changed: false as const,
      productionDailyBestPickChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}

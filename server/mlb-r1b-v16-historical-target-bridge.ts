import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";
import {
  adaptCertifiedFinalC4ToR1bV16Baseline,
  type MlbR1bV16BaselineRow,
} from "./mlb-r1b-v16-final-baseline-adapter";

export const MLB_R1B_V16_HISTORICAL_TARGET_BRIDGE_SCHEMA =
  "courtedge-mlb-r1b-v16-historical-target-bridge.v1" as const;

const STEP12M_LINEUP_SCHEMA = "courtedge-p0-step12m-cohort-pregame-lineups.v1" as const;
const V60_STARTER_SCHEMA = "courtedge-p0-step12v60-pregame-starter-hands.v1" as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MlbR1bV16FrozenLineupSnapshot {
  sourceVersion: string;
  gamePk: number;
  officialDate: string;
  scheduledStart: string | null;
  requestedTimecode: string;
  sourceMetadataTimecode: string;
  homeTeamId: number;
  awayTeamId: number;
  availability: string;
  complete: boolean;
  homeBattingOrder: readonly number[];
  awayBattingOrder: readonly number[];
  sourceDigest: string;
}

export interface MlbR1bV16FrozenStarterSnapshot {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homePitcherId: number;
  awayPitcherId: number;
  requestedTimecode: string;
  sourceMetadataTimecode: string;
  usable: boolean;
  reason: string | null;
  sourceDigest: string;
}

export interface MlbR1bV16HistoricalTargetInput {
  lineupArtifactSchema: typeof STEP12M_LINEUP_SCHEMA;
  lineupArtifactSha256: string;
  starterArtifactSchema: typeof V60_STARTER_SCHEMA;
  starterArtifactSha256: string;
  lineup: MlbR1bV16FrozenLineupSnapshot;
  starter: MlbR1bV16FrozenStarterSnapshot;
}

export interface MlbR1bV16HistoricalTargetResult {
  schemaVersion: typeof MLB_R1B_V16_HISTORICAL_TARGET_BRIDGE_SCHEMA;
  assessment: C4LiveFeatureAssessment;
  rows: readonly MlbR1bV16BaselineRow[];
  provenance: {
    lineupArtifactSchema: typeof STEP12M_LINEUP_SCHEMA;
    lineupArtifactSha256: string;
    starterArtifactSchema: typeof V60_STARTER_SCHEMA;
    starterArtifactSha256: string;
    requestedTimecode: string;
    generatedAt: string;
    targetFeedSource: "FROZEN_SYNTHETIC_IDENTITY_ONLY";
    externalTargetFeedRead: false;
    outcomeFieldsRead: false;
    marketPricesRead: false;
  };
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function positiveInt(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function validTimecode(value: string): boolean {
  return /^\d{8}_\d{6}$/.test(value);
}

function timecodeToIso(value: string): string {
  if (!validTimecode(value)) throw new Error("MLB_R1B_V16_HISTORICAL_TIMECODE_INVALID");
  const compact = value.replace("_", "");
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}.000Z`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error("MLB_R1B_V16_HISTORICAL_TIMECODE_INVALID");
  return iso;
}

function validateOrder(label: "HOME" | "AWAY", order: readonly number[]): void {
  if (!Array.isArray(order) || order.length !== 9) {
    throw new Error(`MLB_R1B_V16_HISTORICAL_${label}_LINEUP_INCOMPLETE`);
  }
  if (!order.every(positiveInt) || new Set(order).size !== 9) {
    throw new Error(`MLB_R1B_V16_HISTORICAL_${label}_LINEUP_INVALID`);
  }
}

function validateFrozenTarget(input: MlbR1bV16HistoricalTargetInput): void {
  if (input.lineupArtifactSchema !== STEP12M_LINEUP_SCHEMA) {
    throw new Error("MLB_R1B_V16_HISTORICAL_LINEUP_SCHEMA_INVALID");
  }
  if (input.starterArtifactSchema !== V60_STARTER_SCHEMA) {
    throw new Error("MLB_R1B_V16_HISTORICAL_STARTER_SCHEMA_INVALID");
  }
  if (!validSha256(input.lineupArtifactSha256) || !validSha256(input.starterArtifactSha256)) {
    throw new Error("MLB_R1B_V16_HISTORICAL_ARTIFACT_DIGEST_INVALID");
  }

  const { lineup, starter } = input;
  if (!validIsoDate(lineup.officialDate) || !validIsoDate(starter.officialDate)) {
    throw new Error("MLB_R1B_V16_HISTORICAL_OFFICIAL_DATE_INVALID");
  }
  if (!positiveInt(lineup.gamePk) || !positiveInt(starter.gamePk)) {
    throw new Error("MLB_R1B_V16_HISTORICAL_GAME_PK_INVALID");
  }
  if (!positiveInt(lineup.homeTeamId) || !positiveInt(lineup.awayTeamId)
      || !positiveInt(starter.homeTeamId) || !positiveInt(starter.awayTeamId)
      || lineup.homeTeamId === lineup.awayTeamId || starter.homeTeamId === starter.awayTeamId) {
    throw new Error("MLB_R1B_V16_HISTORICAL_TEAM_ID_INVALID");
  }
  if (!positiveInt(starter.homePitcherId) || !positiveInt(starter.awayPitcherId)) {
    throw new Error("MLB_R1B_V16_HISTORICAL_STARTER_ID_INVALID");
  }
  if (lineup.complete !== true || lineup.availability !== "COMPLETE") {
    throw new Error("MLB_R1B_V16_HISTORICAL_LINEUP_NOT_COMPLETE");
  }
  if (starter.usable !== true || starter.reason !== null) {
    throw new Error("MLB_R1B_V16_HISTORICAL_STARTER_NOT_USABLE");
  }
  if (!validTimecode(lineup.requestedTimecode) || !validTimecode(starter.requestedTimecode)
      || !validTimecode(lineup.sourceMetadataTimecode) || !validTimecode(starter.sourceMetadataTimecode)) {
    throw new Error("MLB_R1B_V16_HISTORICAL_TIMECODE_INVALID");
  }
  if (lineup.sourceMetadataTimecode > lineup.requestedTimecode
      || starter.sourceMetadataTimecode > starter.requestedTimecode) {
    throw new Error("MLB_R1B_V16_HISTORICAL_SOURCE_AFTER_REQUESTED_TIMECODE");
  }
  if (!lineup.sourceVersion.trim() || !validSha256(lineup.sourceDigest) || !validSha256(starter.sourceDigest)) {
    throw new Error("MLB_R1B_V16_HISTORICAL_SOURCE_PROVENANCE_INVALID");
  }

  const identitiesMatch = lineup.gamePk === starter.gamePk
    && lineup.officialDate === starter.officialDate
    && lineup.homeTeamId === starter.homeTeamId
    && lineup.awayTeamId === starter.awayTeamId
    && lineup.requestedTimecode === starter.requestedTimecode;
  if (!identitiesMatch) throw new Error("MLB_R1B_V16_HISTORICAL_FROZEN_IDENTITY_MISMATCH");

  validateOrder("HOME", lineup.homeBattingOrder);
  validateOrder("AWAY", lineup.awayBattingOrder);
  if (new Set([...lineup.homeBattingOrder, ...lineup.awayBattingOrder]).size !== 18) {
    throw new Error("MLB_R1B_V16_HISTORICAL_CROSS_TEAM_LINEUP_COLLISION");
  }
  if (lineup.scheduledStart !== null && !Number.isFinite(Date.parse(lineup.scheduledStart))) {
    throw new Error("MLB_R1B_V16_HISTORICAL_SCHEDULED_START_INVALID");
  }
}

function frozenTargetFeed(input: MlbR1bV16HistoricalTargetInput): unknown {
  const { lineup, starter } = input;
  return {
    gamePk: lineup.gamePk,
    gameData: {
      game: { pk: lineup.gamePk },
      datetime: { officialDate: lineup.officialDate },
      status: { abstractGameState: "Preview", detailedState: "Pre-Game" },
      teams: {
        home: { id: lineup.homeTeamId },
        away: { id: lineup.awayTeamId },
      },
      probablePitchers: {
        home: { id: starter.homePitcherId },
        away: { id: starter.awayPitcherId },
      },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: [...lineup.homeBattingOrder] },
          away: { battingOrder: [...lineup.awayBattingOrder] },
        },
      },
    },
  };
}

function frozenSlateGame(input: MlbR1bV16HistoricalTargetInput, generatedAt: string): MlbP1SlateGame {
  const { lineup, starter } = input;
  return {
    gamePk: lineup.gamePk,
    startTime: lineup.scheduledStart,
    officialDate: lineup.officialDate,
    venue: null,
    state: "PREGAME",
    detailedState: "Frozen T-minus-5 pregame snapshot",
    homeTeam: { id: lineup.homeTeamId, name: `FROZEN_HOME_${lineup.homeTeamId}` },
    awayTeam: { id: lineup.awayTeamId, name: `FROZEN_AWAY_${lineup.awayTeamId}` },
    homePitcher: { id: starter.homePitcherId, name: `FROZEN_SP_${starter.homePitcherId}`, hand: null, confirmed: true },
    awayPitcher: { id: starter.awayPitcherId, name: `FROZEN_SP_${starter.awayPitcherId}`, hand: null, confirmed: true },
    lineupState: "CONFIRMED",
    homeLineupCount: 9,
    awayLineupCount: 9,
    readiness: "READY_TO_ANALYZE",
    analysisStage: "FINAL",
    analysisAllowed: true,
    blockers: [],
    source: {
      name: "MLB_STATS_API",
      fetchedAt: generatedAt,
      quality: "AUTHORITATIVE",
    },
  };
}

export async function materializeR1bV16HistoricalTarget(options: {
  frozen: MlbR1bV16HistoricalTargetInput;
  fetchImpl: FetchLike;
  apiBaseUrl?: string;
  maxConcurrency?: number;
  timeoutMs?: number;
}): Promise<MlbR1bV16HistoricalTargetResult> {
  validateFrozenTarget(options.frozen);
  const apiBaseUrl = String(options.apiBaseUrl ?? "https://statsapi.mlb.com/api").replace(/\/$/, "");
  if (!/^https?:\/\//.test(apiBaseUrl)) throw new Error("MLB_R1B_V16_HISTORICAL_API_BASE_INVALID");

  const gamePk = options.frozen.lineup.gamePk;
  const targetPath = `/v1.1/game/${gamePk}/feed/live`;
  const targetFeed = frozenTargetFeed(options.frozen);
  const guardedFetch: FetchLike = async (input, init) => {
    const parsed = new URL(input);
    if (parsed.pathname.endsWith(targetPath)) {
      if (parsed.search) throw new Error("MLB_R1B_V16_HISTORICAL_TARGET_QUERY_UNEXPECTED");
      return new Response(JSON.stringify(targetFeed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return options.fetchImpl(input, init);
  };

  const generatedAt = timecodeToIso(options.frozen.lineup.requestedTimecode);
  const materializer = new MlbC4CertifiedMaterializer({
    fetchImpl: guardedFetch,
    apiBaseUrl,
    maxConcurrency: options.maxConcurrency,
    timeoutMs: options.timeoutMs,
  });
  const assessment = await materializer.assessGame(frozenSlateGame(options.frozen, generatedAt));
  const rows = adaptCertifiedFinalC4ToR1bV16Baseline({
    officialDate: options.frozen.lineup.officialDate,
    gamePk,
    generatedAt,
    inputStage: "FINAL",
    c4: assessment,
  });

  return Object.freeze({
    schemaVersion: MLB_R1B_V16_HISTORICAL_TARGET_BRIDGE_SCHEMA,
    assessment,
    rows,
    provenance: Object.freeze({
      lineupArtifactSchema: options.frozen.lineupArtifactSchema,
      lineupArtifactSha256: options.frozen.lineupArtifactSha256.toLowerCase(),
      starterArtifactSchema: options.frozen.starterArtifactSchema,
      starterArtifactSha256: options.frozen.starterArtifactSha256.toLowerCase(),
      requestedTimecode: options.frozen.lineup.requestedTimecode,
      generatedAt,
      targetFeedSource: "FROZEN_SYNTHETIC_IDENTITY_ONLY" as const,
      externalTargetFeedRead: false as const,
      outcomeFieldsRead: false as const,
      marketPricesRead: false as const,
    }),
  });
}

export const MLB_R1B_V16_HISTORICAL_TARGET_BRIDGE_POLICY = Object.freeze({
  frozenLineupSchema: STEP12M_LINEUP_SCHEMA,
  frozenStarterSchema: V60_STARTER_SCHEMA,
  targetFeedFromFrozenIdentityOnly: true as const,
  externalTargetFeedRead: false as const,
  exactNinePlayerOrdersRequired: true as const,
  exactFrozenStarterIdentityRequired: true as const,
  sourceMetadataAtOrBeforeRequestedTimecode: true as const,
  priorOfficialDateHistoryOnly: true as const,
  outcomeFieldsRead: false as const,
  marketPricesRead: false as const,
  modelRefit: false as const,
  newWeightsCreated: false as const,
  thresholdSearch: false as const,
  productionChanged: false as const,
});

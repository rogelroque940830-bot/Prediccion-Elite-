import type { MlbFull13LivePregameInput } from "./mlb-full13-live-feature-builder";
import type {
  FrozenV39LiveSideInput,
  FullModularLiveOperationalInput,
} from "./mlb-full-modular-live-operational-bridge";
import type {
  FrozenV39FeatureName,
  PitchQualityHistoryGame,
  PitcherPitchTypeTotals,
} from "./mlb-full-modular-mechanistic-feature-builder";

export const MLB_V68_PROSPECTIVE_STATE_LIVE_ADAPTER_VERSION =
  "mlb-v68-prospective-state-live-adapter-v1" as const;
export const MLB_V68_PROSPECTIVE_STATE_SCHEMA =
  "courtedge-p0-step12v68-prospective-state.v1" as const;

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_STATE_BRANCH = "data/p0-step12v68-prospective";
const DEFAULT_REPOSITORY = "rogelroque940830-bot/Prediccion-Elite-";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface V39Aggregate {
  starts?: number;
  bf?: number;
  outs?: number;
  pitches?: number;
  k?: number;
  bb?: number;
  er?: number;
  recent?: Array<{ outs?: number; pitches?: number }>;
}

interface V68ProspectiveState {
  schemaVersion: string;
  targetOfficialDate: string;
  stateDigest: string;
  chronology: {
    historyStrictlyBeforeTargetDate?: boolean;
    wholeOfficialDatePriorStateOnly?: boolean;
    sameDateOutcomesUsed?: boolean;
    latestHistoricalOfficialDate?: string | null;
  };
  c4: {
    teams: Record<string, {
      games?: number;
      recent?: Array<[number, number]>;
    }>;
  };
  v39: {
    pitchers: Record<string, V39Aggregate>;
    league: V39Aggregate;
    opponents: Record<string, { games?: number; outs?: number }>;
    previousCompleteLineup: Record<string, number[]>;
  };
  v62: {
    pitchers: Record<string, Record<string, Record<string, number>>>;
    leagueByPitchType: Record<string, Record<string, number>>;
    lookbackDays?: number;
    pitchGamesInWindow?: number;
  };
  policy: {
    researchOnly?: boolean;
    containsTargetOutcomes?: boolean;
    containsMarketPrices?: boolean;
    productionChanged?: boolean;
    betEliteAllowed?: boolean;
    realFinancialExposure?: number;
  };
}

export interface MlbV68ProspectiveStateLiveAdapterOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  repository?: string;
  branch?: string;
}

export interface MlbV68FullModularStateEvidence {
  adapterVersion: typeof MLB_V68_PROSPECTIVE_STATE_LIVE_ADAPTER_VERSION;
  stateDigest: string;
  stateAsOfDate: string;
  v39: FullModularLiveOperationalInput["v39"];
  pitchQualityHistory: PitchQualityHistoryGame[];
  provenance: {
    source: "IMMUTABLE_V68_DAILY_STATE_BRANCH";
    targetOfficialDate: string;
    sameDateOutcomesUsed: false;
    marketPricesUsed: false;
    wholeOfficialDatePriorStateOnly: true;
    v39RuntimeFitUsed: false;
    v62RuntimeFitUsed: false;
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrZero(value: unknown): number {
  return finite(value) ? value : 0;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function assertStateShape(raw: unknown, targetDate: string): V68ProspectiveState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("V68_LIVE_STATE_SHAPE_INVALID");
  }
  const state = raw as V68ProspectiveState;
  if (state.schemaVersion !== MLB_V68_PROSPECTIVE_STATE_SCHEMA) {
    throw new Error(`V68_LIVE_STATE_SCHEMA_INVALID:${state.schemaVersion}`);
  }
  if (state.targetOfficialDate !== targetDate) {
    throw new Error(`V68_LIVE_STATE_DATE_MISMATCH:${state.targetOfficialDate}:${targetDate}`);
  }
  if (!validDigest(state.stateDigest)) throw new Error("V68_LIVE_STATE_DIGEST_MISSING");
  const asOf = state.chronology?.latestHistoricalOfficialDate;
  if (!validIsoDate(asOf) || asOf >= targetDate) {
    throw new Error(`V68_LIVE_STATE_ASOF_INVALID:${String(asOf)}`);
  }
  if (
    state.chronology?.historyStrictlyBeforeTargetDate !== true
    || state.chronology?.wholeOfficialDatePriorStateOnly !== true
    || state.chronology?.sameDateOutcomesUsed !== false
  ) {
    throw new Error("V68_LIVE_STATE_CHRONOLOGY_INVALID");
  }
  if (
    state.policy?.containsTargetOutcomes !== false
    || state.policy?.containsMarketPrices !== false
    || state.policy?.realFinancialExposure !== 0
  ) {
    throw new Error("V68_LIVE_STATE_POLICY_INVALID");
  }
  if (!state.c4?.teams || !state.v39?.pitchers || !state.v39?.league || !state.v62?.pitchers) {
    throw new Error("V68_LIVE_STATE_REQUIRED_SECTION_MISSING");
  }
  if (Number(state.v62.lookbackDays) !== 365) throw new Error("V68_LIVE_STATE_V62_LOOKBACK_DRIFT");
  return state;
}

function shrunkMean(total: number, n: number, anchor: number, weight: number): number {
  return (total + weight * anchor) / (n + weight);
}

function shrunkRate(numerator: number, denominator: number, anchor: number, weight: number): number {
  return (numerator + weight * anchor) / (denominator + weight);
}

function teamRs10(state: V68ProspectiveState, teamId: number): number | null {
  const team = state.c4.teams[String(teamId)];
  if (!team || numberOrZero(team.games) < 5 || !Array.isArray(team.recent) || team.recent.length === 0) return null;
  const recent = team.recent.slice(-10);
  const values = recent.map((row) => Array.isArray(row) ? Number(row[0]) : Number.NaN);
  return values.every(Number.isFinite)
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function lineupContinuity(current: number[], previous: unknown): number | null {
  if (!Array.isArray(previous) || previous.length !== 9) return null;
  const prior = new Set(previous.map(Number));
  return current.reduce((count, playerId) => count + (prior.has(playerId) ? 1 : 0), 0) / 9;
}

function v39LeaguePriors(state: V68ProspectiveState): {
  outsPerStart: number;
  bfPerStart: number;
  pitchesPerStart: number;
  kbf: number;
  bbbf: number;
  erbf: number;
} {
  const league = state.v39.league;
  const starts = numberOrZero(league.starts);
  const bf = numberOrZero(league.bf);
  if (!(starts > 0) || !(bf > 0)) throw new Error("V68_LIVE_V39_LEAGUE_PRIOR_INVALID");
  return {
    outsPerStart: numberOrZero(league.outs) / starts,
    bfPerStart: bf / starts,
    pitchesPerStart: numberOrZero(league.pitches) / starts,
    kbf: numberOrZero(league.k) / bf,
    bbbf: numberOrZero(league.bb) / bf,
    erbf: numberOrZero(league.er) / bf,
  };
}

function buildV39SideFeatures(args: {
  state: V68ProspectiveState;
  pitcherId: number;
  opponentTeamId: number;
  opponentBattingOrder: number[];
}): Partial<Record<FrozenV39FeatureName, number | null>> {
  const priors = v39LeaguePriors(args.state);
  const pitcher = args.state.v39.pitchers[String(args.pitcherId)] ?? {};
  const starts = numberOrZero(pitcher.starts);
  const bf = numberOrZero(pitcher.bf);
  const recent = Array.isArray(pitcher.recent) ? pitcher.recent.slice(-5) : [];
  const opponent = args.state.v39.opponents[String(args.opponentTeamId)] ?? {};
  const previous = args.state.v39.previousCompleteLineup[String(args.opponentTeamId)];

  return {
    pitcher_outs_per_start_shrunk: shrunkMean(numberOrZero(pitcher.outs), starts, priors.outsPerStart, 5),
    pitcher_bf_per_start_shrunk: shrunkMean(bf, starts, priors.bfPerStart, 5),
    pitcher_pitches_per_start_shrunk: shrunkMean(numberOrZero(pitcher.pitches), starts, priors.pitchesPerStart, 5),
    pitcher_kbf_shrunk: shrunkRate(numberOrZero(pitcher.k), bf, priors.kbf, 72),
    pitcher_bbbf_shrunk: shrunkRate(numberOrZero(pitcher.bb), bf, priors.bbbf, 72),
    pitcher_erbf_shrunk: shrunkRate(numberOrZero(pitcher.er), bf, priors.erbf, 72),
    pitcher_recent5_outs_per_start: recent.length
      ? recent.reduce((sum, row) => sum + numberOrZero(row.outs), 0) / recent.length
      : null,
    pitcher_recent5_pitches_per_start: recent.length
      ? recent.reduce((sum, row) => sum + numberOrZero(row.pitches), 0) / recent.length
      : null,
    opponent_vs_starters_outs_per_game_shrunk: shrunkMean(
      numberOrZero(opponent.outs),
      numberOrZero(opponent.games),
      priors.outsPerStart,
      5,
    ),
    opponent_rs10: teamRs10(args.state, args.opponentTeamId),
    opponent_lineup_continuity: lineupContinuity(args.opponentBattingOrder, previous),
    pitcher_prior_starts: starts,
  };
}

function pitcherPitchTypeTotals(state: V68ProspectiveState): PitcherPitchTypeTotals[] {
  const rows: PitcherPitchTypeTotals[] = [];
  for (const [rawPitcherId, pitchTypes] of Object.entries(state.v62.pitchers)) {
    const pitcherId = Number(rawPitcherId);
    if (!Number.isInteger(pitcherId) || pitcherId <= 0 || !pitchTypes || typeof pitchTypes !== "object") continue;
    for (const [pitchType, raw] of Object.entries(pitchTypes)) {
      if (!raw || typeof raw !== "object") continue;
      const source = raw as Record<string, number>;
      rows.push({
        pitcherId,
        pitchType,
        pitches: numberOrZero(source.pitches),
        strikes: numberOrZero(source.strikes),
        swings: numberOrZero(source.swings),
        whiffs: numberOrZero(source.whiffs),
        velocityN: numberOrZero(source.velocityN),
        velocitySum: numberOrZero(source.velocitySum),
        spinN: numberOrZero(source.spinN),
        spinSum: numberOrZero(source.spinSum),
        battedBallN: numberOrZero(source.battedBallN),
        hardHitN: numberOrZero(source.hardHitN),
      });
    }
  }
  if (rows.length === 0) throw new Error("V68_LIVE_V62_PITCHER_STATE_EMPTY");
  return rows;
}

function decodeGitHubContent(payload: any): unknown {
  if (payload?.schemaVersion) return payload;
  if (typeof payload?.content === "string") {
    const text = Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8");
    return JSON.parse(text);
  }
  throw new Error("V68_LIVE_STATE_GITHUB_PAYLOAD_INVALID");
}

export class MlbV68ProspectiveStateLiveAdapter {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly repository: string;
  private readonly branch: string;
  private readonly cache = new Map<string, Promise<V68ProspectiveState>>();

  constructor(options: MlbV68ProspectiveStateLiveAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.repository = clean(options.repository) || DEFAULT_REPOSITORY;
    this.branch = clean(options.branch) || DEFAULT_STATE_BRANCH;
  }

  loadState(targetOfficialDate: string): Promise<V68ProspectiveState> {
    const cached = this.cache.get(targetOfficialDate);
    if (cached) return cached;
    const promise = this.fetchState(targetOfficialDate).catch((error) => {
      this.cache.delete(targetOfficialDate);
      throw error;
    });
    this.cache.set(targetOfficialDate, promise);
    return promise;
  }

  async buildFullModularEvidence(
    targetOfficialDate: string,
    full13: MlbFull13LivePregameInput,
  ): Promise<MlbV68FullModularStateEvidence> {
    const state = await this.loadState(targetOfficialDate);
    if (full13.officialDate !== targetOfficialDate) throw new Error("V68_LIVE_FULL13_DATE_MISMATCH");
    if (!full13.homeStarterId || !full13.awayStarterId || !full13.homeBattingOrder || !full13.awayBattingOrder) {
      throw new Error("V68_LIVE_FULL13_IDENTITY_INCOMPLETE");
    }
    const asOfDate = state.chronology.latestHistoricalOfficialDate as string;
    const home: FrozenV39LiveSideInput = {
      asOfDate,
      features: buildV39SideFeatures({
        state,
        pitcherId: full13.homeStarterId,
        opponentTeamId: full13.awayTeamId,
        opponentBattingOrder: full13.awayBattingOrder,
      }),
    };
    const away: FrozenV39LiveSideInput = {
      asOfDate,
      features: buildV39SideFeatures({
        state,
        pitcherId: full13.awayStarterId,
        opponentTeamId: full13.homeTeamId,
        opponentBattingOrder: full13.homeBattingOrder,
      }),
    };
    const pitchQualityHistory: PitchQualityHistoryGame[] = [{
      officialDate: asOfDate,
      pitcherPitchTypeTotals: pitcherPitchTypeTotals(state),
    }];
    return Object.freeze({
      adapterVersion: MLB_V68_PROSPECTIVE_STATE_LIVE_ADAPTER_VERSION,
      stateDigest: state.stateDigest,
      stateAsOfDate: asOfDate,
      v39: Object.freeze({ home: Object.freeze(home), away: Object.freeze(away) }),
      pitchQualityHistory: Object.freeze(pitchQualityHistory) as unknown as PitchQualityHistoryGame[],
      provenance: Object.freeze({
        source: "IMMUTABLE_V68_DAILY_STATE_BRANCH" as const,
        targetOfficialDate,
        sameDateOutcomesUsed: false as const,
        marketPricesUsed: false as const,
        wholeOfficialDatePriorStateOnly: true as const,
        v39RuntimeFitUsed: false as const,
        v62RuntimeFitUsed: false as const,
      }),
    });
  }

  private async fetchState(targetOfficialDate: string): Promise<V68ProspectiveState> {
    if (!validIsoDate(targetOfficialDate)) throw new Error(`V68_LIVE_TARGET_DATE_INVALID:${targetOfficialDate}`);
    const [owner, repo] = this.repository.split("/");
    if (!owner || !repo) throw new Error("V68_LIVE_REPOSITORY_INVALID");
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/v68/states/${targetOfficialDate}.json?ref=${encodeURIComponent(this.branch)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "CourtEdge-Unified-Elite-V68-Live/1.0",
        },
      });
      if (!response.ok) throw new Error(`V68_LIVE_STATE_HTTP_${response.status}`);
      const payload = await response.json();
      return assertStateShape(decodeGitHubContent(payload), targetOfficialDate);
    } finally {
      clearTimeout(timer);
    }
  }
}

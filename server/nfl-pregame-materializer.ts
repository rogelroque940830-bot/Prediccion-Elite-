export const NFL_PREGAME_MATERIALIZER_SCHEMA = "courtedge-nfl-pregame-materializer.v1" as const;

const TEAM_EWMA_ALPHA = 0.22;
const OPPONENT_ADJUSTMENT_K = 0.20;
const QB_EWMA_ALPHA = 0.18;
const TEAM_METRIC_SEASON_DECAY = 0.70;
const POINTS_REGRESS_WEIGHT = 0.30;
const POINTS_ANCHOR = 22.5;
const OPPONENT_ADJUSTMENT_SEASON_DECAY = 0.75;
const QB_METRIC_SEASON_DECAY = 0.80;

const TEAM_STATE_METRICS = [
  "off_epa", "def_epa", "off_success", "def_success",
  "pass_epa", "def_pass_epa", "rush_epa", "def_rush_epa",
  "pass_success", "def_pass_success", "rush_success", "def_rush_success",
  "sack_rate", "def_sack_rate",
  "explosive_pass", "def_explosive_pass",
  "explosive_rush", "def_explosive_rush",
] as const;

const BASE_COPY_METRICS = ["points_for", "points_against", ...TEAM_STATE_METRICS, "plays", "drives"] as const;

export const NFL_R5H8_RUNTIME_FEATURES = [
  "away_def_epa", "away_def_explosive_pass", "away_def_explosive_rush",
  "away_def_pass_epa", "away_def_pass_success", "away_def_rush_epa",
  "away_def_rush_success", "away_def_sack_rate", "away_def_success",
  "away_drives", "away_explosive_pass", "away_explosive_rush",
  "away_oa_def", "away_oa_off", "away_oa_pass_def", "away_oa_pass_off",
  "away_off_epa", "away_off_success", "away_pass_epa", "away_pass_success",
  "away_plays", "away_points_against", "away_points_for",
  "away_r5b2_hi_cpoe", "away_r5b2_hi_epa", "away_r5b2_hi_sack_rate",
  "away_r5b2_hi_switch", "away_r5b2_hi_uncertainty",
  "away_r5b2_out_switch", "away_r5b2_ts_switch", "away_rush_epa",
  "away_rush_success", "away_sack_rate", "away_uncertainty",
  "home_def_epa", "home_def_explosive_pass", "home_def_explosive_rush",
  "home_def_pass_epa", "home_def_pass_success", "home_def_rush_epa",
  "home_def_rush_success", "home_def_sack_rate", "home_def_success",
  "home_drives", "home_explosive_pass", "home_explosive_rush",
  "home_oa_def", "home_oa_off", "home_oa_pass_def", "home_oa_pass_off",
  "home_off_epa", "home_off_success", "home_pass_epa", "home_pass_success",
  "home_plays", "home_points_against", "home_points_for",
  "home_r5b2_hi_cpoe", "home_r5b2_hi_epa", "home_r5b2_hi_sack_rate",
  "home_r5b2_hi_switch", "home_r5b2_hi_uncertainty",
  "home_r5b2_out_switch", "home_r5b2_ts_switch", "home_rush_epa",
  "home_rush_success", "home_sack_rate", "home_uncertainty",
] as const;

export type NflR5H8RuntimeFeature = typeof NFL_R5H8_RUNTIME_FEATURES[number];
export type NflPregameFeatureMap = Record<NflR5H8RuntimeFeature, number | null>;

export type NflPregameGame = {
  gameId: string;
  season: number;
  week: number;
  gameday: string;
  homeTeam: string;
  awayTeam: string;
};

export type NflTeamGameMetrics = {
  off_epa?: number | null;
  off_success?: number | null;
  plays?: number | null;
  drives?: number | null;
  pass_epa?: number | null;
  pass_success?: number | null;
  rush_epa?: number | null;
  rush_success?: number | null;
  sack_rate?: number | null;
  explosive_pass?: number | null;
  explosive_rush?: number | null;
};

export type NflQbGameMetrics = {
  team: string;
  qbId: string;
  qbEpa?: number | null;
  qbCpoe?: number | null;
  qbSackRate?: number | null;
  qbDropbacks: number;
};

export type NflCompletedObservation = {
  homeScore: number;
  awayScore: number;
  homeMetrics: NflTeamGameMetrics;
  awayMetrics: NflTeamGameMetrics;
  quarterbacks: NflQbGameMetrics[];
};

export type NflReplayGame = NflPregameGame & { observation: NflCompletedObservation };

export type NflOldWeeklyDepthSnapshot = {
  season: number;
  week: number;
  team: string;
  qbs: Array<{ qbId: string; rank: number }>;
};

export type NflTimestampedDepthSnapshot = {
  season: number;
  at: string;
  team: string;
  qbs: Array<{ qbId: string; rank: number }>;
};

export type NflInjuryUpdate = {
  season: number;
  week: number;
  team: string;
  qbId: string;
  modifiedAt: string;
  reportStatus?: string | null;
  practiceStatus?: string | null;
};

export type NflPregameReferenceData = {
  oldWeeklyDepth?: NflOldWeeklyDepthSnapshot[];
  timestampedDepth?: NflTimestampedDepthSnapshot[];
  injuries?: NflInjuryUpdate[];
};

export type NflPregameMaterialization = {
  schemaVersion: typeof NFL_PREGAME_MATERIALIZER_SCHEMA;
  gameId: string;
  season: number;
  week: number;
  gameday: string;
  cutoffUtc: string;
  processedCompletedGames: number;
  features: NflPregameFeatureMap;
  provenance: {
    mode: "PREGAME_ONLY";
    sameGameObservationUsed: false;
    targetGamedayUpdatesAllowed: false;
    marketDataUsedAsFeature: false;
    homeDepthSource: "timestamped_depth" | "lagged_week_depth" | "prior_observed_qb" | "none";
    awayDepthSource: "timestamped_depth" | "lagged_week_depth" | "prior_observed_qb" | "none";
  };
};

type TeamState = {
  values: Map<string, number>;
  n: number;
  seasonN: number;
  oaOff: number;
  oaDef: number;
  oaPassOff: number;
  oaPassDef: number;
  lastProxyQb: string | null;
};

type QbState = {
  values: Map<"qb_epa" | "qb_cpoe" | "qb_sack_rate", number>;
  dropbacks: number;
};

type InjuryFlags = {
  injuryKnown: number;
  reportOut: number;
  reportDoubtful: number;
  reportQuestionable: number;
  practiceDnp: number;
  practiceLimited: number;
  practiceFull: number;
};

type DepthChoice = {
  qbs: Array<{ qbId: string; rank: number }>;
  source: "timestamped_depth" | "lagged_week_depth" | "none";
};

type R5bSide = {
  source: "timestamped_depth" | "lagged_week_depth" | "prior_observed_qb" | "none";
  outSwitch: number;
  tsSwitch: number;
  hiSwitch: number;
  hiEpa: number | null;
  hiCpoe: number | null;
  hiSackRate: number | null;
  hiUncertainty: number | null;
};

const TEAM_MAP: Record<string, string> = {
  OAK: "LV",
  SD: "LAC",
  STL: "LA",
  LAR: "LA",
  JAC: "JAX",
  WSH: "WAS",
};

function normalizeTeam(team: string): string {
  const value = String(team).trim().toUpperCase();
  return TEAM_MAP[value] ?? value;
}

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteOrNaN(value: unknown): number {
  const n = finite(value);
  return n === null ? Number.NaN : n;
}

function utcDayStart(gameday: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameday);
  if (!match) throw new Error(`NFL pregame gameday must be YYYY-MM-DD, got ${gameday}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function updateEwma(values: Map<string, number>, key: string, observed: unknown, alpha: number): void {
  const next = finite(observed);
  if (next === null) return;
  const old = values.get(key);
  values.set(key, old === undefined || !Number.isFinite(old) ? next : (1 - alpha) * old + alpha * next);
}

function qbValue(state: Map<string, QbState>, qbId: string | null, key: "qb_epa" | "qb_cpoe" | "qb_sack_rate"): number | null {
  if (!qbId) return null;
  return state.get(qbId)?.values.get(key) ?? null;
}

function qbUncertainty(state: Map<string, QbState>, qbId: string | null): number {
  if (!qbId) return 1;
  const qb = state.get(qbId);
  if (!qb) return 1;
  return 1 / Math.sqrt(Math.max(qb.dropbacks, 1));
}

function statusFlags(update: NflInjuryUpdate | null): InjuryFlags {
  const out: InjuryFlags = {
    injuryKnown: 0,
    reportOut: 0,
    reportDoubtful: 0,
    reportQuestionable: 0,
    practiceDnp: 0,
    practiceLimited: 0,
    practiceFull: 0,
  };
  if (!update) return out;
  out.injuryKnown = 1;
  const report = String(update.reportStatus ?? "").trim().toLowerCase();
  const practice = String(update.practiceStatus ?? "").trim().toLowerCase();
  out.reportOut = Number(report === "out" || report.startsWith("out"));
  out.reportDoubtful = Number(report.includes("doubt"));
  out.reportQuestionable = Number(report.includes("question"));
  out.practiceDnp = Number(practice.includes("did not") || practice === "dnp" || practice === "did not participate");
  out.practiceLimited = Number(practice.includes("limited"));
  out.practiceFull = Number(practice.includes("full"));
  return out;
}

function sameQb(a: NflQbGameMetrics, b: NflQbGameMetrics): number {
  if (b.qbDropbacks !== a.qbDropbacks) return b.qbDropbacks - a.qbDropbacks;
  return String(a.qbId).localeCompare(String(b.qbId));
}

export class NflPregameMaterializer {
  private readonly oldWeeklyDepth: NflOldWeeklyDepthSnapshot[];
  private readonly timestampedDepth: NflTimestampedDepthSnapshot[];
  private readonly injuries: NflInjuryUpdate[];
  private readonly teamState = new Map<string, TeamState>();
  private readonly proxyQbState = new Map<string, QbState>();
  private readonly r5bQbState = new Map<string, QbState>();
  private readonly lastObservedQb = new Map<string, string>();
  private currentSeason: number | null = null;
  private processedCompletedGames = 0;
  private lastAppliedGameId: string | null = null;

  constructor(referenceData: NflPregameReferenceData = {}) {
    this.oldWeeklyDepth = [...(referenceData.oldWeeklyDepth ?? [])].sort((a, b) =>
      a.season - b.season || a.week - b.week || normalizeTeam(a.team).localeCompare(normalizeTeam(b.team)));
    this.timestampedDepth = [...(referenceData.timestampedDepth ?? [])].sort((a, b) =>
      Date.parse(a.at) - Date.parse(b.at) || normalizeTeam(a.team).localeCompare(normalizeTeam(b.team)));
    this.injuries = [...(referenceData.injuries ?? [])].sort((a, b) => Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt));
  }

  getProcessedCompletedGames(): number {
    return this.processedCompletedGames;
  }

  getLastAppliedGameId(): string | null {
    return this.lastAppliedGameId;
  }

  private stateFor(team: string): TeamState {
    let state = this.teamState.get(team);
    if (!state) {
      state = {
        values: new Map<string, number>(),
        n: 0,
        seasonN: 0,
        oaOff: 0,
        oaDef: 0,
        oaPassOff: 0,
        oaPassDef: 0,
        lastProxyQb: null,
      };
      this.teamState.set(team, state);
    }
    return state;
  }

  private decayQbState(state: Map<string, QbState>): void {
    for (const qb of state.values()) {
      for (const [key, value] of qb.values.entries()) {
        if (Number.isFinite(value)) qb.values.set(key, value * QB_METRIC_SEASON_DECAY);
      }
    }
  }

  private ensureSeason(season: number): void {
    if (!Number.isInteger(season)) throw new Error("NFL pregame season must be an integer");
    if (this.currentSeason === null) {
      this.currentSeason = season;
      return;
    }
    if (season < this.currentSeason) {
      throw new Error(`NFL pregame replay is non-monotonic: ${season} after ${this.currentSeason}`);
    }
    if (season === this.currentSeason) return;

    for (const state of this.teamState.values()) {
      for (const key of TEAM_STATE_METRICS) {
        const value = state.values.get(key);
        if (value !== undefined && Number.isFinite(value)) state.values.set(key, value * TEAM_METRIC_SEASON_DECAY);
      }
      for (const key of ["points_for", "points_against"] as const) {
        const value = state.values.get(key);
        if (value !== undefined && Number.isFinite(value)) {
          state.values.set(key, (1 - POINTS_REGRESS_WEIGHT) * value + POINTS_REGRESS_WEIGHT * POINTS_ANCHOR);
        }
      }
      state.oaOff *= OPPONENT_ADJUSTMENT_SEASON_DECAY;
      state.oaDef *= OPPONENT_ADJUSTMENT_SEASON_DECAY;
      state.oaPassOff *= OPPONENT_ADJUSTMENT_SEASON_DECAY;
      state.oaPassDef *= OPPONENT_ADJUSTMENT_SEASON_DECAY;
      state.seasonN = 0;
      state.lastProxyQb = null;
    }
    this.decayQbState(this.proxyQbState);
    this.decayQbState(this.r5bQbState);
    this.currentSeason = season;
  }

  private depthCandidates(game: NflPregameGame, team0: string, cutoffMs: number): DepthChoice {
    const team = normalizeTeam(team0);
    if (game.season >= 2025) {
      let latest: NflTimestampedDepthSnapshot | null = null;
      for (const snapshot of this.timestampedDepth) {
        if (normalizeTeam(snapshot.team) !== team) continue;
        const at = Date.parse(snapshot.at);
        if (!Number.isFinite(at) || at >= cutoffMs) continue;
        if (!latest || at > Date.parse(latest.at)) latest = snapshot;
      }
      if (latest) return { qbs: latest.qbs, source: "timestamped_depth" };
    }

    let latestOld: NflOldWeeklyDepthSnapshot | null = null;
    for (const snapshot of this.oldWeeklyDepth) {
      if (normalizeTeam(snapshot.team) !== team) continue;
      const eligible = snapshot.season < game.season || (snapshot.season === game.season && snapshot.week < game.week);
      if (!eligible) continue;
      if (!latestOld || snapshot.season > latestOld.season || (snapshot.season === latestOld.season && snapshot.week > latestOld.week)) {
        latestOld = snapshot;
      }
    }
    if (latestOld) return { qbs: latestOld.qbs, source: "lagged_week_depth" };
    return { qbs: [], source: "none" };
  }

  private injuryAt(game: NflPregameGame, team0: string, qbId: string | null, cutoffMs: number): NflInjuryUpdate | null {
    if (!qbId) return null;
    const team = normalizeTeam(team0);
    let latest: NflInjuryUpdate | null = null;
    for (const update of this.injuries) {
      if (update.season !== game.season || update.week !== game.week) continue;
      if (normalizeTeam(update.team) !== team || String(update.qbId) !== String(qbId)) continue;
      const at = Date.parse(update.modifiedAt);
      if (!Number.isFinite(at) || at >= cutoffMs) continue;
      if (!latest || at > Date.parse(latest.modifiedAt)) latest = update;
    }
    return latest;
  }

  private r5bSide(
    game: NflPregameGame,
    team0: string,
    cutoffMs: number,
    proxy: { epa: number | null; cpoe: number | null; sackRate: number | null; uncertainty: number },
  ): R5bSide {
    const team = normalizeTeam(team0);
    const depth = this.depthCandidates(game, team, cutoffMs);
    const candidates = depth.qbs;
    const originalQb1 = candidates[0]?.qbId ?? null;
    const originalFlags = statusFlags(this.injuryAt(game, team, originalQb1, cutoffMs));

    let chosenId: string | null = null;
    let outAhead = 0;
    for (const candidate of candidates.slice(0, 4)) {
      const flags = statusFlags(this.injuryAt(game, team, candidate.qbId, cutoffMs));
      if (flags.reportOut) {
        outAhead += 1;
        continue;
      }
      chosenId = candidate.qbId;
      break;
    }

    let source: R5bSide["source"] = depth.source;
    if (!chosenId) {
      chosenId = this.lastObservedQb.get(team) ?? null;
      source = chosenId ? "prior_observed_qb" : "none";
    }

    const known = Number(chosenId !== null);
    const changedVsLast = Number(
      chosenId !== null
      && this.lastObservedQb.has(team)
      && chosenId !== this.lastObservedQb.get(team),
    );
    const replacementUsed = Number(outAhead > 0 && chosenId !== null);
    const outSwitch = Number(originalFlags.reportOut === 1 && replacementUsed === 1 && known === 1);
    const tsSwitch = Number(source === "timestamped_depth" && changedVsLast === 1 && known === 1);
    const hiSwitch = Number(outSwitch === 1 || tsSwitch === 1);

    const r5bEpa = qbValue(this.r5bQbState, chosenId, "qb_epa");
    const r5bCpoe = qbValue(this.r5bQbState, chosenId, "qb_cpoe");
    const r5bSackRate = qbValue(this.r5bQbState, chosenId, "qb_sack_rate");
    const r5bUncertainty = qbUncertainty(this.r5bQbState, chosenId);

    const choose = (replacement: number | null, fallback: number | null): number | null =>
      hiSwitch === 1 && replacement !== null ? replacement : fallback;

    return {
      source,
      outSwitch,
      tsSwitch,
      hiSwitch,
      hiEpa: choose(r5bEpa, proxy.epa),
      hiCpoe: choose(r5bCpoe, proxy.cpoe),
      hiSackRate: choose(r5bSackRate, proxy.sackRate),
      hiUncertainty: choose(r5bUncertainty, proxy.uncertainty),
    };
  }

  materializePregame(game: NflPregameGame): NflPregameMaterialization {
    this.ensureSeason(game.season);
    const cutoffMs = utcDayStart(game.gameday);
    const home = this.stateFor(game.homeTeam);
    const away = this.stateFor(game.awayTeam);

    const raw: Record<string, number | null> = {};
    raw.home_uncertainty = 1 / Math.sqrt(home.seasonN + 4);
    raw.away_uncertainty = 1 / Math.sqrt(away.seasonN + 4);
    raw.home_oa_off = home.oaOff;
    raw.home_oa_def = home.oaDef;
    raw.away_oa_off = away.oaOff;
    raw.away_oa_def = away.oaDef;
    raw.home_oa_pass_off = home.oaPassOff;
    raw.home_oa_pass_def = home.oaPassDef;
    raw.away_oa_pass_off = away.oaPassOff;
    raw.away_oa_pass_def = away.oaPassDef;

    for (const key of BASE_COPY_METRICS) {
      raw[`home_${key}`] = home.values.get(key) ?? null;
      raw[`away_${key}`] = away.values.get(key) ?? null;
    }

    const homeProxyQb = home.lastProxyQb;
    const awayProxyQb = away.lastProxyQb;
    const homeProxy = {
      epa: qbValue(this.proxyQbState, homeProxyQb, "qb_epa"),
      cpoe: qbValue(this.proxyQbState, homeProxyQb, "qb_cpoe"),
      sackRate: qbValue(this.proxyQbState, homeProxyQb, "qb_sack_rate"),
      uncertainty: qbUncertainty(this.proxyQbState, homeProxyQb),
    };
    const awayProxy = {
      epa: qbValue(this.proxyQbState, awayProxyQb, "qb_epa"),
      cpoe: qbValue(this.proxyQbState, awayProxyQb, "qb_cpoe"),
      sackRate: qbValue(this.proxyQbState, awayProxyQb, "qb_sack_rate"),
      uncertainty: qbUncertainty(this.proxyQbState, awayProxyQb),
    };

    const homeR5b = this.r5bSide(game, game.homeTeam, cutoffMs, homeProxy);
    const awayR5b = this.r5bSide(game, game.awayTeam, cutoffMs, awayProxy);
    for (const [side, value] of [["home", homeR5b], ["away", awayR5b]] as const) {
      raw[`${side}_r5b2_out_switch`] = value.outSwitch;
      raw[`${side}_r5b2_ts_switch`] = value.tsSwitch;
      raw[`${side}_r5b2_hi_switch`] = value.hiSwitch;
      raw[`${side}_r5b2_hi_epa`] = value.hiEpa;
      raw[`${side}_r5b2_hi_cpoe`] = value.hiCpoe;
      raw[`${side}_r5b2_hi_sack_rate`] = value.hiSackRate;
      raw[`${side}_r5b2_hi_uncertainty`] = value.hiUncertainty;
    }

    const features = Object.fromEntries(
      NFL_R5H8_RUNTIME_FEATURES.map((key) => [key, finite(raw[key])]),
    ) as NflPregameFeatureMap;

    return {
      schemaVersion: NFL_PREGAME_MATERIALIZER_SCHEMA,
      gameId: game.gameId,
      season: game.season,
      week: game.week,
      gameday: game.gameday,
      cutoffUtc: iso(cutoffMs),
      processedCompletedGames: this.processedCompletedGames,
      features,
      provenance: {
        mode: "PREGAME_ONLY",
        sameGameObservationUsed: false,
        targetGamedayUpdatesAllowed: false,
        marketDataUsedAsFeature: false,
        homeDepthSource: homeR5b.source,
        awayDepthSource: awayR5b.source,
      },
    };
  }

  private updateTeamState(
    state: TeamState,
    own: NflTeamGameMetrics,
    opponent: NflTeamGameMetrics,
    pointsFor: number,
    pointsAgainst: number,
  ): void {
    const values: Record<string, number | null> = {
      points_for: finite(pointsFor),
      points_against: finite(pointsAgainst),
      off_epa: finite(own.off_epa),
      def_epa: finite(opponent.off_epa),
      off_success: finite(own.off_success),
      def_success: finite(opponent.off_success),
      pass_epa: finite(own.pass_epa),
      def_pass_epa: finite(opponent.pass_epa),
      rush_epa: finite(own.rush_epa),
      def_rush_epa: finite(opponent.rush_epa),
      pass_success: finite(own.pass_success),
      def_pass_success: finite(opponent.pass_success),
      rush_success: finite(own.rush_success),
      def_rush_success: finite(opponent.rush_success),
      sack_rate: finite(own.sack_rate),
      def_sack_rate: finite(opponent.sack_rate),
      explosive_pass: finite(own.explosive_pass),
      def_explosive_pass: finite(opponent.explosive_pass),
      explosive_rush: finite(own.explosive_rush),
      def_explosive_rush: finite(opponent.explosive_rush),
      plays: finite(own.plays),
      drives: finite(own.drives),
    };
    for (const [key, value] of Object.entries(values)) updateEwma(state.values, key, value, TEAM_EWMA_ALPHA);
  }

  private updateQbState(state: Map<string, QbState>, qb: NflQbGameMetrics): void {
    let current = state.get(String(qb.qbId));
    if (!current) {
      current = { values: new Map(), dropbacks: 0 };
      state.set(String(qb.qbId), current);
    }
    updateEwma(current.values, "qb_epa", qb.qbEpa, QB_EWMA_ALPHA);
    updateEwma(current.values, "qb_cpoe", qb.qbCpoe, QB_EWMA_ALPHA);
    updateEwma(current.values, "qb_sack_rate", qb.qbSackRate, QB_EWMA_ALPHA);
    const dropbacks = Math.max(0, Math.trunc(finiteOrNaN(qb.qbDropbacks)));
    if (Number.isFinite(dropbacks)) current.dropbacks += dropbacks;
  }

  applyCompletedGame(game: NflReplayGame): void {
    this.ensureSeason(game.season);
    const home = this.stateFor(game.homeTeam);
    const away = this.stateFor(game.awayTeam);
    const hm = game.observation.homeMetrics ?? {};
    const am = game.observation.awayMetrics ?? {};

    const homeOff = finite(hm.off_epa);
    const awayOff = finite(am.off_epa);
    const homePass = finite(hm.pass_epa);
    const awayPass = finite(am.pass_epa);

    if (homeOff !== null) {
      const error = homeOff - (home.oaOff + away.oaDef);
      home.oaOff += OPPONENT_ADJUSTMENT_K * 0.5 * error;
      away.oaDef += OPPONENT_ADJUSTMENT_K * 0.5 * error;
    }
    if (awayOff !== null) {
      const error = awayOff - (away.oaOff + home.oaDef);
      away.oaOff += OPPONENT_ADJUSTMENT_K * 0.5 * error;
      home.oaDef += OPPONENT_ADJUSTMENT_K * 0.5 * error;
    }
    if (homePass !== null) {
      const error = homePass - (home.oaPassOff + away.oaPassDef);
      home.oaPassOff += OPPONENT_ADJUSTMENT_K * 0.5 * error;
      away.oaPassDef += OPPONENT_ADJUSTMENT_K * 0.5 * error;
    }
    if (awayPass !== null) {
      const error = awayPass - (away.oaPassOff + home.oaPassDef);
      away.oaPassOff += OPPONENT_ADJUSTMENT_K * 0.5 * error;
      home.oaPassDef += OPPONENT_ADJUSTMENT_K * 0.5 * error;
    }

    this.updateTeamState(home, hm, am, game.observation.homeScore, game.observation.awayScore);
    this.updateTeamState(away, am, hm, game.observation.awayScore, game.observation.homeScore);

    for (const [rawTeam, state] of [[game.homeTeam, home], [game.awayTeam, away]] as const) {
      const qbs = game.observation.quarterbacks.filter((qb) => String(qb.team) === String(rawTeam)).sort(sameQb);
      const primary = qbs[0];
      if (!primary) continue;
      this.updateQbState(this.proxyQbState, primary);
      state.lastProxyQb = String(primary.qbId);
    }

    for (const team0 of [game.homeTeam, game.awayTeam]) {
      const normalized = normalizeTeam(team0);
      const qbs = game.observation.quarterbacks
        .filter((qb) => normalizeTeam(qb.team) === normalized)
        .sort(sameQb);
      const primary = qbs[0];
      if (!primary) continue;
      this.lastObservedQb.set(normalized, String(primary.qbId));
      for (const qb of qbs) this.updateQbState(this.r5bQbState, qb);
    }

    home.n += 1;
    away.n += 1;
    home.seasonN += 1;
    away.seasonN += 1;
    this.processedCompletedGames += 1;
    this.lastAppliedGameId = game.gameId;
  }

  replayCompletedGame(game: NflReplayGame): NflPregameMaterialization {
    const materialized = this.materializePregame(game);
    this.applyCompletedGame(game);
    return materialized;
  }
}

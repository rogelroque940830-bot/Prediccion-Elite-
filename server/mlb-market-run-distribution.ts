import { getMlbMarketContract, type MlbMarketType } from "./mlb-market-contract";
import {
  MLB_P1_M6A3A_MODEL_FAMILY,
  MLB_P1_M6A3A_SCHEMA,
  horizonToPeriod,
  validateRunProcessInput,
  type MlbExactMarketProbabilityRequest,
  type MlbExactMarketProbabilityResult,
  type MlbHorizonRunDistribution,
  type MlbHorizonRunDistributionInput,
  type MlbJointRunPoint,
  type MlbMarginPmfPoint,
  type MlbMarketOutcome,
  type MlbRunPmfPoint,
  type MlbTeamRunProcessInput,
} from "./mlb-market-probability-contract";

const EPS = 1e-12;
const DEFAULT_MAX_RUNS = 20;
const MIN_MAX_RUNS = 8;
const MAX_MAX_RUNS = 40;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundProbability(value: number): number {
  return Math.round(clamp01(value) * 1e12) / 1e12;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function negativeBinomialRunPmf(
  input: MlbTeamRunProcessInput,
  maxRuns = DEFAULT_MAX_RUNS,
): { pmf: MlbRunPmfPoint[]; tailMass: number } {
  validateRunProcessInput(input);
  if (!Number.isInteger(maxRuns) || maxRuns < MIN_MAX_RUNS || maxRuns > MAX_MAX_RUNS) {
    throw new Error("P1_M6A3A_INVALID_MAX_RUNS");
  }

  const mu = input.meanRuns;
  const k = input.dispersionK;
  const zeroInflation = input.zeroInflation ?? 0;
  const values: number[] = new Array(maxRuns + 1).fill(0);

  if (mu === 0) {
    values[0] = 1;
  } else {
    const q = mu / (k + mu);
    let p = Math.exp(k * Math.log(k / (k + mu)));
    values[0] = zeroInflation + (1 - zeroInflation) * p;
    for (let runs = 0; runs < maxRuns; runs += 1) {
      p *= ((runs + k) / (runs + 1)) * q;
      values[runs + 1] = (1 - zeroInflation) * p;
    }
  }

  const represented = sum(values);
  const tailMass = clamp01(1 - represented);
  return {
    pmf: values.map((probability, runs) => ({ runs, probability: roundProbability(probability) })),
    tailMass: roundProbability(tailMass),
  };
}

function normalizeJoint(points: MlbJointRunPoint[]): { points: MlbJointRunPoint[]; mass: number } {
  const mass = sum(points.map((point) => point.probability));
  if (!(mass > 0)) throw new Error("P1_M6A3A_EMPTY_JOINT_DISTRIBUTION");
  return {
    mass,
    points: points.map((point) => ({ ...point, probability: point.probability / mass })),
  };
}

function aggregateRuns(
  points: MlbJointRunPoint[],
  selector: (point: MlbJointRunPoint) => number,
): MlbRunPmfPoint[] {
  const map = new Map<number, number>();
  for (const point of points) {
    const key = selector(point);
    map.set(key, (map.get(key) ?? 0) + point.probability);
  }
  return [...map.entries()]
    .sort(([left], [right]) => left - right)
    .map(([runs, probability]) => ({ runs, probability: roundProbability(probability) }));
}

function aggregateMargin(points: MlbJointRunPoint[]): MlbMarginPmfPoint[] {
  const map = new Map<number, number>();
  for (const point of points) {
    const margin = point.homeRuns - point.awayRuns;
    map.set(margin, (map.get(margin) ?? 0) + point.probability);
  }
  return [...map.entries()]
    .sort(([left], [right]) => left - right)
    .map(([homeMinusAway, probability]) => ({ homeMinusAway, probability: roundProbability(probability) }));
}

function moneyline(points: MlbJointRunPoint[]) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  for (const point of points) {
    if (point.homeRuns > point.awayRuns) homeWin += point.probability;
    else if (point.homeRuns < point.awayRuns) awayWin += point.probability;
    else draw += point.probability;
  }
  return {
    homeWin: roundProbability(homeWin),
    draw: roundProbability(draw),
    awayWin: roundProbability(awayWin),
  };
}

export function buildMlbHorizonRunDistribution(
  input: MlbHorizonRunDistributionInput,
): MlbHorizonRunDistribution {
  validateRunProcessInput(input.home);
  validateRunProcessInput(input.away);
  const maxRunsPerTeam = input.maxRunsPerTeam ?? DEFAULT_MAX_RUNS;
  const home = negativeBinomialRunPmf(input.home, maxRunsPerTeam);
  const away = negativeBinomialRunPmf(input.away, maxRunsPerTeam);

  const raw: MlbJointRunPoint[] = [];
  let fullGameTieMassRemoved = 0;
  for (const homePoint of home.pmf) {
    for (const awayPoint of away.pmf) {
      const probability = homePoint.probability * awayPoint.probability;
      if (input.horizon === "FULL_GAME" && homePoint.runs === awayPoint.runs) {
        fullGameTieMassRemoved += probability;
        continue;
      }
      raw.push({ homeRuns: homePoint.runs, awayRuns: awayPoint.runs, probability });
    }
  }

  const rawJointMass = sum(raw.map((point) => point.probability));
  const normalized = normalizeJoint(raw);
  const jointRuns = normalized.points.map((point) => ({
    ...point,
    probability: roundProbability(point.probability),
  }));
  const ml = moneyline(jointRuns);
  const nrfi = input.horizon === "FIRST_INNING"
    ? jointRuns.find((point) => point.homeRuns === 0 && point.awayRuns === 0)?.probability ?? 0
    : null;

  return {
    schemaVersion: MLB_P1_M6A3A_SCHEMA,
    modelFamily: MLB_P1_M6A3A_MODEL_FAMILY,
    modelStatus: "EXPERIMENTAL_SHADOW",
    actionabilityAllowed: false,
    horizon: input.horizon,
    period: horizonToPeriod(input.horizon),
    homeInput: input.home,
    awayInput: input.away,
    maxRunsPerTeam,
    homeRuns: home.pmf,
    awayRuns: away.pmf,
    jointRuns,
    totalRuns: aggregateRuns(jointRuns, (point) => point.homeRuns + point.awayRuns),
    runMargin: aggregateMargin(jointRuns),
    moneyline: ml,
    firstInningRuns: {
      nrfi: nrfi == null ? null : roundProbability(nrfi),
      yrfi: nrfi == null ? null : roundProbability(1 - nrfi),
    },
    diagnostics: {
      homeTailMass: home.tailMass,
      awayTailMass: away.tailMass,
      rawJointMass: Math.round(rawJointMass * 1e12) / 1e12,
      normalizedJointMass: 1,
      fullGameTieMassRemoved: roundProbability(fullGameTieMassRemoved),
      conditionedOnNonTie: input.horizon === "FULL_GAME",
      independenceAssumption: true,
    },
  };
}

function periodMatchesMarket(distribution: MlbHorizonRunDistribution, marketType: MlbMarketType): boolean {
  const contract = getMlbMarketContract(marketType);
  return contract.period === distribution.period;
}

function compare(value: number, target: number): MlbMarketOutcome {
  if (Math.abs(value - target) <= EPS) return "PUSH";
  return value > target ? "WIN" : "LOSS";
}

function result(
  distribution: MlbHorizonRunDistribution,
  request: MlbExactMarketProbabilityRequest,
  probabilities: Record<MlbMarketOutcome, number> | null,
  status: MlbExactMarketProbabilityResult["status"] = "OK",
  blockers: string[] = [],
): MlbExactMarketProbabilityResult {
  return {
    schemaVersion: MLB_P1_M6A3A_SCHEMA,
    status,
    marketType: request.marketType,
    side: request.side,
    line: request.line ?? null,
    horizon: distribution.horizon,
    probabilities,
    actionabilityAllowed: false,
    blockers: [...new Set(["P1_M6A3A_EXPERIMENTAL_SHADOW_ONLY", ...blockers])],
  };
}

function normalizedOutcome(counts: Record<MlbMarketOutcome, number>): Record<MlbMarketOutcome, number> {
  const total = counts.WIN + counts.PUSH + counts.LOSS;
  if (!(total > 0)) return { WIN: 0, PUSH: 0, LOSS: 0 };
  return {
    WIN: roundProbability(counts.WIN / total),
    PUSH: roundProbability(counts.PUSH / total),
    LOSS: roundProbability(counts.LOSS / total),
  };
}

export function evaluateMlbExactMarketProbability(
  distribution: MlbHorizonRunDistribution,
  request: MlbExactMarketProbabilityRequest,
): MlbExactMarketProbabilityResult {
  if (!periodMatchesMarket(distribution, request.marketType)) {
    return result(distribution, request, null, "HORIZON_MISMATCH", ["MARKET_PERIOD_MUST_MATCH_MODEL_HORIZON"]);
  }

  const contract = getMlbMarketContract(request.marketType);
  if (!contract.productionEligible || request.marketType === "OTHER") {
    return result(distribution, request, null, "UNSUPPORTED_MARKET", ["MARKET_NOT_SUPPORTED_BY_A3A_DISTRIBUTION"]);
  }

  const counts: Record<MlbMarketOutcome, number> = { WIN: 0, PUSH: 0, LOSS: 0 };
  const line = request.line ?? null;
  const teamSide = request.side === "HOME" || request.side === "AWAY" ? request.side : null;
  const totalSide = request.side === "OVER" || request.side === "UNDER" ? request.side : null;

  for (const point of distribution.jointRuns) {
    let outcome: MlbMarketOutcome | null = null;

    if (["ML", "F5_ML", "F3_ML", "INNING_1_ML"].includes(request.marketType)) {
      if (!teamSide) return result(distribution, request, null, "INVALID_REQUEST", ["TEAM_SIDE_REQUIRED"]);
      const selected = teamSide === "HOME" ? point.homeRuns : point.awayRuns;
      const rival = teamSide === "HOME" ? point.awayRuns : point.homeRuns;
      outcome = compare(selected, rival);
    } else if (["RUN_LINE", "F5_RUN_LINE", "F3_RUN_LINE"].includes(request.marketType)) {
      if (!teamSide || line == null || !Number.isFinite(line)) {
        return result(distribution, request, null, "INVALID_REQUEST", ["TEAM_SIDE_AND_FINITE_LINE_REQUIRED"]);
      }
      const selected = teamSide === "HOME" ? point.homeRuns : point.awayRuns;
      const rival = teamSide === "HOME" ? point.awayRuns : point.homeRuns;
      outcome = compare(selected + line, rival);
    } else if (["TOTAL", "F5_TOTAL", "F3_TOTAL"].includes(request.marketType)) {
      if (!totalSide || line == null || !Number.isFinite(line)) {
        return result(distribution, request, null, "INVALID_REQUEST", ["TOTAL_SIDE_AND_FINITE_LINE_REQUIRED"]);
      }
      const raw = compare(point.homeRuns + point.awayRuns, line);
      outcome = raw === "PUSH" ? "PUSH" : totalSide === "OVER" ? raw : raw === "WIN" ? "LOSS" : "WIN";
    } else if (["TEAM_TOTAL", "F5_TEAM_TOTAL", "F3_TEAM_TOTAL", "TT_OVER_15_F5", "TT_UNDER_25_F5"].includes(request.marketType)) {
      const variant = request.variant ?? null;
      if (!variant || !totalSide || line == null || !Number.isFinite(line)) {
        return result(distribution, request, null, "INVALID_REQUEST", ["TEAM_TOTAL_VARIANT_SIDE_AND_LINE_REQUIRED"]);
      }
      const runs = variant === "HOME" ? point.homeRuns : point.awayRuns;
      const raw = compare(runs, line);
      outcome = raw === "PUSH" ? "PUSH" : totalSide === "OVER" ? raw : raw === "WIN" ? "LOSS" : "WIN";
    } else if (request.marketType === "NRFI" || request.marketType === "YRFI") {
      if (distribution.horizon !== "FIRST_INNING") {
        return result(distribution, request, null, "HORIZON_MISMATCH", ["FIRST_INNING_DISTRIBUTION_REQUIRED"]);
      }
      const hasRun = point.homeRuns + point.awayRuns > 0;
      const won = request.marketType === "NRFI" ? !hasRun : hasRun;
      outcome = won ? "WIN" : "LOSS";
    } else {
      return result(distribution, request, null, "UNSUPPORTED_MARKET", ["MARKET_NOT_SUPPORTED_BY_A3A_DISTRIBUTION"]);
    }

    counts[outcome] += point.probability;
  }

  return result(distribution, request, normalizedOutcome(counts));
}

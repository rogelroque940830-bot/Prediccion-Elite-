const STRONG_LOGIT = 0.20;

export type NflR5H8Reliability = {
  rule: string;
  fit_accuracy: number;
  fit_log_loss: number;
  reliability: number;
};

export type NflR5H8Pair = {
  rule_a: string;
  rule_b: string;
  corr: number;
  corr_abs: number;
  both_support_n: number;
  both_support_accuracy_shrunk: number;
  pair_logodds_lift: number;
  disagreement_n: number;
  disagreement_accuracy_shrunk: number;
  discord_risk: number;
};

export type NflR5H8CoreConfig = {
  top_k: number;
  reliability_power: number;
  conviction_power: number;
  redundancy_lambda: number;
  synergy_lambda: number;
  agreement_floor: number;
  diversity_power: number;
  confidence_bins: number;
  confidence_floor_quantile: number;
  confidence_floor: number;
  rule_selection_rate: number;
  bin_edges: string | Array<number | null>;
  rule_thresholds: string | Record<string, number | null>;
  safe_conf_thresholds?: string | Record<string, number | null>;
};

export type NflR5H8Evaluation = {
  interactionScore: number;
  agreement: number;
  signedConsensus: number;
  synergy: number;
  contradictionPairRisk: number;
  diversity: number;
  hhi: number;
  redundancyExposure: number;
  confidenceScore: number;
  confidenceStratum: number;
  coreSelected: boolean;
};

function clipProbability(value: number): number {
  return Math.min(1 - 1e-6, Math.max(1e-6, value));
}

function logit(value: number): number {
  const p = clipProbability(value);
  return Math.log(p / (1 - p));
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function parseEdges(value: NflR5H8CoreConfig["bin_edges"]): number[] {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(raw) || raw.length < 2) throw new Error("NFL R5H8 invalid confidence-bin edges");
  return raw.map((entry, index) => {
    if (entry === null) return index === 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const numeric = Number(entry);
    if (!Number.isFinite(numeric)) throw new Error("NFL R5H8 confidence-bin edge must be finite or null sentinel");
    return numeric;
  });
}

function parseThresholds(value: NflR5H8CoreConfig["rule_thresholds"]): Record<number, number> {
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  const out: Record<number, number> = {};
  for (const [key, entry] of Object.entries(raw ?? {})) {
    out[Number(key)] = entry === null ? Number.POSITIVE_INFINITY : Number(entry);
  }
  return out;
}

function assignBin(confidence: number, edges: number[]): number {
  let bin = 0;
  for (let i = 1; i < edges.length - 1; i += 1) {
    if (confidence >= edges[i]) bin += 1;
    else break;
  }
  return bin;
}

function pairLookup(pairs: NflR5H8Pair[]): Map<string, NflR5H8Pair> {
  const out = new Map<string, NflR5H8Pair>();
  for (const pair of pairs) {
    out.set(`${pair.rule_a}\u0000${pair.rule_b}`, pair);
    out.set(`${pair.rule_b}\u0000${pair.rule_a}`, pair);
  }
  return out;
}

/** Exact scalar port of the frozen Python R5H8 interaction/contradiction scoring path. */
export function evaluateNflR5H8(
  referenceProbability: number,
  expertProbabilities: Record<string, number>,
  reliability: NflR5H8Reliability[],
  pairs: NflR5H8Pair[],
  config: NflR5H8CoreConfig,
): NflR5H8Evaluation {
  const k = Math.min(Math.trunc(config.top_k), reliability.length);
  if (k <= 0) throw new Error("NFL R5H8 artifact has no active rules");
  const chosen = reliability.slice(0, k);
  const referenceSign = referenceProbability >= 0.5 ? 1 : -1;
  const pairMap = pairLookup(pairs);

  const z: number[] = [];
  const m0: number[] = [];
  const supports: number[] = [];
  for (const row of chosen) {
    const p = expertProbabilities[row.rule];
    if (!Number.isFinite(p)) throw new Error(`NFL R5H8 missing expert probability for ${row.rule}`);
    const l = clamp(logit(p), -4, 4);
    z.push(l);
    const baseWeight = Math.pow(Math.max(row.reliability, 1e-8), config.reliability_power);
    const conviction = Math.pow(Math.abs(l) + 1e-8, config.conviction_power);
    m0.push(baseWeight * conviction);
    supports.push(Math.sign(l) * referenceSign);
  }

  const exposure = new Array<number>(k).fill(0);
  const denomPairs = Math.max(k - 1, 1);
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      if (i === j) continue;
      const pair = pairMap.get(`${chosen[i].rule}\u0000${chosen[j].rule}`);
      const corr = pair?.corr_abs ?? 0;
      exposure[i] += corr * Math.min(Math.abs(z[i]) / 4, Math.abs(z[j]) / 4);
    }
    exposure[i] /= denomPairs;
  }

  const mass = m0.map((value, i) => value / (1 + config.redundancy_lambda * exposure[i]));
  const total = Math.max(mass.reduce((sum, value) => sum + value, 0), 1e-12);
  const supportMask = supports.map((value) => value > 0);
  const agreeMass = mass.reduce((sum, value, i) => sum + (supportMask[i] ? value : 0), 0);
  const agreement = agreeMass / total;
  const signedConsensus = mass.reduce((sum, value, i) => sum + value * (supportMask[i] ? 1 : -1), 0) / total;

  let synergy = 0;
  let contradictionPairRisk = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      const pair = pairMap.get(`${chosen[i].rule}\u0000${chosen[j].rule}`);
      if (!pair) continue;
      const pairMass = Math.min(mass[i], mass[j]) / total;
      const strong = Math.abs(z[i]) >= STRONG_LOGIT && Math.abs(z[j]) >= STRONG_LOGIT;
      if (strong && supportMask[i] && supportMask[j]) {
        synergy += pairMass * pair.pair_logodds_lift;
      }
      if (strong && supportMask[i] !== supportMask[j]) {
        contradictionPairRisk += pairMass * Math.max(pair.discord_risk, 0);
      }
    }
  }

  const supportTotal = Math.max(mass.reduce((sum, value, i) => sum + (supportMask[i] ? value : 0), 0), 1e-12);
  let hhi = 0;
  for (let i = 0; i < k; i += 1) {
    const share = supportMask[i] ? mass[i] / supportTotal : 0;
    hhi += share * share;
  }
  const maxDiversity = 1 - 1 / Math.max(k, 1);
  const diversity = maxDiversity > 0 ? clamp((1 - hhi) / maxDiversity, 0, 1) : 0;
  const totalRaw = Math.max(m0.reduce((sum, value) => sum + value, 0), 1e-12);
  const redundancyExposure = m0.reduce((sum, value, i) => sum + (value / totalRaw) * exposure[i], 0);

  const eligible = signedConsensus > 0 && agreement >= config.agreement_floor;
  const interactionMultiplier = Math.exp(clamp(
    config.synergy_lambda * synergy - contradictionPairRisk,
    -1.5,
    1.5,
  ));
  let interactionScore = (
    Math.pow(Math.max(agreement, 1e-8), 2)
    * (0.5 + 0.5 * Math.max(signedConsensus, 0))
    * interactionMultiplier
    * Math.pow(0.5 + 0.5 * diversity, config.diversity_power)
  );
  if (!eligible) interactionScore = 0;

  const confidenceScore = Math.abs(clipProbability(referenceProbability) - 0.5) * 2;
  const edges = parseEdges(config.bin_edges);
  const confidenceStratum = assignBin(confidenceScore, edges);
  const thresholds = parseThresholds(config.rule_thresholds);
  const threshold = thresholds[confidenceStratum] ?? Number.POSITIVE_INFINITY;
  const coreSelected = (
    confidenceScore >= config.confidence_floor
    && interactionScore > 0
    && interactionScore >= threshold
  );

  return {
    interactionScore,
    agreement,
    signedConsensus,
    synergy,
    contradictionPairRisk,
    diversity,
    hhi,
    redundancyExposure,
    confidenceScore,
    confidenceStratum,
    coreSelected,
  };
}

export const AMERICAN_ODDS_MIN_ABS = 100;
export const AMERICAN_ODDS_MAX_ABS = 100_000;

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeStandardAmericanOdds(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed == null) return null;
  const rounded = Math.round(parsed);
  const absolute = Math.abs(rounded);
  if (absolute < AMERICAN_ODDS_MIN_ABS || absolute > AMERICAN_ODDS_MAX_ABS) return null;
  return rounded;
}

export function isStandardAmericanOdds(value: unknown): boolean {
  return normalizeStandardAmericanOdds(value) != null;
}

export function americanOddsToImpliedProbability(value: unknown): number | null {
  const odds = normalizeStandardAmericanOdds(value);
  if (odds == null) return null;
  return odds > 0
    ? 100 / (odds + 100)
    : Math.abs(odds) / (Math.abs(odds) + 100);
}

export function impliedProbabilityToAmericanOdds(value: unknown): number | null {
  const probability = finite(value);
  if (probability == null || probability <= 0 || probability >= 1) return null;
  const raw = probability >= 0.5
    ? -(100 * probability) / (1 - probability)
    : (100 * (1 - probability)) / probability;
  return normalizeStandardAmericanOdds(raw);
}

export function medianFinite(values: readonly unknown[]): number | null {
  const sorted = values
    .map(finite)
    .filter((value): value is number => value != null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function consensusAmericanOdds(values: readonly unknown[]): number | null {
  const probabilities = values
    .map(americanOddsToImpliedProbability)
    .filter((value): value is number => value != null);
  const consensusProbability = medianFinite(probabilities);
  return consensusProbability == null
    ? null
    : impliedProbabilityToAmericanOdds(consensusProbability);
}

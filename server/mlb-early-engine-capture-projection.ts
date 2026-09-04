function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberOrNull(value: unknown, digits = 3): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? round(numeric, digits) : null;
}

function probabilityPctOrNull(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const probability = numeric > 1 ? numeric : numeric * 100;
  return probability >= 0 && probability <= 100 ? round(probability, 1) : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Compact, read-only projection of the immutable Early/ERE capture embedded in
 * a canonical MLB scientific snapshot. This deliberately avoids exporting raw
 * payload arrays while preserving the fields needed to audit F5 decisions.
 */
export function projectMlbEarlyEngineCapture(payload: unknown) {
  const root = objectOrNull(payload);
  const analysis = objectOrNull(root?.analysis);
  const layers = objectOrNull(analysis?.layers);
  const capture = objectOrNull(layers?.earlyEngine);
  if (!capture || capture.schemaVersion !== "mlb-early-engine-capture.v1") return null;

  const output = objectOrNull(capture.output);
  const homeEre = objectOrNull(output?.homeEre);
  const awayEre = objectOrNull(output?.awayEre);
  const markets = objectOrNull(output?.markets);
  const f5Unified = objectOrNull(output?.f5Unified);
  const finalRecommendation = objectOrNull(markets?.finalRecommendation);
  const recommendationRelation = objectOrNull(capture.recommendationRelation);
  const savedPick = objectOrNull(capture.savedPick);

  return {
    schemaVersion: "mlb-early-engine-capture.v1" as const,
    source: stringOrNull(capture.source),
    observedAt: stringOrNull(capture.observedAt),
    freshness: stringOrNull(capture.freshness),
    ageMsAtSavedPick: numberOrNull(capture.ageMsAtSavedPick, 0),
    savedMarketType: stringOrNull(savedPick?.marketType),
    savedSide: stringOrNull(savedPick?.side),
    recommendationMatchesSavedPick: booleanOrNull(recommendationRelation?.matchesSavedPick),
    homeEreScore: numberOrNull(homeEre?.ereScore, 1),
    awayEreScore: numberOrNull(awayEre?.ereScore, 1),
    homeEreCategory: stringOrNull(homeEre?.category),
    awayEreCategory: stringOrNull(awayEre?.category),
    homeEreDataStatus: stringOrNull(homeEre?.dataStatus),
    awayEreDataStatus: stringOrNull(awayEre?.dataStatus),
    f5ProbHomePct: probabilityPctOrNull(f5Unified?.f5ProbHome ?? markets?.f5ProbHome),
    f5ProbAwayPct: probabilityPctOrNull(f5Unified?.f5ProbAway ?? markets?.f5ProbAway),
    f5PickSide: stringOrNull(f5Unified?.pickSide ?? markets?.f5RecommendedSide),
    f5Confidence: stringOrNull(f5Unified?.confidence),
    f5TotalRunsEstimated: numberOrNull(markets?.f5TotalRunsEstimated, 2),
    earlyConfidence: stringOrNull(markets?.confidence),
    earlyDataIncomplete: booleanOrNull(markets?.dataIncomplete),
    earlyWarnings: stringArray(markets?.warnings).slice(0, 12),
    finalRecommendation: finalRecommendation ? {
      market: stringOrNull(finalRecommendation.market),
      side: stringOrNull(finalRecommendation.side),
      action: stringOrNull(finalRecommendation.action),
      reason: stringOrNull(finalRecommendation.reason),
      isPremium: booleanOrNull(finalRecommendation.isPremium),
    } : null,
  };
}

export type MlbEarlyEngineCaptureProjection = NonNullable<ReturnType<typeof projectMlbEarlyEngineCapture>>;

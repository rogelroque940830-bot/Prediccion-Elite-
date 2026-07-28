export interface MlbPhaseBFeedLike {
  autoApplyAllowed: boolean;
  phaseB?: {
    enabled: boolean;
    eligiblePlayerNames: string[];
    scale: number;
    maxAbsRuns: number;
  };
}

export interface MlbPhaseBRosterPlayer {
  name: string;
  isPitcher: boolean;
}

export interface MlbPhaseBBullpenSide {
  runsAdjustment?: number | null;
}

export interface MlbPhaseBSelection {
  appliedNames: string[];
  withheldNames: string[];
  blockedReason: string | null;
}

export function resolveMlbPhaseBSelection(
  roster: MlbPhaseBRosterPlayer[],
  feed: MlbPhaseBFeedLike,
  bullpenSide: MlbPhaseBBullpenSide | null | undefined,
): MlbPhaseBSelection {
  const plan = feed.phaseB;
  const eligible = new Set(plan?.eligiblePlayerNames ?? []);
  const knownEligiblePitchers = roster
    .filter((player) => player.isPitcher && eligible.has(player.name))
    .map((player) => player.name);

  if (!plan?.enabled || !feed.autoApplyAllowed || knownEligiblePitchers.length === 0) {
    return { appliedNames: [], withheldNames: Array.from(eligible), blockedReason: null };
  }

  if (!bullpenSide) {
    return {
      appliedNames: [],
      withheldNames: knownEligiblePitchers,
      blockedReason: "BULLPEN_STATUS_UNAVAILABLE",
    };
  }

  if (Number(bullpenSide.runsAdjustment ?? 0) > 0) {
    return {
      appliedNames: [],
      withheldNames: knownEligiblePitchers,
      blockedReason: "BULLPEN_EFFECT_ALREADY_APPLIED",
    };
  }

  return { appliedNames: knownEligiblePitchers, withheldNames: [], blockedReason: null };
}

export function scaleMlbPhaseBRuns(rawRuns: number, scale: number, maxAbsRuns: number): number {
  if (!Number.isFinite(rawRuns) || rawRuns >= 0) return 0;
  const safeScale = Math.max(0, Math.min(1, Number.isFinite(scale) ? scale : 0));
  const safeCap = Math.max(0, Number.isFinite(maxAbsRuns) ? Math.abs(maxAbsRuns) : 0);
  if (safeScale === 0 || safeCap === 0) return 0;
  return Math.max(-safeCap, rawRuns * safeScale);
}

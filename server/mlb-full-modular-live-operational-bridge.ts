import {
  MLB_FULL13_FEATURE_NAMES,
  buildMlbFull13LiveFeatures,
  type MlbFull13LiveFeatureAssessment,
  type MlbFull13LivePregameInput,
} from "./mlb-full13-live-feature-builder";
import {
  FROZEN_V39_FEATURES,
  V66_QUALITY_FEATURE_NAMES,
  buildFullModularMechanisticFeatures,
  buildV66BullpenProfile,
  computeV62StarterPitchQuality,
  scoreFrozenV39ExpectedOuts,
  type BullpenProfile,
  type BullpenUsageGame,
  type FrozenV39FeatureName,
  type PitchQualityHistoryGame,
  type StarterPitchQuality,
} from "./mlb-full-modular-mechanistic-feature-builder";

export const MLB_FULL_MODULAR_LIVE_OPERATIONAL_BRIDGE_VERSION =
  "mlb-full-modular-live-operational-parity-v1" as const;
export const MLB_FULL_MODULAR_DECISION_LEAD_MINUTES = 5 as const;

export const FULL_MODULAR_LIVE_NO_PLAY_REASONS = [
  "DECISION_TIMESTAMP_MISSING_OR_LATE",
  "PROBABLE_STARTER_UNAVAILABLE",
  "CONFIRMED_LINEUP_UNAVAILABLE",
  "FULL13_PRIOR_KNOWLEDGE_MISSING",
  "V39_REQUIRED_RAW_FEATURE_MISSING",
  "V39_SOURCE_NOT_PRIOR_DATE",
  "V62_REQUIRED_STARTER_QUALITY_MISSING",
  "V62_SOURCE_NOT_PRIOR_DATE",
  "V66_REQUIRED_BULLPEN_WORKLOAD_MISSING",
  "V66_SOURCE_NOT_PRIOR_DATE",
  "FULL_MODULAR_REQUIRED_LIVE_INPUT_MISSING",
  "SOURCE_INTEGRITY_FAILED",
] as const;

export type FullModularLiveNoPlayReason =
  (typeof FULL_MODULAR_LIVE_NO_PLAY_REASONS)[number];

export interface FrozenV39LiveSideInput {
  asOfDate: string;
  features: Partial<Record<FrozenV39FeatureName, number | null>>;
}

export interface FullModularLiveOperationalInput {
  observedAtUtc: string;
  scheduledFirstPitchUtc: string;
  full13: MlbFull13LivePregameInput;
  v39: {
    home: FrozenV39LiveSideInput;
    away: FrozenV39LiveSideInput;
  };
  pitchQualityHistory: PitchQualityHistoryGame[];
  bullpen: {
    homeHistory: BullpenUsageGame[];
    awayHistory: BullpenUsageGame[];
  };
}

export interface FullModularLiveReadyAssessment {
  status: "READY";
  bridgeVersion: typeof MLB_FULL_MODULAR_LIVE_OPERATIONAL_BRIDGE_VERSION;
  officialDate: string;
  gamePk: number;
  observedAtUtc: string;
  decisionDeadlineUtc: string;
  full13: MlbFull13LiveFeatureAssessment;
  expectedStarterOuts: {
    home: number;
    away: number;
  };
  starterQuality: {
    home: StarterPitchQuality;
    away: StarterPitchQuality;
  };
  bullpenProfiles: {
    home: BullpenProfile;
    away: BullpenProfile;
  };
  featureVector: Readonly<Record<string, number>>;
  diagnostics: {
    failClosed: true;
    sameDateHistoryAllowed: false;
    outcomeFieldsUsed: readonly [];
    sportsbookPriceFieldsUsed: readonly [];
    v39RuntimeFitAllowed: false;
    v39RuntimePreprocessingFitAllowed: false;
    mechanisticBuilderFinalAuthority: true;
  };
}

export interface FullModularLiveNoPlayAssessment {
  status: "NO_PLAY";
  bridgeVersion: typeof MLB_FULL_MODULAR_LIVE_OPERATIONAL_BRIDGE_VERSION;
  officialDate: string | null;
  gamePk: number | null;
  reason: FullModularLiveNoPlayReason;
  detail?: string;
  diagnostics: {
    failClosed: true;
    sameDateHistoryAllowed: false;
    outcomeFieldsUsed: readonly [];
    sportsbookPriceFieldsUsed: readonly [];
  };
}

export type FullModularLiveOperationalAssessment =
  | FullModularLiveReadyAssessment
  | FullModularLiveNoPlayAssessment;

const ROOT_FORBIDDEN_KEYS = new Set([
  "targetOutcome",
  "outcome",
  "result",
  "winner",
  "homeScore",
  "awayScore",
  "finalScore",
  "moneyline",
  "odds",
  "price",
  "sportsbookPrice",
  "marketPrice",
]);

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function validLineup(order: unknown): order is number[] {
  return Array.isArray(order) &&
    order.length === 9 &&
    new Set(order).size === 9 &&
    order.every((value) => Number.isInteger(value) && Number(value) > 0);
}

function noPlay(
  input: Partial<FullModularLiveOperationalInput> | null | undefined,
  reason: FullModularLiveNoPlayReason,
  detail?: string,
): FullModularLiveNoPlayAssessment {
  const full13 = input && typeof input === "object" ? input.full13 : undefined;
  return Object.freeze({
    status: "NO_PLAY",
    bridgeVersion: MLB_FULL_MODULAR_LIVE_OPERATIONAL_BRIDGE_VERSION,
    officialDate: full13 && validDate(full13.officialDate) ? full13.officialDate : null,
    gamePk: full13 && Number.isInteger(full13.gamePk) && full13.gamePk > 0 ? full13.gamePk : null,
    reason,
    ...(detail ? { detail } : {}),
    diagnostics: Object.freeze({
      failClosed: true,
      sameDateHistoryAllowed: false,
      outcomeFieldsUsed: Object.freeze([]) as readonly [],
      sportsbookPriceFieldsUsed: Object.freeze([]) as readonly [],
    }),
  });
}

function containsForbiddenRootKey(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (ROOT_FORBIDDEN_KEYS.has(key)) return key;
  }
  return null;
}

function allRequiredV39KeysPresent(
  features: Partial<Record<FrozenV39FeatureName, number | null>> | null | undefined,
): boolean {
  if (!features || typeof features !== "object") return false;
  return FROZEN_V39_FEATURES.every((name) =>
    Object.prototype.hasOwnProperty.call(features, name),
  );
}

function firstNotPriorDate(
  rows: Array<{ officialDate: string }> | null | undefined,
  targetDate: string,
): string | null {
  if (!Array.isArray(rows)) return "__MISSING__";
  for (const row of rows) {
    if (!row || !validDate(row.officialDate) || row.officialDate >= targetDate) {
      return row?.officialDate ?? "__INVALID__";
    }
  }
  return null;
}

function completeFiniteRecord(record: Record<string, number | null>): record is Record<string, number> {
  return Object.values(record).every((value) => finite(value));
}

function classifyFull13Error(message: string): FullModularLiveNoPlayReason {
  if (
    message.includes("HISTORY_NOT_STRICTLY_PREGAME") ||
    message.includes("CROSS_SEASON_HISTORY_FORBIDDEN") ||
    message.includes("PITCHER_") ||
    message.includes("NONFINITE") ||
    message.includes("NEGATIVE_PITCHER_STAT")
  ) {
    return "FULL13_PRIOR_KNOWLEDGE_MISSING";
  }
  if (message.includes("LINEUP") || message.includes("PLAYER_ID")) {
    return "CONFIRMED_LINEUP_UNAVAILABLE";
  }
  return "SOURCE_INTEGRITY_FAILED";
}

export function assessFullModularLiveOperationalParity(
  input: FullModularLiveOperationalInput,
): FullModularLiveOperationalAssessment {
  try {
    if (!input || typeof input !== "object" || !input.full13) {
      return noPlay(input, "FULL_MODULAR_REQUIRED_LIVE_INPUT_MISSING");
    }

    const forbiddenRoot = containsForbiddenRootKey(input);
    if (forbiddenRoot) {
      return noPlay(input, "SOURCE_INTEGRITY_FAILED", `FORBIDDEN_ROOT_FIELD:${forbiddenRoot}`);
    }

    const officialDate = input.full13.officialDate;
    if (!validDate(officialDate) || !Number.isInteger(input.full13.gamePk) || input.full13.gamePk <= 0) {
      return noPlay(input, "SOURCE_INTEGRITY_FAILED", "INVALID_GAME_IDENTITY");
    }

    const observedMs = Date.parse(input.observedAtUtc);
    const firstPitchMs = Date.parse(input.scheduledFirstPitchUtc);
    if (!Number.isFinite(observedMs) || !Number.isFinite(firstPitchMs)) {
      return noPlay(input, "DECISION_TIMESTAMP_MISSING_OR_LATE", "INVALID_TIMESTAMP");
    }
    const deadlineMs = firstPitchMs - MLB_FULL_MODULAR_DECISION_LEAD_MINUTES * 60_000;
    if (observedMs > deadlineMs) {
      return noPlay(input, "DECISION_TIMESTAMP_MISSING_OR_LATE");
    }

    if (
      !Number.isInteger(input.full13.homeStarterId) || Number(input.full13.homeStarterId) <= 0 ||
      !Number.isInteger(input.full13.awayStarterId) || Number(input.full13.awayStarterId) <= 0
    ) {
      return noPlay(input, "PROBABLE_STARTER_UNAVAILABLE");
    }
    if (!validLineup(input.full13.homeBattingOrder) || !validLineup(input.full13.awayBattingOrder)) {
      return noPlay(input, "CONFIRMED_LINEUP_UNAVAILABLE");
    }

    if (!input.v39?.home || !input.v39?.away) {
      return noPlay(input, "V39_REQUIRED_RAW_FEATURE_MISSING");
    }
    if (!allRequiredV39KeysPresent(input.v39.home.features) || !allRequiredV39KeysPresent(input.v39.away.features)) {
      return noPlay(input, "V39_REQUIRED_RAW_FEATURE_MISSING");
    }
    if (
      !validDate(input.v39.home.asOfDate) || !validDate(input.v39.away.asOfDate) ||
      input.v39.home.asOfDate >= officialDate || input.v39.away.asOfDate >= officialDate
    ) {
      return noPlay(input, "V39_SOURCE_NOT_PRIOR_DATE");
    }

    const v62Leak = firstNotPriorDate(input.pitchQualityHistory, officialDate);
    if (v62Leak !== null) {
      return noPlay(
        input,
        v62Leak === "__MISSING__" ? "V62_REQUIRED_STARTER_QUALITY_MISSING" : "V62_SOURCE_NOT_PRIOR_DATE",
        v62Leak,
      );
    }
    const homeBullpenLeak = firstNotPriorDate(input.bullpen?.homeHistory, officialDate);
    const awayBullpenLeak = firstNotPriorDate(input.bullpen?.awayHistory, officialDate);
    if (homeBullpenLeak !== null || awayBullpenLeak !== null) {
      const missing = homeBullpenLeak === "__MISSING__" || awayBullpenLeak === "__MISSING__";
      return noPlay(
        input,
        missing ? "V66_REQUIRED_BULLPEN_WORKLOAD_MISSING" : "V66_SOURCE_NOT_PRIOR_DATE",
        homeBullpenLeak ?? awayBullpenLeak ?? undefined,
      );
    }

    let full13Assessment: MlbFull13LiveFeatureAssessment;
    try {
      full13Assessment = buildMlbFull13LiveFeatures(input.full13);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return noPlay(input, classifyFull13Error(message), message);
    }

    for (const name of MLB_FULL13_FEATURE_NAMES) {
      if (!finite(full13Assessment.featureVector[name])) {
        return noPlay(input, "FULL13_PRIOR_KNOWLEDGE_MISSING", `NONFINITE_FULL13:${name}`);
      }
    }

    const homeExpectedOuts = scoreFrozenV39ExpectedOuts(input.v39.home.features);
    const awayExpectedOuts = scoreFrozenV39ExpectedOuts(input.v39.away.features);

    const homeStarterQuality = computeV62StarterPitchQuality({
      starterId: input.full13.homeStarterId as number,
      targetOfficialDate: officialDate,
      history: input.pitchQualityHistory,
    });
    const awayStarterQuality = computeV62StarterPitchQuality({
      starterId: input.full13.awayStarterId as number,
      targetOfficialDate: officialDate,
      history: input.pitchQualityHistory,
    });
    if (!homeStarterQuality || !awayStarterQuality) {
      return noPlay(input, "V62_REQUIRED_STARTER_QUALITY_MISSING");
    }

    const homeBullpenProfile = buildV66BullpenProfile(input.bullpen.homeHistory, officialDate);
    const awayBullpenProfile = buildV66BullpenProfile(input.bullpen.awayHistory, officialDate);
    if (homeBullpenProfile.priorGames30d < 1 || awayBullpenProfile.priorGames30d < 1) {
      return noPlay(input, "V66_REQUIRED_BULLPEN_WORKLOAD_MISSING");
    }

    const mechanistic = buildFullModularMechanisticFeatures({
      homeExpectedOuts,
      awayExpectedOuts,
      homeStarterQuality,
      awayStarterQuality,
      homeBullpenProfile,
      awayBullpenProfile,
    });
    for (const name of V66_QUALITY_FEATURE_NAMES) {
      if (!finite(mechanistic[name])) {
        return noPlay(input, "V62_REQUIRED_STARTER_QUALITY_MISSING", `NONFINITE_V62:${name}`);
      }
    }
    if (!completeFiniteRecord(mechanistic)) {
      return noPlay(input, "FULL_MODULAR_REQUIRED_LIVE_INPUT_MISSING", "NONFINITE_MECHANISTIC_FEATURE");
    }

    const featureVector: Record<string, number> = {};
    for (const name of MLB_FULL13_FEATURE_NAMES) {
      featureVector[name] = full13Assessment.featureVector[name] as number;
    }
    for (const [key, value] of Object.entries(mechanistic)) featureVector[key] = value as number;

    return Object.freeze({
      status: "READY",
      bridgeVersion: MLB_FULL_MODULAR_LIVE_OPERATIONAL_BRIDGE_VERSION,
      officialDate,
      gamePk: input.full13.gamePk,
      observedAtUtc: new Date(observedMs).toISOString(),
      decisionDeadlineUtc: new Date(deadlineMs).toISOString(),
      full13: full13Assessment,
      expectedStarterOuts: Object.freeze({ home: homeExpectedOuts, away: awayExpectedOuts }),
      starterQuality: Object.freeze({ home: homeStarterQuality, away: awayStarterQuality }),
      bullpenProfiles: Object.freeze({ home: homeBullpenProfile, away: awayBullpenProfile }),
      featureVector: Object.freeze(featureVector),
      diagnostics: Object.freeze({
        failClosed: true,
        sameDateHistoryAllowed: false,
        outcomeFieldsUsed: Object.freeze([]) as readonly [],
        sportsbookPriceFieldsUsed: Object.freeze([]) as readonly [],
        v39RuntimeFitAllowed: false,
        v39RuntimePreprocessingFitAllowed: false,
        mechanisticBuilderFinalAuthority: true,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return noPlay(input, "SOURCE_INTEGRITY_FAILED", message);
  }
}

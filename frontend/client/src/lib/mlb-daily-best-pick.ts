export const MLB_DAILY_BEST_PICK_UI_SCHEMA = "courtedge-mlb-daily-best-pick-ui.v1" as const;

export type MlbDailyBestPickMarket = "FIRST_5_ML" | "FULL_GAME_ML";
export type MlbDailyBestPickTier = "A_PLUS" | "PREMIUM";
export type MlbDailyBestPickRoute =
  | "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1"
  | "PREMIUM_A_HOME_ML";

export interface MlbDailyBestPickUiView {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_UI_SCHEMA;
  decision: "BEST_PICK" | "NO_PLAY";
  pick: null | {
    gamePk: number;
    awayTeam: string;
    homeTeam: string;
    market: MlbDailyBestPickMarket;
    side: "HOME";
    route: MlbDailyBestPickRoute;
    tier: MlbDailyBestPickTier;
    prepriceRank: number;
  };
  audit: {
    readyAPlusEvaluations: number;
    readyPremiumEvaluations: number;
    provisionalRowsSkipped: number;
    frozenRouteMatchesOutsideRankedPreprice: number;
  };
  policy: {
    trustedUnifiedPrepriceRuntimeOnly: true;
    finalFrozenInputsOnly: true;
    aPlusAlwaysPrecedesPremium: true;
    existingPrepriceRankPreservedWithinTier: true;
    generalV68FallbackAllowed: false;
    v80Read: false;
    v80Changed: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export type MlbDailyBestPickDisplay =
  | {
      state: "BEST_PICK";
      title: "DAILY BEST PICK";
      badge: string;
      matchup: string;
      selectedTeam: string;
      marketLabel: string;
      tierLabel: string;
      rankLabel: string;
      route: MlbDailyBestPickRoute;
      message: string;
      audit: MlbDailyBestPickUiView["audit"];
    }
  | {
      state: "NO_PLAY";
      title: "DAILY BEST PICK · NO PLAY";
      badge: "PRE-PRICE";
      message: string;
      audit: MlbDailyBestPickUiView["audit"];
    }
  | {
      state: "UNAVAILABLE";
      title: "DAILY BEST PICK NO DISPONIBLE";
      badge: "FAIL CLOSED";
      message: string;
      audit: null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseAudit(value: unknown): MlbDailyBestPickUiView["audit"] | null {
  if (!isRecord(value)) return null;
  const keys = [
    "readyAPlusEvaluations",
    "readyPremiumEvaluations",
    "provisionalRowsSkipped",
    "frozenRouteMatchesOutsideRankedPreprice",
  ] as const;
  if (!keys.every((key) => isNonNegativeInteger(value[key]))) return null;
  return {
    readyAPlusEvaluations: value.readyAPlusEvaluations as number,
    readyPremiumEvaluations: value.readyPremiumEvaluations as number,
    provisionalRowsSkipped: value.provisionalRowsSkipped as number,
    frozenRouteMatchesOutsideRankedPreprice: value.frozenRouteMatchesOutsideRankedPreprice as number,
  };
}

function frozenPolicyIsIntact(value: unknown): value is MlbDailyBestPickUiView["policy"] {
  if (!isRecord(value)) return false;
  return value.trustedUnifiedPrepriceRuntimeOnly === true
    && value.finalFrozenInputsOnly === true
    && value.aPlusAlwaysPrecedesPremium === true
    && value.existingPrepriceRankPreservedWithinTier === true
    && value.generalV68FallbackAllowed === false
    && value.v80Read === false
    && value.v80Changed === false
    && value.automaticBetPlacement === false
    && value.realFinancialExposure === 0;
}

function parsePick(value: unknown): NonNullable<MlbDailyBestPickUiView["pick"]> | null {
  if (!isRecord(value)) return null;
  if (!isNonNegativeInteger(value.gamePk) || value.gamePk === 0) return null;
  if (!nonEmptyString(value.awayTeam) || !nonEmptyString(value.homeTeam)) return null;
  if (!isNonNegativeInteger(value.prepriceRank)) return null;
  if (value.side !== "HOME") return null;

  if (value.route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1") {
    if (value.tier !== "A_PLUS") return null;
    if (value.market !== "FIRST_5_ML" && value.market !== "FULL_GAME_ML") return null;
  } else if (value.route === "PREMIUM_A_HOME_ML") {
    if (value.tier !== "PREMIUM") return null;
    if (value.market !== "FULL_GAME_ML") return null;
  } else {
    return null;
  }

  return {
    gamePk: value.gamePk,
    awayTeam: value.awayTeam.trim(),
    homeTeam: value.homeTeam.trim(),
    market: value.market,
    side: "HOME",
    route: value.route,
    tier: value.tier,
    prepriceRank: value.prepriceRank,
  } as NonNullable<MlbDailyBestPickUiView["pick"]>;
}

export function parseMlbDailyBestPickUiView(value: unknown): MlbDailyBestPickUiView | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== MLB_DAILY_BEST_PICK_UI_SCHEMA) return null;
  if (value.decision !== "BEST_PICK" && value.decision !== "NO_PLAY") return null;

  const audit = parseAudit(value.audit);
  if (!audit || !frozenPolicyIsIntact(value.policy)) return null;

  if (value.decision === "NO_PLAY") {
    if (value.pick !== null) return null;
    return {
      schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
      decision: "NO_PLAY",
      pick: null,
      audit,
      policy: value.policy,
    };
  }

  const pick = parsePick(value.pick);
  if (!pick) return null;
  return {
    schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
    decision: "BEST_PICK",
    pick,
    audit,
    policy: value.policy,
  };
}

function marketLabel(market: MlbDailyBestPickMarket): string {
  return market === "FIRST_5_ML" ? "First 5 ML" : "Full Game ML";
}

export function presentMlbDailyBestPick(value: unknown): MlbDailyBestPickDisplay {
  const parsed = parseMlbDailyBestPickUiView(value);
  if (!parsed) {
    return {
      state: "UNAVAILABLE",
      title: "DAILY BEST PICK NO DISPONIBLE",
      badge: "FAIL CLOSED",
      message: "La respuesta no contiene un Daily BEST PICK válido bajo el contrato congelado. No se infiere ninguna selección.",
      audit: null,
    };
  }

  if (parsed.decision === "NO_PLAY" || !parsed.pick) {
    return {
      state: "NO_PLAY",
      title: "DAILY BEST PICK · NO PLAY",
      badge: "PRE-PRICE",
      message: "No existe una ruta A+/Premium FINAL válida dentro de la población pre-price. El selector no fuerza una jugada.",
      audit: parsed.audit,
    };
  }

  const tierLabel = parsed.pick.tier === "A_PLUS" ? "A+" : "Premium";
  return {
    state: "BEST_PICK",
    title: "DAILY BEST PICK",
    badge: `${tierLabel} · PRE-PRICE`,
    matchup: `${parsed.pick.awayTeam} @ ${parsed.pick.homeTeam}`,
    selectedTeam: parsed.pick.homeTeam,
    marketLabel: marketLabel(parsed.pick.market),
    tierLabel,
    rankLabel: `#${parsed.pick.prepriceRank + 1}`,
    route: parsed.pick.route,
    message: "Selección deportiva derivada solo de inputs FINAL congelados. La cuota no participa en esta elección; no calcula stake ni ejecuta apuestas.",
    audit: parsed.audit,
  };
}

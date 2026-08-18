export const MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA = "courtedge-mlb-daily-best-pick-price-view.v1" as const;

export type MlbDailyBestPickPriceDecision =
  | "ELITE_EVIDENCE_CANDIDATE"
  | "POSITIVE_EV_ENVELOPE_BLOCKED"
  | "NO_POSITIVE_EV"
  | "UPSTREAM_BLOCKED"
  | "PRICE_EVIDENCE_UNAVAILABLE"
  | "NOT_APPLICABLE";

export interface MlbDailyBestPickPriceView {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA;
  decision: MlbDailyBestPickPriceDecision;
  pick: null | {
    gamePk: number;
    market: "FIRST_5_ML" | "FULL_GAME_ML";
    canonicalMarketType: "F5_ML" | "ML";
    side: "HOME";
    route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" | "PREMIUM_A_HOME_ML";
    tier: "A_PLUS" | "PREMIUM";
    prepriceRank: number;
  };
  execution: null | {
    bookKey: string;
    bookTitle: string;
    oddsAmerican: number;
    capturedAt: string;
    providerLastUpdate: string | null;
  };
  economics: null | {
    modelWinProbability: number | null;
    modelPushProbability: number | null;
    expectedValuePerUnit: number | null;
    executionEdgePp: number | null;
    executionNoVigEdgePp: number | null;
    referenceNoVigEdgePp: number | null;
    referenceAgreement: string;
  };
  blockers: readonly string[];
  warnings: readonly string[];
  audit: {
    exactEnvelopeMarketMatches: number;
    exactMarketEdgeMatches: number;
    otherGameMarketsIgnored: number;
    otherSelectedGameMarketsIgnored: number;
  };
  policy: {
    trustedPricedV16RuntimeOnly: true;
    exactDailyBestPickIdentityOnly: true;
    sportingSelectionChangedByPrice: false;
    fallbackToAnotherGameAllowed: false;
    fallbackToAnotherMarketAllowed: false;
    newThresholdAdded: false;
    fixedEvThresholdAdded: false;
    fixedProbabilityThresholdAdded: false;
    betEliteLabelProduced: false;
    finalBetRecommendationProduced: false;
    stakeCalculated: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export type MlbDailyBestPickPriceDisplay = {
  state: MlbDailyBestPickPriceDecision | "UNAVAILABLE";
  title: string;
  badge: string;
  message: string;
  executionLabel: string | null;
  modelProbabilityLabel: string | null;
  evLabel: string | null;
  edgeLabel: string | null;
  blockers: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function safePolicy(value: unknown): value is MlbDailyBestPickPriceView["policy"] {
  if (!isRecord(value)) return false;
  return value.trustedPricedV16RuntimeOnly === true
    && value.exactDailyBestPickIdentityOnly === true
    && value.sportingSelectionChangedByPrice === false
    && value.fallbackToAnotherGameAllowed === false
    && value.fallbackToAnotherMarketAllowed === false
    && value.newThresholdAdded === false
    && value.fixedEvThresholdAdded === false
    && value.fixedProbabilityThresholdAdded === false
    && value.betEliteLabelProduced === false
    && value.finalBetRecommendationProduced === false
    && value.stakeCalculated === false
    && value.automaticBetPlacement === false
    && value.realFinancialExposure === 0;
}

function parsePick(value: unknown): MlbDailyBestPickPriceView["pick"] | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (!nonNegativeInteger(value.gamePk) || value.gamePk === 0) return undefined;
  if (!nonNegativeInteger(value.prepriceRank)) return undefined;
  if (value.side !== "HOME") return undefined;
  if (value.market !== "FIRST_5_ML" && value.market !== "FULL_GAME_ML") return undefined;
  const expectedCanonical = value.market === "FIRST_5_ML" ? "F5_ML" : "ML";
  if (value.canonicalMarketType !== expectedCanonical) return undefined;
  if (value.route === "PREMIUM_A_HOME_ML") {
    if (value.tier !== "PREMIUM" || value.market !== "FULL_GAME_ML") return undefined;
  } else if (value.route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1") {
    if (value.tier !== "A_PLUS") return undefined;
  } else {
    return undefined;
  }
  return value as MlbDailyBestPickPriceView["pick"];
}

function parseExecution(value: unknown): MlbDailyBestPickPriceView["execution"] | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.bookKey !== "string" || !value.bookKey.trim()) return undefined;
  if (typeof value.bookTitle !== "string" || !value.bookTitle.trim()) return undefined;
  if (typeof value.oddsAmerican !== "number" || !Number.isFinite(value.oddsAmerican)) return undefined;
  if (typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) return undefined;
  if (value.providerLastUpdate !== null && (typeof value.providerLastUpdate !== "string" || !Number.isFinite(Date.parse(value.providerLastUpdate)))) return undefined;
  return value as MlbDailyBestPickPriceView["execution"];
}

function parseEconomics(value: unknown): MlbDailyBestPickPriceView["economics"] | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  for (const key of ["modelWinProbability", "modelPushProbability", "expectedValuePerUnit", "executionEdgePp", "executionNoVigEdgePp", "referenceNoVigEdgePp"] as const) {
    if (!finiteOrNull(value[key])) return undefined;
  }
  if (typeof value.referenceAgreement !== "string") return undefined;
  return value as unknown as MlbDailyBestPickPriceView["economics"];
}

function parseStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

export function parseMlbDailyBestPickPriceView(value: unknown): MlbDailyBestPickPriceView | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA) return null;
  const decisions: MlbDailyBestPickPriceDecision[] = [
    "ELITE_EVIDENCE_CANDIDATE",
    "POSITIVE_EV_ENVELOPE_BLOCKED",
    "NO_POSITIVE_EV",
    "UPSTREAM_BLOCKED",
    "PRICE_EVIDENCE_UNAVAILABLE",
    "NOT_APPLICABLE",
  ];
  if (!decisions.includes(value.decision as MlbDailyBestPickPriceDecision)) return null;
  if (!safePolicy(value.policy)) return null;

  const pick = parsePick(value.pick);
  const execution = parseExecution(value.execution);
  const economics = parseEconomics(value.economics);
  const blockers = parseStringArray(value.blockers);
  const warnings = parseStringArray(value.warnings);
  if (pick === undefined || execution === undefined || economics === undefined || blockers === null || warnings === null) return null;

  if (!isRecord(value.audit)
    || !nonNegativeInteger(value.audit.exactEnvelopeMarketMatches)
    || !nonNegativeInteger(value.audit.exactMarketEdgeMatches)
    || !nonNegativeInteger(value.audit.otherGameMarketsIgnored)
    || !nonNegativeInteger(value.audit.otherSelectedGameMarketsIgnored)) return null;

  if (value.decision === "NOT_APPLICABLE") {
    if (pick !== null || execution !== null || economics !== null) return null;
  } else if (value.decision === "PRICE_EVIDENCE_UNAVAILABLE") {
    if (execution !== null || economics !== null) return null;
  } else {
    if (pick === null || economics === null) return null;
  }

  return {
    schemaVersion: MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
    decision: value.decision as MlbDailyBestPickPriceDecision,
    pick,
    execution,
    economics,
    blockers,
    warnings,
    audit: {
      exactEnvelopeMarketMatches: value.audit.exactEnvelopeMarketMatches,
      exactMarketEdgeMatches: value.audit.exactMarketEdgeMatches,
      otherGameMarketsIgnored: value.audit.otherGameMarketsIgnored,
      otherSelectedGameMarketsIgnored: value.audit.otherSelectedGameMarketsIgnored,
    },
    policy: value.policy,
  };
}

function american(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function pct(value: number | null): string | null {
  return value == null ? null : `${(value * 100).toFixed(1)}%`;
}

function signedPp(value: number | null): string | null {
  return value == null ? null : `${value >= 0 ? "+" : ""}${value.toFixed(2)} pp`;
}

export function presentMlbDailyBestPickPrice(value: unknown): MlbDailyBestPickPriceDisplay {
  const parsed = parseMlbDailyBestPickPriceView(value);
  if (!parsed) {
    return {
      state: "UNAVAILABLE",
      title: "PRICE CHECK NO DISPONIBLE",
      badge: "FAIL CLOSED",
      message: "La evidencia de precio no cumple el contrato seguro. El BEST PICK pre-price no cambia.",
      executionLabel: null,
      modelProbabilityLabel: null,
      evLabel: null,
      edgeLabel: null,
      blockers: [],
    };
  }

  if (parsed.decision === "NOT_APPLICABLE") {
    return {
      state: parsed.decision,
      title: "PRICE CHECK · NO APLICA",
      badge: "NO PLAY",
      message: "No existe Daily BEST PICK, por lo que no se evalúa precio.",
      executionLabel: null,
      modelProbabilityLabel: null,
      evLabel: null,
      edgeLabel: null,
      blockers: parsed.blockers,
    };
  }

  const executionLabel = parsed.execution ? `${parsed.execution.bookTitle} ${american(parsed.execution.oddsAmerican)}` : null;
  const modelProbabilityLabel = parsed.economics ? pct(parsed.economics.modelWinProbability) : null;
  const evLabel = parsed.economics ? pct(parsed.economics.expectedValuePerUnit) : null;
  const edgeLabel = parsed.economics ? signedPp(parsed.economics.executionEdgePp) : null;

  if (parsed.decision === "ELITE_EVIDENCE_CANDIDATE") {
    return {
      state: parsed.decision,
      title: "PRICE CHECK · EVIDENCIA ELITE",
      badge: "PRICE PASS",
      message: "El mismo BEST PICK supera el operating envelope vigente con precio ejecutable y EV positivo. Esto aún no produce BET_ELITE, stake ni apuesta automática.",
      executionLabel,
      modelProbabilityLabel,
      evLabel,
      edgeLabel,
      blockers: parsed.blockers,
    };
  }

  if (parsed.decision === "NO_POSITIVE_EV") {
    return {
      state: parsed.decision,
      title: "PRICE CHECK · SIN EV POSITIVO",
      badge: "PRICE BLOCKED",
      message: "La predicción deportiva se conserva, pero la cuota actual no ofrece EV positivo para ese mismo mercado.",
      executionLabel,
      modelProbabilityLabel,
      evLabel,
      edgeLabel,
      blockers: parsed.blockers,
    };
  }

  if (parsed.decision === "POSITIVE_EV_ENVELOPE_BLOCKED") {
    return {
      state: parsed.decision,
      title: "PRICE CHECK · +EV BLOQUEADO",
      badge: "ENVELOPE BLOCK",
      message: "Existe EV positivo, pero el operating envelope vigente bloquea el mismo BEST PICK. No se sustituye por otro juego.",
      executionLabel,
      modelProbabilityLabel,
      evLabel,
      edgeLabel,
      blockers: parsed.blockers,
    };
  }

  if (parsed.decision === "UPSTREAM_BLOCKED") {
    return {
      state: parsed.decision,
      title: "PRICE CHECK · BLOQUEADO",
      badge: "UPSTREAM",
      message: "La cadena de precio/modelo quedó bloqueada antes de completar la evidencia económica del mismo BEST PICK.",
      executionLabel,
      modelProbabilityLabel,
      evLabel,
      edgeLabel,
      blockers: parsed.blockers,
    };
  }

  return {
    state: parsed.decision,
    title: "PRICE CHECK · EVIDENCIA NO DISPONIBLE",
    badge: "NO FALLBACK",
    message: "No existe evidencia económica exacta para el juego/mercado/lado del BEST PICK. No se usa otro juego ni otro mercado.",
    executionLabel: null,
    modelProbabilityLabel: null,
    evLabel: null,
    edgeLabel: null,
    blockers: parsed.blockers,
  };
}

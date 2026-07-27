const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export type MlbInjuryShadowDecision =
  | "APPLY_CANDIDATE"
  | "ALREADY_REFLECTED"
  | "IGNORE"
  | "CONFLICT"
  | "PENDING";

export type MlbInjuryShadowConfidence = "HIGH" | "MEDIUM" | "LOW";
export type MlbInjuryShadowImpact = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface MlbOfficialTransactionEvidence {
  date?: string | null;
  effectiveDate?: string | null;
  typeCode?: string | null;
  typeDesc?: string | null;
  description?: string | null;
}

export interface MlbOfficialRosterEvidence {
  playerId: number;
  name: string;
  statusCode: string;
  statusDescription: string;
  position?: string | null;
}

export interface MlbOfficialInjurySnapshot {
  status: "VERIFIED" | "PARTIAL";
  source: "MLB_STATS";
  fetchedAt: string;
  rosterByPlayerId: Record<number, MlbOfficialRosterEvidence>;
  latestTransactionByPlayerId: Record<number, MlbOfficialTransactionEvidence>;
  errors: string[];
}

export interface MlbInjuryShadowInput {
  playerId: number;
  name: string;
  isPitcher: boolean;
  position?: string | null;
  rosterStatusCode?: string | null;
  rosterStatusDescription?: string | null;
  latestTransaction?: MlbOfficialTransactionEvidence | null;
  probablePitcherId?: number | null;
  gamesStarted?: number | null;
  saves?: number | null;
  holds?: number | null;
  gamesFinished?: number | null;
  inningsPitched?: number | null;
  plateAppearances?: number | null;
  ops?: number | null;
  obp?: number | null;
  slg?: number | null;
  asOfDate: string;
}

export interface MlbInjuryShadowResult {
  decision: MlbInjuryShadowDecision;
  confidence: MlbInjuryShadowConfidence;
  impact: MlbInjuryShadowImpact;
  reasonCode: string;
  reason: string;
  officialStatusCode: string | null;
  officialStatus: string | null;
  daysSinceOfficialTransaction: number | null;
  shadowOnly: true;
}

export interface MlbInjuryShadowSummary {
  total: number;
  applyCandidates: number;
  alreadyReflected: number;
  ignored: number;
  conflicts: number;
  pending: number;
  highConfidence: number;
  mode: "SHADOW";
}

const snapshotCache = new Map<string, { ts: number; data: MlbOfficialInjurySnapshot }>();
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function subtractDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return isoDateOnly(parsed);
}

function transactionText(transaction?: MlbOfficialTransactionEvidence | null): string {
  return [transaction?.typeDesc, transaction?.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function daysBetweenIsoDates(earlier?: string | null, later?: string | null): number | null {
  if (!earlier || !later) return null;
  const a = new Date(`${earlier.slice(0, 10)}T12:00:00Z`).getTime();
  const b = new Date(`${later.slice(0, 10)}T12:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

function isOfficialIlStatus(code: string, description: string): boolean {
  return /^D\d+$/i.test(code) || /injured/i.test(description);
}

function isLongTermIl(code: string, description: string): boolean {
  return /^D60$/i.test(code) || /60[- ]day/i.test(description);
}

function isMinorLeagueStatus(code: string, description: string): boolean {
  return /^(RM|MIN|OPT)$/i.test(code) || /minor|reassigned|optioned/i.test(description);
}

function hitterImpact(input: MlbInjuryShadowInput): MlbInjuryShadowImpact {
  const pa = input.plateAppearances ?? 0;
  const ops = input.ops ?? 0;
  const obp = input.obp ?? 0;
  const slg = input.slg ?? 0;
  const production = ops || (obp + slg);
  if (pa >= 250 && production >= 0.760) return "HIGH";
  if (pa >= 150 && production >= 0.690) return "MEDIUM";
  return "LOW";
}

function pitcherRole(input: MlbInjuryShadowInput): "STARTER" | "HIGH_LEVERAGE" | "OTHER" {
  const starts = input.gamesStarted ?? 0;
  const saves = input.saves ?? 0;
  const holds = input.holds ?? 0;
  const finished = input.gamesFinished ?? 0;
  if (starts >= 5) return "STARTER";
  if (saves >= 5 || holds >= 8 || finished >= 10) return "HIGH_LEVERAGE";
  return "OTHER";
}

export function classifyMlbInjuryShadow(input: MlbInjuryShadowInput): MlbInjuryShadowResult {
  const code = normalizeText(input.rosterStatusCode).toUpperCase();
  const description = normalizeText(input.rosterStatusDescription);
  const txText = transactionText(input.latestTransaction);
  const txDate = input.latestTransaction?.effectiveDate || input.latestTransaction?.date || null;
  const daysSinceTransaction = daysBetweenIsoDates(txDate, input.asOfDate);
  const result = (
    decision: MlbInjuryShadowDecision,
    confidence: MlbInjuryShadowConfidence,
    impact: MlbInjuryShadowImpact,
    reasonCode: string,
    reason: string,
  ): MlbInjuryShadowResult => ({
    decision,
    confidence,
    impact,
    reasonCode,
    reason,
    officialStatusCode: code || null,
    officialStatus: description || null,
    daysSinceOfficialTransaction: daysSinceTransaction,
    shadowOnly: true,
  });

  if (/activated|reinstated|returned/.test(txText)) {
    return result(
      "CONFLICT",
      "HIGH",
      "NONE",
      "OFFICIAL_ACTIVATION_CONFLICT",
      "MLB registra una activación o regreso reciente; no se debe tratar automáticamente como lesionado.",
    );
  }

  if (code === "A" || /^active$/i.test(description)) {
    return result(
      "CONFLICT",
      "HIGH",
      "NONE",
      "OFFICIAL_ACTIVE_ROSTER_CONFLICT",
      "BALLDONTLIE reporta una ausencia, pero MLB lo mantiene en el roster activo.",
    );
  }

  if (isMinorLeagueStatus(code, description)) {
    return result(
      "IGNORE",
      "HIGH",
      "NONE",
      "NOT_ACTIVE_MLB_ROSTER",
      "El jugador figura reasignado u opcionado; no debe generar un ajuste de lesión del roster MLB activo.",
    );
  }

  if (isLongTermIl(code, description)) {
    return result(
      "IGNORE",
      "HIGH",
      "LOW",
      "LONG_TERM_IL_ALREADY_ADAPTED",
      "MLB confirma una ausencia de larga duración; el roster, las estadísticas y el mercado ya han tenido tiempo de adaptarse.",
    );
  }

  if (/rehab/.test(txText)) {
    return result(
      "PENDING",
      "HIGH",
      "LOW",
      "REHAB_ASSIGNMENT",
      "MLB registra una asignación de rehabilitación; sigue fuera, pero el regreso puede ser próximo y requiere observación.",
    );
  }

  if (!isOfficialIlStatus(code, description)) {
    return result(
      "PENDING",
      "LOW",
      "NONE",
      "NO_OFFICIAL_IL_CONFIRMATION",
      "No existe una confirmación oficial suficiente en el roster MLB para aplicar un ajuste automático.",
    );
  }

  if (daysSinceTransaction !== null && daysSinceTransaction >= 21) {
    return result(
      "PENDING",
      "MEDIUM",
      "LOW",
      "EXTENDED_ABSENCE_REQUIRES_DECAY",
      "La ausencia oficial lleva al menos tres semanas; antes de aplicar debe calibrarse cuánto impacto ya absorbieron las estadísticas y el mercado.",
    );
  }

  if (input.isPitcher) {
    if (input.probablePitcherId === input.playerId) {
      return result(
        "CONFLICT",
        "HIGH",
        "NONE",
        "INJURED_PLAYER_LISTED_AS_PROBABLE",
        "El jugador aparece en lista de lesionados y también como abridor probable; se bloquea cualquier ajuste.",
      );
    }
    const role = pitcherRole(input);
    if (role === "STARTER") {
      return result(
        "ALREADY_REFLECTED",
        "HIGH",
        "HIGH",
        "STARTER_REPLACEMENT_CAPTURED",
        "La ausencia del abridor queda capturada al usar las estadísticas del pitcher sustituto anunciado.",
      );
    }
    if (role === "HIGH_LEVERAGE") {
      return result(
        "APPLY_CANDIDATE",
        "HIGH",
        "MEDIUM",
        "OFFICIAL_IL_HIGH_LEVERAGE_RELIEVER",
        "MLB confirma la IL y el rol de bullpen es de alta importancia; candidato para ajuste automático conservador.",
      );
    }
    return result(
      "IGNORE",
      "MEDIUM",
      "LOW",
      "LOW_LEVERAGE_PITCHER",
      "MLB confirma la ausencia, pero el rol del pitcher no justifica un ajuste material independiente.",
    );
  }

  const impact = hitterImpact(input);
  if (impact === "HIGH") {
    return result(
      "APPLY_CANDIDATE",
      "HIGH",
      "HIGH",
      "OFFICIAL_IL_HIGH_IMPACT_HITTER",
      "MLB confirma la IL y la utilización/producción corresponden a un bateador de alto impacto.",
    );
  }
  if (impact === "MEDIUM") {
    return result(
      "APPLY_CANDIDATE",
      "MEDIUM",
      "MEDIUM",
      "OFFICIAL_IL_REGULAR_HITTER",
      "MLB confirma la IL y el jugador tiene utilización suficiente para evaluar un ajuste conservador.",
    );
  }
  return result(
    "IGNORE",
    "MEDIUM",
    "LOW",
    "LOW_USAGE_HITTER",
    "MLB confirma la ausencia, pero la utilización o producción no justifican un ajuste material.",
  );
}

export function summarizeMlbInjuryShadow(results: MlbInjuryShadowResult[]): MlbInjuryShadowSummary {
  return {
    total: results.length,
    applyCandidates: results.filter((item) => item.decision === "APPLY_CANDIDATE").length,
    alreadyReflected: results.filter((item) => item.decision === "ALREADY_REFLECTED").length,
    ignored: results.filter((item) => item.decision === "IGNORE").length,
    conflicts: results.filter((item) => item.decision === "CONFLICT").length,
    pending: results.filter((item) => item.decision === "PENDING").length,
    highConfidence: results.filter((item) => item.confidence === "HIGH").length,
    mode: "SHADOW",
  };
}

export async function fetchOfficialMlbInjurySnapshot(
  teamId: number,
  asOfDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MlbOfficialInjurySnapshot> {
  const cacheKey = `${teamId}::${asOfDate}`;
  const now = Date.now();
  const cached = snapshotCache.get(cacheKey);
  if (cached && now - cached.ts < SNAPSHOT_TTL_MS) return cached.data;

  const errors: string[] = [];
  const rosterByPlayerId: Record<number, MlbOfficialRosterEvidence> = {};
  const latestTransactionByPlayerId: Record<number, MlbOfficialTransactionEvidence> = {};
  const startDate = subtractDays(asOfDate, 120);

  try {
    const response = await fetchImpl(
      `${MLB_BASE}/teams/${teamId}/roster?rosterType=40Man&date=${encodeURIComponent(asOfDate)}`,
    );
    if (!response.ok) throw new Error(`MLB roster HTTP ${response.status}`);
    const payload: any = await response.json();
    for (const entry of payload?.roster ?? []) {
      const playerId = Number(entry?.person?.id);
      if (!Number.isFinite(playerId)) continue;
      rosterByPlayerId[playerId] = {
        playerId,
        name: normalizeText(entry?.person?.fullName),
        statusCode: normalizeText(entry?.status?.code),
        statusDescription: normalizeText(entry?.status?.description),
        position: normalizeText(entry?.position?.abbreviation) || null,
      };
    }
  } catch (error: any) {
    errors.push(String(error?.message || error || "MLB roster failure"));
  }

  try {
    const response = await fetchImpl(
      `${MLB_BASE}/transactions?teamId=${teamId}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(asOfDate)}`,
    );
    if (!response.ok) throw new Error(`MLB transactions HTTP ${response.status}`);
    const payload: any = await response.json();
    const transactions: any[] = Array.isArray(payload?.transactions) ? payload.transactions : [];
    transactions.sort((a, b) => {
      const aDate = String(a?.effectiveDate || a?.date || "");
      const bDate = String(b?.effectiveDate || b?.date || "");
      return bDate.localeCompare(aDate);
    });
    for (const transaction of transactions) {
      const playerId = Number(transaction?.person?.id);
      if (!Number.isFinite(playerId) || latestTransactionByPlayerId[playerId]) continue;
      latestTransactionByPlayerId[playerId] = {
        date: transaction?.date || null,
        effectiveDate: transaction?.effectiveDate || null,
        typeCode: transaction?.typeCode || null,
        typeDesc: transaction?.typeDesc || null,
        description: transaction?.description || null,
      };
    }
  } catch (error: any) {
    errors.push(String(error?.message || error || "MLB transactions failure"));
  }

  const data: MlbOfficialInjurySnapshot = {
    status: errors.length === 0 ? "VERIFIED" : "PARTIAL",
    source: "MLB_STATS",
    fetchedAt: new Date(now).toISOString(),
    rosterByPlayerId,
    latestTransactionByPlayerId,
    errors,
  };
  snapshotCache.set(cacheKey, { ts: now, data });
  return data;
}

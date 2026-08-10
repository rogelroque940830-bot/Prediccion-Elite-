import {
  daysBetweenIsoDates,
  type MlbInjuryShadowResult,
  type MlbOfficialInjurySnapshot,
  type MlbOfficialRosterEvidence,
  type MlbOfficialTransactionEvidence,
} from "./mlb-injury-shadow";
import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";

export const MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE = "MLB_STATS_OFFICIAL_SUPPLEMENT" as const;
export const MLB_OFFICIAL_INJURY_SUPPLEMENT_REASON = "OFFICIAL_SOURCE_SUPPLEMENT_EVIDENCE_ONLY" as const;
export const MLB_INJURY_IDENTITY_DIAGNOSTIC_SCHEMA = "courtedge-mlb-injury-identity-diagnostic.v1" as const;

export interface MlbOfficialInjurySupplementPlayer {
  playerId: number;
  name: string;
  position: string;
  status: string;
  isPitcher: boolean;
  source: typeof MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE;
  officialStatusCode: string | null;
  officialStatus: string | null;
  officialTransaction: MlbOfficialTransactionEvidence | null;
  shadow: MlbInjuryShadowResult;
}

export interface MlbOfficialInjurySupplementResult {
  sourceHealthy: boolean;
  rawOfficialOnlyCount: number;
  supplementedCount: number;
  unresolvedOfficialOnlyCount: number;
  coverageReconciled: boolean;
  supplements: MlbOfficialInjurySupplementPlayer[];
  reason:
    | "RECONCILED_WITH_MLB_OFFICIAL"
    | "NO_OFFICIAL_ONLY_GAP"
    | "SOURCE_NOT_HEALTHY"
    | "REJECTED_EXTERNAL_IDENTITY"
    | "ANOMALOUS_EXTERNAL_LIST";
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

export function isOfficialMlbInjuredRosterEntry(entry: MlbOfficialRosterEvidence): boolean {
  const code = normalize(entry.statusCode).toUpperCase();
  const description = normalize(entry.statusDescription);
  return /^D\d+$/i.test(code) || /injured/i.test(description);
}

function isPitcherPosition(position: unknown): boolean {
  const normalized = normalize(position).toUpperCase();
  return ["P", "SP", "RP", "LHP", "RHP"].includes(normalized) || /PITCHER/.test(normalized);
}

function evidenceOnlyShadow(
  roster: MlbOfficialRosterEvidence,
  transaction: MlbOfficialTransactionEvidence | null,
  asOfDate: string,
): MlbInjuryShadowResult {
  const transactionDate = transaction?.effectiveDate || transaction?.date || null;
  return {
    decision: "PENDING",
    confidence: "HIGH",
    impact: "NONE",
    reasonCode: MLB_OFFICIAL_INJURY_SUPPLEMENT_REASON,
    reason: "MLB official confirms the injured-roster identity. The record supplements source coverage only and is not eligible for automatic injury adjustment without the normal detector path.",
    officialStatusCode: normalize(roster.statusCode) || null,
    officialStatus: normalize(roster.statusDescription) || null,
    daysSinceOfficialTransaction: daysBetweenIsoDates(transactionDate, asOfDate),
    shadowOnly: true,
  };
}

export function reconcileMlbOfficialOnlyInjuries(input: {
  sourceStatus: string;
  stale?: boolean;
  anomalous?: boolean;
  rejectedCount?: number;
  officialSnapshot: MlbOfficialInjurySnapshot | null | undefined;
  existingPlayerIds: Iterable<number>;
  asOfDate: string;
}): MlbOfficialInjurySupplementResult {
  const existing = new Set(
    Array.from(input.existingPlayerIds)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
  const officialEntries = Object.values(input.officialSnapshot?.rosterByPlayerId ?? {})
    .filter(isOfficialMlbInjuredRosterEntry)
    .filter((entry) => !existing.has(Number(entry.playerId)))
    .filter((entry) => Number.isInteger(Number(entry.playerId)) && Number(entry.playerId) > 0)
    .filter((entry) => normalize(entry.name).length > 0)
    .sort((left, right) => Number(left.playerId) - Number(right.playerId));

  const rawOfficialOnlyCount = officialEntries.length;
  const sourceHealthy = input.sourceStatus === "VERIFIED"
    && input.officialSnapshot?.status === "VERIFIED"
    && input.stale !== true
    && (input.officialSnapshot?.errors?.length ?? 0) === 0;
  const rejectedCount = Math.max(0, Math.trunc(Number(input.rejectedCount) || 0));

  if (input.anomalous === true) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: rawOfficialOnlyCount,
      coverageReconciled: rawOfficialOnlyCount === 0,
      supplements: [],
      reason: "ANOMALOUS_EXTERNAL_LIST",
    };
  }
  if (rejectedCount > 0) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: rawOfficialOnlyCount,
      coverageReconciled: rawOfficialOnlyCount === 0,
      supplements: [],
      reason: "REJECTED_EXTERNAL_IDENTITY",
    };
  }
  if (!sourceHealthy) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: rawOfficialOnlyCount,
      coverageReconciled: rawOfficialOnlyCount === 0,
      supplements: [],
      reason: "SOURCE_NOT_HEALTHY",
    };
  }
  if (rawOfficialOnlyCount === 0) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount: 0,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: 0,
      coverageReconciled: true,
      supplements: [],
      reason: "NO_OFFICIAL_ONLY_GAP",
    };
  }

  const supplements = officialEntries.map((entry): MlbOfficialInjurySupplementPlayer => {
    const transaction = input.officialSnapshot?.latestTransactionByPlayerId?.[entry.playerId] ?? null;
    return {
      playerId: Number(entry.playerId),
      name: normalize(entry.name),
      position: normalize(entry.position),
      status: normalize(entry.statusDescription) || normalize(entry.statusCode),
      isPitcher: isPitcherPosition(entry.position),
      source: MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE,
      officialStatusCode: normalize(entry.statusCode) || null,
      officialStatus: normalize(entry.statusDescription) || null,
      officialTransaction: transaction,
      shadow: evidenceOnlyShadow(entry, transaction, input.asOfDate),
    };
  });

  return {
    sourceHealthy,
    rawOfficialOnlyCount,
    supplementedCount: supplements.length,
    unresolvedOfficialOnlyCount: Math.max(0, rawOfficialOnlyCount - supplements.length),
    coverageReconciled: supplements.length === rawOfficialOnlyCount,
    supplements,
    reason: "RECONCILED_WITH_MLB_OFFICIAL",
  };
}

// ---------------------------------------------------------------------------
// P1-M2B aggregate-only Railway research diagnostic.
// This mirrors the current BDL -> MLB identity gate but returns counts only.
// It does not change reconciliation, Phase B, model inputs or recommendations.
// ---------------------------------------------------------------------------

const DIAGNOSTIC_MLB_BASE = "https://statsapi.mlb.com/api/v1";
const DIAGNOSTIC_BDL_BASE = "https://api.balldontlie.io";
const DIAGNOSTIC_BDL_MLB_TEAM_TO_ID: Record<string, number> = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CHW: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133,
  PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120, WAS: 120,
};

type DiagnosticRejectReason =
  | "MISSING_NAME"
  | "SEARCH_TRANSPORT_FAILURE"
  | "SEARCH_EMPTY"
  | "EXACT_NAME_NOT_FOUND"
  | "EXACT_NAME_NO_CURRENT_TEAM"
  | "EXACT_NAME_WRONG_CURRENT_TEAM"
  | "STATS_ENRICHMENT_FAILURE";

interface DiagnosticRecord {
  teamId: number;
  name: string;
  isPitcher: boolean;
}

interface DiagnosticStrictResult {
  record: DiagnosticRecord;
  resolved: boolean;
  reason?: DiagnosticRejectReason;
}

interface DiagnosticOfficialAuthorityIndex {
  rosterByName: Map<string, Array<{ playerId: number; il: boolean }>>;
  transactionsByName: Map<string, number[]>;
  healthy: boolean;
}

export interface MlbInjuryIdentityDiagnostic {
  schemaVersion: typeof MLB_INJURY_IDENTITY_DIAGNOSTIC_SCHEMA;
  asOfDate: string;
  season: string;
  privacy: {
    aggregateOnly: true;
    playerNamesReturned: false;
    playerIdsReturned: false;
    credentialReturned: false;
  };
  source: {
    bdlPages: number;
    bdlTotalRecords: number;
    activeMappedBeforeDedupe: number;
    activeMappedAfterDedupe: number;
    teamsWithActiveRecords: number;
  };
  strictResolver: {
    resolved: number;
    rejected: number;
    rejectionReasons: Record<DiagnosticRejectReason, number>;
  };
  officialAuthority: {
    rejectedEvaluated: number;
    uniqueRosterExactName: number;
    uniqueRosterIlExactName: number;
    uniqueRosterNonIlExactName: number;
    uniqueTransactionExactNameOnly: number;
    ambiguousOfficialExactName: number;
    noOfficialExactName: number;
    authorityUnavailable: number;
    safelyResolvableIdentityTotal: number;
    remainingUnresolved: number;
  };
}

function diagnosticNormalizeName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function diagnosticDisplayName(injury: any): string {
  const player = injury?.player ?? {};
  return String(player.full_name || `${player.first_name || ""} ${player.last_name || ""}`.trim()).trim();
}

function diagnosticIsPitcherRecord(injury: any): boolean {
  const pos = String(injury?.player?.position || "").trim();
  const normalized = pos.toUpperCase();
  return /pitcher/i.test(pos) || ["P", "SP", "RP", "LHP", "RHP"].includes(normalized);
}

function diagnosticIsActiveMlbInjuryRecord(injury: any): boolean {
  const text = [
    injury?.status,
    injury?.type,
    injury?.detail,
    injury?.description,
    injury?.short_comment,
  ].filter(Boolean).join(" ").toLowerCase();
  if (!text) return false;
  if (/\b(reinstated|activated|available|healthy|returned|cleared|probable)\b/.test(text)) return false;
  return /\b(out|injured list|day[- ]to[- ]day|dtd|doubtful|questionable|suspended|bereavement|paternity|restricted list)\b/.test(text)
    || /\b(10|15|60)[- ]day il\b/.test(text)
    || /\bil\b/.test(text);
}

function diagnosticDedupeTeam(records: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const injury of records) {
    const player = injury?.player ?? {};
    const key = String(player.id || player.player_id || player.full_name || `${player.first_name || ""}-${player.last_name || ""}`).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(injury);
  }
  return out;
}

function diagnosticIsOfficialIlStatus(code: unknown, description: unknown): boolean {
  return /^D\d+$/i.test(String(code || "")) || /injured/i.test(String(description || ""));
}

function diagnosticAddIndex(map: Map<string, number[]>, name: unknown, playerId: unknown): void {
  const key = diagnosticNormalizeName(name);
  const id = Number(playerId);
  if (!key || !Number.isInteger(id) || id <= 0) return;
  const values = map.get(key) ?? [];
  if (!values.includes(id)) values.push(id);
  map.set(key, values);
}

async function diagnosticFetchBdlRecords(fetchImpl: typeof fetch, bdlKey: string): Promise<{
  pages: number;
  totalRecords: number;
  activeBeforeDedupe: number;
  byTeam: Record<number, any[]>;
}> {
  const byTeam: Record<number, any[]> = {};
  let pages = 0;
  let totalRecords = 0;
  let activeBeforeDedupe = 0;
  let cursor: number | null = null;

  while (pages < 10) {
    const url = `${DIAGNOSTIC_BDL_BASE}/mlb/v1/player_injuries?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await fetchImpl(url, { headers: { Authorization: bdlKey, Accept: "application/json" } });
    if (!response.ok) throw new Error(`BALLDONTLIE injuries HTTP ${response.status}`);
    const payload: any = await response.json();
    const data: any[] = Array.isArray(payload?.data) ? payload.data : [];
    totalRecords += data.length;
    for (const injury of data) {
      if (!diagnosticIsActiveMlbInjuryRecord(injury)) continue;
      const abbr = String(injury?.player?.team?.abbreviation || "").toUpperCase();
      const teamId = DIAGNOSTIC_BDL_MLB_TEAM_TO_ID[abbr];
      if (!teamId) continue;
      (byTeam[teamId] ??= []).push(injury);
      activeBeforeDedupe += 1;
    }
    pages += 1;
    cursor = payload?.meta?.next_cursor ?? null;
    if (!cursor) break;
  }

  for (const teamId of Object.keys(byTeam).map(Number)) byTeam[teamId] = diagnosticDedupeTeam(byTeam[teamId]);
  return { pages, totalRecords, activeBeforeDedupe, byTeam };
}

async function diagnosticStrictResolve(
  record: DiagnosticRecord,
  season: string,
  fetchImpl: typeof fetch,
): Promise<DiagnosticStrictResult> {
  if (!record.name) return { record, resolved: false, reason: "MISSING_NAME" };
  try {
    const search = await fetchImpl(buildMlbPeopleSearchUrl(DIAGNOSTIC_MLB_BASE, record.name, season));
    if (!search.ok) return { record, resolved: false, reason: "SEARCH_TRANSPORT_FAILURE" };
    const payload: any = await search.json();
    const people: any[] = Array.isArray(payload?.people) ? payload.people : [];
    if (!people.length) return { record, resolved: false, reason: "SEARCH_EMPTY" };

    const target = diagnosticNormalizeName(record.name);
    const exact = people.filter((person) => diagnosticNormalizeName(person?.fullName) === target);
    if (!exact.length) return { record, resolved: false, reason: "EXACT_NAME_NOT_FOUND" };
    const sameTeam = exact.filter((person) => Number(person?.currentTeam?.id) === record.teamId);
    if (!sameTeam.length) {
      const hasAnyCurrentTeam = exact.some((person) => Number.isInteger(Number(person?.currentTeam?.id)));
      return {
        record,
        resolved: false,
        reason: hasAnyCurrentTeam ? "EXACT_NAME_WRONG_CURRENT_TEAM" : "EXACT_NAME_NO_CURRENT_TEAM",
      };
    }

    const playerId = Number(sameTeam[0]?.id);
    if (!Number.isInteger(playerId) || playerId <= 0) return { record, resolved: false, reason: "EXACT_NAME_NOT_FOUND" };

    try {
      if (record.isPitcher) {
        const current = await fetchImpl(`${DIAGNOSTIC_MLB_BASE}/people/${playerId}/stats?stats=season&group=pitching&season=${season}`);
        const currentPayload: any = await current.json();
        const stat = currentPayload?.stats?.[0]?.splits?.[0]?.stat ?? {};
        if (!stat?.era) {
          const previous = String(Number(season) - 1);
          const fallback = await fetchImpl(`${DIAGNOSTIC_MLB_BASE}/people/${playerId}/stats?stats=season&group=pitching&season=${previous}`);
          await fallback.json();
        }
      } else {
        const current = await fetchImpl(`${DIAGNOSTIC_MLB_BASE}/people/${playerId}/stats?stats=season&group=hitting&season=${season}`);
        const currentPayload: any = await current.json();
        const stat = currentPayload?.stats?.[0]?.splits?.[0]?.stat ?? {};
        if (!stat?.ops) {
          const previous = String(Number(season) - 1);
          const fallback = await fetchImpl(`${DIAGNOSTIC_MLB_BASE}/people/${playerId}/stats?stats=season&group=hitting&season=${previous}`);
          await fallback.json();
        }
      }
    } catch {
      return { record, resolved: false, reason: "STATS_ENRICHMENT_FAILURE" };
    }
    return { record, resolved: true };
  } catch {
    return { record, resolved: false, reason: "SEARCH_TRANSPORT_FAILURE" };
  }
}

async function diagnosticBuildOfficialAuthorityIndex(
  teamId: number,
  asOfDate: string,
  fetchImpl: typeof fetch,
): Promise<DiagnosticOfficialAuthorityIndex> {
  const rosterByName = new Map<string, Array<{ playerId: number; il: boolean }>>();
  const transactionsByName = new Map<string, number[]>();
  let healthy = true;

  try {
    const rosterResponse = await fetchImpl(`${DIAGNOSTIC_MLB_BASE}/teams/${teamId}/roster?rosterType=40Man&date=${encodeURIComponent(asOfDate)}`);
    if (!rosterResponse.ok) throw new Error(`roster ${rosterResponse.status}`);
    const rosterPayload: any = await rosterResponse.json();
    for (const entry of rosterPayload?.roster ?? []) {
      const key = diagnosticNormalizeName(entry?.person?.fullName);
      const playerId = Number(entry?.person?.id);
      if (!key || !Number.isInteger(playerId) || playerId <= 0) continue;
      const values = rosterByName.get(key) ?? [];
      if (!values.some((value) => value.playerId === playerId)) {
        values.push({
          playerId,
          il: diagnosticIsOfficialIlStatus(entry?.status?.code, entry?.status?.description),
        });
      }
      rosterByName.set(key, values);
    }
  } catch {
    healthy = false;
  }

  try {
    const start = new Date(`${asOfDate}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 120);
    const startDate = start.toISOString().slice(0, 10);
    const txResponse = await fetchImpl(`${DIAGNOSTIC_MLB_BASE}/transactions?teamId=${teamId}&startDate=${startDate}&endDate=${encodeURIComponent(asOfDate)}`);
    if (!txResponse.ok) throw new Error(`transactions ${txResponse.status}`);
    const txPayload: any = await txResponse.json();
    for (const tx of txPayload?.transactions ?? []) {
      const relevant = [tx?.typeDesc, tx?.description].filter(Boolean).join(" ").toLowerCase();
      if (!/injured|activated|reinstated|returned|rehab|disabled list/.test(relevant)) continue;
      diagnosticAddIndex(transactionsByName, tx?.person?.fullName, tx?.person?.id);
    }
  } catch {
    healthy = false;
  }

  return { rosterByName, transactionsByName, healthy };
}

export async function buildMlbInjuryIdentityDiagnostic(input: {
  asOfDate: string;
  season: string;
  bdlKey: string;
  fetchImpl?: typeof fetch;
}): Promise<MlbInjuryIdentityDiagnostic> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOfDate)) throw new Error("Invalid asOfDate");
  if (!/^\d{4}$/.test(input.season)) throw new Error("Invalid season");
  if (!input.bdlKey) throw new Error("Missing BDL credential");
  const fetchImpl = input.fetchImpl ?? fetch;
  const source = await diagnosticFetchBdlRecords(fetchImpl, input.bdlKey);

  const records: DiagnosticRecord[] = [];
  for (const [teamIdText, injuries] of Object.entries(source.byTeam)) {
    const teamId = Number(teamIdText);
    for (const injury of injuries) {
      records.push({
        teamId,
        name: diagnosticDisplayName(injury),
        isPitcher: diagnosticIsPitcherRecord(injury),
      });
    }
  }

  const strictResults = await Promise.all(records.map((record) => diagnosticStrictResolve(record, input.season, fetchImpl)));
  const rejected = strictResults.filter((result) => !result.resolved);
  const rejectionReasons: Record<DiagnosticRejectReason, number> = {
    MISSING_NAME: 0,
    SEARCH_TRANSPORT_FAILURE: 0,
    SEARCH_EMPTY: 0,
    EXACT_NAME_NOT_FOUND: 0,
    EXACT_NAME_NO_CURRENT_TEAM: 0,
    EXACT_NAME_WRONG_CURRENT_TEAM: 0,
    STATS_ENRICHMENT_FAILURE: 0,
  };
  for (const result of rejected) rejectionReasons[result.reason ?? "SEARCH_TRANSPORT_FAILURE"] += 1;

  const teamIds = Array.from(new Set(rejected.map((result) => result.record.teamId)));
  const authorityByTeam = new Map<number, DiagnosticOfficialAuthorityIndex>();
  await Promise.all(teamIds.map(async (teamId) => {
    authorityByTeam.set(teamId, await diagnosticBuildOfficialAuthorityIndex(teamId, input.asOfDate, fetchImpl));
  }));

  let uniqueRosterExactName = 0;
  let uniqueRosterIlExactName = 0;
  let uniqueRosterNonIlExactName = 0;
  let uniqueTransactionExactNameOnly = 0;
  let ambiguousOfficialExactName = 0;
  let noOfficialExactName = 0;
  let authorityUnavailable = 0;
  let safelyResolvableIdentityTotal = 0;

  for (const result of rejected) {
    const authority = authorityByTeam.get(result.record.teamId);
    if (!authority?.healthy) {
      authorityUnavailable += 1;
      continue;
    }
    const key = diagnosticNormalizeName(result.record.name);
    const rosterMatches = authority.rosterByName.get(key) ?? [];
    if (rosterMatches.length === 1) {
      uniqueRosterExactName += 1;
      if (rosterMatches[0].il) uniqueRosterIlExactName += 1;
      else uniqueRosterNonIlExactName += 1;
      safelyResolvableIdentityTotal += 1;
      continue;
    }
    if (rosterMatches.length > 1) {
      ambiguousOfficialExactName += 1;
      continue;
    }

    const transactionIds = authority.transactionsByName.get(key) ?? [];
    if (transactionIds.length === 1) {
      uniqueTransactionExactNameOnly += 1;
      safelyResolvableIdentityTotal += 1;
    } else if (transactionIds.length > 1) {
      ambiguousOfficialExactName += 1;
    } else {
      noOfficialExactName += 1;
    }
  }

  return {
    schemaVersion: MLB_INJURY_IDENTITY_DIAGNOSTIC_SCHEMA,
    asOfDate: input.asOfDate,
    season: input.season,
    privacy: {
      aggregateOnly: true,
      playerNamesReturned: false,
      playerIdsReturned: false,
      credentialReturned: false,
    },
    source: {
      bdlPages: source.pages,
      bdlTotalRecords: source.totalRecords,
      activeMappedBeforeDedupe: source.activeBeforeDedupe,
      activeMappedAfterDedupe: records.length,
      teamsWithActiveRecords: Object.keys(source.byTeam).length,
    },
    strictResolver: {
      resolved: strictResults.length - rejected.length,
      rejected: rejected.length,
      rejectionReasons,
    },
    officialAuthority: {
      rejectedEvaluated: rejected.length,
      uniqueRosterExactName,
      uniqueRosterIlExactName,
      uniqueRosterNonIlExactName,
      uniqueTransactionExactNameOnly,
      ambiguousOfficialExactName,
      noOfficialExactName,
      authorityUnavailable,
      safelyResolvableIdentityTotal,
      remainingUnresolved: Math.max(0, rejected.length - safelyResolvableIdentityTotal),
    },
  };
}

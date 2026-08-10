import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const BDL_BASE = "https://api.balldontlie.io";

export const MLB_INJURY_IDENTITY_DIAGNOSTIC_SCHEMA = "courtedge-mlb-injury-identity-diagnostic.v1" as const;

const BDL_MLB_TEAM_TO_ID: Record<string, number> = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CHW: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133,
  PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120, WAS: 120,
};

type RejectReason =
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

interface StrictResult {
  record: DiagnosticRecord;
  resolved: boolean;
  reason?: RejectReason;
}

interface OfficialAuthorityIndex {
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
    rejectionReasons: Record<RejectReason, number>;
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

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function displayName(injury: any): string {
  const player = injury?.player ?? {};
  return String(player.full_name || `${player.first_name || ""} ${player.last_name || ""}`.trim()).trim();
}

function isPitcherRecord(injury: any): boolean {
  const pos = String(injury?.player?.position || "").trim();
  const normalized = pos.toUpperCase();
  return /pitcher/i.test(pos) || ["P", "SP", "RP", "LHP", "RHP"].includes(normalized);
}

function isActiveMlbInjuryRecord(injury: any): boolean {
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

function dedupeTeam(records: any[]): any[] {
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

function isOfficialIlStatus(code: unknown, description: unknown): boolean {
  return /^D\d+$/i.test(String(code || "")) || /injured/i.test(String(description || ""));
}

function addIndex(map: Map<string, number[]>, name: unknown, playerId: unknown): void {
  const key = normalizeName(name);
  const id = Number(playerId);
  if (!key || !Number.isInteger(id) || id <= 0) return;
  const values = map.get(key) ?? [];
  if (!values.includes(id)) values.push(id);
  map.set(key, values);
}

async function fetchBdlRecords(fetchImpl: typeof fetch, bdlKey: string): Promise<{
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
    const url = `${BDL_BASE}/mlb/v1/player_injuries?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await fetchImpl(url, { headers: { Authorization: bdlKey, Accept: "application/json" } });
    if (!response.ok) throw new Error(`BALLDONTLIE injuries HTTP ${response.status}`);
    const payload: any = await response.json();
    const data: any[] = Array.isArray(payload?.data) ? payload.data : [];
    totalRecords += data.length;
    for (const injury of data) {
      if (!isActiveMlbInjuryRecord(injury)) continue;
      const abbr = String(injury?.player?.team?.abbreviation || "").toUpperCase();
      const teamId = BDL_MLB_TEAM_TO_ID[abbr];
      if (!teamId) continue;
      (byTeam[teamId] ??= []).push(injury);
      activeBeforeDedupe += 1;
    }
    pages += 1;
    cursor = payload?.meta?.next_cursor ?? null;
    if (!cursor) break;
  }

  for (const teamId of Object.keys(byTeam).map(Number)) byTeam[teamId] = dedupeTeam(byTeam[teamId]);
  return { pages, totalRecords, activeBeforeDedupe, byTeam };
}

async function strictResolve(
  record: DiagnosticRecord,
  season: string,
  fetchImpl: typeof fetch,
): Promise<StrictResult> {
  if (!record.name) return { record, resolved: false, reason: "MISSING_NAME" };
  try {
    const search = await fetchImpl(buildMlbPeopleSearchUrl(MLB_BASE, record.name, season));
    if (!search.ok) return { record, resolved: false, reason: "SEARCH_TRANSPORT_FAILURE" };
    const payload: any = await search.json();
    const people: any[] = Array.isArray(payload?.people) ? payload.people : [];
    if (!people.length) return { record, resolved: false, reason: "SEARCH_EMPTY" };

    const target = normalizeName(record.name);
    const exact = people.filter((person) => normalizeName(person?.fullName) === target);
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
        const current = await fetchImpl(`${MLB_BASE}/people/${playerId}/stats?stats=season&group=pitching&season=${season}`);
        const currentPayload: any = await current.json();
        const stat = currentPayload?.stats?.[0]?.splits?.[0]?.stat ?? {};
        if (!stat?.era) {
          const previous = String(Number(season) - 1);
          const fallback = await fetchImpl(`${MLB_BASE}/people/${playerId}/stats?stats=season&group=pitching&season=${previous}`);
          await fallback.json();
        }
      } else {
        const current = await fetchImpl(`${MLB_BASE}/people/${playerId}/stats?stats=season&group=hitting&season=${season}`);
        const currentPayload: any = await current.json();
        const stat = currentPayload?.stats?.[0]?.splits?.[0]?.stat ?? {};
        if (!stat?.ops) {
          const previous = String(Number(season) - 1);
          const fallback = await fetchImpl(`${MLB_BASE}/people/${playerId}/stats?stats=season&group=hitting&season=${previous}`);
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

async function buildOfficialAuthorityIndex(
  teamId: number,
  asOfDate: string,
  fetchImpl: typeof fetch,
): Promise<OfficialAuthorityIndex> {
  const rosterByName = new Map<string, Array<{ playerId: number; il: boolean }>>();
  const transactionsByName = new Map<string, number[]>();
  let healthy = true;

  try {
    const rosterResponse = await fetchImpl(`${MLB_BASE}/teams/${teamId}/roster?rosterType=40Man&date=${encodeURIComponent(asOfDate)}`);
    if (!rosterResponse.ok) throw new Error(`roster ${rosterResponse.status}`);
    const rosterPayload: any = await rosterResponse.json();
    for (const entry of rosterPayload?.roster ?? []) {
      const key = normalizeName(entry?.person?.fullName);
      const playerId = Number(entry?.person?.id);
      if (!key || !Number.isInteger(playerId) || playerId <= 0) continue;
      const values = rosterByName.get(key) ?? [];
      if (!values.some((value) => value.playerId === playerId)) {
        values.push({
          playerId,
          il: isOfficialIlStatus(entry?.status?.code, entry?.status?.description),
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
    const txResponse = await fetchImpl(`${MLB_BASE}/transactions?teamId=${teamId}&startDate=${startDate}&endDate=${encodeURIComponent(asOfDate)}`);
    if (!txResponse.ok) throw new Error(`transactions ${txResponse.status}`);
    const txPayload: any = await txResponse.json();
    for (const tx of txPayload?.transactions ?? []) {
      const relevant = [tx?.typeDesc, tx?.description].filter(Boolean).join(" ").toLowerCase();
      if (!/injured|activated|reinstated|returned|rehab|disabled list/.test(relevant)) continue;
      addIndex(transactionsByName, tx?.person?.fullName, tx?.person?.id);
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
  const source = await fetchBdlRecords(fetchImpl, input.bdlKey);

  const records: DiagnosticRecord[] = [];
  for (const [teamIdText, injuries] of Object.entries(source.byTeam)) {
    const teamId = Number(teamIdText);
    for (const injury of injuries) {
      records.push({
        teamId,
        name: displayName(injury),
        isPitcher: isPitcherRecord(injury),
      });
    }
  }

  const strictResults = await Promise.all(records.map((record) => strictResolve(record, input.season, fetchImpl)));
  const rejected = strictResults.filter((result) => !result.resolved);
  const rejectionReasons: Record<RejectReason, number> = {
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
  const authorityByTeam = new Map<number, OfficialAuthorityIndex>();
  await Promise.all(teamIds.map(async (teamId) => {
    authorityByTeam.set(teamId, await buildOfficialAuthorityIndex(teamId, input.asOfDate, fetchImpl));
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
    const key = normalizeName(result.record.name);
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

export const MLB_INJURY_IDENTITY_RESEARCH_SCHEMA = "p1-m2b-deployed-injury-identity-diagnostic.v1" as const;
export const MLB_INJURY_IDENTITY_RESEARCH_DATE = "2026-08-09" as const;

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const BDL_BASE = "https://api.balldontlie.io";
const MLB_SEASON = "2026";

const BDL_MLB_TEAM_TO_ID: Record<string, number> = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CHW: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133,
  PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120, WAS: 120,
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Cause =
  | "NO_SEARCH_RESULTS"
  | "EXACT_NAME_CURRENT_TEAM_MISSING"
  | "EXACT_NAME_TEAM_MISMATCH"
  | "NAME_MISMATCH_SAME_TEAM_CANDIDATE"
  | "NAME_MISMATCH_NO_SAME_TEAM_CANDIDATE"
  | "LOOKUP_ERROR";

export interface MlbInjuryIdentityResearchResult {
  schemaVersion: typeof MLB_INJURY_IDENTITY_RESEARCH_SCHEMA;
  auditDate: string;
  state: "MEASURED" | "SOURCE_UNAVAILABLE" | "SOURCE_ERROR";
  sample: {
    slateTeams: number;
    rawActiveMappedRecords: number;
    dedupedRecords: number;
    baselineAccepted: number;
    baselineRejected: number;
    rejectedTeams: number;
  };
  baselineCauseCounts: Record<Cause, number>;
  sourceNameShape: {
    fullNamePresent: number;
    structuredPresent: number;
    normalizedEqual: number;
    normalizedDifferent: number;
  };
  strictQueryVariantRescueCounts: {
    currentSport1: number;
    structuredNoSport: number;
    structuredSport1: number;
  };
  teamAuthority: {
    roster40ExactUnique: number;
    roster40InjuredExactUnique: number;
    relevantTransactionExactUnique: number;
    rosterOrTransactionExactUnique: number;
    rosterTransactionIdConflict: number;
    rosterExactAmbiguous: number;
    transactionExactAmbiguous: number;
    unmatched: number;
  };
  sourceErrors: {
    schedule: number;
    bdl: number;
    peopleSearch: number;
    roster: number;
    transactions: number;
  };
  safety: {
    aggregateOnly: true;
    rawPlayerIdentityReturned: false;
    rawTeamIdentityReturned: false;
    fuzzyMatchingUsed: false;
    surnameOnlyMatchingUsed: false;
    writesPerformed: 0;
  };
}

function emptyResult(date: string): MlbInjuryIdentityResearchResult {
  return {
    schemaVersion: MLB_INJURY_IDENTITY_RESEARCH_SCHEMA,
    auditDate: date,
    state: "MEASURED",
    sample: {
      slateTeams: 0,
      rawActiveMappedRecords: 0,
      dedupedRecords: 0,
      baselineAccepted: 0,
      baselineRejected: 0,
      rejectedTeams: 0,
    },
    baselineCauseCounts: {
      NO_SEARCH_RESULTS: 0,
      EXACT_NAME_CURRENT_TEAM_MISSING: 0,
      EXACT_NAME_TEAM_MISMATCH: 0,
      NAME_MISMATCH_SAME_TEAM_CANDIDATE: 0,
      NAME_MISMATCH_NO_SAME_TEAM_CANDIDATE: 0,
      LOOKUP_ERROR: 0,
    },
    sourceNameShape: {
      fullNamePresent: 0,
      structuredPresent: 0,
      normalizedEqual: 0,
      normalizedDifferent: 0,
    },
    strictQueryVariantRescueCounts: {
      currentSport1: 0,
      structuredNoSport: 0,
      structuredSport1: 0,
    },
    teamAuthority: {
      roster40ExactUnique: 0,
      roster40InjuredExactUnique: 0,
      relevantTransactionExactUnique: 0,
      rosterOrTransactionExactUnique: 0,
      rosterTransactionIdConflict: 0,
      rosterExactAmbiguous: 0,
      transactionExactAmbiguous: 0,
      unmatched: 0,
    },
    sourceErrors: {
      schedule: 0,
      bdl: 0,
      peopleSearch: 0,
      roster: 0,
      transactions: 0,
    },
    safety: {
      aggregateOnly: true,
      rawPlayerIdentityReturned: false,
      rawTeamIdentityReturned: false,
      fuzzyMatchingUsed: false,
      surnameOnlyMatchingUsed: false,
      writesPerformed: 0,
    },
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeName(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
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

function dedupeMlbInjuries(records: Array<{ injury: any; teamId: number }>): Array<{ injury: any; teamId: number }> {
  const seen = new Set<string>();
  const result: Array<{ injury: any; teamId: number }> = [];
  for (const item of records) {
    const player = item.injury?.player ?? {};
    const key = String(
      player.id
      || player.player_id
      || player.full_name
      || `${player.first_name || ""}-${player.last_name || ""}`,
    ).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function playerName(player: any): string {
  return clean(player?.full_name) || clean(`${clean(player?.first_name)} ${clean(player?.last_name)}`);
}

function structuredName(player: any): string {
  return clean(`${clean(player?.first_name)} ${clean(player?.last_name)}`);
}

function officialIl(entry: any): boolean {
  const code = clean(entry?.status?.code);
  const description = clean(entry?.status?.description);
  return /^D\d+$/i.test(code) || /injured/i.test(description);
}

function relevantTransaction(tx: any): boolean {
  const text = [tx?.typeDesc, tx?.description].filter(Boolean).join(" ").toLowerCase();
  return /injured|activated|reinstated|returned|rehab|disabled list/.test(text);
}

function subtractDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function distinctPositiveIds(values: unknown[]): number[] {
  return [...new Set(values
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

async function fetchJson(fetcher: FetchLike, url: string, init?: RequestInit): Promise<{ ok: boolean; body: any }> {
  try {
    const response = await fetcher(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ok: false, body: null };
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, body: null };
  }
}

async function mapLimit<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

async function peopleSearch(
  fetcher: FetchLike,
  name: string,
  sport1: boolean,
): Promise<{ ok: boolean; people: any[] }> {
  if (!name) return { ok: true, people: [] };
  const url = new URL(`${MLB_BASE}/people/search`);
  url.searchParams.set("names", name);
  url.searchParams.set("season", MLB_SEASON);
  url.searchParams.set("hydrate", "currentTeam");
  if (sport1) url.searchParams.set("sportIds", "1");
  const response = await fetchJson(fetcher, url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "CourtEdge-P1-M2B-Identity-Research/1.0" },
  });
  return {
    ok: response.ok,
    people: response.ok && Array.isArray(response.body?.people) ? response.body.people : [],
  };
}

function strictAccepted(people: any[], queryName: string, teamId: number): boolean {
  const target = normalizeName(queryName);
  return people.some((person) =>
    normalizeName(person?.fullName) === target
    && Number(person?.currentTeam?.id) === teamId
  );
}

export async function runMlbInjuryIdentityRuntimeResearch(options: {
  date: string;
  bdlApiKey: string;
  fetcher?: FetchLike;
}): Promise<MlbInjuryIdentityResearchResult> {
  const fetcher = options.fetcher ?? fetch;
  const result = emptyResult(options.date);
  if (!clean(options.bdlApiKey)) {
    result.state = "SOURCE_UNAVAILABLE";
    return result;
  }

  const scheduleUrl = new URL(`${MLB_BASE}/schedule`);
  scheduleUrl.searchParams.set("sportId", "1");
  scheduleUrl.searchParams.set("date", options.date);
  const scheduleResponse = await fetchJson(fetcher, scheduleUrl.toString(), {
    headers: { Accept: "application/json", "User-Agent": "CourtEdge-P1-M2B-Identity-Research/1.0" },
  });
  if (!scheduleResponse.ok) {
    result.sourceErrors.schedule += 1;
    result.state = "SOURCE_ERROR";
    return result;
  }
  const teamIds = new Set<number>();
  for (const dateEntry of scheduleResponse.body?.dates ?? []) {
    for (const game of dateEntry?.games ?? []) {
      for (const team of [game?.teams?.home?.team, game?.teams?.away?.team]) {
        const teamId = Number(team?.id);
        if (Number.isInteger(teamId) && teamId > 0) teamIds.add(teamId);
      }
    }
  }
  result.sample.slateTeams = teamIds.size;

  const raw: Array<{ injury: any; teamId: number }> = [];
  let cursor: number | null = null;
  let pages = 0;
  while (pages < 10) {
    const url = new URL(`${BDL_BASE}/mlb/v1/player_injuries`);
    url.searchParams.set("per_page", "100");
    if (cursor) url.searchParams.set("cursor", String(cursor));
    const response = await fetchJson(fetcher, url.toString(), {
      headers: { Authorization: options.bdlApiKey, Accept: "application/json" },
    });
    if (!response.ok) {
      result.sourceErrors.bdl += 1;
      result.state = "SOURCE_ERROR";
      return result;
    }
    const data = Array.isArray(response.body?.data) ? response.body.data : [];
    for (const injury of data) {
      if (!isActiveMlbInjuryRecord(injury)) continue;
      const abbreviation = clean(injury?.player?.team?.abbreviation).toUpperCase();
      const teamId = BDL_MLB_TEAM_TO_ID[abbreviation];
      if (!teamId || !teamIds.has(teamId)) continue;
      raw.push({ injury, teamId });
    }
    pages += 1;
    cursor = response.body?.meta?.next_cursor ?? null;
    if (!cursor) break;
  }
  result.sample.rawActiveMappedRecords = raw.length;
  const deduped = dedupeMlbInjuries(raw);
  result.sample.dedupedRecords = deduped.length;

  type Rejected = {
    injury: any;
    teamId: number;
    currentName: string;
    structured: string;
  };
  const rejected: Rejected[] = [];
  const baseline = await mapLimit(deduped, 12, async (item) => {
    const currentName = playerName(item.injury?.player);
    const structured = structuredName(item.injury?.player);
    const search = await peopleSearch(fetcher, currentName, false);
    return { item, currentName, structured, search };
  });

  for (const entry of baseline) {
    const { item, currentName, structured, search } = entry;
    if (!search.ok) {
      result.sourceErrors.peopleSearch += 1;
      result.sample.baselineRejected += 1;
      result.baselineCauseCounts.LOOKUP_ERROR += 1;
      rejected.push({ injury: item.injury, teamId: item.teamId, currentName, structured });
      continue;
    }
    if (strictAccepted(search.people, currentName, item.teamId)) {
      result.sample.baselineAccepted += 1;
      continue;
    }
    result.sample.baselineRejected += 1;
    const target = normalizeName(currentName);
    const exact = search.people.filter((person) => normalizeName(person?.fullName) === target);
    if (search.people.length === 0) {
      result.baselineCauseCounts.NO_SEARCH_RESULTS += 1;
    } else if (exact.length > 0) {
      if (exact.some((person) => person?.currentTeam?.id == null)) {
        result.baselineCauseCounts.EXACT_NAME_CURRENT_TEAM_MISSING += 1;
      } else {
        result.baselineCauseCounts.EXACT_NAME_TEAM_MISMATCH += 1;
      }
    } else if (search.people.some((person) => Number(person?.currentTeam?.id) === item.teamId)) {
      result.baselineCauseCounts.NAME_MISMATCH_SAME_TEAM_CANDIDATE += 1;
    } else {
      result.baselineCauseCounts.NAME_MISMATCH_NO_SAME_TEAM_CANDIDATE += 1;
    }
    rejected.push({ injury: item.injury, teamId: item.teamId, currentName, structured });
  }

  const rejectedTeams = [...new Set(rejected.map((entry) => entry.teamId))].sort((a, b) => a - b);
  result.sample.rejectedTeams = rejectedTeams.length;

  const queryVariants = await mapLimit(rejected, 10, async (entry) => {
    const currentSport1 = await peopleSearch(fetcher, entry.currentName, true);
    let structuredNoSport = { ok: true, people: [] as any[] };
    let structuredSport1 = { ok: true, people: [] as any[] };
    if (entry.structured && normalizeName(entry.structured) !== normalizeName(entry.currentName)) {
      [structuredNoSport, structuredSport1] = await Promise.all([
        peopleSearch(fetcher, entry.structured, false),
        peopleSearch(fetcher, entry.structured, true),
      ]);
    } else {
      structuredNoSport = await peopleSearch(fetcher, entry.structured, false);
      structuredSport1 = currentSport1;
    }
    return { entry, currentSport1, structuredNoSport, structuredSport1 };
  });

  for (const variant of queryVariants) {
    const { entry } = variant;
    const full = clean(entry.injury?.player?.full_name);
    if (full) result.sourceNameShape.fullNamePresent += 1;
    if (entry.structured) result.sourceNameShape.structuredPresent += 1;
    if (full && entry.structured) {
      if (normalizeName(full) === normalizeName(entry.structured)) result.sourceNameShape.normalizedEqual += 1;
      else result.sourceNameShape.normalizedDifferent += 1;
    }
    if (!variant.currentSport1.ok) result.sourceErrors.peopleSearch += 1;
    if (!variant.structuredNoSport.ok) result.sourceErrors.peopleSearch += 1;
    if (!variant.structuredSport1.ok) result.sourceErrors.peopleSearch += 1;
    if (strictAccepted(variant.currentSport1.people, entry.currentName, entry.teamId)) {
      result.strictQueryVariantRescueCounts.currentSport1 += 1;
    }
    if (strictAccepted(variant.structuredNoSport.people, entry.structured, entry.teamId)) {
      result.strictQueryVariantRescueCounts.structuredNoSport += 1;
    }
    if (strictAccepted(variant.structuredSport1.people, entry.structured, entry.teamId)) {
      result.strictQueryVariantRescueCounts.structuredSport1 += 1;
    }
  }

  const authorityByTeam = new Map<number, { roster: any[]; transactions: any[] }>();
  const startDate = subtractDays(options.date, 120);
  await mapLimit(rejectedTeams, 10, async (teamId) => {
    const [rosterResponse, transactionResponse] = await Promise.all([
      fetchJson(fetcher, `${MLB_BASE}/teams/${teamId}/roster?rosterType=40Man&date=${encodeURIComponent(options.date)}`, {
        headers: { Accept: "application/json", "User-Agent": "CourtEdge-P1-M2B-Identity-Research/1.0" },
      }),
      fetchJson(fetcher, `${MLB_BASE}/transactions?teamId=${teamId}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(options.date)}`, {
        headers: { Accept: "application/json", "User-Agent": "CourtEdge-P1-M2B-Identity-Research/1.0" },
      }),
    ]);
    if (!rosterResponse.ok) result.sourceErrors.roster += 1;
    if (!transactionResponse.ok) result.sourceErrors.transactions += 1;
    authorityByTeam.set(teamId, {
      roster: rosterResponse.ok && Array.isArray(rosterResponse.body?.roster) ? rosterResponse.body.roster : [],
      transactions: transactionResponse.ok && Array.isArray(transactionResponse.body?.transactions)
        ? transactionResponse.body.transactions.filter(relevantTransaction)
        : [],
    });
  });

  for (const entry of rejected) {
    const authority = authorityByTeam.get(entry.teamId) ?? { roster: [], transactions: [] };
    const target = normalizeName(entry.currentName);
    const rosterMatches = authority.roster.filter((row) => normalizeName(row?.person?.fullName) === target);
    const injuredRosterMatches = rosterMatches.filter(officialIl);
    const transactionMatches = authority.transactions.filter((tx) => normalizeName(tx?.person?.fullName) === target);
    const rosterIds = distinctPositiveIds(rosterMatches.map((row) => row?.person?.id));
    const injuredRosterIds = distinctPositiveIds(injuredRosterMatches.map((row) => row?.person?.id));
    const transactionIds = distinctPositiveIds(transactionMatches.map((tx) => tx?.person?.id));
    const unionIds = distinctPositiveIds([...rosterIds, ...transactionIds]);

    if (rosterIds.length === 1) result.teamAuthority.roster40ExactUnique += 1;
    else if (rosterIds.length > 1) result.teamAuthority.rosterExactAmbiguous += 1;
    if (injuredRosterIds.length === 1) result.teamAuthority.roster40InjuredExactUnique += 1;
    if (transactionIds.length === 1) result.teamAuthority.relevantTransactionExactUnique += 1;
    else if (transactionIds.length > 1) result.teamAuthority.transactionExactAmbiguous += 1;
    if (rosterIds.length === 1 && transactionIds.length === 1 && rosterIds[0] !== transactionIds[0]) {
      result.teamAuthority.rosterTransactionIdConflict += 1;
    }
    if (unionIds.length === 1) result.teamAuthority.rosterOrTransactionExactUnique += 1;
    else if (unionIds.length === 0) result.teamAuthority.unmatched += 1;
  }

  return result;
}

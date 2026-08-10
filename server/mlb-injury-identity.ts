export function buildMlbPeopleSearchUrl(
  baseUrl: string,
  playerName: string,
  season: string,
): string {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    names: playerName,
    season,
    hydrate: "currentTeam",
  });
  return `${normalizedBase}/people/search?${params.toString()}`;
}

export type MlbInjuryIdentityResolutionSource =
  | "MLB_PEOPLE_CURRENT_TEAM"
  | "MLB_OFFICIAL_TEAM_IL_ROSTER";

export interface MlbInjuryIdentityOfficialRosterEntry {
  playerId: number;
  name: string;
  statusCode?: string | null;
  statusDescription?: string | null;
  position?: string | null;
}

export interface MlbInjuryIdentityResolution {
  playerId: number;
  position?: string;
  source: MlbInjuryIdentityResolutionSource;
}

export function normalizeMlbInjuryIdentityName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export function isOfficialMlbIlRosterIdentity(entry: MlbInjuryIdentityOfficialRosterEntry): boolean {
  const code = String(entry.statusCode ?? "").trim();
  const description = String(entry.statusDescription ?? "").trim();
  return /^D\d+$/i.test(code) || /injured/i.test(description);
}

/**
 * Resolve a BALLDONTLIE injury identity without fuzzy matching.
 *
 * The existing people/search + currentTeam path remains authoritative when it succeeds.
 * A fallback is permitted only when a healthy MLB official team roster contains exactly
 * one exact normalized-name match and that row is explicitly an Injured List entry.
 *
 * Transaction-only evidence, active roster rows, ambiguous matches and degraded official
 * evidence are intentionally outside this resolver and remain rejected.
 *
 * This helper is intentionally side-effect free; the core route remains responsible for
 * downstream stats enrichment and can still reject a resolved identity if enrichment fails.
 */
export function resolveMlbInjuryIdentity(input: {
  playerName: string;
  teamId: number;
  people: any[];
  officialRosterByPlayerId?: Record<string | number, MlbInjuryIdentityOfficialRosterEntry>;
  officialRosterVerified: boolean;
}): MlbInjuryIdentityResolution | null {
  const targetName = normalizeMlbInjuryIdentityName(input.playerName);
  if (!targetName || !Number.isInteger(input.teamId) || input.teamId <= 0) return null;

  const people = Array.isArray(input.people) ? input.people : [];
  const strictMatch = people.find((person: any) =>
    Number(person?.currentTeam?.id) === input.teamId
    && normalizeMlbInjuryIdentityName(person?.fullName) === targetName
    && Number.isInteger(Number(person?.id))
    && Number(person.id) > 0
  );
  if (strictMatch) {
    return {
      playerId: Number(strictMatch.id),
      ...(strictMatch?.primaryPosition?.abbreviation
        ? { position: String(strictMatch.primaryPosition.abbreviation) }
        : {}),
      source: "MLB_PEOPLE_CURRENT_TEAM",
    };
  }

  if (!input.officialRosterVerified) return null;

  const rosterMatches = Object.values(input.officialRosterByPlayerId ?? {})
    .filter((entry) => normalizeMlbInjuryIdentityName(entry?.name) === targetName)
    .filter((entry) => Number.isInteger(Number(entry?.playerId)) && Number(entry.playerId) > 0)
    .filter(isOfficialMlbIlRosterIdentity);

  const uniqueByPlayerId = new Map<number, MlbInjuryIdentityOfficialRosterEntry>();
  for (const entry of rosterMatches) uniqueByPlayerId.set(Number(entry.playerId), entry);
  if (uniqueByPlayerId.size !== 1) return null;

  const entry = Array.from(uniqueByPlayerId.values())[0];
  return {
    playerId: Number(entry.playerId),
    ...(String(entry.position ?? "").trim() ? { position: String(entry.position).trim() } : {}),
    source: "MLB_OFFICIAL_TEAM_IL_ROSTER",
  };
}

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

export async function resolveMlbAnalysisDate(rawDate: unknown, gamePk?: number): Promise<string> {
  const candidate = String(rawDate || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return candidate;

  if (Number.isFinite(gamePk) && Number(gamePk) > 0) {
    try {
      const response = await fetch(
        `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks=${Number(gamePk)}`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } },
      );
      if (response.ok) {
        const payload: any = await response.json();
        const resolved = payload?.dates?.[0]?.date;
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(resolved || ""))) {
          return String(resolved);
        }
      }
    } catch (error) {
      console.warn("[MLB] Could not resolve analysis date from gamePk", gamePk, error);
    }
  }

  return new Date().toISOString().slice(0, 10);
}

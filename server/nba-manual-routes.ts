import type { Express, Request } from "express";

type Source = "direct" | "production-readonly-fallback";

type EndpointPayload = {
  success?: boolean;
  data?: unknown[];
};

const CACHE_TTL_MS = 30 * 60 * 1000;
let cache: { key: string; ts: number; payload: unknown } | null = null;

function originFor(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

async function fetchJsonArray(url: string, timeoutMs = 9_000): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const payload = (await response.json()) as EndpointPayload;
    if (!payload?.success || !Array.isArray(payload.data) || payload.data.length === 0) {
      throw new Error(`Invalid or empty NBA payload: ${url}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function getEndpoint(
  req: Request,
  path: string,
): Promise<{ data: unknown[]; source: Source }> {
  const directBase = originFor(req);
  const fallbackBase = (
    process.env.NBA_READONLY_FALLBACK_BASE ||
    "https://web-production-7067b.up.railway.app"
  ).replace(/\/$/, "");

  try {
    const data = await fetchJsonArray(`${directBase}${path}`);
    return { data, source: "direct" };
  } catch (directError) {
    console.warn(`NBA manual direct endpoint failed: ${path}`, directError);
    if (fallbackBase.toLowerCase() === directBase.toLowerCase()) {
      throw new Error("Refusing recursive NBA manual fallback");
    }
    const data = await fetchJsonArray(`${fallbackBase}${path}`, 10_000);
    return { data, source: "production-readonly-fallback" };
  }
}

function byTeamId(rows: unknown[]): Map<number, any> {
  const map = new Map<number, any>();
  for (const row of rows as any[]) {
    const id = Number(row?.teamId);
    if (Number.isFinite(id)) map.set(id, row);
  }
  return map;
}

function normalizeDateForForm(rawDate: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(rawDate);
  if (!iso) return rawDate;
  const [year, month, day] = rawDate.split("-");
  return `${month}/${day}/${year}`;
}

export function registerNbaManualRoutes(app: Express): void {
  app.get("/api/nba/manual-teams", async (req, res) => {
    try {
      const rawDate = String(req.query.date || "");
      const formDate = normalizeDateForForm(rawDate);
      const key = `nba-manual-teams:${formDate || "latest"}`;
      const now = Date.now();
      if (cache && cache.key === key && now - cache.ts < CACHE_TTL_MS) {
        return res.json(cache.payload);
      }

      const [advanced, winrate, recent5, sos, form] = await Promise.all([
        getEndpoint(req, "/api/nba/teams"),
        getEndpoint(req, "/api/nba/winrate"),
        getEndpoint(req, "/api/nba/recent5").catch(() => ({ data: [], source: "direct" as Source })),
        getEndpoint(req, "/api/nba/sos").catch(() => ({ data: [], source: "direct" as Source })),
        formDate
          ? getEndpoint(req, `/api/nba/form?date=${encodeURIComponent(formDate)}`).catch(() => ({ data: [], source: "direct" as Source }))
          : Promise.resolve({ data: [], source: "direct" as Source }),
      ]);

      const winById = byTeamId(winrate.data);
      const recentById = byTeamId(recent5.data);
      const sosById = byTeamId(sos.data);
      const formById = byTeamId(form.data);

      const data = (advanced.data as any[])
        .map((team: any) => {
          const teamId = Number(team?.teamId);
          const base = winById.get(teamId) || {};
          const recent = recentById.get(teamId) || {};
          const schedule = sosById.get(teamId) || {};
          const fatigue = formById.get(teamId) || {};
          const daysRest = Number(fatigue.daysRest);
          const hasCurrentForm = Number.isFinite(daysRest) && daysRest >= 0 && daysRest <= 7;

          return {
            teamId,
            teamName: String(team?.teamName || ""),
            netRtg: Number(team?.netRtg),
            offRtg: Number(team?.offRtg),
            defRtg: Number(team?.defRtg),
            pace: Number(team?.pace),
            winPct: Number(base?.winPct),
            ppg: Number(base?.ppg),
            pace5: Number.isFinite(Number(recent?.pace5)) ? Number(recent.pace5) : undefined,
            ppg5: Number.isFinite(Number(recent?.ppg5)) ? Number(recent.ppg5) : undefined,
            oppAvgOffRtg: Number.isFinite(Number(schedule?.oppAvgOffRtg)) ? Number(schedule.oppAvgOffRtg) : undefined,
            oppAvgDefRtg: Number.isFinite(Number(schedule?.oppAvgDefRtg)) ? Number(schedule.oppAvgDefRtg) : undefined,
            oppAvgNetRtg: Number.isFinite(Number(schedule?.oppAvgNetRtg)) ? Number(schedule.oppAvgNetRtg) : undefined,
            sosLabel: schedule?.sosLabel,
            opponents: Array.isArray(schedule?.opponents) ? schedule.opponents : undefined,
            daysRest: hasCurrentForm ? daysRest : undefined,
            isB2B: hasCurrentForm ? Boolean(fatigue?.isB2B) : undefined,
            streak: hasCurrentForm && Number.isFinite(Number(fatigue?.streak)) ? Number(fatigue.streak) : undefined,
            gamesLast7Days: hasCurrentForm && Number.isFinite(Number(fatigue?.gamesLast7Days))
              ? Number(fatigue.gamesLast7Days)
              : undefined,
          };
        })
        .filter((team: any) =>
          team.teamName &&
          Number.isFinite(team.netRtg) &&
          Number.isFinite(team.offRtg) &&
          Number.isFinite(team.defRtg) &&
          Number.isFinite(team.pace) &&
          Number.isFinite(team.winPct)
        );

      if (data.length === 0) {
        throw new Error("NBA manual team directory is empty");
      }

      const sources = [advanced.source, winrate.source, recent5.source, sos.source, form.source];
      const source: Source = sources.includes("production-readonly-fallback")
        ? "production-readonly-fallback"
        : "direct";
      const payload = { success: true, data, source };
      cache = { key, ts: now, payload };
      return res.json(payload);
    } catch (error) {
      console.error("NBA manual teams error", error);
      return res.status(500).json({
        success: false,
        error: "No se pudieron obtener estadísticas verificadas para el selector manual NBA",
      });
    }
  });
}

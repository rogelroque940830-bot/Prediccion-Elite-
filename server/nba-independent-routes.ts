import type { Express } from "express";
import fs from "fs";
import path from "path";

type EndpointPayload = { success?: boolean; data?: unknown[] };
type Source = "direct" | "integration-local-cache" | "production-bootstrap-cache";

type NbaSnapshot = {
  schemaVersion: 1;
  fetchedAt: string;
  date: string;
  data: any[];
  source: Source;
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_FILE = path.join(process.cwd(), "data", "nba-independent-cache.json");
let memorySnapshot: NbaSnapshot | null = null;
let memoryLoadedAt = 0;

function normalizeDateForForm(rawDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;
  const [year, month, day] = rawDate.split("-");
  return `${month}/${day}/${year}`;
}

function ensureDataDir(): void {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function validSnapshot(value: any): value is NbaSnapshot {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    Array.isArray(value.data) &&
    value.data.length >= 25 &&
    typeof value.fetchedAt === "string"
  );
}

function loadLocalSnapshot(): NbaSnapshot | null {
  if (memorySnapshot) return memorySnapshot;
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!validSnapshot(parsed)) return null;
    memorySnapshot = parsed;
    memoryLoadedAt = Date.now();
    return parsed;
  } catch (error) {
    console.error("NBA independent cache read error", error);
    return null;
  }
}

function saveLocalSnapshot(snapshot: NbaSnapshot): void {
  ensureDataDir();
  const temp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2), "utf8");
  fs.renameSync(temp, CACHE_FILE);
  memorySnapshot = snapshot;
  memoryLoadedAt = Date.now();
}

async function fetchJsonArray(url: string, timeoutMs = 12_000): Promise<unknown[]> {
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

function byTeamId(rows: unknown[]): Map<number, any> {
  const map = new Map<number, any>();
  for (const row of rows as any[]) {
    const id = Number(row?.teamId);
    if (Number.isFinite(id)) map.set(id, row);
  }
  return map;
}

async function buildDirectory(base: string, rawDate: string): Promise<any[]> {
  const formDate = normalizeDateForForm(rawDate);
  const [advanced, winrate, recent5, sos, form] = await Promise.all([
    fetchJsonArray(`${base}/api/nba/teams`),
    fetchJsonArray(`${base}/api/nba/winrate`),
    fetchJsonArray(`${base}/api/nba/recent5`).catch(() => []),
    fetchJsonArray(`${base}/api/nba/sos`).catch(() => []),
    formDate
      ? fetchJsonArray(`${base}/api/nba/form?date=${encodeURIComponent(formDate)}`).catch(() => [])
      : Promise.resolve([]),
  ]);

  const winById = byTeamId(winrate);
  const recentById = byTeamId(recent5);
  const sosById = byTeamId(sos);
  const formById = byTeamId(form);

  return (advanced as any[])
    .map((team: any) => {
      const teamId = Number(team?.teamId);
      const baseStats = winById.get(teamId) || {};
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
        winPct: Number(baseStats?.winPct),
        ppg: Number(baseStats?.ppg),
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
}

function localBase(): string {
  return `http://127.0.0.1:${process.env.PORT || 5000}`;
}

async function fetchDirectSnapshot(rawDate: string): Promise<NbaSnapshot> {
  const data = await buildDirectory(localBase(), rawDate);
  if (data.length < 25) throw new Error(`Direct NBA directory returned only ${data.length} teams`);
  return {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    date: rawDate,
    data,
    source: "direct",
  };
}

async function resolveSnapshot(rawDate: string): Promise<{ snapshot: NbaSnapshot; source: Source; stale: boolean }> {
  const now = Date.now();
  if (memorySnapshot && now - memoryLoadedAt < CACHE_TTL_MS) {
    const source: Source = memorySnapshot.source === "production-bootstrap-cache"
      ? "integration-local-cache"
      : memorySnapshot.source;
    return { snapshot: memorySnapshot, source, stale: false };
  }

  try {
    const direct = await fetchDirectSnapshot(rawDate);
    saveLocalSnapshot(direct);
    return { snapshot: direct, source: "direct", stale: false };
  } catch (directError) {
    console.error("NBA direct source error", directError);
    const local = loadLocalSnapshot();
    if (local) {
      const ageMs = Math.max(0, now - new Date(local.fetchedAt).getTime());
      return { snapshot: local, source: "integration-local-cache", stale: ageMs > CACHE_TTL_MS };
    }

    throw new Error("NBA direct source unavailable and integration cache is empty");
  }
}

export function registerIndependentNbaRoutes(app: Express): void {
  app.get("/api/nba/manual-teams", async (req, res) => {
    try {
      const rawDate = String(req.query.date || "");
      const resolved = await resolveSnapshot(rawDate);
      return res.json({
        success: true,
        data: resolved.snapshot.data,
        source: resolved.source,
        stale: resolved.stale,
        fetchedAt: resolved.snapshot.fetchedAt,
      });
    } catch (error) {
      console.error("NBA independent manual teams error", error);
      return res.status(500).json({
        success: false,
        error: "No se pudieron obtener estadísticas NBA independientes",
      });
    }
  });

  app.get("/api/nba/independent-status", async (req, res) => {
    try {
      const rawDate = String(req.query.date || "");
      const resolved = await resolveSnapshot(rawDate);
      return res.json({
        success: true,
        source: resolved.source,
        stale: resolved.stale,
        fetchedAt: resolved.snapshot.fetchedAt,
        teams: resolved.snapshot.data.length,
        cacheFile: path.basename(CACHE_FILE),
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error?.message || "NBA independent source unavailable",
      });
    }
  });
}

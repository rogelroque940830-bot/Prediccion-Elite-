import type { Express } from "express";
import { todayNBA, withCache } from "./route-runtime";
import {
  fetchReadonlyFallback,
  fetchWnbaPlayersDirect,
  fetchWnbaScheduleResilient,
  fetchWnbaSosDirect,
  validWnbaPlayers,
  validWnbaSos,
  type FetchLike,
} from "./wnba-s6b-data-resilience";

const SCHEDULE_PATH = "/api/wnba/games";
const SOS_PATH = "/api/wnba/sos";
const PLAYERS_PATH = "/api/wnba/players";

type CacheLike = <T>(key: string, factory: () => Promise<T>) => Promise<T>;

interface WnbaS6bRouteOptions {
  fetcher?: FetchLike;
  cache?: CacheLike;
  today?: () => string;
  scheduleDirectTimeoutMs?: number;
  scheduleFallbackTimeoutMs?: number;
  statsTimeoutMs?: number;
  readonlyFallbackTimeoutMs?: number;
  sosFallbackUrl?: string;
  playersFallbackUrl?: string;
}

function fallbackUrl(envName: string, defaultPath: string, override?: string): string {
  return String(override ?? process.env[envName] ?? `https://web-production-7067b.up.railway.app${defaultPath}`).trim();
}

export function registerWnbaS6bRoutes(app: Express, options: WnbaS6bRouteOptions = {}): void {
  const fetcher = options.fetcher ?? fetch;
  const cache = options.cache ?? withCache;
  const today = options.today ?? todayNBA;

  app.get(SCHEDULE_PATH, async (req, res) => {
    const date = String(req.query.date ?? today()).trim();
    try {
      const result = await cache(`wnba-s6b-schedule-${date}`, () => fetchWnbaScheduleResilient(date, {
        fetcher,
        directTimeoutMs: options.scheduleDirectTimeoutMs,
        fallbackTimeoutMs: options.scheduleFallbackTimeoutMs,
      }));
      return res.json({ success: true, data: result.data, source: result.source });
    } catch (error) {
      console.error("wnba S6B schedule error", error);
      return res.status(500).json({
        success: false,
        error: "No se pudo obtener el calendario WNBA",
        code: "WNBA_SCHEDULE_UNAVAILABLE",
      });
    }
  });

  app.get(SOS_PATH, async (req, res) => {
    try {
      const result = await cache("wnba-s6b-sos-v1", async () => {
        try {
          const data = await fetchWnbaSosDirect(fetcher, options.statsTimeoutMs ?? 8_000);
          return { data, source: "wnba-stats-direct" };
        } catch (directError) {
          console.warn("WNBA SOS direct source failed; trying read-only fallback", directError);
          const data = await fetchReadonlyFallback({
            url: fallbackUrl("WNBA_READONLY_SOS_FALLBACK_URL", SOS_PATH, options.sosFallbackUrl),
            currentHost: req.get("host") ?? "",
            fetcher,
            timeoutMs: options.readonlyFallbackTimeoutMs ?? 10_000,
            validate: validWnbaSos,
            label: "WNBA SOS",
          });
          return { data, source: "production-readonly-fallback" };
        }
      });
      return res.json({ success: true, data: result.data, source: result.source });
    } catch (error) {
      console.error("wnba S6B SOS error", error);
      return res.status(500).json({
        success: false,
        error: "No se pudo calcular SOS WNBA",
        code: "WNBA_SOS_UNAVAILABLE",
      });
    }
  });

  app.get(PLAYERS_PATH, async (req, res) => {
    try {
      const result = await cache("wnba-s6b-players-v1", async () => {
        try {
          const data = await fetchWnbaPlayersDirect(fetcher, options.statsTimeoutMs ?? 8_000);
          return { data, source: "wnba-stats-direct" };
        } catch (directError) {
          console.warn("WNBA players direct source failed; trying read-only fallback", directError);
          const data = await fetchReadonlyFallback({
            url: fallbackUrl("WNBA_READONLY_PLAYERS_FALLBACK_URL", PLAYERS_PATH, options.playersFallbackUrl),
            currentHost: req.get("host") ?? "",
            fetcher,
            timeoutMs: options.readonlyFallbackTimeoutMs ?? 10_000,
            validate: validWnbaPlayers,
            label: "WNBA players",
          });
          return { data, source: "production-readonly-fallback" };
        }
      });
      return res.json({ success: true, data: result.data, source: result.source });
    } catch (error) {
      console.error("wnba S6B players error", error);
      return res.status(500).json({
        success: false,
        error: "No se pudieron obtener jugadores WNBA",
        code: "WNBA_PLAYERS_UNAVAILABLE",
      });
    }
  });
}

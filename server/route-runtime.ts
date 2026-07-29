export function requireSecret(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const NBA_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.nba.com/",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Origin": "https://www.nba.com",
  "Connection": "keep-alive",
};

export const WNBA_HEADERS: Record<string, string> = {
  ...NBA_HEADERS,
  Referer: "https://www.wnba.com/",
  Origin: "https://www.wnba.com",
};

export const SEASON = "2025-26";
export const FL_TZ = "America/New_York";
export const SELF_URL = `http://localhost:${process.env.PORT || 5000}`;

const cache: Record<string, { data: unknown; ts: number }> = {};
const TTL = 30 * 60 * 1000;

export async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < TTL) {
    return cache[key].data as T;
  }
  const data = await fn();
  cache[key] = { data, ts: now };
  return data;
}

export function invalidateCache(key: string): void {
  delete cache[key];
}

export async function nbaFetch(
  url: string,
  headers: Record<string, string> = NBA_HEADERS,
  timeoutMs = 12_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`NBA API ${res.status}: ${url}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function wnbaFetch(url: string) {
  const candidates: Array<{ url: string; headers: Record<string, string> }> = url.includes("stats.nba.com")
    ? [
        { url, headers: NBA_HEADERS },
        { url: url.replace("https://stats.nba.com", "https://stats.wnba.com"), headers: WNBA_HEADERS },
      ]
    : [{ url, headers: url.includes("stats.wnba.com") ? WNBA_HEADERS : NBA_HEADERS }];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await nbaFetch(candidate.url, candidate.headers, 12_000);
    } catch (error) {
      lastError = error;
      console.warn(`WNBA stats source failed: ${candidate.url}`, error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("WNBA stats sources unavailable");
}

export function idx(headers: string[], name: string): number {
  return headers.indexOf(name);
}

export function floridaParts(offsetDays = 0): { y: string; m: string; d: string } {
  const now = new Date();
  if (offsetDays) now.setUTCDate(now.getUTCDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: FL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((part) => [part.type, part.value]));
  return { y: parts.year, m: parts.month, d: parts.day };
}

export function todayNBA(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

export function todayISO(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

export function isoToNBA(iso: string): string {
  return iso;
}

export function nbaToISO(nba: string): string {
  const match = nba.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return nba;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

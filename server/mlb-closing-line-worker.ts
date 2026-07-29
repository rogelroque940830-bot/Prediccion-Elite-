import type { LedgerPrediction, MlbLedgerStore } from "./mlb-ledger-store";
import {
  MLB_CLOSING_CAPTURE_CHECKPOINTS,
  type MlbClosingCaptureCheckpoint,
  type MlbClosingLineStore,
} from "./mlb-closing-line-store";

const ODDS_API = "https://api.the-odds-api.com/v4";
const SPORT_KEY = "baseball_mlb";
const BOOKMAKERS = [
  "hardrockbet_fl",
  "hardrockbet",
  "hardrockbet_az",
  "draftkings",
  "fanduel",
  "betmgm",
];
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const START_DELAY_MS = 45 * 1000;

export type SupportedClosingMarket =
  | "h2h"
  | "spreads"
  | "totals"
  | "h2h_1st_5_innings"
  | "totals_1st_5_innings";

export interface ClosingCaptureResult {
  checked: number;
  due: number;
  captured: number;
  unsupported: number;
  noEvent: number;
  noMarket: number;
  noBook: number;
  requests: number;
  quotaRemaining: number | null;
  errors: Array<{ predictionId: string; error: string }>;
}

interface QuotaSummary {
  remaining: number | null;
  used: number | null;
  last: number | null;
}

interface FetchResult {
  data: any;
  quota: QuotaSummary;
}

interface DuePrediction {
  prediction: LedgerPrediction;
  checkpoint: MlbClosingCaptureCheckpoint;
  marketKey: SupportedClosingMarket;
  featured: boolean;
}

interface SelectedQuote {
  sourceEventId: string;
  bookmakerKey: string;
  bookmakerTitle: string;
  matchMode: "EXACT_BOOK" | "PROXY_BOOK";
  marketKey: SupportedClosingMarket;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  quoteAt: string;
  comparable: boolean;
  lineClv: number | null;
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function teamAlias(value: string): string {
  return value
    .replace(/^oakland/, "")
    .replace(/^athletics/, "")
    .replace(/^theathletics/, "");
}

function sameTeam(left: unknown, right: unknown): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return a === b || teamAlias(a) === teamAlias(b);
}

function parseHeaderNumber(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

async function fetchJson(url: string): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: { "User-Agent": "CourtEdge-MLB-Closing-Line/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => null);
  const quota = {
    remaining: parseHeaderNumber(response.headers.get("x-requests-remaining")),
    used: parseHeaderNumber(response.headers.get("x-requests-used")),
    last: parseHeaderNumber(response.headers.get("x-requests-last")),
  };
  if (!response.ok || (!Array.isArray(data) && typeof data !== "object")) {
    throw new Error(data?.message || `Odds API ${response.status}`);
  }
  if (data?.error_code || data?.message) {
    throw new Error(data.message || data.error_code);
  }
  return { data, quota };
}

export function validClosingQuoteTiming(
  predictionRecordedAtMs: number,
  quoteAt: string,
  commenceTime: string,
): boolean {
  const quoteAtMs = Date.parse(quoteAt);
  const commenceTimeMs = Date.parse(commenceTime);
  return Number.isFinite(predictionRecordedAtMs)
    && Number.isFinite(quoteAtMs)
    && Number.isFinite(commenceTimeMs)
    && quoteAtMs >= predictionRecordedAtMs
    && quoteAtMs <= commenceTimeMs;
}

export function closingCheckpointFor(
  nowMs: number,
  commenceTime: string | null | undefined,
): MlbClosingCaptureCheckpoint | null {
  const commenceMs = commenceTime ? Date.parse(commenceTime) : NaN;
  if (!Number.isFinite(commenceMs)) return null;
  const minutes = (commenceMs - nowMs) / 60_000;
  if (minutes <= 0 || minutes > 180) return null;
  if (minutes <= 15) return "T15";
  if (minutes <= 60) return "T60";
  return "T180";
}

export function closingMarketForPrediction(
  prediction: LedgerPrediction,
): { marketKey: SupportedClosingMarket; featured: boolean } | null {
  if (prediction.market.type === "ML") return { marketKey: "h2h", featured: true };
  if (prediction.market.type === "RUN_LINE") return { marketKey: "spreads", featured: true };
  if (prediction.market.type === "TOTAL") return { marketKey: "totals", featured: true };
  if (prediction.market.type === "F5_ML") return { marketKey: "h2h_1st_5_innings", featured: false };
  if (prediction.market.type === "F5_TOTAL") return { marketKey: "totals_1st_5_innings", featured: false };
  return null;
}

function exactBookAliases(book: string | null | undefined): string[] {
  const value = normalize(book);
  if (!value || value.includes("consensus")) return [];
  if (value.includes("hardrock")) return ["hardrockbet_fl", "hardrockbet", "hardrockbet_az"];
  if (value.includes("draftkings") || value === "dk") return ["draftkings"];
  if (value.includes("fanduel") || value === "fd") return ["fanduel"];
  if (value.includes("betmgm") || value === "mgm") return ["betmgm"];
  return BOOKMAKERS.filter((key) => value.includes(normalize(key)));
}

function chooseBookmaker(event: any, prediction: LedgerPrediction) {
  const books = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const exactAliases = exactBookAliases(prediction.market.book);
  for (const alias of exactAliases) {
    const match = books.find((book: any) => book?.key === alias);
    if (match) return { book: match, matchMode: "EXACT_BOOK" as const };
  }
  for (const key of BOOKMAKERS) {
    const match = books.find((book: any) => book?.key === key);
    if (match) return { book: match, matchMode: "PROXY_BOOK" as const };
  }
  return null;
}

function selectedTeamName(prediction: LedgerPrediction, event: any): string | null {
  const selection = normalize(prediction.market.selection);
  const home = String(event?.home_team || prediction.game.homeTeam || "");
  const away = String(event?.away_team || prediction.game.awayTeam || "");
  if (selection.includes(normalize(home))) return home;
  if (selection.includes(normalize(away))) return away;
  if (selection.includes("home") || selection.includes("local")) return home;
  if (selection.includes("away") || selection.includes("visitante")) return away;
  return null;
}

function totalDirection(selection: string): "Over" | "Under" | null {
  const value = normalize(selection);
  if (value.includes("over") || value.includes("mas")) return "Over";
  if (value.includes("under") || value.includes("menos")) return "Under";
  return null;
}

function sameLine(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Math.abs(left - right) < 1e-9;
}

function lineValueFor(
  prediction: LedgerPrediction,
  closeLine: number | null,
): number | null {
  const ticketLine = prediction.market.line;
  if (ticketLine == null || closeLine == null || sameLine(ticketLine, closeLine)) return null;
  if (prediction.market.type === "RUN_LINE") return Math.round((ticketLine - closeLine) * 1000) / 1000;
  const direction = totalDirection(prediction.market.selection);
  if (direction === "Over") return Math.round((closeLine - ticketLine) * 1000) / 1000;
  if (direction === "Under") return Math.round((ticketLine - closeLine) * 1000) / 1000;
  return null;
}

export function selectClosingQuote(
  event: any,
  prediction: LedgerPrediction,
  marketKey: SupportedClosingMarket,
): SelectedQuote | null {
  const chosen = chooseBookmaker(event, prediction);
  if (!chosen) return null;
  const markets = Array.isArray(chosen.book?.markets) ? chosen.book.markets : [];
  const market = markets.find((item: any) => item?.key === marketKey);
  if (!market) return null;
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];

  let outcome: any = null;
  if (marketKey === "h2h" || marketKey === "h2h_1st_5_innings") {
    const teamName = selectedTeamName(prediction, event);
    if (!teamName) return null;
    outcome = outcomes.find((item: any) => sameTeam(item?.name, teamName));
  } else if (marketKey === "spreads") {
    const teamName = selectedTeamName(prediction, event);
    if (!teamName) return null;
    const teamOutcomes = outcomes.filter((item: any) => sameTeam(item?.name, teamName));
    outcome = teamOutcomes.find((item: any) => sameLine(Number(item?.point), prediction.market.line)) ?? teamOutcomes[0];
  } else {
    const direction = totalDirection(prediction.market.selection);
    if (!direction) return null;
    const directional = outcomes.filter((item: any) => normalize(item?.name) === normalize(direction));
    outcome = directional.find((item: any) => sameLine(Number(item?.point), prediction.market.line)) ?? directional[0];
  }

  const oddsAmerican = Number(outcome?.price);
  if (!Number.isInteger(oddsAmerican) || oddsAmerican === 0) return null;
  const point = outcome?.point == null ? null : Number(outcome.point);
  const line = Number.isFinite(point) ? point : null;
  const comparable = prediction.market.type === "ML" || prediction.market.type === "F5_ML"
    ? true
    : sameLine(prediction.market.line, line);
  const quoteAtRaw = market?.last_update || chosen.book?.last_update || event?.last_update || new Date().toISOString();
  const quoteAtMs = Date.parse(String(quoteAtRaw));
  const quoteAt = Number.isFinite(quoteAtMs) ? new Date(quoteAtMs).toISOString() : new Date().toISOString();

  return {
    sourceEventId: String(event?.id || ""),
    bookmakerKey: String(chosen.book?.key || "unknown"),
    bookmakerTitle: String(chosen.book?.title || chosen.book?.key || "Unknown"),
    matchMode: chosen.matchMode,
    marketKey,
    selection: String(outcome?.name || prediction.market.selection),
    line,
    oddsAmerican,
    quoteAt,
    comparable,
    lineClv: lineValueFor(prediction, line),
  };
}

function matchEvent(events: any[], prediction: LedgerPrediction): any | null {
  const expectedStart = prediction.game.commenceTime ? Date.parse(prediction.game.commenceTime) : NaN;
  const candidates = events.filter((event: any) => {
    const ordered = sameTeam(event?.home_team, prediction.game.homeTeam) && sameTeam(event?.away_team, prediction.game.awayTeam);
    const reversed = sameTeam(event?.home_team, prediction.game.awayTeam) && sameTeam(event?.away_team, prediction.game.homeTeam);
    if (!ordered && !reversed) return false;
    if (!Number.isFinite(expectedStart)) return true;
    const actualStart = Date.parse(String(event?.commence_time || ""));
    return Number.isFinite(actualStart) && Math.abs(actualStart - expectedStart) <= 90 * 60 * 1000;
  });
  if (candidates.length !== 1) return null;
  return candidates[0];
}

function quotaMerge(current: number | null, next: number | null): number | null {
  if (next == null) return current;
  if (current == null) return next;
  return Math.min(current, next);
}

export async function runMlbClosingLineCapture(
  ledgerStore: MlbLedgerStore,
  closingStore: MlbClosingLineStore,
  nowMs = Date.now(),
): Promise<ClosingCaptureResult> {
  const records = ledgerStore.listRecords({ limit: 10_000 });
  const result: ClosingCaptureResult = {
    checked: records.length,
    due: 0,
    captured: 0,
    unsupported: 0,
    noEvent: 0,
    noMarket: 0,
    noBook: 0,
    requests: 0,
    quotaRemaining: null,
    errors: [],
  };

  const due: DuePrediction[] = [];
  for (const record of records) {
    const checkpoint = closingCheckpointFor(nowMs, record.prediction.game.commenceTime);
    if (!checkpoint || closingStore.hasAttempt(record.prediction.id, checkpoint)) continue;
    const market = closingMarketForPrediction(record.prediction);
    if (!market) {
      closingStore.appendAttempt(record.prediction.id, {
        checkpoint,
        status: "UNSUPPORTED",
        attemptedAt: new Date(nowMs).toISOString(),
        reason: `Market ${record.prediction.market.type} is not supported by C2D v1`,
      });
      result.unsupported++;
      continue;
    }
    due.push({ prediction: record.prediction, checkpoint, ...market });
  }
  result.due = due.length;
  if (due.length === 0) return result;

  const apiKey = String(process.env.ODDS_API_KEY || "").trim();
  if (!apiKey) throw new Error("Missing required environment variable: ODDS_API_KEY");
  const bookmakers = BOOKMAKERS.join(",");
  const eventsUrl = `${ODDS_API}/sports/${SPORT_KEY}/events?apiKey=${encodeURIComponent(apiKey)}&dateFormat=iso`;
  const eventsResponse = await fetchJson(eventsUrl);
  result.requests++;
  result.quotaRemaining = quotaMerge(result.quotaRemaining, eventsResponse.quota.remaining);
  const events = Array.isArray(eventsResponse.data) ? eventsResponse.data : [];

  const eventByPrediction = new Map<string, any>();
  for (const item of due) {
    const event = matchEvent(events, item.prediction);
    if (!event) {
      closingStore.appendAttempt(item.prediction.id, {
        checkpoint: item.checkpoint,
        status: "NO_EVENT",
        attemptedAt: new Date(nowMs).toISOString(),
        reason: "No unique Odds API event matched teams and commence time",
      });
      result.noEvent++;
      continue;
    }
    eventByPrediction.set(item.prediction.id, event);
  }

  const featuredDue = due.filter((item) => item.featured && eventByPrediction.has(item.prediction.id));
  const featuredMarkets = [...new Set(featuredDue.map((item) => item.marketKey))].sort();
  const featuredEventIds = [...new Set(featuredDue.map((item) => eventByPrediction.get(item.prediction.id)?.id).filter(Boolean))];
  const featuredPayloadById = new Map<string, any>();
  let featuredQuota: QuotaSummary = { remaining: null, used: null, last: null };
  if (featuredMarkets.length && featuredEventIds.length) {
    const url = `${ODDS_API}/sports/${SPORT_KEY}/odds?apiKey=${encodeURIComponent(apiKey)}&bookmakers=${bookmakers}&markets=${featuredMarkets.join(",")}&eventIds=${featuredEventIds.join(",")}&oddsFormat=american&dateFormat=iso`;
    const response = await fetchJson(url);
    result.requests++;
    featuredQuota = response.quota;
    result.quotaRemaining = quotaMerge(result.quotaRemaining, response.quota.remaining);
    for (const event of Array.isArray(response.data) ? response.data : []) {
      featuredPayloadById.set(String(event?.id || ""), event);
    }
  }

  const additionalPayloadByKey = new Map<string, { event: any; quota: QuotaSummary }>();
  const additionalGroups = new Map<string, DuePrediction[]>();
  for (const item of due.filter((row) => !row.featured && eventByPrediction.has(row.prediction.id))) {
    const eventId = String(eventByPrediction.get(item.prediction.id)?.id || "");
    if (!eventId) continue;
    additionalGroups.set(eventId, [...(additionalGroups.get(eventId) || []), item]);
  }
  for (const [eventId, items] of additionalGroups) {
    const markets = [...new Set(items.map((item) => item.marketKey))].sort();
    const url = `${ODDS_API}/sports/${SPORT_KEY}/events/${encodeURIComponent(eventId)}/odds?apiKey=${encodeURIComponent(apiKey)}&bookmakers=${bookmakers}&markets=${markets.join(",")}&oddsFormat=american&dateFormat=iso`;
    try {
      const response = await fetchJson(url);
      result.requests++;
      result.quotaRemaining = quotaMerge(result.quotaRemaining, response.quota.remaining);
      additionalPayloadByKey.set(eventId, { event: response.data, quota: response.quota });
    } catch (error) {
      for (const item of items) {
        result.errors.push({ predictionId: item.prediction.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  for (const item of due) {
    if (!eventByPrediction.has(item.prediction.id)) continue;
    try {
      const baseEvent = eventByPrediction.get(item.prediction.id);
      const eventId = String(baseEvent?.id || "");
      const payload = item.featured
        ? featuredPayloadById.get(eventId)
        : additionalPayloadByKey.get(eventId)?.event;
      const quota = item.featured ? featuredQuota : additionalPayloadByKey.get(eventId)?.quota;
      if (!payload) {
        closingStore.appendAttempt(item.prediction.id, {
          checkpoint: item.checkpoint,
          status: "NO_MARKET",
          attemptedAt: new Date(nowMs).toISOString(),
          reason: `No odds payload returned for ${item.marketKey}`,
        });
        result.noMarket++;
        continue;
      }
      const quote = selectClosingQuote(payload, item.prediction, item.marketKey);
      if (!quote) {
        const hasMarket = (payload?.bookmakers || []).some((book: any) =>
          (book?.markets || []).some((market: any) => market?.key === item.marketKey));
        closingStore.appendAttempt(item.prediction.id, {
          checkpoint: item.checkpoint,
          status: hasMarket ? "NO_BOOK" : "NO_MARKET",
          attemptedAt: new Date(nowMs).toISOString(),
          reason: hasMarket
            ? "No supported bookmaker contained the selected outcome"
            : `Market ${item.marketKey} was not returned`,
        });
        if (hasMarket) result.noBook++;
        else result.noMarket++;
        continue;
      }
      const commenceTime = item.prediction.game.commenceTime;
      if (!commenceTime || !validClosingQuoteTiming(item.prediction.recordedAtMs, quote.quoteAt, commenceTime)) {
        throw new Error("Provider quote timestamp must be between pick recording and commence time");
      }
      closingStore.appendObservation(item.prediction.id, {
        clientRequestId: `auto-close:${item.prediction.id}:${item.checkpoint}:${quote.bookmakerKey}:${item.marketKey}`,
        checkpoint: item.checkpoint,
        quoteAt: quote.quoteAt,
        commenceTime,
        source: "THE_ODDS_API",
        sourceEventId: quote.sourceEventId,
        bookmakerKey: quote.bookmakerKey,
        bookmakerTitle: quote.bookmakerTitle,
        matchMode: quote.matchMode,
        marketKey: item.marketKey,
        selection: quote.selection,
        line: quote.line,
        oddsAmerican: quote.oddsAmerican,
        ticketOddsAmerican: item.prediction.market.oddsAmerican,
        ticketLine: item.prediction.market.line,
        comparable: quote.comparable,
        lineClv: quote.lineClv,
        quota: quota ?? undefined,
        metadata: {
          requestedBook: item.prediction.market.book ?? null,
          captureVersion: "mlb-closing-capture.v1",
        },
      });
      closingStore.appendAttempt(item.prediction.id, {
        checkpoint: item.checkpoint,
        status: "CAPTURED",
        attemptedAt: new Date(nowMs).toISOString(),
        reason: `${quote.matchMode} ${quote.bookmakerKey} ${item.marketKey}`,
      });
      result.captured++;
    } catch (error) {
      result.errors.push({
        predictionId: item.prediction.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

let workerStarted = false;
let workerRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;
let startHandle: NodeJS.Timeout | null = null;

export function startMlbClosingLineWorker(
  ledgerStore: MlbLedgerStore,
  closingStore: MlbClosingLineStore,
): void {
  if (workerStarted || process.env.MLB_CLOSING_LINE_CAPTURE === "false") return;
  workerStarted = true;
  const configured = Number(process.env.MLB_CLOSING_LINE_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(configured) && configured >= 5 * 60 * 1000
    ? configured
    : DEFAULT_INTERVAL_MS;

  const run = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      const summary = await runMlbClosingLineCapture(ledgerStore, closingStore);
      if (summary.due > 0 || summary.errors.length > 0) {
        console.log(`[mlb-ledger] closing-line worker ${JSON.stringify(summary)}`);
      }
    } catch (error) {
      console.error("[mlb-ledger] closing-line worker failed", error);
    } finally {
      workerRunning = false;
    }
  };

  startHandle = setTimeout(() => void run(), START_DELAY_MS);
  startHandle.unref();
  intervalHandle = setInterval(() => void run(), intervalMs);
  intervalHandle.unref();
}

export function stopMlbClosingLineWorkerForTests(): void {
  if (startHandle) clearTimeout(startHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startHandle = null;
  intervalHandle = null;
  workerStarted = false;
  workerRunning = false;
}

export { MLB_CLOSING_CAPTURE_CHECKPOINTS };

import type { MlbPregameLineInputs, MlbPregameMarket } from "./mlb-pregame-readiness";

export const MLB_MANUAL_QUOTE_BOOK = "Hard Rock Bet · verificado por usuario" as const;

export interface MlbManualQuoteCapture {
  gamePk: string;
  date: string;
  market: MlbPregameMarket;
  capturedAt: string;
  signature: string;
  book: typeof MLB_MANUAL_QUOTE_BOOK;
}

export interface MlbManualQuoteContext {
  gamePk: string;
  date: string;
  market: MlbPregameMarket;
  lines: MlbPregameLineInputs;
}

export interface MlbManualQuoteRequest {
  url: string;
  oddsMode: "manual" | "automatic";
  captureCurrent: boolean;
}

function finite(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function americanOdds(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed == null || !Number.isInteger(parsed) || Math.abs(parsed) < 100 || Math.abs(parsed) > 100_000) return null;
  return parsed;
}

function iso(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const parsed = text ? Date.parse(text) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function gamePk(value: unknown): string | null {
  const parsed = Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function officialDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === text ? text : null;
}

function canonicalNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

export function buildMlbManualQuoteSignature(
  market: MlbPregameMarket,
  lines: MlbPregameLineInputs,
): string | null {
  if (market === "ML") {
    const home = americanOdds(lines.mlHome);
    const away = americanOdds(lines.mlAway);
    return home != null && away != null ? `ML|${home}|${away}` : null;
  }
  if (market === "F5_ML") {
    const home = americanOdds(lines.f5MlHome);
    const away = americanOdds(lines.f5MlAway);
    return home != null && away != null ? `F5_ML|${home}|${away}` : null;
  }
  if (market === "RUN_LINE") {
    const line = finite(lines.runLine);
    const home = americanOdds(lines.runLineHomeOdds);
    const away = americanOdds(lines.runLineAwayOdds);
    return line != null && home != null && away != null
      ? `RUN_LINE|${canonicalNumber(line)}|${home}|${away}`
      : null;
  }
  if (market === "TOTAL") {
    const line = finite(lines.totalLine);
    const over = americanOdds(lines.overOdds);
    const under = americanOdds(lines.underOdds);
    return line != null && over != null && under != null
      ? `TOTAL|${canonicalNumber(line)}|${over}|${under}`
      : null;
  }

  // The current predictor does not carry a distinct F5 Over/Under pair.
  // Do not synthesize it from full-game total prices.
  return null;
}

export function createMlbManualQuoteCapture(input: MlbManualQuoteContext & { capturedAt: string }): MlbManualQuoteCapture | null {
  const normalizedGamePk = gamePk(input.gamePk);
  const normalizedDate = officialDate(input.date);
  const signature = buildMlbManualQuoteSignature(input.market, input.lines);
  const normalizedCapturedAt = iso(input.capturedAt);
  if (!normalizedGamePk || !normalizedDate || !signature || !normalizedCapturedAt) return null;
  return {
    gamePk: normalizedGamePk,
    date: normalizedDate,
    market: input.market,
    capturedAt: normalizedCapturedAt,
    signature,
    book: MLB_MANUAL_QUOTE_BOOK,
  };
}

export function isMlbManualQuoteCaptureCurrent(
  capture: MlbManualQuoteCapture | null | undefined,
  context: MlbManualQuoteContext,
): boolean {
  if (!capture) return false;
  const normalizedGamePk = gamePk(context.gamePk);
  const normalizedDate = officialDate(context.date);
  if (!normalizedGamePk || !normalizedDate) return false;
  if (capture.gamePk !== normalizedGamePk || capture.date !== normalizedDate || capture.market !== context.market) return false;
  const signature = buildMlbManualQuoteSignature(context.market, context.lines);
  return Boolean(signature && signature === capture.signature && iso(capture.capturedAt));
}

function addMarketParams(
  params: URLSearchParams,
  market: MlbPregameMarket,
  lines: MlbPregameLineInputs,
): boolean {
  if (market === "ML") {
    const home = americanOdds(lines.mlHome);
    const away = americanOdds(lines.mlAway);
    if (home == null || away == null) return false;
    params.set("manualHomeOdds", String(home));
    params.set("manualAwayOdds", String(away));
    return true;
  }
  if (market === "F5_ML") {
    const home = americanOdds(lines.f5MlHome);
    const away = americanOdds(lines.f5MlAway);
    if (home == null || away == null) return false;
    params.set("manualHomeOdds", String(home));
    params.set("manualAwayOdds", String(away));
    return true;
  }
  if (market === "RUN_LINE") {
    const line = finite(lines.runLine);
    const home = americanOdds(lines.runLineHomeOdds);
    const away = americanOdds(lines.runLineAwayOdds);
    if (line == null || home == null || away == null) return false;
    params.set("manualLine", canonicalNumber(line));
    params.set("manualHomeOdds", String(home));
    params.set("manualAwayOdds", String(away));
    return true;
  }
  if (market === "TOTAL") {
    const line = finite(lines.totalLine);
    const over = americanOdds(lines.overOdds);
    const under = americanOdds(lines.underOdds);
    if (line == null || over == null || under == null) return false;
    params.set("manualLine", canonicalNumber(line));
    params.set("manualOverOdds", String(over));
    params.set("manualUnderOdds", String(under));
    return true;
  }
  return false;
}

/**
 * Overlay an explicit operator-verified Hard Rock snapshot onto the existing
 * readiness URL. The capture must match the exact game/date/market/quote tuple.
 * This prevents a prior-game snapshot from being reused during a React render
 * before effect-driven cleanup can run. Time age remains server-authoritative.
 */
export function applyMlbManualQuoteCapture(input: {
  automaticUrl: string;
  market: MlbPregameMarket;
  lines: MlbPregameLineInputs;
  capture?: MlbManualQuoteCapture | null;
}): MlbManualQuoteRequest {
  const [path, rawQuery = ""] = input.automaticUrl.split("?", 2);
  const params = new URLSearchParams(rawQuery);
  const context: MlbManualQuoteContext = {
    gamePk: params.get("gamePk") ?? "",
    date: params.get("date") ?? "",
    market: input.market,
    lines: input.lines,
  };
  if (!isMlbManualQuoteCaptureCurrent(input.capture, context)) {
    return { url: input.automaticUrl, oddsMode: "automatic", captureCurrent: false };
  }

  params.delete("oddsMode");
  params.delete("manualCapturedAt");
  params.delete("manualBook");
  params.delete("manualLine");
  params.delete("manualHomeOdds");
  params.delete("manualAwayOdds");
  params.delete("manualOverOdds");
  params.delete("manualUnderOdds");

  if (!addMarketParams(params, input.market, input.lines)) {
    return { url: input.automaticUrl, oddsMode: "automatic", captureCurrent: false };
  }

  params.set("oddsMode", "manual");
  params.set("manualCapturedAt", input.capture!.capturedAt);
  params.set("manualBook", input.capture!.book);
  return {
    url: `${path}?${params.toString()}`,
    oddsMode: "manual",
    captureCurrent: true,
  };
}

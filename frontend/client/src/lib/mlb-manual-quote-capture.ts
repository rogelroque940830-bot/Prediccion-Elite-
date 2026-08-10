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

type NormalizedQuote = { signature: string; values: number[] };

function number(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function american(value: unknown): number | null {
  const parsed = number(value);
  return parsed != null && Number.isInteger(parsed) && Math.abs(parsed) >= 100 && Math.abs(parsed) <= 100_000
    ? parsed
    : null;
}

function timestamp(value: unknown): string | null {
  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function identity(gamePk: unknown, date: unknown): [string, string] | null {
  const game = Number(String(gamePk ?? "").trim());
  const day = String(date ?? "").trim();
  if (!Number.isInteger(game) || game <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day
    ? [String(game), day]
    : null;
}

function quote(market: MlbPregameMarket, lines: MlbPregameLineInputs): NormalizedQuote | null {
  let values: Array<number | null>;
  if (market === "ML") values = [american(lines.mlHome), american(lines.mlAway)];
  else if (market === "F5_ML") values = [american(lines.f5MlHome), american(lines.f5MlAway)];
  else if (market === "RUN_LINE") values = [number(lines.runLine), american(lines.runLineHomeOdds), american(lines.runLineAwayOdds)];
  else if (market === "TOTAL") values = [number(lines.totalLine), american(lines.overOdds), american(lines.underOdds)];
  else return null;
  if (values.some((value) => value == null)) return null;
  const normalized = values as number[];
  return { signature: `${market}|${normalized.join("|")}`, values: normalized };
}

export function buildMlbManualQuoteSignature(market: MlbPregameMarket, lines: MlbPregameLineInputs): string | null {
  return quote(market, lines)?.signature ?? null;
}

export function createMlbManualQuoteCapture(input: MlbManualQuoteContext & { capturedAt: string }): MlbManualQuoteCapture | null {
  const id = identity(input.gamePk, input.date);
  const normalizedQuote = quote(input.market, input.lines);
  const capturedAt = timestamp(input.capturedAt);
  if (!id || !normalizedQuote || !capturedAt) return null;
  return {
    gamePk: id[0],
    date: id[1],
    market: input.market,
    capturedAt,
    signature: normalizedQuote.signature,
    book: MLB_MANUAL_QUOTE_BOOK,
  };
}

export function isMlbManualQuoteCaptureCurrent(
  capture: MlbManualQuoteCapture | null | undefined,
  context: MlbManualQuoteContext,
): boolean {
  if (!capture) return false;
  const id = identity(context.gamePk, context.date);
  const normalizedQuote = quote(context.market, context.lines);
  return Boolean(
    id
      && normalizedQuote
      && capture.gamePk === id[0]
      && capture.date === id[1]
      && capture.market === context.market
      && capture.signature === normalizedQuote.signature
      && timestamp(capture.capturedAt),
  );
}

export function applyMlbManualQuoteCapture(input: {
  automaticUrl: string;
  market: MlbPregameMarket;
  lines: MlbPregameLineInputs;
  capture?: MlbManualQuoteCapture | null;
}): { url: string; oddsMode: "manual" | "automatic"; captureCurrent: boolean } {
  const [path, rawQuery = ""] = input.automaticUrl.split("?", 2);
  const params = new URLSearchParams(rawQuery);
  const normalizedQuote = quote(input.market, input.lines);
  if (!normalizedQuote || !isMlbManualQuoteCaptureCurrent(input.capture, {
    gamePk: params.get("gamePk") ?? "",
    date: params.get("date") ?? "",
    market: input.market,
    lines: input.lines,
  })) return { url: input.automaticUrl, oddsMode: "automatic", captureCurrent: false };

  const values = normalizedQuote.values;
  if (input.market === "ML" || input.market === "F5_ML") {
    params.set("manualHomeOdds", String(values[0]));
    params.set("manualAwayOdds", String(values[1]));
  } else if (input.market === "RUN_LINE") {
    params.set("manualLine", String(values[0]));
    params.set("manualHomeOdds", String(values[1]));
    params.set("manualAwayOdds", String(values[2]));
  } else {
    params.set("manualLine", String(values[0]));
    params.set("manualOverOdds", String(values[1]));
    params.set("manualUnderOdds", String(values[2]));
  }
  params.set("oddsMode", "manual");
  params.set("manualCapturedAt", input.capture!.capturedAt);
  params.set("manualBook", input.capture!.book);
  return { url: `${path}?${params.toString()}`, oddsMode: "manual", captureCurrent: true };
}

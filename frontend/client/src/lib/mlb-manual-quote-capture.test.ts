import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_MANUAL_QUOTE_BOOK,
  applyMlbManualQuoteCapture,
  buildMlbManualQuoteSignature,
  createMlbManualQuoteCapture,
  isMlbManualQuoteCaptureCurrent,
} from "./mlb-manual-quote-capture";
import type { MlbPregameLineInputs } from "./mlb-pregame-readiness";

const lines: MlbPregameLineInputs = {
  mlHome: "-125",
  mlAway: "+115",
  runLine: "-1.5",
  runLineHomeOdds: "+135",
  runLineAwayOdds: "-155",
  totalLine: "8.5",
  overOdds: "-110",
  underOdds: "-110",
  f5MlHome: "-120",
  f5MlAway: "+105",
  f5TotalLine: "4.5",
  f5OddsSource: "manual",
};

const automaticUrl = "/api/mlb/p1/v1/pregame-readiness?gamePk=824158&date=2026-08-10&market=ML";
const capturedAt = "2026-08-10T19:50:00.000Z";

test("manual signatures require complete market-specific bilateral prices", () => {
  assert.equal(buildMlbManualQuoteSignature("ML", lines), "ML|-125|115");
  assert.equal(buildMlbManualQuoteSignature("F5_ML", lines), "F5_ML|-120|105");
  assert.equal(buildMlbManualQuoteSignature("RUN_LINE", lines), "RUN_LINE|-1.5|135|-155");
  assert.equal(buildMlbManualQuoteSignature("TOTAL", lines), "TOTAL|8.5|-110|-110");
  assert.equal(buildMlbManualQuoteSignature("F5_TOTAL", lines), null);

  assert.equal(buildMlbManualQuoteSignature("ML", { ...lines, mlAway: "" }), null);
  assert.equal(buildMlbManualQuoteSignature("RUN_LINE", { ...lines, runLineHomeOdds: "-95" }), null);
  assert.equal(buildMlbManualQuoteSignature("TOTAL", { ...lines, underOdds: "abc" }), null);
});

test("capture exists only after an explicit timestamped user action", () => {
  const capture = createMlbManualQuoteCapture("ML", lines, capturedAt);
  assert.deepEqual(capture, {
    market: "ML",
    capturedAt,
    signature: "ML|-125|115",
    book: MLB_MANUAL_QUOTE_BOOK,
  });
  assert.equal(createMlbManualQuoteCapture("ML", lines, "not-a-time"), null);
  assert.equal(createMlbManualQuoteCapture("F5_TOTAL", lines, capturedAt), null);
});

test("changing any certified value invalidates the capture instead of manufacturing a new timestamp", () => {
  const capture = createMlbManualQuoteCapture("TOTAL", lines, capturedAt);
  assert.ok(capture);
  assert.equal(isMlbManualQuoteCaptureCurrent(capture, "TOTAL", lines), true);
  assert.equal(isMlbManualQuoteCaptureCurrent(capture, "TOTAL", { ...lines, overOdds: "-115" }), false);
  assert.equal(isMlbManualQuoteCaptureCurrent(capture, "TOTAL", { ...lines, totalLine: "9" }), false);
  assert.equal(isMlbManualQuoteCaptureCurrent(capture, "ML", lines), false);
});

test("ML capture overlays exact backend manual parameters and preserves stored capture time", () => {
  const capture = createMlbManualQuoteCapture("ML", lines, capturedAt);
  const request = applyMlbManualQuoteCapture({ automaticUrl, market: "ML", lines, capture });
  assert.equal(request.oddsMode, "manual");
  assert.equal(request.captureCurrent, true);
  const parsed = new URL(request.url, "https://local.invalid");
  assert.equal(parsed.searchParams.get("oddsMode"), "manual");
  assert.equal(parsed.searchParams.get("manualCapturedAt"), capturedAt);
  assert.equal(parsed.searchParams.get("manualBook"), MLB_MANUAL_QUOTE_BOOK);
  assert.equal(parsed.searchParams.get("manualHomeOdds"), "-125");
  assert.equal(parsed.searchParams.get("manualAwayOdds"), "115");
});

test("Run Line and Total map only their exact server contract fields", () => {
  const rlCapture = createMlbManualQuoteCapture("RUN_LINE", lines, capturedAt);
  const rl = applyMlbManualQuoteCapture({
    automaticUrl: automaticUrl.replace("market=ML", "market=RUN_LINE"),
    market: "RUN_LINE",
    lines,
    capture: rlCapture,
  });
  const rlUrl = new URL(rl.url, "https://local.invalid");
  assert.equal(rlUrl.searchParams.get("manualLine"), "-1.5");
  assert.equal(rlUrl.searchParams.get("manualHomeOdds"), "135");
  assert.equal(rlUrl.searchParams.get("manualAwayOdds"), "-155");
  assert.equal(rlUrl.searchParams.get("manualOverOdds"), null);

  const totalCapture = createMlbManualQuoteCapture("TOTAL", lines, capturedAt);
  const total = applyMlbManualQuoteCapture({
    automaticUrl: automaticUrl.replace("market=ML", "market=TOTAL"),
    market: "TOTAL",
    lines,
    capture: totalCapture,
  });
  const totalUrl = new URL(total.url, "https://local.invalid");
  assert.equal(totalUrl.searchParams.get("manualLine"), "8.5");
  assert.equal(totalUrl.searchParams.get("manualOverOdds"), "-110");
  assert.equal(totalUrl.searchParams.get("manualUnderOdds"), "-110");
  assert.equal(totalUrl.searchParams.get("manualHomeOdds"), null);
});

test("manual capture remains fail-closed when absent, edited, incomplete or unsupported", () => {
  const capture = createMlbManualQuoteCapture("F5_ML", lines, capturedAt);
  assert.ok(capture);

  const absent = applyMlbManualQuoteCapture({ automaticUrl, market: "ML", lines, capture: null });
  assert.equal(absent.oddsMode, "automatic");
  assert.equal(absent.url, automaticUrl);

  const edited = applyMlbManualQuoteCapture({
    automaticUrl: automaticUrl.replace("market=ML", "market=F5_ML"),
    market: "F5_ML",
    lines: { ...lines, f5MlAway: "+110" },
    capture,
  });
  assert.equal(edited.oddsMode, "automatic");
  assert.doesNotMatch(edited.url, /oddsMode=manual/);

  const unsupported = applyMlbManualQuoteCapture({
    automaticUrl: automaticUrl.replace("market=ML", "market=F5_TOTAL"),
    market: "F5_TOTAL",
    lines,
    capture: null,
  });
  assert.equal(unsupported.oddsMode, "automatic");
});

test("capture helper never decides time freshness locally", () => {
  const oldCapture = createMlbManualQuoteCapture("ML", lines, "2026-08-01T00:00:00.000Z");
  assert.ok(oldCapture);
  const request = applyMlbManualQuoteCapture({ automaticUrl, market: "ML", lines, capture: oldCapture });
  assert.equal(request.oddsMode, "manual");
  assert.match(request.url, /manualCapturedAt=2026-08-01T00%3A00%3A00.000Z/);
  // Server P1-M2B remains authoritative for the five-minute freshness decision.
});

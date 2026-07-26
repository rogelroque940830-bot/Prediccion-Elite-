import fs from "node:fs";
import { chromium } from "playwright";

const API_BASE = process.env.API_BASE || "https://web-p0-integration.up.railway.app";
const APP_URL = process.env.APP_URL || "http://127.0.0.1:4173/#/mlb";
const WRITE_TOKEN = String(process.env.COURTEDGE_WRITE_TOKEN || "").trim();
const GAME_PK = 823433;
const GAME_DATE = "2026-07-26";
const EVIDENCE_PATH = process.env.EVIDENCE_PATH || "mlb-real-ledger-evidence.json";

if (!WRITE_TOKEN) throw new Error("COURTEDGE_WRITE_TOKEN secret is not available to the workflow");

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method || "GET"} ${url} -> ${response.status}: ${text.slice(0, 500)}`);
  return body;
}

const evidence = {
  test: "real-mlb-predictor-to-ledger",
  gamePk: GAME_PK,
  gameDate: GAME_DATE,
  startedAt: new Date().toISOString(),
  apiBase: API_BASE,
};

const official = await jsonFetch(`https://statsapi.mlb.com/api/v1.1/game/${GAME_PK}/feed/live`);
const abstractState = official?.gameData?.status?.abstractGameState;
const detailedState = official?.gameData?.status?.detailedState;
const officialStart = official?.gameData?.datetime?.dateTime;
evidence.officialPregame = { abstractState, detailedState, officialStart };
if (abstractState !== "Preview") {
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify({ ...evidence, aborted: true, reason: "Official game is no longer pregame" }, null, 2));
  throw new Error(`Official MLB state is ${abstractState}/${detailedState}; refusing post-start ledger write`);
}

const before = await jsonFetch(`${API_BASE}/api/mlb/ledger/v1/status`);
evidence.ledgerBefore = before.data;

const oddsEnvelope = await jsonFetch(`${API_BASE}/api/odds/mlb?date=${GAME_DATE}`);
const oddsGame = (oddsEnvelope.games || []).find((game) => {
  const home = String(game.homeTeam || "").toLowerCase();
  const away = String(game.awayTeam || "").toLowerCase();
  return home.includes("phil") && away.includes("yank");
});
if (!oddsGame?.ml?.home || !oddsGame?.ml?.away) {
  throw new Error("Hard Rock odds endpoint did not return NYY @ PHI moneyline prices");
}
evidence.hardRockOdds = oddsGame;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const browserLog = [];
const pickPosts = [];
page.on("console", (message) => browserLog.push({ type: message.type(), text: message.text() }));
page.on("pageerror", (error) => browserLog.push({ type: "pageerror", text: error.message }));

await page.route(`${API_BASE}/**`, async (route) => {
  const request = route.request();
  const method = request.method();
  const headers = { ...request.headers() };
  for (const key of ["origin", "referer", "host", "content-length", "cookie"]) delete headers[key];
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers["x-courtedge-write-key"] = WRITE_TOKEN;
  const response = await fetch(request.url(), {
    method,
    headers,
    body: ["GET", "HEAD"].includes(method) ? undefined : request.postDataBuffer(),
    redirect: "manual",
  });
  const body = Buffer.from(await response.arrayBuffer());
  const responseHeaders = {};
  for (const [key, value] of response.headers.entries()) {
    if (!["content-encoding", "content-length", "transfer-encoding", "set-cookie"].includes(key.toLowerCase())) responseHeaders[key] = value;
  }
  if (request.url().includes("/api/picks/v2") && method === "POST") {
    let parsed = null;
    try { parsed = JSON.parse(body.toString("utf8")); } catch {}
    pickPosts.push({ status: response.status, body: parsed || body.toString("utf8") });
  }
  await route.fulfill({ status: response.status, headers: responseHeaders, body });
});

try {
  await page.goto(APP_URL, { waitUntil: "networkidle", timeout: 120_000 });
  await page.getByRole("heading", { name: /Predictor MLB/i }).waitFor({ timeout: 60_000 });

  await page.getByTestId("button-load-mlb").click();
  await page.getByTestId("select-mlb-game").waitFor({ timeout: 120_000 });
  await page.getByTestId("select-mlb-game").click();
  await page.getByRole("option", { name: /New York Yankees @ Philadelphia Phillies/i }).click();

  await page.getByTestId("button-mlb-autofill").click();
  await page.getByText(/Pitchers \+ Stats \+ Bullpen cargados/i).waitFor({ timeout: 300_000 });

  const hrButton = page.getByRole("button", { name: /Cuotas HR/i });
  await hrButton.click();
  await page.waitForTimeout(1_500);

  const expected = {
    homeMl: String(oddsGame.ml.home),
    awayMl: String(oddsGame.ml.away),
    runLine: oddsGame.spread?.line == null ? null : String(oddsGame.spread.line),
    homeRunLineOdds: oddsGame.spread?.homeOdds == null ? null : String(oddsGame.spread.homeOdds),
    awayRunLineOdds: oddsGame.spread?.awayOdds == null ? null : String(oddsGame.spread.awayOdds),
    total: oddsGame.total?.line == null ? null : String(oddsGame.total.line),
    overOdds: oddsGame.total?.overOdds == null ? null : String(oddsGame.total.overOdds),
    underOdds: oddsGame.total?.underOdds == null ? null : String(oddsGame.total.underOdds),
  };
  await page.getByTestId("line-ml-odds").fill(expected.homeMl);
  await page.getByTestId("line-ml-away").fill(expected.awayMl);
  if (expected.runLine) await page.getByTestId("line-run-line").fill(expected.runLine);
  if (expected.homeRunLineOdds) await page.getByTestId("input-rl-odds").fill(expected.homeRunLineOdds);
  if (expected.awayRunLineOdds) await page.getByTestId("input-rl-away").fill(expected.awayRunLineOdds);
  if (expected.total) await page.getByTestId("line-ou").fill(expected.total);
  if (expected.overOdds) await page.getByTestId("input-over-odds").fill(expected.overOdds);
  if (expected.underOdds) await page.getByTestId("input-under-odds").fill(expected.underOdds);
  evidence.uiOdds = expected;

  await page.getByTestId("btn-predict").click();
  await page.getByRole("heading", { name: /Resultados del Análisis/i }).waitFor({ timeout: 90_000 });
  const bodyText = await page.locator("body").innerText();
  const marker = bodyText.indexOf("ÚNICA JUGADA RECOMENDADA");
  const recommendationSlice = marker >= 0 ? bodyText.slice(marker, marker + 700) : "PASS — Sin jugada en este partido";
  evidence.recommendationText = recommendationSlice;

  let selectedMarket = "ML";
  if (/F5 \(5 entradas\)/i.test(recommendationSlice)) selectedMarket = "F5";
  else if (/Run Line/i.test(recommendationSlice)) selectedMarket = "Run Line";
  else if (/Total O\/U/i.test(recommendationSlice)) selectedMarket = "TOTAL";
  evidence.selectedMarket = selectedMarket;

  const saveHeading = page.getByText("Guardar picks en historial MLB", { exact: true });
  await saveHeading.scrollIntoViewIfNeeded();
  const saveCard = saveHeading.locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]');
  let saveButton;
  if (selectedMarket === "F5") saveButton = saveCard.getByRole("button", { name: /^F5$/ });
  else if (selectedMarket === "Run Line") saveButton = saveCard.getByRole("button", { name: /Run Line/i });
  else if (selectedMarket === "TOTAL") saveButton = saveCard.getByRole("button", { name: /^(OVER|UNDER)$/i });
  else saveButton = saveCard.getByRole("button", { name: /^ML$/ });

  const firstPost = page.waitForResponse((response) => response.url().includes("/api/picks/v2") && response.request().method() === "POST", { timeout: 60_000 });
  await saveButton.click();
  const savedResponse = await firstPost;
  const savedBody = await savedResponse.json();
  evidence.savedResponse = { status: savedResponse.status(), body: savedBody };
  if (!savedResponse.ok() || !savedBody?.success || savedBody?.ledger?.mode !== "FULL_SNAPSHOT") {
    throw new Error(`Canonical save failed: ${savedResponse.status()} ${JSON.stringify(savedBody)}`);
  }

  const postsAfterFirst = pickPosts.length;
  await saveButton.click();
  await page.waitForTimeout(1_500);
  evidence.duplicateUiGuard = { postsBeforeSecondClick: postsAfterFirst, postsAfterSecondClick: pickPosts.length };
  if (pickPosts.length !== postsAfterFirst) throw new Error("Second identical UI click sent another Picks V2 POST");

  await page.screenshot({ path: "mlb-real-ledger-ui.png", fullPage: true });
} finally {
  evidence.browserLog = browserLog.slice(-200);
  evidence.pickPosts = pickPosts;
  await browser.close();
}

const after = await jsonFetch(`${API_BASE}/api/mlb/ledger/v1/status`);
const records = await jsonFetch(`${API_BASE}/api/mlb/ledger/v1/predictions?from=${GAME_DATE}&to=${GAME_DATE}&limit=100`);
const matching = (records.data || []).filter((record) => record?.prediction?.game?.gamePk === GAME_PK);
evidence.ledgerAfter = after.data;
evidence.matchingRecords = matching;
evidence.finishedAt = new Date().toISOString();

if (after.data.predictions !== before.data.predictions + 1) {
  throw new Error(`Expected ledger prediction count ${before.data.predictions + 1}, got ${after.data.predictions}`);
}
if (matching.length !== 1) throw new Error(`Expected exactly one ledger record for gamePk ${GAME_PK}, got ${matching.length}`);
const prediction = matching[0].prediction;
if (prediction.game.homeTeam !== "Philadelphia Phillies" || prediction.game.awayTeam !== "New York Yankees") throw new Error("Official home/away orientation is incorrect");
if (prediction.analysisStage !== "FINAL" && prediction.analysisStage !== "PROVISIONAL") throw new Error("Missing scientific analysis stage");
if (!prediction.payload?.analysis?.rawInputs || !prediction.payload?.analysis?.rawOutput) throw new Error("Full calculation snapshot is missing rawInputs/rawOutput");
if (!String(prediction.clientRequestId || "").startsWith("picks-v2:")) throw new Error("Canonical clientRequestId is missing");

fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({
  success: true,
  predictionId: prediction.id,
  selection: prediction.market.selection,
  market: prediction.market.type,
  odds: prediction.market.oddsAmerican,
  modelProbability: prediction.probabilities.model,
  edgePp: prediction.probabilities.edgePp,
  signal: prediction.decision.signal,
  stakeUnits: prediction.decision.stakeUnits,
  stage: prediction.analysisStage,
  ledgerBefore: before.data.predictions,
  ledgerAfter: after.data.predictions,
}, null, 2));

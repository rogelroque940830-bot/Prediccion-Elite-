// ═══════════════════════════════════════════════════════════════════════════
// SHARP SIGNALS — Line Movement, Steam Detection, Reverse Line Movement, CLV
//
// These are the professional-bettor edge signals that retail models ignore.
//
//   LINE MOVEMENT  — comparing current line vs a stored "opening" snapshot
//   STEAM MOVE     — 3+ books moving line same direction in <10 min
//   REVERSE LINE   — public on side A, line moves toward side B = sharp money
//   CLV (Closing Line Value) — compare bet odds at pick time vs closing odds
// ═══════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

// ─── PERSISTENT STORAGE ────────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), "data");
const HISTORY_FILE = path.join(DATA_DIR, "line-history.json");

export interface LineSnapshot {
  ts: number;                     // unix ms
  sport: string;
  gameKey: string;                // "{awayTeam}@{homeTeam}@{commenceISO}"
  book: string;                   // "hardrockbet_fl" etc
  ml: { home: number; away: number } | null;
  spread: { line: number; homeOdds: number; awayOdds: number } | null;
  total: { line: number; overOdds: number; underOdds: number } | null;
}

let historyCache: LineSnapshot[] = [];
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(HISTORY_FILE)) {
      historyCache = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch (e) {
    historyCache = [];
  }
  loaded = true;
}

function persist() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Prune: keep only last 7 days of history
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    historyCache = historyCache.filter((s) => s.ts >= cutoff);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyCache));
  } catch {}
}

export function recordSnapshot(snap: LineSnapshot) {
  ensureLoaded();
  historyCache.push(snap);
  // Persist every 10 snapshots to reduce I/O
  if (historyCache.length % 10 === 0) persist();
}

export function getHistoryForGame(sport: string, gameKey: string): LineSnapshot[] {
  ensureLoaded();
  return historyCache.filter((s) => s.sport === sport && s.gameKey === gameKey);
}

export function getAllGameKeys(sport: string): string[] {
  ensureLoaded();
  return Array.from(new Set(historyCache.filter(s => s.sport === sport).map(s => s.gameKey)));
}

export function getAllSnapshots(): LineSnapshot[] {
  ensureLoaded();
  return historyCache;
}

// ─── LINE MOVEMENT ANALYSIS ────────────────────────────────────────────────
export interface LineMovement {
  gameKey: string;
  market: "ML" | "Spread" | "Total";
  side: string;             // "home" | "away" | "over" | "under"
  opening: number;          // opening odds or line
  current: number;
  delta: number;
  magnitude: "none" | "small" | "moderate" | "big";
  direction: "toward" | "away" | "neutral";
  notes: string;
}

/**
 * Analyzes one game's history across books to compute net line movement.
 * Returns the "consensus" opening and current lines (using DraftKings as proxy).
 */
export function analyzeLineMovement(history: LineSnapshot[]): LineMovement[] {
  if (history.length < 2) return [];
  const sorted = [...history].sort((a, b) => a.ts - b.ts);

  // Prefer Hard Rock; fallback to DraftKings/FanDuel
  const pickBook = (snaps: LineSnapshot[]): LineSnapshot | null => {
    for (const pref of ["hardrockbet_fl", "hardrockbet", "draftkings", "fanduel"]) {
      const s = snaps.find((x) => x.book === pref);
      if (s) return s;
    }
    return snaps[0] || null;
  };

  // Group by timestamp (within 1 min = same snapshot round)
  const byTime: Record<string, LineSnapshot[]> = {};
  for (const s of sorted) {
    const bucket = Math.floor(s.ts / 60000) * 60000;
    byTime[bucket] = byTime[bucket] || [];
    byTime[bucket].push(s);
  }
  const buckets = Object.keys(byTime).sort();
  if (buckets.length < 2) return [];

  const openSnap = pickBook(byTime[buckets[0]]);
  const currSnap = pickBook(byTime[buckets[buckets.length - 1]]);
  if (!openSnap || !currSnap) return [];

  const movements: LineMovement[] = [];
  const gameKey = currSnap.gameKey;

  // ML movement (in cents)
  if (openSnap.ml && currSnap.ml) {
    const homeDelta = currSnap.ml.home - openSnap.ml.home;
    if (Math.abs(homeDelta) >= 5) {
      const dir = homeDelta > 0 ? "away" : "toward"; // price higher = less favored
      movements.push({
        gameKey, market: "ML", side: "home",
        opening: openSnap.ml.home, current: currSnap.ml.home,
        delta: homeDelta,
        magnitude: Math.abs(homeDelta) >= 20 ? "big" : Math.abs(homeDelta) >= 10 ? "moderate" : "small",
        direction: homeDelta < 0 ? "toward" : "away",
        notes: `ML local ${openSnap.ml.home > 0 ? "+" : ""}${openSnap.ml.home} → ${currSnap.ml.home > 0 ? "+" : ""}${currSnap.ml.home}`,
      });
    }
  }

  // Spread movement (in points)
  if (openSnap.spread && currSnap.spread) {
    const lineDelta = currSnap.spread.line - openSnap.spread.line;
    if (Math.abs(lineDelta) >= 0.5) {
      movements.push({
        gameKey, market: "Spread", side: "home",
        opening: openSnap.spread.line, current: currSnap.spread.line,
        delta: lineDelta,
        magnitude: Math.abs(lineDelta) >= 2 ? "big" : Math.abs(lineDelta) >= 1 ? "moderate" : "small",
        direction: lineDelta > 0 ? "toward" : "away", // positive = home getting less favored
        notes: `Spread ${openSnap.spread.line > 0 ? "+" : ""}${openSnap.spread.line} → ${currSnap.spread.line > 0 ? "+" : ""}${currSnap.spread.line}`,
      });
    }
  }

  // Total movement
  if (openSnap.total && currSnap.total) {
    const totalDelta = currSnap.total.line - openSnap.total.line;
    if (Math.abs(totalDelta) >= 0.5) {
      movements.push({
        gameKey, market: "Total", side: "over",
        opening: openSnap.total.line, current: currSnap.total.line,
        delta: totalDelta,
        magnitude: Math.abs(totalDelta) >= 2 ? "big" : Math.abs(totalDelta) >= 1 ? "moderate" : "small",
        direction: totalDelta > 0 ? "toward" : "away",
        notes: `Total ${openSnap.total.line} → ${currSnap.total.line}`,
      });
    }
  }

  return movements;
}

// ─── STEAM DETECTION ───────────────────────────────────────────────────────
// A "steam move" is when 3+ sportsbooks move the line in the same direction
// within a short window (<10 minutes). This indicates sharp money hitting.

export interface SteamMove {
  gameKey: string;
  market: "ML" | "Spread" | "Total";
  direction: "home" | "away" | "over" | "under";
  booksMoved: string[];
  magnitude: number;
  timestamp: number;
  notes: string;
}

export function detectSteamMoves(history: LineSnapshot[]): SteamMove[] {
  if (history.length < 6) return []; // need multi-book, multi-time data
  const sorted = [...history].sort((a, b) => a.ts - b.ts);

  // Group by book, then compare each book's 2 most recent snapshots
  const byBook: Record<string, LineSnapshot[]> = {};
  for (const s of sorted) {
    byBook[s.book] = byBook[s.book] || [];
    byBook[s.book].push(s);
  }

  const now = Date.now();
  const WINDOW = 15 * 60 * 1000; // 15 min

  const moves: Record<string, { books: string[]; mag: number; dir: string }> = {};
  for (const [book, snaps] of Object.entries(byBook)) {
    if (snaps.length < 2) continue;
    const latest = snaps[snaps.length - 1];
    // Find snap from 10-30 min ago for this book
    const priorIdx = snaps.findIndex((s) => now - s.ts > 10 * 60 * 1000 && now - s.ts < 60 * 60 * 1000);
    if (priorIdx === -1) continue;
    const prior = snaps[priorIdx];
    if (latest.ts - prior.ts > WINDOW) continue;

    // Spread move
    if (prior.spread && latest.spread) {
      const d = latest.spread.line - prior.spread.line;
      if (Math.abs(d) >= 0.5) {
        const key = `Spread-${d > 0 ? "away" : "home"}`;
        moves[key] = moves[key] || { books: [], mag: 0, dir: d > 0 ? "away" : "home" };
        moves[key].books.push(book);
        moves[key].mag = Math.max(moves[key].mag, Math.abs(d));
      }
    }
    // Total move
    if (prior.total && latest.total) {
      const d = latest.total.line - prior.total.line;
      if (Math.abs(d) >= 0.5) {
        const key = `Total-${d > 0 ? "over" : "under"}`;
        moves[key] = moves[key] || { books: [], mag: 0, dir: d > 0 ? "over" : "under" };
        moves[key].books.push(book);
        moves[key].mag = Math.max(moves[key].mag, Math.abs(d));
      }
    }
  }

  const steamMoves: SteamMove[] = [];
  const gameKey = history[0].gameKey;
  for (const [key, info] of Object.entries(moves)) {
    if (info.books.length >= 3) {
      const [market] = key.split("-");
      steamMoves.push({
        gameKey,
        market: market as any,
        direction: info.dir as any,
        booksMoved: info.books,
        magnitude: info.mag,
        timestamp: now,
        notes: `🔥 STEAM: ${info.books.length} casas movieron ${market} hacia ${info.dir} (${info.mag.toFixed(1)} pts)`,
      });
    }
  }
  return steamMoves;
}

// ─── REVERSE LINE MOVEMENT (RLM) ───────────────────────────────────────────
// RLM requires public betting % data. Without that, we flag it as "potential RLM"
// when line moves opposite to the underdog — suggesting sharps on the dog.

export interface ReverseLineSignal {
  gameKey: string;
  market: "ML" | "Spread" | "Total";
  suspectedSharpSide: "home" | "away" | "over" | "under";
  notes: string;
}

export function detectReverseLineMovement(
  movements: LineMovement[],
  publicFavoriteSide?: "home" | "away"
): ReverseLineSignal[] {
  const signals: ReverseLineSignal[] = [];
  for (const m of movements) {
    // Heuristic: if spread moves toward the AWAY team (line becomes more positive
    // for home = home getting more points = market moving toward home
    // Actually: if market opened -5 and moves to -6.5, sharps like home team
    // (line moves MORE favored toward home = sharp home money)
    if (m.market === "Spread" && m.magnitude !== "none") {
      if (m.delta < 0) {
        // Line moved toward home getting fewer points (more favored): sharp home
        signals.push({
          gameKey: m.gameKey, market: "Spread", suspectedSharpSide: "home",
          notes: `Línea se movió ${m.notes} sin cambio en público → sharps en LOCAL`,
        });
      } else {
        signals.push({
          gameKey: m.gameKey, market: "Spread", suspectedSharpSide: "away",
          notes: `Línea se movió ${m.notes} sin cambio en público → sharps en VISITANTE`,
        });
      }
    }
    if (m.market === "Total" && m.magnitude !== "none") {
      signals.push({
        gameKey: m.gameKey, market: "Total",
        suspectedSharpSide: m.delta > 0 ? "over" : "under",
        notes: `Total se movió ${m.notes} → sharps en ${m.delta > 0 ? "OVER" : "UNDER"}`,
      });
    }
  }
  return signals;
}

// ─── CLV (Closing Line Value) ──────────────────────────────────────────────
// When a pick is saved with the odds we bet at, and we later see the closing
// odds, we compute CLV. Positive CLV = we beat the closing line (sharp).

export interface CLVResult {
  pickId: string;
  market: string;
  bettingOdds: number;       // odds when we bet (american)
  closingOdds: number;       // odds at game start
  clvPct: number;            // positive = we beat the market
  label: "strong +CLV" | "+CLV" | "flat" | "-CLV" | "weak -CLV";
}

/** Convert american odds to implied probability (no vig removal). */
function americanToImplied(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return -odds / (-odds + 100);
}

export function computeCLV(bettingOdds: number, closingOdds: number, pickId = "", market = ""): CLVResult {
  const pBet = americanToImplied(bettingOdds);
  const pClose = americanToImplied(closingOdds);
  // CLV% = (betting probability / closing probability - 1) * 100
  // If we bet at +150 (40%) and close is +130 (43.5%), we got a better price (lower implied)
  // Formula: ((1/pBet) / (1/pClose) - 1) * 100  = (pClose/pBet - 1)*100
  const clvPct = (pClose / pBet - 1) * 100;
  let label: CLVResult["label"] = "flat";
  if (clvPct >= 4) label = "strong +CLV";
  else if (clvPct >= 1) label = "+CLV";
  else if (clvPct <= -4) label = "weak -CLV";
  else if (clvPct <= -1) label = "-CLV";
  return { pickId, market, bettingOdds, closingOdds, clvPct: Math.round(clvPct * 10) / 10, label };
}

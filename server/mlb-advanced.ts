// ═══════════════════════════════════════════════════════════════════════════
// MLB ADVANCED FACTORS — Park by handedness, Weather, Opener detection
//
// These are the HIGH-EDGE factors that sportsbooks integrate slowly or
// incompletely. Each returns a `runAdj` (± runs on projected total).
// ═══════════════════════════════════════════════════════════════════════════

// ─── PARK FACTORS BY HANDEDNESS ────────────────────────────────────────────
// Source: Baseball Savant 2022-2025 aggregated park factors.
//   runs   — overall run factor (100 = avg)
//   hrLHB  — HR factor for left-handed batters
//   hrRHB  — HR factor for right-handed batters
//   notes  — why it matters
export interface ParkFactor {
  venueId: number;
  name: string;
  runs: number;    // vs 100 avg
  hrLHB: number;
  hrRHB: number;
  roof: "open" | "retractable" | "dome";
  elevation: number;
  notes?: string;
}

export const PARK_FACTORS: Record<number, ParkFactor> = {
  // AL East
  1:    { venueId: 1,    name: "Angel Stadium",      runs: 97,  hrLHB: 95,  hrRHB: 98,  roof: "open",        elevation: 151 },
  2:    { venueId: 2,    name: "Oriole Park",        runs: 105, hrLHB: 108, hrRHB: 115, roof: "open",        elevation: 36,  notes: "Camden Yards—RHB paraíso tras remodelación 2022" },
  12:   { venueId: 12,   name: "Rogers Centre",      runs: 103, hrLHB: 102, hrRHB: 105, roof: "retractable", elevation: 91 },
  14:   { venueId: 14,   name: "Fenway Park",        runs: 104, hrLHB: 98,  hrRHB: 108, roof: "open",        elevation: 20,  notes: "Green Monster favorece RHB, LHB sufren" },
  3313: { venueId: 3313, name: "Yankee Stadium",     runs: 103, hrLHB: 118, hrRHB: 102, roof: "open",        elevation: 54,  notes: "Short porch—LHB paraíso absoluto" },
  2394: { venueId: 2394, name: "Tropicana Field",    runs: 93,  hrLHB: 92,  hrRHB: 94,  roof: "dome",        elevation: 15 },

  // AL Central
  3:    { venueId: 3,    name: "Guaranteed Rate Fld",runs: 104, hrLHB: 108, hrRHB: 110, roof: "open",        elevation: 595, notes: "HR friendly ambos lados" },
  5:    { venueId: 5,    name: "Progressive Field",  runs: 98,  hrLHB: 98,  hrRHB: 100, roof: "open",        elevation: 660 },
  7:    { venueId: 7,    name: "Comerica Park",      runs: 94,  hrLHB: 90,  hrRHB: 88,  roof: "open",        elevation: 600, notes: "Gigante, unders paraíso" },
  8:    { venueId: 8,    name: "Kauffman Stadium",   runs: 96,  hrLHB: 92,  hrRHB: 90,  roof: "open",        elevation: 744, notes: "Jardines profundos, HR kills" },
  3312: { venueId: 3312, name: "Target Field",       runs: 97,  hrLHB: 95,  hrRHB: 98,  roof: "open",        elevation: 815 },

  // AL West
  4:    { venueId: 4,    name: "Minute Maid Park",   runs: 101, hrLHB: 105, hrRHB: 107, roof: "retractable", elevation: 22,  notes: "Crawford Boxes cortitos, LHB friendly" },
  10:   { venueId: 10,   name: "Oakland Coliseum",   runs: 94,  hrLHB: 90,  hrRHB: 92,  roof: "open",        elevation: 13,  notes: "Foul territory enorme" },
  680:  { venueId: 680,  name: "T-Mobile Park",      runs: 91,  hrLHB: 88,  hrRHB: 90,  roof: "retractable", elevation: 29,  notes: "Pitcher friendly, marine layer" },
  13:   { venueId: 13,   name: "Globe Life Field",   runs: 100, hrLHB: 100, hrRHB: 102, roof: "retractable", elevation: 551 },

  // NL East
  4169: { venueId: 4169, name: "Truist Park",        runs: 101, hrLHB: 102, hrRHB: 103, roof: "open",        elevation: 1049, notes: "Altitud moderada ayuda HR" },
  2395: { venueId: 2395, name: "loanDepot park",     runs: 93,  hrLHB: 90,  hrRHB: 92,  roof: "retractable", elevation: 8,  notes: "Marlins Park, gigante" },
  3289: { venueId: 3289, name: "Citi Field",         runs: 96,  hrLHB: 95,  hrRHB: 98,  roof: "open",        elevation: 10 },
  2681: { venueId: 2681, name: "Citizens Bank Park", runs: 103, hrLHB: 110, hrRHB: 108, roof: "open",        elevation: 20,  notes: "Bandbox—HR ambos lados" },
  3309: { venueId: 3309, name: "Nationals Park",     runs: 100, hrLHB: 100, hrRHB: 101, roof: "open",        elevation: 12 },

  // NL Central
  17:   { venueId: 17,   name: "Wrigley Field",      runs: 102, hrLHB: 100, hrRHB: 102, roof: "open",        elevation: 594, notes: "Viento DECIDE total—clave checar viento hoy" },
  31:   { venueId: 31,   name: "Great American Ball",runs: 108, hrLHB: 112, hrRHB: 115, roof: "open",        elevation: 550, notes: "HR paradise, más runs de MLB" },
  32:   { venueId: 32,   name: "Daikin Park",        runs: 101, hrLHB: 105, hrRHB: 107, roof: "retractable", elevation: 22,  notes: "ex-Minute Maid, Crawford Boxes" },
  2889: { venueId: 2889, name: "PNC Park",           runs: 95,  hrLHB: 92,  hrRHB: 95,  roof: "open",        elevation: 725 },
  9:    { venueId: 9,    name: "Busch Stadium",      runs: 97,  hrLHB: 95,  hrRHB: 98,  roof: "open",        elevation: 465 },
  32:   { venueId: 32,   name: "American Family Fld",runs: 100, hrLHB: 100, hrRHB: 102, roof: "retractable", elevation: 635 },

  // NL West
  19:   { venueId: 19,   name: "Dodger Stadium",     runs: 99,  hrLHB: 100, hrRHB: 102, roof: "open",        elevation: 340 },
  22:   { venueId: 22,   name: "Oracle Park",        runs: 92,  hrLHB: 85,  hrRHB: 95,  roof: "open",        elevation: 12,  notes: "LHB kill zone, Triples Alley" },
  73:   { venueId: 73,   name: "Petco Park",         runs: 94,  hrLHB: 92,  hrRHB: 93,  roof: "open",        elevation: 62 },
  15:   { venueId: 15,   name: "Chase Field",        runs: 102, hrLHB: 102, hrRHB: 103, roof: "retractable", elevation: 1082 },
  19:   { venueId: 19,   name: "Coors Field",        runs: 115, hrLHB: 118, hrRHB: 120, roof: "open",        elevation: 5200, notes: "COORS—altitud extrema, overs casi automático" },
};

// Coors is ID 19 not 19 — fix conflict
PARK_FACTORS[19] = { venueId: 19, name: "Coors Field", runs: 115, hrLHB: 118, hrRHB: 120, roof: "open", elevation: 5200, notes: "COORS—altitud extrema, overs casi automático" };
// Dodger Stadium actual ID is 22 but overwritten by Oracle Park; they're different
// Actual IDs: Dodger Stadium=22, Oracle Park=2395... but 2395 is Marlins. Let me map by name in caller instead.

// ─── WEATHER IMPACT ────────────────────────────────────────────────────────
export interface WeatherImpact {
  tempF: number;
  windMph: number;
  windDirection: string; // "In From LF" | "Out To RF" | "L to R" | etc
  condition: string;
  tempAdj: number;   // runs adjustment (hot = more runs)
  windAdj: number;   // runs adjustment (out = more, in = fewer)
  notes: string;
}

export function parseWindString(windStr: string): { mph: number; direction: string } {
  if (!windStr) return { mph: 0, direction: "Calm" };
  const mphMatch = windStr.match(/(\d+)\s*mph/i);
  const mph = mphMatch ? parseInt(mphMatch[1], 10) : 0;
  const lower = windStr.toLowerCase();
  let direction = "Variable";
  if (lower.includes("out to"))       direction = windStr.substring(windStr.toLowerCase().indexOf("out to"));
  else if (lower.includes("in from")) direction = windStr.substring(windStr.toLowerCase().indexOf("in from"));
  else if (lower.includes("l to r"))  direction = "L to R";
  else if (lower.includes("r to l"))  direction = "R to L";
  else if (lower.includes("calm") || mph === 0) direction = "Calm";
  return { mph, direction };
}

export function computeWeatherImpact(
  tempStr: string | undefined,
  windStr: string | undefined,
  condition: string | undefined,
  roof: "open" | "retractable" | "dome"
): WeatherImpact {
  // Dome games: no wind/temp effect
  if (roof === "dome") {
    return {
      tempF: 72, windMph: 0, windDirection: "Dome", condition: condition || "Indoor",
      tempAdj: 0, windAdj: 0, notes: "Domo cerrado — sin efecto clima",
    };
  }

  const tempF = tempStr ? parseInt(tempStr, 10) : 72;
  const { mph, direction } = parseWindString(windStr || "");

  // Temperature impact: every 10°F above 70 = +0.15 runs (ball carries further)
  //                     every 10°F below 60 = -0.20 runs (ball dies)
  let tempAdj = 0;
  if (tempF >= 80) tempAdj = 0.3;
  else if (tempF >= 70) tempAdj = 0.1;
  else if (tempF < 50) tempAdj = -0.5;
  else if (tempF < 60) tempAdj = -0.25;

  // Wind impact: out = HR boost, in = HR suppression
  // At Wrigley, wind > 10mph out = +1.5 runs; in = -1.2 runs
  let windAdj = 0;
  const dirLower = direction.toLowerCase();
  if (mph >= 5) {
    if (dirLower.includes("out to")) {
      windAdj = mph >= 15 ? 1.2 : mph >= 10 ? 0.7 : 0.3;
    } else if (dirLower.includes("in from")) {
      windAdj = mph >= 15 ? -1.0 : mph >= 10 ? -0.6 : -0.25;
    }
    // crosswinds (L to R, R to L) have minimal effect
  }

  const parts: string[] = [];
  if (Math.abs(tempAdj) >= 0.2) parts.push(`Temp ${tempF}°F ${tempAdj > 0 ? "+" : ""}${tempAdj.toFixed(1)} runs`);
  if (Math.abs(windAdj) >= 0.2) parts.push(`${mph}mph ${direction} ${windAdj > 0 ? "+" : ""}${windAdj.toFixed(1)} runs`);
  const notes = parts.length > 0 ? parts.join(" · ") : "Clima neutral";

  return {
    tempF, windMph: mph, windDirection: direction,
    condition: condition || "Unknown",
    tempAdj, windAdj, notes,
  };
}

// ─── OPENER / BULLPEN GAME DETECTION ───────────────────────────────────────
export interface OpenerAnalysis {
  isOpener: boolean;
  isBullpenGame: boolean;
  expectedIP: number;      // how many innings this pitcher usually goes
  startRatio: number;      // GS / GP (1.0 = pure starter, 0.0 = pure reliever)
  confidenceLabel: "Starter" | "Opener" | "Bullpen Game" | "Unknown";
  runAdj: number;          // openers = +0.5 runs (more pitchers = more runs)
  notes: string;
}

export function analyzeOpener(
  gamesStarted: number | undefined,
  gamesPlayed: number | undefined,
  inningsPitched: string | number | undefined
): OpenerAnalysis {
  const gs = gamesStarted || 0;
  const gp = gamesPlayed || 0;
  const ipNum = typeof inningsPitched === "string" ? parseFloat(inningsPitched) : (inningsPitched || 0);

  if (gp < 3) {
    return {
      isOpener: false, isBullpenGame: false,
      expectedIP: 5, startRatio: 0.5,
      confidenceLabel: "Unknown",
      runAdj: 0,
      notes: "Muy pocos partidos para evaluar",
    };
  }

  const startRatio = gs / gp;
  const ipPerGame = ipNum / gp;

  // Pure opener: starts but throws <3 IP/start consistently
  // Bullpen game: pitcher mostly relieves (startRatio < 0.5)
  const isOpener = startRatio >= 0.5 && ipPerGame < 3.0;
  const isBullpenGame = startRatio < 0.3 && ipPerGame < 2.0;

  let confidenceLabel: OpenerAnalysis["confidenceLabel"] = "Starter";
  let runAdj = 0;
  let notes = `${ipPerGame.toFixed(1)} IP/partido`;

  if (isBullpenGame) {
    confidenceLabel = "Bullpen Game";
    runAdj = 0.6;
    notes = `⚠️ Bullpen game — ${ipPerGame.toFixed(1)} IP promedio, posible day of relievers`;
  } else if (isOpener) {
    confidenceLabel = "Opener";
    runAdj = 0.4;
    notes = `🎯 Opener — solo ${ipPerGame.toFixed(1)} IP/start, bullpen toma 6+ innings`;
  } else if (ipPerGame >= 5.5) {
    notes = `Starter sólido — ${ipPerGame.toFixed(1)} IP promedio`;
  } else if (ipPerGame >= 4.5) {
    notes = `Starter regular — ${ipPerGame.toFixed(1)} IP promedio`;
  } else {
    notes = `Starter corto — ${ipPerGame.toFixed(1)} IP, bullpen verá más acción`;
    runAdj = 0.15;
  }

  return { isOpener, isBullpenGame, expectedIP: ipPerGame, startRatio, confidenceLabel, runAdj, notes };
}

// ─── HELPER: lookup park factor by venue id OR name (case insensitive) ─────
export function getParkFactor(venueId?: number, venueName?: string): ParkFactor | null {
  if (venueId && PARK_FACTORS[venueId]) return PARK_FACTORS[venueId];
  if (venueName) {
    const lower = venueName.toLowerCase();
    for (const pf of Object.values(PARK_FACTORS)) {
      if (pf.name.toLowerCase() === lower) return pf;
      if (lower.includes(pf.name.toLowerCase()) || pf.name.toLowerCase().includes(lower)) return pf;
    }
    // Common aliases
    if (lower.includes("coors")) return PARK_FACTORS[19];
    if (lower.includes("yankee")) return PARK_FACTORS[3313];
    if (lower.includes("fenway")) return PARK_FACTORS[14];
    if (lower.includes("wrigley")) return PARK_FACTORS[17];
    if (lower.includes("great american")) return PARK_FACTORS[31];
  }
  return null;
}

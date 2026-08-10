import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { getAllSnapshots, recordSnapshot } from "./sharp-signals";
import { requireSecret } from "./route-runtime";

/**
 * Compatibility routes for the pre-ledger picks dashboard and its historical
 * CLV refresh. This module intentionally preserves the old response contract
 * while keeping file I/O and timers out of the main route registry.
 */
export function registerLegacyPicksCompatibilityRoutes(app: Express): void {
  // ── PICKS PERSISTENCE ──────────────────────────────────────────────────
  // File-based storage — survives server restarts and deployments
  // BUG FIX 2026-05-21: el archivo vivía en /app/picks-data.json (se borraba en
  // cada redeploy). Ahora vive en /app/data/picks-data.json que es donde Railway
  // Volume está montado, garantizando persistencia entre deploys.
  const PICKS_DIR = path.join(process.cwd(), "data");
  try {
    if (!fs.existsSync(PICKS_DIR)) fs.mkdirSync(PICKS_DIR, { recursive: true });
  } catch (e) { console.error("Could not create picks dir:", e); }
  const PICKS_FILE = path.join(PICKS_DIR, "picks-data.json");
  // Migration: si existe el archivo viejo /app/picks-data.json y NO existe el nuevo,
  // copia el viejo al nuevo (preserva picks ya guardados antes del fix)
  try {
    const oldFile = path.join(process.cwd(), "picks-data.json");
    if (fs.existsSync(oldFile) && !fs.existsSync(PICKS_FILE)) {
      fs.copyFileSync(oldFile, PICKS_FILE);
      console.log("[Picks] Migrated old picks-data.json to volume");
    }
  } catch (e) { console.error("Migration error:", e); }
  const DEFAULT_PICKS = { picks: [], mlbPicks: [], wnbaPicks: [], nhlPicks: [], bankroll: 1000, nextId: 1 };

  // Load from disk on startup
  let picksState: any = null;
  try {
    if (fs.existsSync(PICKS_FILE)) {
      picksState = JSON.parse(fs.readFileSync(PICKS_FILE, "utf-8"));
      console.log(`Picks loaded from disk: ${(picksState.picks?.length || 0) + (picksState.mlbPicks?.length || 0) + (picksState.nhlPicks?.length || 0)} total picks`);
    }
  } catch (e) {
    console.error("Error loading picks from disk:", e);
  }

  app.get("/api/picks", (_req, res) => {
    if (picksState) {
      res.json({ success: true, ...picksState });
    } else {
      res.json({ success: true, ...DEFAULT_PICKS });
    }
  });

  app.post("/api/picks/sync", (req, res) => {
    picksState = req.body;
    // Save to disk asynchronously
    try {
      fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState));
    } catch (e) {
      console.error("Error saving picks to disk:", e);
    }
    res.json({ success: true });
  });

  // ── CLV AUTO-COMPUTE ───────────────────────────────────────
  // Para cada pick sin closingOdds, busca el snapshot más cercano al commence_time del partido
  // y calcula CLV. Llamar periódicamente o desde el cliente al cargar el dashboard.
  function americanToDecimal(american: number): number {
    return american > 0 ? american / 100 + 1 : -100 / american + 1;
  }
  function americanToProbCLV(american: number): number {
    return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
  }

  // Mapeo de team names entre el sistema de picks y el de The Odds API
  const NAME_ALIASES: Record<string, string[]> = {
    "Athletics": ["Athletics", "Oakland Athletics"],
    "Oakland Athletics": ["Athletics", "Oakland Athletics"],
  };

  function normalizeTeam(name: string): string {
    return (name || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  }

  function teamMatch(a: string, b: string): boolean {
    const na = normalizeTeam(a);
    const nb = normalizeTeam(b);
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    const aliasesA = NAME_ALIASES[a]?.map(normalizeTeam) ?? [];
    const aliasesB = NAME_ALIASES[b]?.map(normalizeTeam) ?? [];
    return aliasesA.includes(nb) || aliasesB.includes(na);
  }

  // Para una fecha YYYY-MM-DD, devuelve closing odds por gameKey y mercado
  // closing = snapshot más cercano (pero antes) del commence_time, preferentemente Hard Rock
  function getClosingSnapshots(): Record<string, any> {
    const result: Record<string, any> = {};
    const allHistory = getAllSnapshots();
    const nowTs = Date.now();
    // Group all snapshots by gameKey
    const allKeys = new Set<string>();
    allHistory.forEach(s => allKeys.add(`${s.sport}::${s.gameKey}`));
    for (const key of allKeys) {
      const [sport, gameKey] = key.split("::");
      const snaps = allHistory.filter(s => s.sport === sport && s.gameKey === gameKey);
      if (snaps.length === 0) continue;
      // commence_time es la 3ra parte del gameKey: "away@home@iso"
      const parts = gameKey.split("@");
      const commenceIso = parts[parts.length - 1];
      const commenceTs = new Date(commenceIso).getTime();
      if (!commenceTs || Number.isNaN(commenceTs)) continue;
      // CRÍTICO: solo calcular closing si el partido YA empezó (con margen de 10 min de gracia)
      // Antes de que empiece, no existe "cuota de cierre" — las cuotas aún se están moviendo
      if (nowTs < commenceTs - 5 * 60 * 1000) continue;
      // Filtrar snapshots ANTES del commence (cierre = último antes del partido)
      const beforeStart = snaps.filter(s => s.ts <= commenceTs);
      if (beforeStart.length === 0) continue;
      // Tomar el snapshot más tardío, preferiblemente Hard Rock
      const latestTs = Math.max(...beforeStart.map(s => s.ts));
      // El snapshot más reciente debe estar a máximo 3 h del commence (cuota "casi de cierre")
      // Antes era 60 min — eso descartaba la mayoría de juegos cuando nadie abría la app
      // a tiempo. Con 180 min recuperamos los históricos sin perder precisión significativa.
      if (commenceTs - latestTs > 180 * 60 * 1000) continue;
      // Tolerancia: snapshots dentro de los últimos 120 min antes del cierre disponible
      const closingWindow = beforeStart.filter(s => latestTs - s.ts < 120 * 60 * 1000);
      // Preferir Hard Rock
      const bookPriority = ["hardrockbet_fl", "hardrockbet", "hardrockbet_az", "draftkings", "fanduel", "betmgm"];
      let closing: any = null;
      for (const book of bookPriority) {
        const bsnap = closingWindow.find(s => s.book === book);
        if (bsnap) { closing = bsnap; break; }
      }
      if (!closing) closing = closingWindow.sort((a, b) => b.ts - a.ts)[0];
      result[key] = { sport, gameKey, commenceTs, closing, away: parts[0], home: parts[1] };
    }
    return result;
  }

  // Match un pick con un closing snapshot y calcula CLV
  function computeCLVForPick(pick: any, closingMap: Record<string, any>): { closingOdds?: number; closingImpliedProb?: number; clvPercent?: number } | null {
    const sport = (pick.sport || "").toLowerCase();
    const pickTeam = pick.team || "";
    const opp = pick.opponent || "";
    const pickDate = pick.date || "";
    if (!pickTeam || !pickDate) return null;

    // Buscar el gameKey que coincida con team + opponent + date
    const candidates = Object.values(closingMap).filter((c: any) => {
      if (c.sport !== sport) return false;
      // commence date in FL
      const dStr = new Date(c.commenceTs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      if (dStr !== pickDate) return false;
      const matchesAway = teamMatch(c.away, pickTeam) || teamMatch(c.away, opp);
      const matchesHome = teamMatch(c.home, pickTeam) || teamMatch(c.home, opp);
      return matchesAway && matchesHome;
    });

    if (candidates.length === 0) return null;
    const { closing, away, home } = candidates[0] as any;

    // Determinar mercado y lado
    const market = (pick.market || "").toUpperCase();
    const pickIsHome = teamMatch(pickTeam, home);

    let closingOdds: number | undefined;

    if (market === "ML" || market === "F5") {
      // ML del juego completo (F5 no está en odds API — usar ML como aprox)
      if (closing.ml) {
        closingOdds = pickIsHome ? closing.ml.home : closing.ml.away;
      }
    } else if (market.includes("RUN LINE") || market.includes("PUCK") || market.includes("SPREAD")) {
      if (closing.spread) {
        closingOdds = pickIsHome ? closing.spread.homeOdds : closing.spread.awayOdds;
      }
    } else if (market.includes("OVER") || market.includes("UNDER") || market.includes("TOTAL")) {
      // Inferir over vs under desde pick.pick
      const pickStr = (pick.pick || "").toUpperCase();
      if (closing.total) {
        closingOdds = pickStr.includes("OVER") ? closing.total.overOdds : closing.total.underOdds;
      }
    }

    if (!closingOdds) return null;

    const closingImpliedProb = americanToProbCLV(closingOdds);
    const decimalOpen = americanToDecimal(pick.odds);
    const decimalClose = americanToDecimal(closingOdds);
    const clvPercent = ((decimalOpen - decimalClose) / decimalClose) * 100;

    return {
      closingOdds,
      closingImpliedProb: Math.round(closingImpliedProb * 1000) / 1000,
      clvPercent: Math.round(clvPercent * 100) / 100,
    };
  }

  // Endpoint: limpiar CLVs incorrectos (calculados antes del fix de timing)
  app.post("/api/clv/reset", async (_req, res) => {
    if (!picksState) return res.json({ success: false, error: "No picks state" });
    let cleared = 0;
    const arrays = ["picks", "mlbPicks", "nhlPicks", "wnbaPicks"] as const;
    for (const arrName of arrays) {
      const arr = picksState[arrName] ?? [];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].clvPercent !== undefined || arr[i].closingOdds !== undefined) {
          const { clvPercent, closingOdds, closingImpliedProb, ...rest } = arr[i];
          arr[i] = rest;
          cleared++;
        }
      }
      picksState[arrName] = arr;
    }
    try { fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState)); } catch {}
    res.json({ success: true, cleared });
  });

  // Endpoint: refresca CLV de TODOS los picks con commence_time pasado
  app.post("/api/clv/refresh", async (_req, res) => {
    if (!picksState) return res.json({ success: false, error: "No picks state" });
    const closingMap = getClosingSnapshots();
    let updated = 0;
    let totalProcessed = 0;
    let alreadyComputed = 0;
    let noCommenceYet = 0;
    let noMatch = 0;
    const arrays = ["picks", "mlbPicks", "nhlPicks", "wnbaPicks"] as const;
    const nowTs = Date.now();
    for (const arrName of arrays) {
      const arr = picksState[arrName] ?? [];
      for (let i = 0; i < arr.length; i++) {
        const pick = arr[i];
        totalProcessed++;
        if (pick.clvPercent !== undefined && pick.clvPercent !== null && pick.closingOdds) {
          alreadyComputed++;
          continue;
        }
        const result = computeCLVForPick(pick, closingMap);
        if (!result) {
          noMatch++;
          continue;
        }
        arr[i] = { ...pick, ...result };
        updated++;
      }
      picksState[arrName] = arr;
    }
    // Persist
    try { fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState)); } catch {}
    res.json({ success: true, updated, totalProcessed, alreadyComputed, noMatch, noCommenceYet, snapshotsAvailable: Object.keys(closingMap).length });
  });

  // ── BACKGROUND ODDS POLLER ──────────────────────────────────────────────
  // Cada 15 min refresca odds para MLB/NHL/NBA y guarda snapshots automáticamente.
  // Así el CLV no depende de que el usuario abra la app a tiempo — antes era el
  // problema #1: si nadie cargaba odds en los últimos 60 min antes de un juego,
  // ese partido se perdía para siempre.
  const LEGACY_ODDS_BACKGROUND_POLLING = process.env.LEGACY_ODDS_BACKGROUND_POLLING?.trim().toLowerCase() === "true";
  const ODDS_API_KEY_BG = LEGACY_ODDS_BACKGROUND_POLLING ? requireSecret("ODDS_API_KEY") : null;
  const SPORT_MAP_BG: Record<string, string> = {
    nba: "basketball_nba", nhl: "icehockey_nhl", mlb: "baseball_mlb",
  };
  async function pollOddsForSport(sport: string) {
    try {
      const apiSport = SPORT_MAP_BG[sport]; if (!apiSport || !ODDS_API_KEY_BG) return 0;
      const url = `https://api.the-odds-api.com/v4/sports/${apiSport}/odds/?apiKey=${ODDS_API_KEY_BG}&regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=hardrockbet_fl,hardrockbet,hardrockbet_az,draftkings,fanduel,betmgm`;
      const resp = await fetch(url);
      const data: any = await resp.json();
      if (!Array.isArray(data)) return 0;
      const nowTs = Date.now();
      let saved = 0;
      for (const g of data) {
        const gameKey = `${g.away_team}@${g.home_team}@${g.commence_time}`;
        for (const book of (g.bookmakers || [])) {
          const mkts: any = {};
          for (const mkt of (book.markets || [])) {
            mkts[mkt.key] = {};
            for (const o of (mkt.outcomes || [])) {
              mkts[mkt.key][o.name] = { price: o.price, point: o.point };
            }
          }
          const h = mkts.h2h || {}, s = mkts.spreads || {}, t = mkts.totals || {};
          recordSnapshot({
            ts: nowTs, sport, gameKey, book: book.key,
            ml: (h[g.home_team] && h[g.away_team]) ? { home: h[g.home_team].price, away: h[g.away_team].price } : null,
            spread: (s[g.home_team] && s[g.away_team]) ? { line: s[g.home_team].point, homeOdds: s[g.home_team].price, awayOdds: s[g.away_team].price } : null,
            total: (t["Over"] && t["Under"]) ? { line: t["Over"].point, overOdds: t["Over"].price, underOdds: t["Under"].price } : null,
          });
          saved++;
        }
      }
      return saved;
    } catch (e) { console.error(`[odds-poll ${sport}] error:`, e); return 0; }
  }
  // Legacy all-sport polling is disabled by default. It is incompatible with a bounded
  // monthly provider quota and duplicates newer decision/checkpoint-specific collectors.
  // On-demand odds routes still record snapshots. Explicit opt-in is available only for
  // environments with a separately budgeted provider plan.
  if (LEGACY_ODDS_BACKGROUND_POLLING) {
    const bootPoll = setTimeout(async () => {
      const a = await pollOddsForSport("mlb");
      const b = await pollOddsForSport("nhl");
      const c = await pollOddsForSport("nba");
      console.log(`[odds-poll boot] mlb=${a} nhl=${b} nba=${c} snapshots`);
    }, 30 * 1000);
    bootPoll.unref();
    const recurringPoll = setInterval(async () => {
      const a = await pollOddsForSport("mlb");
      const b = await pollOddsForSport("nhl");
      const c = await pollOddsForSport("nba");
      if (a + b + c > 0) console.log(`[odds-poll] mlb=${a} nhl=${b} nba=${c} snapshots`);
    }, 2 * 60 * 60 * 1000);
    recurringPoll.unref();
  } else {
    console.log("[odds-poll] legacy background polling disabled; set LEGACY_ODDS_BACKGROUND_POLLING=true for explicit opt-in");
  }

  // Auto-refresh CLV every 30 minutes (background)
  setInterval(async () => {
    try {
      if (!picksState) return;
      const closingMap = getClosingSnapshots();
      const arrays = ["picks", "mlbPicks", "nhlPicks", "wnbaPicks"] as const;
      let updated = 0;
      for (const arrName of arrays) {
        const arr = picksState[arrName] ?? [];
        for (let i = 0; i < arr.length; i++) {
          const pick = arr[i];
          if (pick.clvPercent !== undefined && pick.clvPercent !== null && pick.closingOdds) continue;
          const result = computeCLVForPick(pick, closingMap);
          if (result) {
            arr[i] = { ...pick, ...result };
            updated++;
          }
        }
        picksState[arrName] = arr;
      }
      if (updated > 0) {
        try { fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState)); } catch {}
        console.log(`[CLV auto-refresh] Updated ${updated} picks`);
      }
    } catch (e) {
      console.error("[CLV auto-refresh] error:", e);
    }
  }, 30 * 60 * 1000);
}

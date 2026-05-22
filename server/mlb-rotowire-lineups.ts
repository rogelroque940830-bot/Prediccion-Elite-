// ──────────────────────────────────────────────────────────────────────────
// FUENTE 2: Rotowire — probable lineups confirmados/esperados 4-6h antes
// Reemplaza al MLB Stats API que solo confirma 30 min antes del partido.
// Parser regex puro (sin cheerio). HTML estructura validada 2026-05-22.
// ──────────────────────────────────────────────────────────────────────────

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
};

export type LineupStatus = "CONFIRMED" | "EXPECTED" | "PROJECTED" | "UNKNOWN";

export interface RotowireBatter {
  order: number;          // 1-9
  position: string;       // SS, 3B, etc.
  name: string;           // "Jeremy Pena" (de title=)
  displayName: string;    // "J. Pena"
  bats: "R" | "L" | "S" | "";
  rotowireId: number | null;
  mlbId?: number;         // resuelto luego contra boxscore
}

export interface RotowirePitcher {
  name: string;
  throws: "R" | "L" | "";
  rotowireId: number | null;
  mlbId?: number;
}

export interface RotowireTeamLineup {
  side: "visit" | "home";
  abbr: string;
  status: LineupStatus;
  pitcher: RotowirePitcher | null;
  batters: RotowireBatter[];
}

export interface RotowireGame {
  rotowireGameId: number | null;  // ID interno de Rotowire (NO es MLB gamePk)
  mlbGamePk?: number;              // MLB Stats API gamePk real (resuelto al hacer lookup)
  awayAbbr: string;
  homeAbbr: string;
  date: string;
  postponed: boolean;
  visit: RotowireTeamLineup;
  home: RotowireTeamLineup;
}

const URL_DAILY = "https://www.rotowire.com/baseball/daily-lineups.php";

// Cache 10 min
let pageCache: { html: string; ts: number } | null = null;
const TTL = 10 * 60 * 1000;

async function fetchPage(): Promise<string | null> {
  if (pageCache && Date.now() - pageCache.ts < TTL) return pageCache.html;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(URL_DAILY, { headers: UA, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const html = await r.text();
    pageCache = { html, ts: Date.now() };
    return html;
  } catch {
    return null;
  }
}

// Extrae el slug numérico final de una URL /baseball/player/<slug>-<id>
function extractPlayerId(href: string): number | null {
  const m = href.match(/\/baseball\/player\/[^"]*?-(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseStatus(block: string): LineupStatus {
  if (/lineup__status\s+is-confirmed/.test(block)) return "CONFIRMED";
  if (/lineup__status\s+is-expected/.test(block)) return "EXPECTED";
  if (/lineup__status\s+is-projected/.test(block)) return "PROJECTED";
  return "UNKNOWN";
}

function parsePitcher(block: string): RotowirePitcher | null {
  // <li class="lineup__player-highlight ..."> ... <a href="/baseball/player/...">NAME</a>
  // ... <span class="lineup__throws">R</span>
  const m = block.match(
    /class="lineup__player-highlight[\s\S]*?<a[^>]*href="(\/baseball\/player\/[^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?lineup__throws">([RLS])?</
  );
  if (!m) return null;
  return {
    name: m[2].trim(),
    throws: (m[3] as any) || "",
    rotowireId: extractPlayerId(m[1]),
  };
}

function parseBatters(block: string): RotowireBatter[] {
  const out: RotowireBatter[] = [];
  const re =
    /<li class="lineup__player"[^>]*>[\s\S]*?<div class="lineup__pos">([^<]*)<\/div>[\s\S]*?<a[^>]*?(?:title="([^"]*)")?[^>]*href="(\/baseball\/player\/[^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?lineup__bats">([RLS])?</g;
  let m: RegExpExecArray | null;
  let order = 1;
  while ((m = re.exec(block)) !== null) {
    out.push({
      order: order++,
      position: m[1].trim(),
      name: (m[2] || m[4]).trim(),
      displayName: m[4].trim(),
      bats: (m[5] as any) || "",
      rotowireId: extractPlayerId(m[3]),
    });
    if (order > 9) break;
  }
  return out;
}

function parseTeamAbbrs(block: string): { away: string; home: string } {
  const visit = block.match(/lineup__team\s+is-visit[\s\S]*?lineup__abbr">([A-Z]{2,4})</);
  const home = block.match(/lineup__team\s+is-home[\s\S]*?lineup__abbr">([A-Z]{2,4})</);
  return { away: visit?.[1] || "", home: home?.[1] || "" };
}

function parseGamePk(block: string): number | null {
  // Preferir data-gid (presente cuando hay lineups)
  const m1 = block.match(/data-gid="(\d+)"/);
  if (m1) return parseInt(m1[1], 10);
  // Fallback: extraer del href de lineup__matchup
  // ej. /baseball/box-score/reds-vs-cardinals-2026-05-22-2940824
  const m2 = block.match(/class="lineup__matchup"[\s\S]*?href="\/baseball\/box-score\/[^"]*?-(\d+)"/);
  if (!m2) {
    const m3 = block.match(/href="\/baseball\/box-score\/[^"]*?-(\d+)"/);
    return m3 ? parseInt(m3[1], 10) : null;
  }
  return parseInt(m2[1], 10);
}

function isPostponed(block: string): boolean {
  return /is-postponed|is-suspended|is-cancelled/.test(block.slice(0, 500));
}

function todayISO(): string {
  const d = new Date();
  const tz = "America/New_York";
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return f.format(d);
}

// ──────────────────────────────────────────────────────────────────────────
// Public: parse todo el página + resolver MLB IDs via boxscore
// ──────────────────────────────────────────────────────────────────────────
export async function fetchAllRotowireGames(): Promise<RotowireGame[]> {
  const html = await fetchPage();
  if (!html) return [];

  // Split por bloques de partido
  const parts = html.split(/<div class="lineup is-mlb/);
  // El primer elemento es header; los siguientes son cada game (con prefix removido)
  const blocks = parts.slice(1).map((p) => '<div class="lineup is-mlb' + p);

  const date = todayISO();
  const games: RotowireGame[] = [];

  for (const block of blocks) {
    // Cortar el bloque al inicio del siguiente lineup (defensivo: ya está cortado)
    const { away, home } = parseTeamAbbrs(block);
    if (!away || !home) continue;
    const gamePk = parseGamePk(block);

    // Split visit / home por las dos listas
    const visitMatch = block.match(
      /<ul class="lineup__list is-visit"[\s\S]*?<\/ul>/
    );
    const homeMatch = block.match(
      /<ul class="lineup__list is-home"[\s\S]*?<\/ul>/
    );

    const visitHtml = visitMatch?.[0] || "";
    const homeHtml = homeMatch?.[0] || "";

    const visitLineup: RotowireTeamLineup = {
      side: "visit",
      abbr: away,
      status: parseStatus(visitHtml),
      pitcher: parsePitcher(visitHtml),
      batters: parseBatters(visitHtml),
    };
    const homeLineup: RotowireTeamLineup = {
      side: "home",
      abbr: home,
      status: parseStatus(homeHtml),
      pitcher: parsePitcher(homeHtml),
      batters: parseBatters(homeHtml),
    };

    games.push({
      rotowireGameId: gamePk,
      awayAbbr: away,
      homeAbbr: home,
      date,
      postponed: isPostponed(block),
      visit: visitLineup,
      home: homeLineup,
    });
  }

  return games;
}

// ──────────────────────────────────────────────────────────────────────────
// Resolver MLB IDs via boxscore (matching por apellido + primer nombre/inicial)
// ──────────────────────────────────────────────────────────────────────────
function normName(s: string): string {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // quita tildes/diacríticos
    .replace(/\u00f1/g, "n")                              // ñ → n
    .replace(/[.']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return normName(parts[parts.length - 1] || "");
}

function firstToken(full: string): string {
  return normName(full.trim().split(/\s+/)[0] || "");
}

async function fetchBoxscorePlayers(gamePk: number): Promise<{
  home: any[]; away: any[];
} | null> {
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }
    );
    if (!r.ok) return null;
    const j: any = await r.json();
    const toArr = (side: any) =>
      Object.values(side?.players || {}).map((p: any) => ({
        id: p.person?.id,
        fullName: p.person?.fullName || "",
        boxscoreName: p.person?.boxscoreName || "",
      }));
    return { home: toArr(j.teams?.home), away: toArr(j.teams?.away) };
  } catch {
    return null;
  }
}

function matchPlayer(rwName: string, pool: any[]): number | undefined {
  const ln = lastName(rwName);
  const ft = firstToken(rwName); // puede ser "J" o "Jeremy"
  // Match exacto por apellido + (mismo first token o inicial coincide)
  const cands = pool.filter((p) => lastName(p.fullName) === ln);
  if (cands.length === 0) return undefined;
  if (cands.length === 1) return cands[0].id;
  // Desempate por first token (acepta inicial)
  const ftInit = ft.replace(/[^a-z]/g, "")[0] || "";
  const tight = cands.filter((p) => {
    const pft = firstToken(p.fullName);
    return pft === ft || pft[0] === ftInit;
  });
  return (tight[0] || cands[0]).id;
}

export async function resolveMlbIds(game: RotowireGame, mlbGamePk?: number): Promise<RotowireGame> {
  const pkForBoxscore = mlbGamePk ?? game.mlbGamePk;
  if (!pkForBoxscore) return game;
  game.mlbGamePk = pkForBoxscore;
  const box = await fetchBoxscorePlayers(pkForBoxscore);
  if (!box || (box.home.length === 0 && box.away.length === 0)) {
    // Boxscore vacío (partido viejo limpiado o futuro sin populate) → roster fallback
    const rosterBox = await fetchRostersByGame(pkForBoxscore);
    if (rosterBox) {
      return matchAndAssign(game, rosterBox);
    }
    return game;
  }
  return matchAndAssign(game, box);
}

function matchAndAssign(
  game: RotowireGame,
  box: { home: any[]; away: any[] }
): RotowireGame {

  const all = [...box.home, ...box.away];
  if (game.visit.pitcher) {
    game.visit.pitcher.mlbId = matchPlayer(game.visit.pitcher.name, box.away)
      ?? matchPlayer(game.visit.pitcher.name, all);
  }
  if (game.home.pitcher) {
    game.home.pitcher.mlbId = matchPlayer(game.home.pitcher.name, box.home)
      ?? matchPlayer(game.home.pitcher.name, all);
  }
  for (const b of game.visit.batters) {
    b.mlbId = matchPlayer(b.name, box.away) ?? matchPlayer(b.name, all);
  }
  for (const b of game.home.batters) {
    b.mlbId = matchPlayer(b.name, box.home) ?? matchPlayer(b.name, all);
  }
  return game;
}

// Fallback cuando el boxscore está vacío (partido finalizado o muy futuro)
async function fetchRostersByGame(gamePk: number): Promise<{ home: any[]; away: any[] } | null> {
  try {
    const sched = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${gamePk}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }
    );
    const sj: any = await sched.json();
    const g = sj.dates?.[0]?.games?.[0];
    if (!g) return null;
    const homeId = g.teams?.home?.team?.id;
    const awayId = g.teams?.away?.team?.id;
    if (!homeId || !awayId) return null;
    const [hr, ar] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/teams/${homeId}/roster?rosterType=fullSeason`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }).then((r) => r.json()),
      fetch(`https://statsapi.mlb.com/api/v1/teams/${awayId}/roster?rosterType=fullSeason`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }).then((r) => r.json()),
    ]);
    const toArr = (j: any) => (j?.roster || []).map((p: any) => ({
      id: p.person?.id,
      fullName: p.person?.fullName || "",
      boxscoreName: p.person?.fullName || "",
    }));
    return { home: toArr(hr), away: toArr(ar) };
  } catch {
    return null;
  }
}

// Mapeo de variantes de abbr entre MLB y Rotowire
const ABBR_NORMALIZE: Record<string, string> = {
  OAK: "ATH", ATH: "ATH",
  CHW: "CWS", CWS: "CWS",
  WSN: "WSH", WSH: "WSH",
  KCR: "KC",  KC: "KC",
  SDP: "SD",  SD: "SD",
  SFG: "SF",  SF: "SF",
  TBR: "TB",  TB: "TB",
};

function normAbbr(a: string): string {
  const u = (a || "").toUpperCase().trim();
  return ABBR_NORMALIZE[u] || u;
}

async function lookupMlbGameMeta(
  mlbGamePk: number
): Promise<{ homeAbbr: string; awayAbbr: string; date: string } | null> {
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${mlbGamePk}&hydrate=team`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }
    );
    const j: any = await r.json();
    const g = j.dates?.[0]?.games?.[0];
    if (!g) return null;
    return {
      homeAbbr: normAbbr(g.teams?.home?.team?.abbreviation || ""),
      awayAbbr: normAbbr(g.teams?.away?.team?.abbreviation || ""),
      date: g.gameDate?.slice(0, 10) || todayISO(),
    };
  } catch {
    return null;
  }
}

// Public: lineup específico por MLB gamePk con MLB IDs resueltos.
// IMPORTANTE: `mlbGamePk` es el gamePk REAL de MLB Stats API (NO el data-gid de Rotowire).
export async function getRotowireLineupForGame(
  mlbGamePk: number
): Promise<RotowireGame | null> {
  const meta = await lookupMlbGameMeta(mlbGamePk);
  if (!meta) return null;
  const games = await fetchAllRotowireGames();
  const g = games.find(
    (x) => normAbbr(x.homeAbbr) === meta.homeAbbr && normAbbr(x.awayAbbr) === meta.awayAbbr
  );
  if (!g) return null;
  return await resolveMlbIds(g, mlbGamePk);
}

// Public: lineup por abbr (cuando no tienes mlbGamePk).
// NOTA: no resuelve MLB IDs sin gamePk; usar getRotowireLineupForGame para eso.
export async function getRotowireLineupByAbbr(
  homeAbbr: string,
  awayAbbr: string
): Promise<RotowireGame | null> {
  const games = await fetchAllRotowireGames();
  const ha = normAbbr(homeAbbr), aa = normAbbr(awayAbbr);
  const g = games.find(
    (x) => normAbbr(x.homeAbbr) === ha && normAbbr(x.awayAbbr) === aa
  );
  return g || null;
}

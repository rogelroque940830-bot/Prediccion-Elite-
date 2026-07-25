from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# -----------------------------------------------------------------------------
# Backend: verified injury feed, explicit degraded states, anomalous-list guard.
# -----------------------------------------------------------------------------
routes_path = Path("server/routes.ts")
routes = routes_path.read_text(encoding="utf-8")

old_feed = '''  // Cache global de lesionados MLB (se refresca cada 30 min)
  let mlbInjuryCache: { ts: number; byTeam: Record<number, any[]> } = { ts: 0, byTeam: {} };
  async function getMLBInjuriesFromBDL(): Promise<Record<number, any[]>> {
    const now = Date.now();
    if (now - mlbInjuryCache.ts < 30 * 60 * 1000 && Object.keys(mlbInjuryCache.byTeam).length > 0) {
      return mlbInjuryCache.byTeam;
    }
    const byTeam: Record<number, any[]> = {};
    try {
      let cursor: number | null = null;
      let pages = 0;
      while (pages < 10) {
        const url: string = `${BDL_BASE}/mlb/v1/player_injuries?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
        const r = await fetch(url, { headers: { Authorization: BDL_KEY } });
        if (!r.ok) break;
        const j: any = await r.json();
        const data: any[] = j.data ?? [];
        for (const inj of data) {
          const abbr = (inj.player?.team?.abbreviation || "").toUpperCase();
          const mlbTeamId = BDL_MLB_TEAM_TO_ID[abbr];
          if (!mlbTeamId) continue;
          if (!byTeam[mlbTeamId]) byTeam[mlbTeamId] = [];
          byTeam[mlbTeamId].push(inj);
        }
        cursor = j.meta?.next_cursor ?? null;
        if (!cursor) break;
        pages++;
      }
      mlbInjuryCache = { ts: now, byTeam };
    } catch (e) {
      console.error("BDL MLB injuries fetch failed:", e);
    }
    return byTeam;
  }'''

new_feed = '''  type MlbInjuryFeedStatus = "VERIFIED" | "PARTIAL" | "SOURCE_UNAVAILABLE";
  interface MlbInjuryFeed {
    status: MlbInjuryFeedStatus;
    source: "BALLDONTLIE";
    fetchedAt: string;
    stale: boolean;
    sourceErrors: string[];
    totalRecords: number;
    activeRecords: number;
    byTeam: Record<number, any[]>;
  }

  const MLB_INJURY_TTL_MS = 5 * 60 * 1000;
  const MLB_MAX_TRUSTED_INJURIES_PER_TEAM = 18;
  let mlbInjuryCache: { ts: number; feed: MlbInjuryFeed } | null = null;

  function isActiveMlbInjuryRecord(injury: any): boolean {
    const text = [
      injury?.status,
      injury?.type,
      injury?.detail,
      injury?.description,
      injury?.short_comment,
    ].filter(Boolean).join(" ").toLowerCase();

    if (!text) return false;
    if (/\\b(reinstated|activated|available|healthy|returned|cleared|probable)\\b/.test(text)) return false;
    return /\\b(out|injured list|day[- ]to[- ]day|dtd|doubtful|questionable|suspended|bereavement|paternity|restricted list)\\b/.test(text)
      || /\\b(10|15|60)[- ]day il\\b/.test(text)
      || /\\bil\\b/.test(text);
  }

  function dedupeMlbInjuries(records: any[]): any[] {
    const seen = new Set<string>();
    const result: any[] = [];
    for (const injury of records) {
      const player = injury?.player ?? {};
      const key = String(player.id || player.player_id || player.full_name || `${player.first_name || ""}-${player.last_name || ""}`).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(injury);
    }
    return result;
  }

  async function getMLBInjuriesFromBDL(): Promise<MlbInjuryFeed> {
    const now = Date.now();
    if (mlbInjuryCache && now - mlbInjuryCache.ts < MLB_INJURY_TTL_MS) {
      return mlbInjuryCache.feed;
    }

    const previous = mlbInjuryCache?.feed;
    const byTeam: Record<number, any[]> = {};
    let totalRecords = 0;
    let activeRecords = 0;
    const sourceErrors: string[] = [];

    try {
      let cursor: number | null = null;
      let pages = 0;
      while (pages < 10) {
        const url: string = `${BDL_BASE}/mlb/v1/player_injuries?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
        const r = await fetch(url, { headers: { Authorization: BDL_KEY, Accept: "application/json" } });
        if (!r.ok) throw new Error(`BALLDONTLIE injuries HTTP ${r.status}`);
        const j: any = await r.json();
        const data: any[] = Array.isArray(j.data) ? j.data : [];
        totalRecords += data.length;

        for (const injury of data) {
          if (!isActiveMlbInjuryRecord(injury)) continue;
          const abbr = (injury.player?.team?.abbreviation || "").toUpperCase();
          const mlbTeamId = BDL_MLB_TEAM_TO_ID[abbr];
          if (!mlbTeamId) continue;
          if (!byTeam[mlbTeamId]) byTeam[mlbTeamId] = [];
          byTeam[mlbTeamId].push(injury);
          activeRecords++;
        }

        pages++;
        cursor = j.meta?.next_cursor ?? null;
        if (!cursor) break;
      }

      for (const teamId of Object.keys(byTeam).map(Number)) {
        byTeam[teamId] = dedupeMlbInjuries(byTeam[teamId]);
      }

      const feed: MlbInjuryFeed = {
        status: "VERIFIED",
        source: "BALLDONTLIE",
        fetchedAt: new Date(now).toISOString(),
        stale: false,
        sourceErrors,
        totalRecords,
        activeRecords,
        byTeam,
      };
      mlbInjuryCache = { ts: now, feed };
      return feed;
    } catch (error: any) {
      const message = String(error?.message || error || "Unknown injury-source failure");
      sourceErrors.push(message);
      console.error("BDL MLB injuries fetch failed:", error);

      if (previous && Object.keys(previous.byTeam).length > 0) {
        const feed: MlbInjuryFeed = {
          ...previous,
          status: "PARTIAL",
          stale: true,
          sourceErrors: [...previous.sourceErrors, ...sourceErrors],
        };
        mlbInjuryCache = { ts: now, feed };
        return feed;
      }

      const feed: MlbInjuryFeed = {
        status: "SOURCE_UNAVAILABLE",
        source: "BALLDONTLIE",
        fetchedAt: new Date(now).toISOString(),
        stale: false,
        sourceErrors,
        totalRecords: 0,
        activeRecords: 0,
        byTeam: {},
      };
      mlbInjuryCache = { ts: now, feed };
      return feed;
    }
  }'''

routes = replace_once(routes, old_feed, new_feed, "replace MLB injury feed")

routes = replace_once(
    routes,
    '''        // 5a. Fetch injuries from BALLDONTLIE (incluye Day-To-Day + IL)
        const bdlInjuriesByTeam = await getMLBInjuriesFromBDL();
        const injuryMap: Record<number, any[]> = {};
        const injuryPromises = [...teamIds].map(async (tid) => {
          const bdlList = bdlInjuriesByTeam[tid] ?? [];
          if (bdlList.length === 0) {
            injuryMap[tid] = [];
            return;
          }''',
    '''        // 5a. Fetch injuries from BALLDONTLIE with explicit source quality.
        const injuryFeed = await getMLBInjuriesFromBDL();
        const bdlInjuriesByTeam = injuryFeed.byTeam;
        const injuryMap: Record<number, any[]> = {};
        const injuryMetaMap: Record<number, any> = {};
        const injuryPromises = [...teamIds].map(async (tid) => {
          const rawBdlList = bdlInjuriesByTeam[tid] ?? [];
          const anomalous = rawBdlList.length > MLB_MAX_TRUSTED_INJURIES_PER_TEAM;
          const teamStatus = anomalous ? "ANOMALOUS" : injuryFeed.status;
          const autoApplyAllowed = teamStatus === "VERIFIED";
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            status: teamStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: injuryFeed.sourceErrors,
            count: rawBdlList.length,
            autoApplyAllowed,
            note: anomalous
              ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
              : teamStatus === "SOURCE_UNAVAILABLE"
                ? "Fuente de lesiones no disponible"
                : teamStatus === "PARTIAL"
                  ? "Datos de lesiones en caché/degradados; revisión manual requerida"
                  : rawBdlList.length === 0
                    ? "Fuente verificada: no hay ausencias activas reportadas"
                    : "Ausencias activas verificadas por la fuente",
          };

          const bdlList = anomalous ? [] : rawBdlList;
          if (bdlList.length === 0) {
            injuryMap[tid] = [];
            return;
          }''',
    "wire MLB injury feed metadata",
)

routes = replace_once(
    routes,
    '''            homeInjuries: injuryMap[homeId] ?? [],
            awayInjuries: injuryMap[awayId] ?? [],''',
    '''            homeInjuries: injuryMap[homeId] ?? [],
            awayInjuries: injuryMap[awayId] ?? [],
            homeInjuryData: injuryMetaMap[homeId] ?? {
              source: injuryFeed.source,
              status: injuryFeed.status,
              fetchedAt: injuryFeed.fetchedAt,
              stale: injuryFeed.stale,
              sourceErrors: injuryFeed.sourceErrors,
              count: 0,
              autoApplyAllowed: injuryFeed.status === "VERIFIED",
            },
            awayInjuryData: injuryMetaMap[awayId] ?? {
              source: injuryFeed.source,
              status: injuryFeed.status,
              fetchedAt: injuryFeed.fetchedAt,
              stale: injuryFeed.stale,
              sourceErrors: injuryFeed.sourceErrors,
              count: 0,
              autoApplyAllowed: injuryFeed.status === "VERIFIED",
            },''',
    "expose MLB injury metadata",
)

routes_path.write_text(routes, encoding="utf-8")


# -----------------------------------------------------------------------------
# Frontend: do not auto-mark degraded/anomalous lists; show source status;
# degrade BET signals when injury coverage is not verified; cap stake at 1.0u.
# -----------------------------------------------------------------------------
page_path = Path("frontend/client/src/pages/mlb-predictor.tsx")
page = page_path.read_text(encoding="utf-8")

page = replace_once(
    page,
    '''interface MLBInjury {
  name: string;''',
    '''type MLBInjuryFeedStatus = "VERIFIED" | "PARTIAL" | "SOURCE_UNAVAILABLE" | "ANOMALOUS";
interface MLBInjuryFeedMeta {
  source: string;
  status: MLBInjuryFeedStatus;
  fetchedAt?: string;
  stale?: boolean;
  sourceErrors?: string[];
  count: number;
  autoApplyAllowed: boolean;
  note?: string;
}
const EMPTY_MLB_INJURY_FEED: MLBInjuryFeedMeta = {
  source: "BALLDONTLIE",
  status: "SOURCE_UNAVAILABLE",
  count: 0,
  autoApplyAllowed: false,
  note: "Fuente de lesiones pendiente",
};

interface MLBInjury {
  name: string;''',
    "insert MLB injury feed types",
)

page = replace_once(
    page,
    '''  injuryProbDelta: number;
  sharpAgainst: boolean;''',
    '''  injuryProbDelta: number;
  injuryDataQuality?: "VERIFIED" | "DEGRADED";
  sharpAgainst: boolean;''',
    "add injury quality to PQS input",
)

page = replace_once(
    page,
    '''  if (input.sharpAgainst) warnings.push(`🚨 Dinero sharp en CONTRA`);
  if (input.oddsAmerican > 200 || input.oddsAmerican < -300) warnings.push("⚠️ Cuotas extremas");''',
    '''  if (input.sharpAgainst) warnings.push(`🚨 Dinero sharp en CONTRA`);
  if (input.injuryDataQuality !== "VERIFIED") warnings.push("⚠️ Cobertura de lesiones no verificada — señal degradada");
  if (input.oddsAmerican > 200 || input.oddsAmerican < -300) warnings.push("⚠️ Cuotas extremas");''',
    "warn on degraded injury coverage",
)

page = replace_once(
    page,
    '''  } else if (score >= 8 && edgeReal >= 7 && factorsAlignment >= 6) recommendation = "BET_FUERTE";
  else if (score >= 7 && edgeReal >= 5 && factorsAlignment >= 5) recommendation = "BET";
  else if (score >= 6 && edgeReal >= 3) recommendation = "LEAN";

  // ─── STAKE KELLY FRACCIONAL ───
  let stakeUnits = 0;
  if (recommendation !== "PASS" && edgeReal > 0) {
    const decimalOdds = input.oddsAmerican > 0 ? (input.oddsAmerican / 100) + 1 : (100 / (-input.oddsAmerican)) + 1;
    const b = decimalOdds - 1;
    const p = input.modelProb;
    const fullKelly = (b * p - (1 - p)) / b;
    const fractionalKelly = Math.max(0, fullKelly * 0.25);
    stakeUnits = Math.round(Math.min(5, fractionalKelly * 100) * 2) / 2;
    if (recommendation === "LEAN") stakeUnits = Math.min(stakeUnits, 1);
    else if (recommendation === "BET") stakeUnits = Math.min(stakeUnits, 3);
    else if (recommendation === "BET_FUERTE") stakeUnits = Math.min(stakeUnits, 5);
  }''',
    '''  } else if (score >= 8 && edgeReal >= 7 && factorsAlignment >= 6) recommendation = "BET_FUERTE";
  else if (score >= 7 && edgeReal >= 5 && factorsAlignment >= 5) recommendation = "BET";
  else if (score >= 6 && edgeReal >= 3) recommendation = "LEAN";

  if (input.injuryDataQuality !== "VERIFIED" && (recommendation === "BET" || recommendation === "BET_FUERTE")) {
    recommendation = "LEAN";
    warnings.unshift("🛡️ BET bloqueado hasta verificar lesiones de ambos equipos");
  }

  // ─── STAKE KELLY FRACCIONAL — CAP TEMPORAL 1.0u ───
  let stakeUnits = 0;
  if (recommendation !== "PASS" && edgeReal > 0) {
    const decimalOdds = input.oddsAmerican > 0 ? (input.oddsAmerican / 100) + 1 : (100 / (-input.oddsAmerican)) + 1;
    const b = decimalOdds - 1;
    const p = input.modelProb;
    const fullKelly = (b * p - (1 - p)) / b;
    const fractionalKelly = Math.max(0, fullKelly * 0.25);
    const rawStakeUnits = Math.round(fractionalKelly * 100 * 2) / 2;
    stakeUnits = Math.min(1, rawStakeUnits);
    if (rawStakeUnits > 1) warnings.push(`🛡️ Stake reducido de ${rawStakeUnits.toFixed(1)}u a 1.0u por cap de calibración`);
  }''',
    "cap MLB stake and degrade unverified injuries",
)

page = replace_once(
    page,
    '''  const [homeInjuryRoster, setHomeInjuryRoster] = useState<MLBInjury[]>([]);
  const [awayInjuryRoster, setAwayInjuryRoster] = useState<MLBInjury[]>([]);
  const [homeInjuryMissing, setHomeInjuryMissing] = useState<Set<string>>(new Set());''',
    '''  const [homeInjuryRoster, setHomeInjuryRoster] = useState<MLBInjury[]>([]);
  const [awayInjuryRoster, setAwayInjuryRoster] = useState<MLBInjury[]>([]);
  const [homeInjuryFeed, setHomeInjuryFeed] = useState<MLBInjuryFeedMeta>(EMPTY_MLB_INJURY_FEED);
  const [awayInjuryFeed, setAwayInjuryFeed] = useState<MLBInjuryFeedMeta>(EMPTY_MLB_INJURY_FEED);
  const [homeInjuryMissing, setHomeInjuryMissing] = useState<Set<string>>(new Set());''',
    "add MLB injury feed states",
)

old_autofill = '''    // Lesiones — auto-rellenar con todos los lesionados marcados
    const homeInj: MLBInjury[] = (game as any).homeInjuries ?? [];
    const awayInj: MLBInjury[] = (game as any).awayInjuries ?? [];
    setHomeInjuryRoster(homeInj);
    setAwayInjuryRoster(awayInj);
    const homeMissingSet = new Set(homeInj.map(p => p.name));
    const awayMissingSet = new Set(awayInj.map(p => p.name));
    setHomeInjuryMissing(homeMissingSet);
    setAwayInjuryMissing(awayMissingSet);
    // Inicializar gamesOut con los valores que vienen del API
    const homeGO: Record<string, number> = {};
    const awayGO: Record<string, number> = {};
    for (const p of homeInj) homeGO[p.name] = p.gamesMissed ?? 0;
    for (const p of awayInj) awayGO[p.name] = p.gamesMissed ?? 0;
    setHomeInjuryGamesOut(homeGO);
    setAwayInjuryGamesOut(awayGO);
    const homeImpact = calcMLBInjuryImpact(homeInj, homeMissingSet, homeGO);
    const awayImpact = calcMLBInjuryImpact(awayInj, awayMissingSet, awayGO);
    setHomeInjury(homeImpact.runs !== 0 ? homeImpact.runs.toFixed(1) : "0");
    setAwayInjury(awayImpact.runs !== 0 ? awayImpact.runs.toFixed(1) : "0");
    setHomeInjuryFactors({
      off: homeImpact.offFactor,
      def: homeImpact.defFactor,
      type: homeImpact.runs !== 0 ? "Auto" : "Mixto",
    });
    setAwayInjuryFactors({
      off: awayImpact.offFactor,
      def: awayImpact.defFactor,
      type: awayImpact.runs !== 0 ? "Auto" : "Mixto",
    });'''

new_autofill = '''    // Lesiones — solo auto-aplicar cuando la fuente y el tamaño de lista son verificables.
    const homeInj: MLBInjury[] = (game as any).homeInjuries ?? [];
    const awayInj: MLBInjury[] = (game as any).awayInjuries ?? [];
    const homeFeed: MLBInjuryFeedMeta = (game as any).homeInjuryData ?? EMPTY_MLB_INJURY_FEED;
    const awayFeed: MLBInjuryFeedMeta = (game as any).awayInjuryData ?? EMPTY_MLB_INJURY_FEED;
    setHomeInjuryRoster(homeInj);
    setAwayInjuryRoster(awayInj);
    setHomeInjuryFeed(homeFeed);
    setAwayInjuryFeed(awayFeed);

    const homeAutoApply = homeFeed.status === "VERIFIED" && homeFeed.autoApplyAllowed && homeInj.length <= 18;
    const awayAutoApply = awayFeed.status === "VERIFIED" && awayFeed.autoApplyAllowed && awayInj.length <= 18;
    const homeMissingSet = homeAutoApply ? new Set(homeInj.map(p => p.name)) : new Set<string>();
    const awayMissingSet = awayAutoApply ? new Set(awayInj.map(p => p.name)) : new Set<string>();
    setHomeInjuryMissing(homeMissingSet);
    setAwayInjuryMissing(awayMissingSet);

    // Inicializar gamesOut con los valores que vienen del API.
    const homeGO: Record<string, number> = {};
    const awayGO: Record<string, number> = {};
    for (const p of homeInj) homeGO[p.name] = p.gamesMissed ?? 0;
    for (const p of awayInj) awayGO[p.name] = p.gamesMissed ?? 0;
    setHomeInjuryGamesOut(homeGO);
    setAwayInjuryGamesOut(awayGO);

    const homeImpact = calcMLBInjuryImpact(homeInj, homeMissingSet, homeGO);
    const awayImpact = calcMLBInjuryImpact(awayInj, awayMissingSet, awayGO);
    setHomeInjury(homeAutoApply && homeImpact.runs !== 0 ? homeImpact.runs.toFixed(1) : "0");
    setAwayInjury(awayAutoApply && awayImpact.runs !== 0 ? awayImpact.runs.toFixed(1) : "0");
    setHomeInjuryFactors({
      off: homeAutoApply ? homeImpact.offFactor : 1.0,
      def: homeAutoApply ? homeImpact.defFactor : 0.5,
      type: homeAutoApply && homeImpact.runs !== 0 ? "Auto verificado" : "Sin ajuste automático",
    });
    setAwayInjuryFactors({
      off: awayAutoApply ? awayImpact.offFactor : 1.0,
      def: awayAutoApply ? awayImpact.defFactor : 0.5,
      type: awayAutoApply && awayImpact.runs !== 0 ? "Auto verificado" : "Sin ajuste automático",
    });'''

page = replace_once(page, old_autofill, new_autofill, "harden MLB injury autofill")

page = replace_once(
    page,
    '''        const injuryProbDelta = Math.abs(parseFloat(homeInjury) || 0) + Math.abs(parseFloat(awayInjury) || 0);''',
    '''        const injuryProbDelta = Math.abs(parseFloat(homeInjury) || 0) + Math.abs(parseFloat(awayInjury) || 0);
        const injuryDataQuality: "VERIFIED" | "DEGRADED" =
          homeInjuryFeed.status === "VERIFIED" && awayInjuryFeed.status === "VERIFIED"
            ? "VERIFIED"
            : "DEGRADED";''',
    "derive MLB injury data quality",
)

page = page.replace(
    '''          statcastDataQuality, statcastSignal, injuryProbDelta,
          sharpAgainst:''',
    '''          statcastDataQuality, statcastSignal, injuryProbDelta, injuryDataQuality,
          sharpAgainst:''',
)
if page.count("injuryProbDelta, injuryDataQuality") != 4:
    raise RuntimeError(f"PQS injuryDataQuality propagation: expected 4 calls, found {page.count('injuryProbDelta, injuryDataQuality')}")

page = replace_once(
    page,
    '''    homeInjury, homeInjuryFactors, awayInjury, awayInjuryFactors,''',
    '''    homeInjury, homeInjuryFactors, awayInjury, awayInjuryFactors, homeInjuryFeed, awayInjuryFeed,''',
    "add injury feeds to prediction dependencies",
)

page = replace_once(
    page,
    '''    const injuryRoster = isHome ? homeInjuryRoster : awayInjuryRoster;
    const injuryMissing = isHome ? homeInjuryMissing : awayInjuryMissing;''',
    '''    const injuryRoster = isHome ? homeInjuryRoster : awayInjuryRoster;
    const injuryFeed = isHome ? homeInjuryFeed : awayInjuryFeed;
    const injuryMissing = isHome ? homeInjuryMissing : awayInjuryMissing;''',
    "wire injury feed into team card",
)

page = replace_once(
    page,
    '''                {/* Auto-rellenado de lesionados desde BALLDONTLIE (incluye DTD + IL) */}
                {injuryRoster.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-amber-500/20 space-y-1.5">''',
    '''                {/* Estado verificable de la fuente de lesiones */}
                <div className={`mt-2 p-2 rounded border text-[10px] ${
                  injuryFeed.status === "VERIFIED"
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                    : injuryFeed.status === "ANOMALOUS"
                      ? "bg-red-500/10 border-red-500/40 text-red-300"
                      : "bg-amber-500/10 border-amber-500/30 text-amber-300"
                }`}>
                  <p className="font-semibold">
                    {injuryFeed.status === "VERIFIED"
                      ? `✓ Fuente verificada · ${injuryFeed.count} ausencia(s) activa(s)`
                      : injuryFeed.status === "ANOMALOUS"
                        ? `🚫 Lista anormal (${injuryFeed.count}) · ajuste automático bloqueado`
                        : injuryFeed.status === "PARTIAL"
                          ? "⚠ Datos de lesiones degradados/caché · revisión manual"
                          : "⚠ Fuente de lesiones no disponible · no equivale a cero lesionados"}
                  </p>
                  {injuryFeed.note && <p className="mt-0.5 opacity-80">{injuryFeed.note}</p>}
                </div>

                {/* Auto-rellenado de lesionados desde BALLDONTLIE (solo listas confiables) */}
                {injuryRoster.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-amber-500/20 space-y-1.5">''',
    "render MLB injury source status",
)

page_path.write_text(page, encoding="utf-8")
print("MLB injury/source hardening and 1.0u stake cap applied")

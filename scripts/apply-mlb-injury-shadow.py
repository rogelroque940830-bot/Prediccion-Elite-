from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


routes = Path("server/routes.ts")
text = routes.read_text(encoding="utf-8")

text = replace_once(
    text,
    'import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";\n',
    '''import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";
import {
  classifyMlbInjuryShadow,
  fetchOfficialMlbInjurySnapshot,
  summarizeMlbInjuryShadow,
} from "./mlb-injury-shadow";
''',
    "routes import",
)

text = replace_once(
    text,
    '''        const teamIds = new Set<number>();
        const pitcherIds = new Set<number>();
        for (const g of rawGames) {
          teamIds.add(g.teams.home.team.id);
          teamIds.add(g.teams.away.team.id);
          if (g.teams.home.probablePitcher?.id) pitcherIds.add(g.teams.home.probablePitcher.id);
          if (g.teams.away.probablePitcher?.id) pitcherIds.add(g.teams.away.probablePitcher.id);
        }
''',
    '''        const teamIds = new Set<number>();
        const pitcherIds = new Set<number>();
        const probablePitcherByTeam: Record<number, number | null> = {};
        for (const g of rawGames) {
          const homeTeamId = g.teams.home.team.id;
          const awayTeamId = g.teams.away.team.id;
          teamIds.add(homeTeamId);
          teamIds.add(awayTeamId);
          probablePitcherByTeam[homeTeamId] = g.teams.home.probablePitcher?.id ?? null;
          probablePitcherByTeam[awayTeamId] = g.teams.away.probablePitcher?.id ?? null;
          if (g.teams.home.probablePitcher?.id) pitcherIds.add(g.teams.home.probablePitcher.id);
          if (g.teams.away.probablePitcher?.id) pitcherIds.add(g.teams.away.probablePitcher.id);
        }
''',
    "team collection",
)

text = replace_once(
    text,
    '''        const injuryFeed = await getMLBInjuriesFromBDL();
        const bdlInjuriesByTeam = injuryFeed.byTeam;
        const injuryMap: Record<number, any[]> = {};
        const injuryMetaMap: Record<number, any> = {};
        const injuryPromises = [...teamIds].map(async (tid) => {
''',
    '''        const injuryFeed = await getMLBInjuriesFromBDL();
        const bdlInjuriesByTeam = injuryFeed.byTeam;
        const injuryMap: Record<number, any[]> = {};
        const injuryMetaMap: Record<number, any> = {};
        const officialInjurySnapshots: Record<number, Awaited<ReturnType<typeof fetchOfficialMlbInjurySnapshot>>> = {};
        await Promise.all([...teamIds].map(async (tid) => {
          officialInjurySnapshots[tid] = await fetchOfficialMlbInjurySnapshot(tid, dateParam);
        }));
        const injuryPromises = [...teamIds].map(async (tid) => {
''',
    "injury setup",
)

text = replace_once(
    text,
    '''                  name, position: positionAbbr, status: fullStatus,
                  era:''',
    '''                  playerId: pid, name, position: positionAbbr, status: fullStatus,
                  era:''',
    "pitcher player id",
)
text = replace_once(
    text,
    '''                  name, position: positionAbbr, status: fullStatus,
                  ops:''',
    '''                  playerId: pid, name, position: positionAbbr, status: fullStatus,
                  ops:''',
    "hitter player id",
)

text = replace_once(
    text,
    '''          const verifiedList = list.filter(Boolean) as any[];
          const rejectedCount = rawBdlList.length - verifiedList.length;
          injuryMap[tid] = verifiedList;

          // Con ausencias presentes todavía no tenemos duración oficial verificable.
          // Se muestran para revisión, pero jamás se aplican automáticamente al modelo.
          const identityComplete = injuryFeed.status === "VERIFIED" && rejectedCount === 0;
          const safeStatus = identityComplete && verifiedList.length === 0 ? "VERIFIED" : "PARTIAL";
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            status: safeStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: injuryFeed.sourceErrors,
            count: verifiedList.length,
            rejectedCount,
            autoApplyAllowed: false,
            note: rejectedCount > 0
              ? `${rejectedCount} registro(s) descartado(s) por no coincidir con el equipo MLB actual; ajuste automático bloqueado`
              : verifiedList.length > 0
                ? "Jugador y equipo verificados; duración real de la ausencia no verificada. Selección manual requerida"
                : "Fuente verificada: no hay ausencias activas confirmadas para este equipo",
          };
''',
    '''          const verifiedList = list.filter(Boolean) as any[];
          const rejectedCount = rawBdlList.length - verifiedList.length;
          const officialSnapshot = officialInjurySnapshots[tid];
          const probablePitcherId = probablePitcherByTeam[tid] ?? null;
          const shadowList = verifiedList.map((player: any) => {
            const rosterEvidence = officialSnapshot?.rosterByPlayerId?.[player.playerId];
            const transactionEvidence = officialSnapshot?.latestTransactionByPlayerId?.[player.playerId] ?? null;
            const shadow = classifyMlbInjuryShadow({
              playerId: player.playerId,
              name: player.name,
              isPitcher: player.isPitcher,
              position: player.position,
              rosterStatusCode: rosterEvidence?.statusCode ?? null,
              rosterStatusDescription: rosterEvidence?.statusDescription ?? null,
              latestTransaction: transactionEvidence,
              probablePitcherId,
              gamesStarted: player.gamesStarted,
              saves: player.saves,
              holds: player.holds,
              gamesFinished: player.gamesFinished,
              inningsPitched: player.inningsPitched,
              plateAppearances: player.plateAppearances,
              ops: player.ops,
              obp: player.obp,
              slg: player.slg,
              asOfDate: dateParam,
            });
            return {
              ...player,
              officialStatusCode: rosterEvidence?.statusCode ?? null,
              officialStatus: rosterEvidence?.statusDescription ?? null,
              officialTransaction: transactionEvidence,
              shadow,
            };
          });
          const shadowSummary = summarizeMlbInjuryShadow(shadowList.map((player: any) => player.shadow));
          injuryMap[tid] = shadowList;

          // Fase A: decide jugador por jugador, pero no altera proyección ni ledger.
          const identityComplete = injuryFeed.status === "VERIFIED" && rejectedCount === 0;
          const safeStatus = identityComplete && shadowList.length === 0 ? "VERIFIED" : "PARTIAL";
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            validationSource: officialSnapshot?.source ?? "MLB_STATS",
            status: safeStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: [...(injuryFeed.sourceErrors ?? []), ...(officialSnapshot?.errors ?? [])],
            officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
            officialFetchedAt: officialSnapshot?.fetchedAt,
            count: shadowList.length,
            rejectedCount,
            autoApplyAllowed: false,
            shadowMode: true,
            shadowSummary,
            note: rejectedCount > 0
              ? `${rejectedCount} registro(s) descartado(s); el resto fue clasificado automáticamente en modo sombra`
              : shadowList.length > 0
                ? "BALLDONTLIE detecta; MLB valida roster y transacciones. El modo sombra no modifica todavía la proyección"
                : "Fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
          };
''',
    "verified injury block",
)

fallback_old = '''              count: 0,
              autoApplyAllowed: injuryFeed.status === "VERIFIED",
            },
'''
fallback_new = '''              count: 0,
              autoApplyAllowed: false,
              shadowMode: true,
              shadowSummary: {
                total: 0, applyCandidates: 0, alreadyReflected: 0,
                ignored: 0, conflicts: 0, pending: 0,
                highConfidence: 0, mode: "SHADOW",
              },
            },
'''
if text.count(fallback_old) != 2:
    raise SystemExit(f"fallback injury metadata: expected 2 matches, found {text.count(fallback_old)}")
text = text.replace(fallback_old, fallback_new, 2)
routes.write_text(text, encoding="utf-8")

shadow_module = Path("server/mlb-injury-shadow.ts")
shadow_text = shadow_module.read_text(encoding="utf-8")
shadow_text = replace_once(
    shadow_text,
    '''    for (const transaction of transactions) {
      const playerId = Number(transaction?.person?.id);
      if (!Number.isFinite(playerId) || latestTransactionByPlayerId[playerId]) continue;
''',
    '''    for (const transaction of transactions) {
      const relevantText = [transaction?.typeDesc, transaction?.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!/injured|activated|reinstated|returned|rehab|disabled list/.test(relevantText)) continue;
      const playerId = Number(transaction?.person?.id);
      if (!Number.isFinite(playerId) || latestTransactionByPlayerId[playerId]) continue;
''',
    "relevant transaction filter",
)
shadow_module.write_text(shadow_text, encoding="utf-8")

frontend = Path("frontend/client/src/pages/mlb-predictor.tsx")
ui = frontend.read_text(encoding="utf-8")
ui = replace_once(
    ui,
    '''interface MLBInjuryFeedMeta {
  source: string;
  status: MLBInjuryFeedStatus;
  fetchedAt?: string;
  stale?: boolean;
  sourceErrors?: string[];
  count: number;
  autoApplyAllowed: boolean;
  note?: string;
}
''',
    '''interface MLBInjuryShadowSummary {
  total: number;
  applyCandidates: number;
  alreadyReflected: number;
  ignored: number;
  conflicts: number;
  pending: number;
  highConfidence: number;
  mode: "SHADOW";
}
interface MLBInjuryFeedMeta {
  source: string;
  validationSource?: string;
  status: MLBInjuryFeedStatus;
  fetchedAt?: string;
  stale?: boolean;
  sourceErrors?: string[];
  officialValidationStatus?: "VERIFIED" | "PARTIAL";
  officialFetchedAt?: string;
  count: number;
  autoApplyAllowed: boolean;
  shadowMode?: boolean;
  shadowSummary?: MLBInjuryShadowSummary;
  note?: string;
}
''',
    "frontend injury metadata types",
)
ui = replace_once(
    ui,
    '''  source?: string;
  // Override de lineup slot (1-9). Si no se pasa, el modelo asume slot por posición.
''',
    '''  source?: string;
  playerId?: number;
  officialStatusCode?: string | null;
  officialStatus?: string | null;
  officialTransaction?: {
    date?: string | null;
    effectiveDate?: string | null;
    typeCode?: string | null;
    typeDesc?: string | null;
    description?: string | null;
  } | null;
  shadow?: {
    decision: "APPLY_CANDIDATE" | "ALREADY_REFLECTED" | "IGNORE" | "CONFLICT" | "PENDING";
    confidence: "HIGH" | "MEDIUM" | "LOW";
    impact: "HIGH" | "MEDIUM" | "LOW" | "NONE";
    reasonCode: string;
    reason: string;
    daysSinceOfficialTransaction?: number | null;
    shadowOnly: true;
  };
  // Override de lineup slot (1-9). Si no se pasa, el modelo asume slot por posición.
''',
    "frontend injury player types",
)

panel_marker = '                {/* Auto-rellenado de lesionados desde BALLDONTLIE (solo listas confiables) */}'
panel = '''                {injuryFeed.shadowMode && injuryFeed.shadowSummary && (
                  <div className="mt-2 p-2 rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] text-cyan-200 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold uppercase tracking-wider">Automatización · modo sombra</p>
                      <span className="text-cyan-300/80">BDL detecta · MLB valida</span>
                    </div>
                    <p className="text-cyan-100/80">Clasifica automáticamente, pero todavía no modifica la proyección ni el ledger.</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <span>Candidatos: <b>{injuryFeed.shadowSummary.applyCandidates}</b></span>
                      <span>Ya reflejados: <b>{injuryFeed.shadowSummary.alreadyReflected}</b></span>
                      <span>Ignorados: <b>{injuryFeed.shadowSummary.ignored}</b></span>
                      <span>Conflictos: <b>{injuryFeed.shadowSummary.conflicts}</b></span>
                      <span>Pendientes: <b>{injuryFeed.shadowSummary.pending}</b></span>
                      <span>Confianza alta: <b>{injuryFeed.shadowSummary.highConfidence}</b></span>
                    </div>
                  </div>
                )}

'''
ui = replace_once(ui, panel_marker, panel + panel_marker, "frontend shadow panel")
ui = replace_once(
    ui,
    '                        Lesionados detectados ({injuryRoster.length}) — toca para incluir/excluir:\n',
    '                        Lesionados detectados ({injuryRoster.length}) — clasificados automáticamente; toque solo para override manual:\n',
    "frontend injury heading",
)
ui = replace_once(
    ui,
    '''                            title={`${t.type} · ${pl.status}${pl.returnDate ? `\nRegreso: ${new Date(pl.returnDate).toLocaleDateString("es-ES")}` : ""}${pl.shortComment ? `\n\n${pl.shortComment}` : ""}`}
''',
    '''                            title={`${t.type} · ${pl.status}${pl.officialStatus ? `\nMLB: ${pl.officialStatus}` : ""}${pl.shadow?.reason ? `\nAutomático: ${pl.shadow.reason}` : ""}${pl.returnDate ? `\nRegreso: ${new Date(pl.returnDate).toLocaleDateString("es-ES")}` : ""}${pl.shortComment ? `\n\n${pl.shortComment}` : ""}`}
''',
    "frontend injury tooltip",
)
ui = replace_once(
    ui,
    '''                            <span className={isOut ? "line-through" : ""}>{pl.name}</span>
                            <span className="text-[9px] text-muted-foreground ml-1">({pl.position} · {statSnip})</span>
''',
    '''                            <span className={isOut ? "line-through" : ""}>{pl.name}</span>
                            <span className="text-[9px] text-muted-foreground ml-1">({pl.position} · {statSnip})</span>
                            {pl.shadow && (
                              <span className={`text-[9px] ml-1 ${
                                pl.shadow.decision === "APPLY_CANDIDATE" ? "text-emerald-300" :
                                pl.shadow.decision === "ALREADY_REFLECTED" ? "text-blue-300" :
                                pl.shadow.decision === "IGNORE" ? "text-slate-400" :
                                pl.shadow.decision === "CONFLICT" ? "text-red-300" : "text-amber-300"
                              }`}>
                                · {pl.shadow.decision === "APPLY_CANDIDATE" ? "aplicaría" :
                                  pl.shadow.decision === "ALREADY_REFLECTED" ? "ya reflejado" :
                                  pl.shadow.decision === "IGNORE" ? "ignorado" :
                                  pl.shadow.decision === "CONFLICT" ? "conflicto" : "pendiente"}
                              </span>
                            )}
''',
    "frontend injury chip",
)
frontend.write_text(ui, encoding="utf-8")

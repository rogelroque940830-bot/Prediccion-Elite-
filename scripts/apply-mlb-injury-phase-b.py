from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


# --- Backend route integration ---
routes = Path("server/routes.ts")
text = routes.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''} from "./mlb-injury-shadow";
''',
    '''} from "./mlb-injury-shadow";
import { buildMlbInjuryPhaseBPlan } from "./mlb-injury-phase-b";
''',
    "routes phase B import",
)

empty_old = '''            const sourcesVerified = !anomalous
              && injuryFeed.status === "VERIFIED"
              && officialSnapshot?.status === "VERIFIED";
            injuryMap[tid] = [];
            injuryMetaMap[tid] = {
              ...injuryMetaMap[tid],
              status: anomalous ? "ANOMALOUS" : sourcesVerified && officialOnly === 0 ? "VERIFIED" : "PARTIAL",
              shadowSummary: {
                total: 0, applyCandidates: 0, alreadyReflected: 0,
                ignored: 0, conflicts: 0, pending: 0,
                highConfidence: 0, officialOnly, mode: "SHADOW",
              },
              note: anomalous
                ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
                : officialOnly > 0
                  ? `BALLDONTLIE no reportó ${officialOnly} jugador(es) que MLB mantiene en lista de lesionados; cobertura en revisión`
                  : "Ambas fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
            };
'''
empty_new = '''            const sourcesVerified = !anomalous
              && injuryFeed.status === "VERIFIED"
              && officialSnapshot?.status === "VERIFIED";
            const phaseB = buildMlbInjuryPhaseBPlan({
              sourceStatus: injuryFeed.status,
              officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
              stale: injuryFeed.stale,
              anomalous,
              rejectedCount: 0,
              officialOnly,
              players: [],
            });
            injuryMap[tid] = [];
            injuryMetaMap[tid] = {
              ...injuryMetaMap[tid],
              status: anomalous ? "ANOMALOUS" : sourcesVerified && officialOnly === 0 ? "VERIFIED" : "PARTIAL",
              autoApplyAllowed: phaseB.autoApplyAllowed,
              phaseB,
              shadowSummary: {
                total: 0, applyCandidates: 0, alreadyReflected: 0,
                ignored: 0, conflicts: 0, pending: 0,
                highConfidence: 0, officialOnly, mode: "SHADOW",
              },
              note: anomalous
                ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
                : officialOnly > 0
                  ? `BALLDONTLIE no reportó ${officialOnly} jugador(es) que MLB mantiene en lista de lesionados; cobertura en revisión`
                  : "Ambas fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
            };
'''
text = replace_once(text, empty_old, empty_new, "empty injury phase B plan")

summary_old = '''          const shadowSummary = {
            ...summarizeMlbInjuryShadow(shadowList.map((player: any) => player.shadow)),
            officialOnly,
          };
          injuryMap[tid] = shadowList;

          // Fase A: decide jugador por jugador, pero no altera proyección ni ledger.
'''
summary_new = '''          const shadowSummary = {
            ...summarizeMlbInjuryShadow(shadowList.map((player: any) => player.shadow)),
            officialOnly,
          };
          const phaseB = buildMlbInjuryPhaseBPlan({
            sourceStatus: injuryFeed.status,
            officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
            stale: injuryFeed.stale,
            anomalous,
            rejectedCount,
            officialOnly,
            players: shadowList.map((player: any) => ({
              playerId: Number(player.playerId),
              name: String(player.name),
              isPitcher: Boolean(player.isPitcher),
              shadow: player.shadow,
            })),
          });
          injuryMap[tid] = shadowList;

          // Fase B: candidatos de alta confianza pasan a una segunda reconciliación con Bullpen Status.
'''
text = replace_once(text, summary_old, summary_new, "nonempty injury phase B plan")

meta_old = '''            count: shadowList.length,
            rejectedCount,
            autoApplyAllowed: false,
            shadowMode: true,
            shadowSummary,
            note: rejectedCount > 0
              ? `${rejectedCount} registro(s) descartado(s); el resto fue clasificado automáticamente en modo sombra`
              : shadowList.length > 0
                ? "BALLDONTLIE detecta; MLB valida roster y transacciones. El modo sombra no modifica todavía la proyección"
                : "Fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
'''
meta_new = '''            count: shadowList.length,
            rejectedCount,
            autoApplyAllowed: phaseB.autoApplyAllowed,
            shadowMode: true,
            shadowSummary,
            phaseB,
            note: phaseB.autoApplyAllowed
              ? `${phaseB.eligiblePlayerNames.length} relevista(s) superaron la Fase B; falta reconciliación final con Bullpen Status`
              : rejectedCount > 0
                ? `${rejectedCount} registro(s) descartado(s); los candidatos restantes no superaron todas las barreras de activación`
                : shadowList.length > 0
                  ? "BALLDONTLIE detecta y MLB valida; la Fase B se abstiene cuando falta certeza o existe riesgo de doble conteo"
                  : "Fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
'''
text = replace_once(text, meta_old, meta_new, "injury metadata phase B")
routes.write_text(text, encoding="utf-8")


# --- Package test scripts ---
package = Path("package.json")
text = package.read_text(encoding="utf-8")
text = text.replace(
    "server/mlb-injury-shadow.test.ts\"",
    "server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts\"",
    1,
)
text = text.replace(
    '"test:mlb-injuries": "tsx --test server/mlb-injury-identity.test.ts server/mlb-injury-shadow.test.ts"',
    '"test:mlb-injuries": "tsx --test server/mlb-injury-identity.test.ts server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts"',
    1,
)
text = text.replace(
    '"test:mlb-injury-shadow": "tsx --test server/mlb-injury-shadow.test.ts"',
    '"test:mlb-injury-shadow": "tsx --test server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts"',
    1,
)
package.write_text(text, encoding="utf-8")


# --- Frontend integration ---
frontend = Path("frontend/client/src/pages/mlb-predictor.tsx")
ui = frontend.read_text(encoding="utf-8")
ui = replace_once(
    ui,
    '''import { americanImpliedProbability, createMlbScientificSnapshot, isoDateTimeOrUndefined, mapMlbLedgerMarket, noVigSideProbability, parseMlbMarketLine, type MlbSourceStatus } from "@/lib/mlb-scientific-snapshot";
''',
    '''import { americanImpliedProbability, createMlbScientificSnapshot, isoDateTimeOrUndefined, mapMlbLedgerMarket, noVigSideProbability, parseMlbMarketLine, type MlbSourceStatus } from "@/lib/mlb-scientific-snapshot";
import { resolveMlbPhaseBSelection, scaleMlbPhaseBRuns } from "@/lib/mlb-injury-phase-b";
''',
    "frontend phase B import",
)

phase_type = '''interface MLBInjuryPhaseBPlan {
  enabled: true;
  mode: "AUTO_CONSERVATIVE";
  autoApplyAllowed: boolean;
  coverage: "FULL" | "PARTIAL" | "BLOCKED";
  eligiblePlayerIds: number[];
  eligiblePlayerNames: string[];
  withheldCandidateNames: string[];
  candidateCount: number;
  scale: number;
  maxAbsRuns: number;
  requiresBullpenReconciliation: true;
  reason: string;
}
'''
ui = replace_once(
    ui,
    '''interface MLBInjuryFeedMeta {
''',
    phase_type + '''interface MLBInjuryFeedMeta {
''',
    "frontend phase B interface",
)
ui = replace_once(
    ui,
    '''  shadowSummary?: MLBInjuryShadowSummary;
  note?: string;
''',
    '''  shadowSummary?: MLBInjuryShadowSummary;
  phaseB?: MLBInjuryPhaseBPlan;
  note?: string;
''',
    "frontend feed phase B field",
)

state_old = '''  const [homeInjuryMissing, setHomeInjuryMissing] = useState<Set<string>>(new Set());
  const [awayInjuryMissing, setAwayInjuryMissing] = useState<Set<string>>(new Set());
  // Override de juegos perdidos por jugador (si el usuario lo ajusta manualmente)
'''
state_new = '''  const [homeInjuryMissing, setHomeInjuryMissing] = useState<Set<string>>(new Set());
  const [awayInjuryMissing, setAwayInjuryMissing] = useState<Set<string>>(new Set());
  const [homePhaseBAutoApplied, setHomePhaseBAutoApplied] = useState<Set<string>>(new Set());
  const [awayPhaseBAutoApplied, setAwayPhaseBAutoApplied] = useState<Set<string>>(new Set());
  const [homePhaseBStatus, setHomePhaseBStatus] = useState("");
  const [awayPhaseBStatus, setAwayPhaseBStatus] = useState("");
  // Override de juegos perdidos por jugador (si el usuario lo ajusta manualmente)
'''
ui = replace_once(ui, state_old, state_new, "frontend phase B states")

injury_old = '''    // Lesiones — solo auto-aplicar cuando la fuente y el tamaño de lista son verificables.
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
    });
'''
injury_new = '''    // Lesiones — la Fase B espera la reconciliación con Bullpen Status antes de tocar la proyección.
    const homeInj: MLBInjury[] = (game as any).homeInjuries ?? [];
    const awayInj: MLBInjury[] = (game as any).awayInjuries ?? [];
    const homeFeed: MLBInjuryFeedMeta = (game as any).homeInjuryData ?? EMPTY_MLB_INJURY_FEED;
    const awayFeed: MLBInjuryFeedMeta = (game as any).awayInjuryData ?? EMPTY_MLB_INJURY_FEED;
    setHomeInjuryRoster(homeInj);
    setAwayInjuryRoster(awayInj);
    setHomeInjuryFeed(homeFeed);
    setAwayInjuryFeed(awayFeed);
    setHomeInjuryMissing(new Set());
    setAwayInjuryMissing(new Set());
    setHomePhaseBAutoApplied(new Set());
    setAwayPhaseBAutoApplied(new Set());
    setHomePhaseBStatus("Esperando reconciliación con Bullpen Status");
    setAwayPhaseBStatus("Esperando reconciliación con Bullpen Status");

    // Inicializar gamesOut con los valores que vienen del API.
    const homeGO: Record<string, number> = {};
    const awayGO: Record<string, number> = {};
    for (const p of homeInj) homeGO[p.name] = p.gamesMissed ?? 0;
    for (const p of awayInj) awayGO[p.name] = p.gamesMissed ?? 0;
    setHomeInjuryGamesOut(homeGO);
    setAwayInjuryGamesOut(awayGO);
    setHomeInjury("0");
    setAwayInjury("0");
    setHomeInjuryFactors({ off: 1.0, def: 0.5, type: "Fase B pendiente" });
    setAwayInjuryFactors({ off: 1.0, def: 0.5, type: "Fase B pendiente" });
'''
ui = replace_once(ui, injury_old, injury_new, "frontend defer injury auto apply")

bullpen_old = '''    // Bullpen status — closer cansado? bullpen comprometido?
    try {
      const bpRes = await fetch(`${API_BASE}/api/mlb/bullpen-status/${gameId}`);
      if (bpRes.ok) {
        const bp = await bpRes.json();
        setBullpenStatus(bp);
      } else {
        setBullpenStatus(null);
      }
    } catch {
      setBullpenStatus(null);
    }
'''
bullpen_new = '''    // Bullpen status — reconciliación obligatoria antes de activar lesiones de relevistas.
    let phaseBBullpen: any | null = null;
    try {
      const bpRes = await fetch(`${API_BASE}/api/mlb/bullpen-status/${gameId}`);
      if (bpRes.ok) {
        phaseBBullpen = await bpRes.json();
        setBullpenStatus(phaseBBullpen);
      } else {
        setBullpenStatus(null);
      }
    } catch {
      setBullpenStatus(null);
    }

    const homePhaseB = resolveMlbPhaseBSelection(homeInj, homeFeed, phaseBBullpen?.home);
    const awayPhaseB = resolveMlbPhaseBSelection(awayInj, awayFeed, phaseBBullpen?.away);
    const homePhaseBSet = new Set(homePhaseB.appliedNames);
    const awayPhaseBSet = new Set(awayPhaseB.appliedNames);
    const homeRawImpact = calcMLBInjuryImpact(homeInj, homePhaseBSet, homeGO);
    const awayRawImpact = calcMLBInjuryImpact(awayInj, awayPhaseBSet, awayGO);
    const homeAutoRuns = scaleMlbPhaseBRuns(
      homeRawImpact.runs,
      homeFeed.phaseB?.scale ?? 0,
      homeFeed.phaseB?.maxAbsRuns ?? 0,
    );
    const awayAutoRuns = scaleMlbPhaseBRuns(
      awayRawImpact.runs,
      awayFeed.phaseB?.scale ?? 0,
      awayFeed.phaseB?.maxAbsRuns ?? 0,
    );
    setHomeInjuryMissing(homePhaseBSet);
    setAwayInjuryMissing(awayPhaseBSet);
    setHomePhaseBAutoApplied(homePhaseBSet);
    setAwayPhaseBAutoApplied(awayPhaseBSet);
    setHomeInjury(homeAutoRuns !== 0 ? homeAutoRuns.toFixed(1) : "0");
    setAwayInjury(awayAutoRuns !== 0 ? awayAutoRuns.toFixed(1) : "0");
    setHomeInjuryFactors({
      off: homePhaseBSet.size > 0 ? homeRawImpact.offFactor : 1.0,
      def: homePhaseBSet.size > 0 ? homeRawImpact.defFactor : 0.5,
      type: homePhaseBSet.size > 0 ? "Fase B automática" : "Sin ajuste automático",
    });
    setAwayInjuryFactors({
      off: awayPhaseBSet.size > 0 ? awayRawImpact.offFactor : 1.0,
      def: awayPhaseBSet.size > 0 ? awayRawImpact.defFactor : 0.5,
      type: awayPhaseBSet.size > 0 ? "Fase B automática" : "Sin ajuste automático",
    });
    setHomePhaseBStatus(
      homePhaseBSet.size > 0
        ? `${homePhaseBSet.size} relevista(s) autoaplicado(s) · ajuste conservador ${homeAutoRuns.toFixed(1)} runs`
        : homePhaseB.blockedReason === "BULLPEN_EFFECT_ALREADY_APPLIED"
          ? "Abstención: Bullpen Status ya aplica un deterioro; se evita doble conteo"
          : homePhaseB.blockedReason === "BULLPEN_STATUS_UNAVAILABLE"
            ? "Abstención: Bullpen Status no disponible"
            : "Sin relevistas elegibles para ajuste automático",
    );
    setAwayPhaseBStatus(
      awayPhaseBSet.size > 0
        ? `${awayPhaseBSet.size} relevista(s) autoaplicado(s) · ajuste conservador ${awayAutoRuns.toFixed(1)} runs`
        : awayPhaseB.blockedReason === "BULLPEN_EFFECT_ALREADY_APPLIED"
          ? "Abstención: Bullpen Status ya aplica un deterioro; se evita doble conteo"
          : awayPhaseB.blockedReason === "BULLPEN_STATUS_UNAVAILABLE"
            ? "Abstención: Bullpen Status no disponible"
            : "Sin relevistas elegibles para ajuste automático",
    );
'''
ui = replace_once(ui, bullpen_old, bullpen_new, "frontend bullpen reconciliation")

refs_old = '''    const injuryMissing = isHome ? homeInjuryMissing : awayInjuryMissing;
    const setInjuryMissing = isHome ? setHomeInjuryMissing : setAwayInjuryMissing;
    const injuryGamesOut = isHome ? homeInjuryGamesOut : awayInjuryGamesOut;
'''
refs_new = '''    const injuryMissing = isHome ? homeInjuryMissing : awayInjuryMissing;
    const setInjuryMissing = isHome ? setHomeInjuryMissing : setAwayInjuryMissing;
    const phaseBAutoApplied = isHome ? homePhaseBAutoApplied : awayPhaseBAutoApplied;
    const setPhaseBAutoApplied = isHome ? setHomePhaseBAutoApplied : setAwayPhaseBAutoApplied;
    const phaseBStatus = isHome ? homePhaseBStatus : awayPhaseBStatus;
    const setPhaseBStatus = isHome ? setHomePhaseBStatus : setAwayPhaseBStatus;
    const injuryGamesOut = isHome ? homeInjuryGamesOut : awayInjuryGamesOut;
'''
ui = replace_once(ui, refs_old, refs_new, "team card phase B refs")

manual_input_old = '''                    setInjury(e.target.value);
                    // manual edit → default seguro
                    setInjuryFactors({ off: 1.0, def: 0.5, type: "Manual" });
'''
manual_input_new = '''                    setInjury(e.target.value);
                    setPhaseBAutoApplied(new Set());
                    setPhaseBStatus("Override manual del ajuste agregado");
                    // manual edit → default seguro
                    setInjuryFactors({ off: 1.0, def: 0.5, type: "Manual" });
'''
ui = replace_once(ui, manual_input_old, manual_input_new, "manual injury input clears auto state")

panel_old = '''                {injuryFeed.shadowMode && injuryFeed.shadowSummary && (
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
                      <span>Solo en MLB: <b>{injuryFeed.shadowSummary.officialOnly}</b></span>
                    </div>
                  </div>
                )}
'''
panel_new = '''                {injuryFeed.phaseB?.enabled && injuryFeed.shadowSummary ? (
                  <div className="mt-2 p-2 rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-200 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold uppercase tracking-wider">Automatización · Fase B activa</p>
                      <span className="text-emerald-300/80">BDL detecta · MLB valida · bullpen reconcilia</span>
                    </div>
                    <p className="text-emerald-100/80">Solo relevistas recientes de alta confianza pueden modificar la proyección. Los demás casos se retienen automáticamente.</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <span>Candidatos detectados: <b>{injuryFeed.phaseB.candidateCount}</b></span>
                      <span>Elegibles backend: <b>{injuryFeed.phaseB.eligiblePlayerNames.length}</b></span>
                      <span>Autoaplicados: <b>{phaseBAutoApplied.size}</b></span>
                      <span>Retenidos: <b>{injuryFeed.phaseB.withheldCandidateNames.length}</b></span>
                      <span>Cobertura: <b>{injuryFeed.phaseB.coverage}</b></span>
                      <span>Escala: <b>{Math.round(injuryFeed.phaseB.scale * 100)}%</b></span>
                      <span>Tope: <b>±{injuryFeed.phaseB.maxAbsRuns.toFixed(2)} runs</b></span>
                      <span>Solo en MLB: <b>{injuryFeed.shadowSummary.officialOnly}</b></span>
                    </div>
                    {phaseBStatus && <p className="pt-1 border-t border-emerald-500/20 text-emerald-100">{phaseBStatus}</p>}
                  </div>
                ) : injuryFeed.shadowMode && injuryFeed.shadowSummary ? (
                  <div className="mt-2 p-2 rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] text-cyan-200">
                    Clasificación en modo sombra; no se aplica ningún ajuste.
                  </div>
                ) : null}
'''
ui = replace_once(ui, panel_old, panel_new, "phase B panel")

map_old = '''                      {injuryRoster.map((pl) => {
                        const isOut = injuryMissing.has(pl.name);
                        const t = detectMLBPlayerType(pl);
'''
map_new = '''                      {injuryRoster.map((pl) => {
                        const isOut = injuryMissing.has(pl.name);
                        const isPhaseBAuto = phaseBAutoApplied.has(pl.name);
                        const isPhaseBWithheld = injuryFeed.phaseB?.withheldCandidateNames.includes(pl.name) === true;
                        const t = detectMLBPlayerType(pl);
'''
ui = replace_once(ui, map_old, map_new, "injury chip phase B flags")

click_old = '''                              setInjuryMissing(next);
                              const impact = calcMLBInjuryImpact(injuryRoster, next, injuryGamesOut);
                              setInjury(impact.runs !== 0 ? impact.runs.toFixed(1) : "0");
                              setInjuryFactors({
                                off: impact.offFactor,
                                def: impact.defFactor,
                                type: impact.runs !== 0 ? "Auto" : "Mixto",
                              });
'''
click_new = '''                              setInjuryMissing(next);
                              const nextAuto = new Set(phaseBAutoApplied);
                              nextAuto.delete(pl.name);
                              setPhaseBAutoApplied(nextAuto);
                              setPhaseBStatus("Override manual aplicado; el cálculo deja de usar el tope automático para esa selección");
                              const impact = calcMLBInjuryImpact(injuryRoster, next, injuryGamesOut);
                              setInjury(impact.runs !== 0 ? impact.runs.toFixed(1) : "0");
                              setInjuryFactors({
                                off: impact.offFactor,
                                def: impact.defFactor,
                                type: impact.runs !== 0 ? "Override manual" : "Mixto",
                              });
'''
ui = replace_once(ui, click_old, click_new, "manual chip override")

class_old = '''                              isOut
                                ? "bg-red-500/30 border-red-400 text-red-200 font-bold"
                                : "bg-slate-700/40 border-slate-600 text-slate-400"
'''
class_new = '''                              isPhaseBAuto
                                ? "bg-emerald-500/25 border-emerald-400 text-emerald-100 font-bold"
                                : isOut
                                  ? "bg-red-500/30 border-red-400 text-red-200 font-bold"
                                  : "bg-slate-700/40 border-slate-600 text-slate-400"
'''
ui = replace_once(ui, class_old, class_new, "injury chip automatic class")

label_old = '''                            {pl.shadow && (
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
'''
label_new = '''                            {pl.shadow && (
                              <span className={`text-[9px] ml-1 ${
                                isPhaseBAuto ? "text-emerald-200" :
                                isPhaseBWithheld ? "text-amber-300" :
                                pl.shadow.decision === "ALREADY_REFLECTED" ? "text-blue-300" :
                                pl.shadow.decision === "IGNORE" ? "text-slate-400" :
                                pl.shadow.decision === "CONFLICT" ? "text-red-300" : "text-amber-300"
                              }`}>
                                · {isPhaseBAuto ? "auto aplicado" :
                                  isPhaseBWithheld ? "retenido" :
                                  pl.shadow.decision === "APPLY_CANDIDATE" ? "candidato" :
                                  pl.shadow.decision === "ALREADY_REFLECTED" ? "ya reflejado" :
                                  pl.shadow.decision === "IGNORE" ? "ignorado" :
                                  pl.shadow.decision === "CONFLICT" ? "conflicto" : "pendiente"}
                              </span>
                            )}
'''
ui = replace_once(ui, label_old, label_new, "injury chip phase B label")

games_old = '''                                  setInjuryGamesOut(nextGO);
                                  const impact = calcMLBInjuryImpact(injuryRoster, injuryMissing, nextGO);
                                  setInjury(impact.runs !== 0 ? impact.runs.toFixed(1) : "0");
                                  setInjuryFactors({
                                    off: impact.offFactor,
                                    def: impact.defFactor,
                                    type: impact.runs !== 0 ? "Auto" : "Mixto",
                                  });
'''
games_new = '''                                  setInjuryGamesOut(nextGO);
                                  const nextAuto = new Set(phaseBAutoApplied);
                                  nextAuto.delete(nm);
                                  setPhaseBAutoApplied(nextAuto);
                                  setPhaseBStatus("Override manual de juegos fuera aplicado");
                                  const impact = calcMLBInjuryImpact(injuryRoster, injuryMissing, nextGO);
                                  setInjury(impact.runs !== 0 ? impact.runs.toFixed(1) : "0");
                                  setInjuryFactors({
                                    off: impact.offFactor,
                                    def: impact.defFactor,
                                    type: impact.runs !== 0 ? "Override manual" : "Mixto",
                                  });
'''
ui = replace_once(ui, games_old, games_new, "games out manual override")
frontend.write_text(ui, encoding="utf-8")

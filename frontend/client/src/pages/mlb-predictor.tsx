import { useState, useCallback, useEffect, useRef } from "react";
import { predictMLB, predictF5, predictTotalRuns, predictF5Total, evaluateRunLine, evaluateMLBTotal, mlbGetEdge, mlbGetSignal, mlbGetBestPlay, regressPitcher, americanToProb, mlbPoissonTotal, mlbFindSafePlay, mlbGenerateAltLines, mlbRegressToMarket, mlbCalibrate, applyUmpireAdjustment, applyUmpireTotalAdjustment, type MLBUmpireImpact, type MLBTeam, type MLBPitcher, type MLBGameContext, type MLBBestPlay, type MLBPoissonResult, type MLBSafePlay, type AltLine, MLB_TEAMS, TEAM_PARKS, PARK_FACTORS } from "@/lib/mlb-model";
import { getAwayTravelDistance, travelPenalty } from "@/lib/travel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Brain, Star, AlertTriangle, RefreshCw, Zap, Save, Check } from "lucide-react";
import { PrintFab } from "@/components/print-fab";
import { MlbTesiCard } from "@/components/mlb-tesi-card";
import { MlbEreCard } from "@/components/mlb-ere-card";
import { MlbEarlyMarketsCard } from "@/components/mlb-early-markets-card";
import { useAppContext } from "@/lib/context";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import { DatePickerFL, todayFL } from "@/components/date-picker-fl";
import { MLBUmpireCard, MLBAdvancedCard, EliteBanner, SharpSignalsCard, sharpBadgeFor, MLBContextualCard, type SharpDirection } from "@/components/elite-factors";
import { americanImpliedProbability, createMlbScientificSnapshot, isoDateTimeOrUndefined, mapMlbLedgerMarket, noVigSideProbability, parseMlbMarketLine, type MlbSourceStatus } from "@/lib/mlb-scientific-snapshot";
import { resolveMlbPhaseBSelection, scaleMlbPhaseBRuns } from "@/lib/mlb-injury-phase-b";
import { buildMlbInjuryAuditSnapshot } from "@/lib/mlb-injury-audit";
import { buildMlbReviewQueue, classifyMlbDecisionReview, type MlbGameQueueView } from "@/lib/mlb-review-priority";

// ── MLB INJURY TYPES & CALC ──────────────────────────────────────────────────
type MLBInjuryFeedStatus = "VERIFIED" | "PARTIAL" | "SOURCE_UNAVAILABLE" | "ANOMALOUS";
interface MLBInjuryShadowSummary {
  total: number;
  applyCandidates: number;
  alreadyReflected: number;
  ignored: number;
  conflicts: number;
  pending: number;
  highConfidence: number;
  officialOnly: number;
  mode: "SHADOW";
}
interface MLBInjuryPhaseBPlan {
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
interface MLBInjuryFeedMeta {
  source: string;
  validationSource?: string;
  status: MLBInjuryFeedStatus;
  fetchedAt?: string;
  stale?: boolean;
  sourceErrors?: string[];
  officialValidationStatus?: "VERIFIED" | "PARTIAL";
  officialFetchedAt?: string;
  rejectedCount?: number;
  count: number;
  autoApplyAllowed: boolean;
  shadowMode?: boolean;
  shadowSummary?: MLBInjuryShadowSummary;
  phaseB?: MLBInjuryPhaseBPlan;
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
  name: string;
  position: string;
  status: string;
  isPitcher: boolean;
  gamesMissed?: number;  // Cuántos juegos del equipo se ha perdido
  gamesPlayed?: number;
  teamGP?: number;
  // Hitter
  ops?: number | null;
  avg?: number | null;
  obp?: number | null;
  slg?: number | null;     // Slugging — mide poder real
  iso?: number | null;     // Isolated power (SLG - AVG)
  homeRuns?: number;
  doubles?: number;
  triples?: number;
  stolenBases?: number;
  rbi?: number;
  atBats?: number;
  plateAppearances?: number;
  // Pitcher
  era?: number | null;
  whip?: number | null;
  k9?: number | null;
  inningsPitched?: number;
  ipPerStart?: number | null; // Diferencia ace (6.5+) vs opener (3.0)
  battersFaced?: number;
  strikeoutsK?: number;
  wins?: number;
  losses?: number;
  gamesStarted?: number;
  saves?: number;          // Closer real si saves ≥5
  holds?: number;          // Setup man si holds ≥10
  gamesFinished?: number;  // Confirma role de closer
  // De BALLDONTLIE
  returnDate?: string | null;
  shortComment?: string | null;
  source?: string;
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
  lineupSlot?: number;
}

// Factor de decaimiento según cuántos juegos lleva fuera:
// Si lleva muchos juegos fuera, las stats del equipo YA reflejan su ausencia → reducir impacto
function injuryDecayFactor(gamesMissed: number): { factor: number; note: string } {
  if (gamesMissed >= 15) return { factor: 0, note: `${gamesMissed}+ fuera → stats ya ajustadas (0%)` };
  if (gamesMissed >= 10) return { factor: 0.15, note: `${gamesMissed} fuera → season stats lo reflejan (15%)` };
  if (gamesMissed >= 5) return { factor: 0.4, note: `${gamesMissed} fuera → parcial (40%)` };
  if (gamesMissed >= 3) return { factor: 0.7, note: `${gamesMissed} fuera → reciente (70%)` };
  return { factor: 1.0, note: gamesMissed > 0 ? `${gamesMissed} fuera → impacto total` : "recién lesionado (100%)" };
}

// ── STAR POWER INDEX (0-10) ── Proxy de WAR usando stats disponibles
// Hitters: wOBA-equiv + ISO + posición premium + slot
// Pitchers: SIERA-like + IP/start + role leverage
function starPowerIndex(p: MLBInjury): { score: number; tier: "SUPERSTAR" | "STAR" | "STARTER" | "ROLE"; role: string } {
  if (p.isPitcher) {
    const era = p.era ?? 4.30;
    const ip = p.inningsPitched ?? 0;
    const gs = p.gamesStarted ?? 0;
    const k9 = p.k9 ?? 7.5;
    const sv = p.saves ?? 0;
    const hd = p.holds ?? 0;
    const gf = p.gamesFinished ?? 0;
    const ipPerStart = p.ipPerStart ?? 0;

    // Pitcher score base por calidad (ERA + K/9)
    let score = 5.0;
    if (era > 0) score += Math.max(-3, Math.min(3, (4.30 - era) * 1.0));    // ERA delta vs league avg
    score += Math.max(-1, Math.min(2, (k9 - 8.5) * 0.25));                  // K/9 bonus
    if (gs >= 10) score += Math.min(1.5, (ipPerStart - 5.0) * 0.6);         // Ace gets +1.5, opener gets -1

    // Determinar role real
    let role = "Relevista";
    if (gs >= 12) role = ipPerStart >= 6.2 ? "Ace (SP élite)" : ipPerStart >= 5.5 ? "Abridor regular" : "Abridor 5-back";
    else if (sv >= 5 && gf >= 10) role = "Closer";
    else if (hd >= 8) role = "Setup";
    else if (gs >= 3) role = "Swing/Spot starter";
    else if (ip >= 25) role = "Middle relief";
    else role = "Mop/Long relief";

    score = Math.max(0, Math.min(10, score));
    const tier = score >= 8 ? "SUPERSTAR" : score >= 6 ? "STAR" : score >= 4 ? "STARTER" : "ROLE";
    return { score: Math.round(score * 10) / 10, tier, role };
  }

  // HITTER
  const woba = ((p.obp ?? 0.310) * 1.7 + (p.slg ?? 0.380) * 1.0) / 2.7; // proxy de wOBA desde OBP/SLG
  const iso = p.iso ?? (p.slg && p.avg ? p.slg - p.avg : 0.140);
  const pa = p.plateAppearances ?? 0;
  const pos = (p.position || "").toUpperCase();
  const positionPremium = ["SS", "C", "CF"].includes(pos) ? 1.0 : ["2B", "3B"].includes(pos) ? 0.5 : 0;

  // Score base por wOBA (league avg ≈ .320)
  let score = 5.0;
  score += Math.max(-3, Math.min(4, (woba - 0.320) * 35));     // wOBA delta: .400 → +2.8, .280 → -1.4
  score += Math.max(0, Math.min(1.5, (iso - 0.150) * 8));      // ISO bonus: .240 ISO → +0.7
  score += positionPremium;                                       // SS/C/CF premium
  if (pa < 100) score -= 1.5;                                    // sample-size penalty
  else if (pa < 200) score -= 0.7;

  score = Math.max(0, Math.min(10, score));
  const tier = score >= 8 ? "SUPERSTAR" : score >= 6 ? "STAR" : score >= 4 ? "STARTER" : "ROLE";
  const role = tier === "SUPERSTAR" ? "Estrella" : tier === "STAR" ? "Bateador clave" : tier === "STARTER" ? "Titular" : "Rol/utility";
  return { score: Math.round(score * 10) / 10, tier, role };
}

// ── LINEUP SLOT WEIGHT ── PA proyectadas vs slot promedio (~640 PA cleanup vs ~500 #8)
function lineupSlotWeight(slot: number | undefined, pos: string): number {
  if (slot && slot >= 1 && slot <= 9) {
    if (slot >= 3 && slot <= 4) return 1.30;
    if (slot === 2 || slot === 5) return 1.15;
    if (slot === 1) return 1.10;
    if (slot === 6 || slot === 7) return 0.90;
    return 0.70; // 8-9
  }
  // Sin slot: inferir por posición (heurística)
  const p = pos.toUpperCase();
  if (["DH", "1B", "LF", "RF"].includes(p)) return 1.20; // power positions tipo cleanup
  if (["3B", "CF"].includes(p)) return 1.05;
  if (["SS", "2B"].includes(p)) return 0.95;
  if (p === "C") return 0.80;
  return 0.85;
}

// ── BULLPEN LEVERAGE ── Diferencia closer real (gmLI 1.8) vs middle relief (gmLI 0.9)
function bullpenLeverage(role: string): number {
  if (role === "Closer") return 1.0;
  if (role === "Setup") return 0.70;
  if (role === "Middle relief") return 0.40;
  if (role === "Swing/Spot starter") return 0.50;
  return 0.15; // Mop
}

// ── Detécta tipo + factores (preservado para retrocompatibilidad de UI antigua) ──
function detectMLBPlayerType(p: MLBInjury): { off: number; def: number; type: string; baseRuns: number } {
  const sp = starPowerIndex(p);
  const slotMul = p.isPitcher ? 1.0 : lineupSlotWeight(p.lineupSlot, p.position || "");

  if (p.isPitcher) {
    // baseRuns escalado por score (0-10) y por leverage del role
    const lev = bullpenLeverage(sp.role);
    // SP: baseRuns directo del score (—1.7 max para ace 9+)
    const isSP = sp.role.includes("Abridor") || sp.role === "Ace (SP élite)";
    let baseRuns: number;
    if (isSP) {
      baseRuns = -((sp.score - 4) / 6) * 1.8; // 10 → -1.8, 4 → 0
      baseRuns = Math.min(0, baseRuns);
    } else {
      // Bullpen: leverage cap. Closer élite -0.7, middle -0.2, mop -0.05
      baseRuns = -((sp.score - 4) / 6) * 0.9 * lev;
      baseRuns = Math.min(0, baseRuns);
    }
    return { off: 0, def: 1.0, type: `${sp.role} (★ ${sp.score})`, baseRuns: Math.round(baseRuns * 10) / 10 };
  }

  // HITTER: baseRuns escala con score × slotMul
  // SUPERSTAR slot 3-4 = -1.7, STAR slot 6 = -0.6, ROLE slot 8 = -0.15
  let baseRuns = -((sp.score - 4) / 6) * 1.5 * slotMul;
  baseRuns = Math.min(0, baseRuns);
  baseRuns = Math.round(baseRuns * 10) / 10;

  // off/def split por posición
  const pos = (p.position || "").toUpperCase();
  let off = 1.0, def = 0.2;
  if (["SS", "C", "CF"].includes(pos)) { off = 0.5; def = 0.6; }
  else if (["2B", "3B"].includes(pos)) { off = 0.7; def = 0.4; }

  return { off, def, type: `${sp.role} (★ ${sp.score})`, baseRuns };
}

// Calcula impacto acumulado de lesiones MLB
// gamesOutOverride permite forzar manualmente el # de juegos perdidos por jugador
function calcMLBInjuryImpact(
  roster: MLBInjury[],
  missing: Set<string>,
  gamesOutOverride: Record<string, number> = {},
): { runs: number; offFactor: number; defFactor: number; details: string[] } {
  let totalRuns = 0;
  let weightedOff = 0;
  let weightedDef = 0;
  let totalWeight = 0;
  const details: string[] = [];
  for (const p of roster) {
    if (!missing.has(p.name)) continue;
    const t = detectMLBPlayerType(p);
    // Aplicar decaimiento basado en juegos perdidos — evita doble contabilización
    const gm = gamesOutOverride[p.name] ?? p.gamesMissed ?? 0;
    const decay = injuryDecayFactor(gm);
    const adjustedRuns = t.baseRuns * decay.factor;
    totalRuns += adjustedRuns;
    const w = Math.abs(adjustedRuns);
    weightedOff += t.off * w;
    weightedDef += t.def * w;
    totalWeight += w;
    const statLabel = p.isPitcher
      ? `ERA ${(p.era ?? 0).toFixed(2)}`
      : `OPS ${(p.ops ?? 0).toFixed(3)}·${p.homeRuns ?? 0}HR`;
    details.push(`${p.name} (${p.position}) — ${t.type} · ${statLabel} · ${decay.note} → ${adjustedRuns.toFixed(1)} runs`);
  }
  const offFactor = totalWeight > 0 ? weightedOff / totalWeight : 1.0;
  const defFactor = totalWeight > 0 ? weightedDef / totalWeight : 0.5;
  return { runs: Math.max(-4, totalRuns), offFactor, defFactor, details };
}

// ── HELPERS (outside component to avoid remount) ─────────────────────────────
function signalColor(s: string) {
  if (s === "BET") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (s === "LEAN") return "bg-amber-500/20 text-amber-400 border-amber-500/30";
  return "bg-red-500/20 text-red-400 border-red-500/30";
}
function confidenceColor(c: number) {
  if (c >= 75) return "text-green-400";
  if (c >= 60) return "text-amber-400";
  return "text-orange-400";
}

// ── RESULT TYPES ─────────────────────────────────────────────────────────────
interface MLBResult {
  homeProb: number;
  awayProb: number;
  f5HomeProb: number;
  f5AwayProb: number;
  estimatedTotal: number;
  estimatedF5Total: number;
  runLine: ReturnType<typeof evaluateRunLine>;
  ouResult: ReturnType<typeof evaluateMLBTotal>;
  f5OuResult: ReturnType<typeof evaluateMLBTotal> | null;
  mlEdge: number;
  mlSignal: "BET" | "LEAN" | "PASS";
  f5Edge: number;
  f5Signal: "BET" | "LEAN" | "PASS";
  impliedProb: number;
  pickedSide?: "home" | "away";
  recommendedOdds?: number;
  f5PickedSide?: "home" | "away";
  f5RecommendedOdds?: number;
  homeTeamName: string;
  awayTeamName: string;
  ouLine: number;
  f5OuLine: number | null;
  bestPlay: MLBBestPlay | null;
  poisson: MLBPoissonResult | null;
  safePlay: MLBSafePlay | null;
  altLines: AltLine[];
  factorBreakdown?: {
    baseProb: number;
    finalProb: number;
    baseTotal: number;
    finalTotal: number;
    injuryHomeProbabilityDeltaPp?: number;
    injuryTotalRunsDelta?: number;
    injuryDataQuality?: "VERIFIED" | "DEGRADED";
    injuryHasAppliedAdjustment?: boolean;
    notes: string[];
    // Calibración vs mercado (3 números transparentes)
    modelHomeProb?: number;       // pura del modelo (post factores)
    marketHomeProb?: number;      // implicada por cuotas
    modelF5HomeProb?: number;
    marketF5HomeProb?: number;
  };
  // ⚭ PICK QUALITY SCORES — uno por cada mercado (ML, F5, Run Line, O/U)
  pickQualities?: {
    ml?: PickQualityResult;
    f5?: PickQualityResult;
    runLine?: PickQualityResult;
    ou?: PickQualityResult;
  };
  // Compatibility field used by the legacy single-market quality helper.
  pickQuality?: PickQualityResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// PICK QUALITY SCORE — SISTEMA PROFESIONAL DE DISCIPLINA (Ruta B)
// Disciplina por MERCADO: cada apuesta (ML, F5, Run Line, O/U) tiene su propio PQS
// con edge real calibrado, vetos duros y stake Kelly fraccional.
// ═══════════════════════════════════════════════════════════════════════════
interface PickQualityResult {
  market: "ML" | "F5" | "RUN_LINE" | "O/U";
  score: number;
  rating: "S+" | "S" | "A" | "B" | "C" | "D" | "F";
  recommendation: "BET_FUERTE" | "BET" | "LEAN" | "PASS";
  stakeUnits: number;
  edgeReal: number;
  factorsAlignment: number;
  marketGap: number;
  warnings: string[];
  confirms: string[];
  reasoning: string;
  pickedSideLabel: string;
  pickedSideOdds: number;
  pickedSideExtra?: string; // ej: "Over 8.5" o "+1.5"
}

function computePickQualityGeneric(input: {
  market: "ML" | "F5" | "RUN_LINE" | "O/U";
  modelProb: number;          // probabilidad pura del modelo (lado escogido)
  marketImpliedProb: number;  // probabilidad implicada por las cuotas
  oddsAmerican: number;       // cuota american del lado escogido
  pickedSideLabel: string;
  pickedSideExtra?: string;
  marketGap: number;          // diferencia modelo vs mercado en proporción (0-1)
  eliteFactorsActive: number; // factores élite activos en general
  rookieAlert: boolean;
  recentImplosion: boolean;
  statcastDataQuality: "OK" | "MISSING";
  statcastSignal: number;     // qué tan claro es el signal Statcast (0-1)
  injuryProbDelta: number;
  injuryDataQuality?: "VERIFIED" | "DEGRADED";
  sharpAgainst: boolean;
  sharpStrong: boolean;
}): PickQualityResult {
  const warnings: string[] = [];
  const confirms: string[] = [];

  const edgeReal = (input.modelProb - input.marketImpliedProb) * 100;
  const factorsAlignment = input.eliteFactorsActive;

  // ─── EVALUACIÓN DE WARNINGS ───
  if (input.rookieAlert) warnings.push("🚨 Bullpen game / SP rookie");
  if (input.recentImplosion) warnings.push("⚠️ Pitcher con implosion reciente");
  if (input.statcastDataQuality === "MISSING") warnings.push("⚠️ Sin datos Statcast pitch-by-pitch");
  if (input.marketGap >= 0.25) warnings.push(`🚨 Gap >25pp con mercado (${(input.marketGap*100).toFixed(0)}pp) — sobre-confianza`);
  else if (input.marketGap >= 0.15) warnings.push(`⚠️ Gap moderado con mercado (${(input.marketGap*100).toFixed(0)}pp)`);
  if (input.sharpAgainst) warnings.push(`🚨 Dinero sharp en CONTRA`);
  if (input.injuryDataQuality !== "VERIFIED") warnings.push("⚠️ Cobertura de lesiones no verificada — señal degradada");
  if (input.oddsAmerican > 200 || input.oddsAmerican < -300) warnings.push("⚠️ Cuotas extremas");

  // ─── CONFIRMS POSITIVOS ───
  if (factorsAlignment >= 8) confirms.push(`✅ ${factorsAlignment} factores élite alineados`);
  else if (factorsAlignment >= 5) confirms.push(`✅ ${factorsAlignment} factores élite activos`);
  if (input.statcastSignal >= 0.40) confirms.push(`✅ Statcast claro`);
  if (Math.abs(input.injuryProbDelta) >= 5) confirms.push(`✅ Lesiones impactan`);
  if (edgeReal >= 7) confirms.push(`✅ Edge real >7pp`);
  else if (edgeReal >= 4) confirms.push(`✅ Edge real >4pp`);

  // ─── SCORE 1-10 ───
  let score = 5;
  if (edgeReal >= 10) score += 2;
  else if (edgeReal >= 7) score += 1.5;
  else if (edgeReal >= 4) score += 1;
  else if (edgeReal >= 2) score += 0.5;
  else if (edgeReal < 0) score -= 2;

  if (factorsAlignment >= 8) score += 2;
  else if (factorsAlignment >= 6) score += 1.5;
  else if (factorsAlignment >= 4) score += 1;
  else if (factorsAlignment <= 2) score -= 1;

  if (input.statcastDataQuality === "OK" && input.statcastSignal >= 0.40) score += 1;
  else if (input.statcastDataQuality === "MISSING") score -= 0.5; // menor penalty para mercados de totales

  if (input.rookieAlert) score -= 1.5;
  if (input.recentImplosion) score -= 1;
  if (input.marketGap >= 0.25) score -= 2;
  else if (input.marketGap >= 0.15) score -= 0.5;
  if (input.sharpAgainst) score -= input.sharpStrong ? 3 : 2;

  if (input.oddsAmerican > 250 || input.oddsAmerican < -300) score -= 1;
  score = Math.max(1, Math.min(10, score));

  // ─── RATING ───
  let rating: PickQualityResult["rating"] = "F";
  if (score >= 9) rating = "S+";
  else if (score >= 8) rating = "S";
  else if (score >= 7) rating = "A";
  else if (score >= 6) rating = "B";
  else if (score >= 5) rating = "C";
  else if (score >= 4) rating = "D";

  // ─── VETOS DUROS ───
  let hardVetoToPass = false;
  let hardVetoReason = "";
  if (input.sharpAgainst && input.sharpStrong) {
    hardVetoToPass = true;
    hardVetoReason = "STEAM sharp en contra";
  }
  if (input.marketGap >= 0.30) {
    hardVetoToPass = true;
    hardVetoReason = `Gap ${(input.marketGap*100).toFixed(0)}pp — sobre-confianza extrema`;
  }
  if (edgeReal < 0) {
    hardVetoToPass = true;
    hardVetoReason = `Edge negativo (${edgeReal.toFixed(1)}pp)`;
  }
  if (input.rookieAlert && input.modelProb > 0.70 && input.market === "ML") {
    hardVetoToPass = true;
    hardVetoReason = `Bullpen game + alta confianza`;
  }

  // ─── RECOMENDACIÓN ───
  let recommendation: PickQualityResult["recommendation"] = "PASS";
  if (hardVetoToPass) {
    recommendation = "PASS";
    warnings.unshift(`🚫 VETO: ${hardVetoReason}`);
  } else if (score >= 8 && edgeReal >= 7 && factorsAlignment >= 6) recommendation = "BET_FUERTE";
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
  }

  let reasoning = `Edge ${edgeReal.toFixed(1)}pp, ${factorsAlignment} factores, gap ${(input.marketGap*100).toFixed(0)}pp`;
  if (recommendation === "PASS") reasoning += ". PASS protege banca.";

  return {
    market: input.market,
    score: Math.round(score * 10) / 10,
    rating, recommendation, stakeUnits,
    edgeReal: Math.round(edgeReal * 10) / 10,
    factorsAlignment,
    marketGap: Math.round(input.marketGap * 1000) / 10,
    warnings, confirms, reasoning,
    pickedSideLabel: input.pickedSideLabel,
    pickedSideOdds: input.oddsAmerican,
    pickedSideExtra: input.pickedSideExtra,
  };
}

// Mantener computePickQuality original (usa el genérico internamente para ML)
function computePickQuality(input: {
  homeProb: number;
  modelHomeProb: number;
  marketHomeProbCal: number | undefined;
  eliteFactorsActive: number;
  mlOddsHomeNum: number;
  mlOddsAwayNum: number;
  pickedSide: "home" | "away" | undefined;
  homeTeamName: string;
  awayTeamName: string;
  rookieAlert: boolean;
  sharpDir: any;
  recentImplosion: boolean;
  statcastDataQuality: "OK" | "MISSING";
  statcastRunsDelta: number;
  injuryProbDelta: number;
}): NonNullable<MLBResult["pickQuality"]> {
  const warnings: string[] = [];
  const confirms: string[] = [];

  // 1. EDGE REAL vs mercado (calibrado, no inflado)
  const sideProb = input.pickedSide === "away" ? (1 - input.homeProb) : input.homeProb;
  const sideOdds = input.pickedSide === "away" ? input.mlOddsAwayNum : input.mlOddsHomeNum;
  const impliedSide = sideOdds > 0 ? 100 / (sideOdds + 100) : (-sideOdds) / ((-sideOdds) + 100);
  const edgeReal = (sideProb - impliedSide) * 100; // pp

  // 2. ALINEACIÓN DE FACTORES ÉLITE — cuántos confirman el lado escogido
  // Conservador: usamos eliteFactorsActive como proxy (idealmente trackeariaímos signo de cada factor)
  const factorsAlignment = input.eliteFactorsActive;

  // 3. GAP MODELO vs MERCADO (después de calibración; >25pp es bandera roja)
  const marketGap = input.marketHomeProbCal !== undefined ? Math.abs(input.modelHomeProb - input.marketHomeProbCal) : 0;

  // ─── EVALUACIÓN DE WARNINGS ───
  if (input.rookieAlert) warnings.push("🚨 Bullpen game / SP rookie");
  if (input.recentImplosion) warnings.push("⚠️ Pitcher con implosion reciente");
  if (input.statcastDataQuality === "MISSING") warnings.push("⚠️ Sin datos Statcast pitch-by-pitch");
  if (marketGap >= 0.25) warnings.push(`🚨 Gap >25pp con mercado (${(marketGap*100).toFixed(0)}pp) — sobre-confianza`);
  else if (marketGap >= 0.15) warnings.push(`⚠️ Gap moderado con mercado (${(marketGap*100).toFixed(0)}pp)`);
  // Sharp en contra del lado escogido
  if (input.sharpDir?.mlSide && input.sharpDir.strength !== "none") {
    const sharpAgainst = (input.sharpDir.mlSide === "home" && input.pickedSide === "away") ||
                         (input.sharpDir.mlSide === "away" && input.pickedSide === "home");
    if (sharpAgainst) warnings.push(`🚨 Dinero sharp en CONTRA (→ ${input.sharpDir.mlSide.toUpperCase()})`);
    else confirms.push(`✅ Dinero sharp con nosotros (→ ${input.sharpDir.mlSide.toUpperCase()})`);
  }
  if (sideOdds > 200 || sideOdds < -300) warnings.push("⚠️ Cuotas extremas (no recomendado)");

  // ─── CONFIRMS POSITIVOS ───
  if (factorsAlignment >= 8) confirms.push(`✅ ${factorsAlignment} factores élite alineados (excelente)`);
  else if (factorsAlignment >= 5) confirms.push(`✅ ${factorsAlignment} factores élite activos`);
  if (input.statcastRunsDelta >= 0.40) confirms.push(`✅ Statcast claro (${input.statcastRunsDelta.toFixed(2)} runs delta)`);
  if (Math.abs(input.injuryProbDelta) >= 5) confirms.push(`✅ Lesiones impactan (${input.injuryProbDelta > 0 ? "+" : ""}${input.injuryProbDelta.toFixed(1)}pp)`);
  if (edgeReal >= 7) confirms.push(`✅ Edge real >7pp`);
  else if (edgeReal >= 4) confirms.push(`✅ Edge real >4pp`);

  // ─── CALCULO DEL SCORE 1-10 ───
  let score = 5; // base
  // Edge real (clave): cada 2pp suma 1
  if (edgeReal >= 10) score += 2;
  else if (edgeReal >= 7) score += 1.5;
  else if (edgeReal >= 4) score += 1;
  else if (edgeReal >= 2) score += 0.5;
  else if (edgeReal < 0) score -= 2; // edge negativo = nunca apostar
  // Factores alineados
  if (factorsAlignment >= 8) score += 2;
  else if (factorsAlignment >= 6) score += 1.5;
  else if (factorsAlignment >= 4) score += 1;
  else if (factorsAlignment <= 2) score -= 1;
  // Statcast
  if (input.statcastDataQuality === "OK" && input.statcastRunsDelta >= 0.40) score += 1;
  else if (input.statcastDataQuality === "MISSING") score -= 1;
  // Penalties por warnings
  if (input.rookieAlert) score -= 1.5;
  if (input.recentImplosion) score -= 1;
  if (marketGap >= 0.25) score -= 2; // bandera máxima
  else if (marketGap >= 0.15) score -= 0.5;
  // Sharp en contra: penalty más fuerte cuando es strong
  if (input.sharpDir?.mlSide && input.sharpDir.strength !== "none") {
    const sharpAgainst = (input.sharpDir.mlSide === "home" && input.pickedSide === "away") ||
                         (input.sharpDir.mlSide === "away" && input.pickedSide === "home");
    if (sharpAgainst) {
      score -= input.sharpDir.strength === "strong" ? 3 : 2;  // antes 1.5; ahora 2-3
    } else {
      score += 0.5;
    }
  }
  // Cuotas extremas
  if (sideOdds > 250 || sideOdds < -300) score -= 1;

  score = Math.max(1, Math.min(10, score));

  // ─── RATING TIER ───
  let rating: NonNullable<MLBResult["pickQuality"]>["rating"] = "F";
  if (score >= 9) rating = "S+";
  else if (score >= 8) rating = "S";
  else if (score >= 7) rating = "A";
  else if (score >= 6) rating = "B";
  else if (score >= 5) rating = "C";
  else if (score >= 4) rating = "D";

  // ─── VETOS DUROS (independientes del score) ───
  // Banderas que automaticamente bajan a PASS, sin importar el score
  let hardVetoToPass = false;
  let hardVetoReason = "";

  // VETO 1: Sharp money en contra Y strength fuerte = PASS forzado
  if (input.sharpDir?.mlSide && input.sharpDir.strength === "strong") {
    const sharpAgainst = (input.sharpDir.mlSide === "home" && input.pickedSide === "away") ||
                         (input.sharpDir.mlSide === "away" && input.pickedSide === "home");
    if (sharpAgainst) {
      hardVetoToPass = true;
      hardVetoReason = "STEAM sharp en contra del lado escogido";
    }
  }

  // VETO 2: Gap >25pp con mercado = PASS (sobre-confianza extrema)
  if (marketGap >= 0.30) {
    hardVetoToPass = true;
    hardVetoReason = `Gap ${(marketGap*100).toFixed(0)}pp con mercado — sobre-confianza extrema`;
  }

  // VETO 3: Edge real negativo = PASS (perdiendo dinero esperado)
  if (edgeReal < 0) {
    hardVetoToPass = true;
    hardVetoReason = `Edge negativo (${edgeReal.toFixed(1)}pp) — cuotas mejor que probabilidad`;
  }

  // VETO 4: Bullpen game con prob >70% = riesgo demasiado alto
  if (input.rookieAlert && input.homeProb > 0.70) {
    hardVetoToPass = true;
    hardVetoReason = `Bullpen game + alta confianza = patrón histórico de pérdida`;
  }

  // ─── RECOMENDACIÓN ───
  let recommendation: NonNullable<MLBResult["pickQuality"]>["recommendation"] = "PASS";
  if (hardVetoToPass) {
    recommendation = "PASS";
    warnings.unshift(`🚫 VETO: ${hardVetoReason}`);
  } else if (score >= 8 && edgeReal >= 7 && factorsAlignment >= 6) recommendation = "BET_FUERTE";
  else if (score >= 7 && edgeReal >= 5 && factorsAlignment >= 5) recommendation = "BET";
  else if (score >= 6 && edgeReal >= 3) recommendation = "LEAN";
  else recommendation = "PASS";

  // ─── STAKE KELLY FRACCIONAL (1/4 Kelly) ───
  let stakeUnits = 0;
  if (recommendation !== "PASS" && edgeReal > 0) {
    const decimalOdds = sideOdds > 0 ? (sideOdds / 100) + 1 : (100 / (-sideOdds)) + 1;
    const b = decimalOdds - 1;
    const p = sideProb;
    const fullKelly = (b * p - (1 - p)) / b;
    const fractionalKelly = Math.max(0, fullKelly * 0.25); // 1/4 Kelly conservador
    // Convertir a unidades 0-5
    stakeUnits = Math.round(Math.min(5, fractionalKelly * 100) * 2) / 2; // múltiplos de 0.5
    // Limitar por recommendation tier
    if (recommendation === "LEAN") stakeUnits = Math.min(stakeUnits, 1);
    else if (recommendation === "BET") stakeUnits = Math.min(stakeUnits, 3);
    else if (recommendation === "BET_FUERTE") stakeUnits = Math.min(stakeUnits, 5);
  }

  // ─── REASONING ───
  let reasoning = `Edge ${edgeReal.toFixed(1)}pp, ${factorsAlignment} factores activos`;
  if (warnings.length > 0) reasoning += `. ${warnings.length} warning${warnings.length > 1 ? "s" : ""}`;
  if (recommendation === "PASS") reasoning += ". Élite tipster: PASS protege banca.";
  else if (recommendation === "BET_FUERTE") reasoning += ". Setup de alta calidad.";

  return {
    market: "ML" as const,
    score: Math.round(score * 10) / 10,
    rating,
    recommendation,
    stakeUnits,
    edgeReal: Math.round(edgeReal * 10) / 10,
    factorsAlignment,
    marketGap: Math.round(marketGap * 1000) / 10,
    warnings,
    confirms,
    reasoning,
    pickedSideLabel: input.pickedSide === "away" ? input.awayTeamName : input.homeTeamName,
    pickedSideOdds: sideOdds,
  };
}

export default function MLBPredictor() {
  const { state, dispatch } = useAppContext();
  const { toast } = useToast();

  // Save MLB pick + one canonical scientific snapshot.
  const savePick = (market: string, pick: string, odds: number, modelProbFallback: number) => {
    if (!result) {
      toast({ title: "Genera la predicción antes de guardar", variant: "destructive" });
      return;
    }

    const normalizedMarket = market.trim().toLowerCase();
    const selectedHome = pick.toLowerCase().includes((homeTeam || "Local").toLowerCase());
    const pq = normalizedMarket === "ml" ? result.pickQualities?.ml
      : normalizedMarket === "f5" ? result.pickQualities?.f5
        : normalizedMarket.includes("run line") ? result.pickQualities?.runLine
          : normalizedMarket === "o/u" ? result.pickQualities?.ou
            : undefined;

    let resolvedModelProb = modelProbFallback;
    let oppositeOdds: number | undefined;
    if (normalizedMarket === "ml") {
      resolvedModelProb = (selectedHome ? result.homeProb : result.awayProb) * 100;
      oppositeOdds = selectedHome ? (parseInt(mlOddsAway) || undefined) : (parseInt(mlOdds) || undefined);
    } else if (normalizedMarket === "f5") {
      resolvedModelProb = (selectedHome ? result.f5HomeProb : result.f5AwayProb) * 100;
      oppositeOdds = selectedHome ? (parseInt(f5MlAway) || undefined) : (parseInt(f5MlHome) || undefined);
    } else if (normalizedMarket.includes("run line")) {
      resolvedModelProb = ((result.runLine as any).coverProb ?? (result.runLine.coversRL ? 0.56 : 0.44)) * 100;
      oppositeOdds = result.runLine.pickedSide === "home" ? (parseInt(rlOddsAway) || undefined) : (parseInt(rlOdds) || undefined);
    } else if (normalizedMarket === "o/u") {
      resolvedModelProb = ((result.ouResult as any).hitProb ?? 0.55) * 100;
      oppositeOdds = result.ouResult.side === "OVER" ? (parseInt(underOdds) || undefined) : (parseInt(overOdds) || undefined);
    } else if (normalizedMarket.includes("f5 o/u") && result.f5OuResult) {
      resolvedModelProb = ((result.f5OuResult as any).hitProb ?? 0.55) * 100;
    }

    resolvedModelProb = Math.max(0.1, Math.min(99.9, resolvedModelProb));
    const duplicatePick = state.mlbPicks.some((existing) =>
      existing.date === selectedDate
      && existing.market.trim().toLowerCase() === normalizedMarket
      && existing.pick.trim().toLowerCase() === pick.trim().toLowerCase()
      && existing.odds === odds
      && Math.abs(existing.modelProb - resolvedModelProb) < 0.01
    );
    if (duplicatePick) {
      toast({
        title: "Este pick MLB ya está guardado",
        description: "No se creó otra entrada en el historial ni en el ledger.",
      });
      return;
    }
    const implied = americanImpliedProbability(odds);
    const noVig = noVigSideProbability(odds, oppositeOdds);
    const edgePp = implied == null ? undefined : resolvedModelProb - implied * 100;
    const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
    const fallbackKelly = Math.max(0, (b * (resolvedModelProb / 100) - (1 - resolvedModelProb / 100)) / b) * 0.25 * 100;
    const operationalStake = Math.min(1, Math.max(0, pq?.stakeUnits ?? fallbackKelly));
    const capturedAt = new Date().toISOString();
    const selectedGame = mlbGames.find((game) => String(game.gameId) === selectedGameId) as any;
    const commenceTime = isoDateTimeOrUndefined(selectedGame?.commenceTime || selectedGame?.gameTime || selectedGame?.gameDate);
    if (commenceTime && Date.parse(capturedAt) > Date.parse(commenceTime)) {
      toast({
        title: "El juego ya comenzó",
        description: "No se puede guardar una predicción científica pregame después del inicio oficial.",
        variant: "destructive",
      });
      return;
    }
    const injuryStatus = (status: MLBInjuryFeedStatus): MlbSourceStatus => status === "VERIFIED" ? "VERIFIED"
      : status === "PARTIAL" ? "PARTIAL"
        : status === "SOURCE_UNAVAILABLE" ? "MISSING" : "UNKNOWN";
    const completeFactorFeeds = [lineupMatchup, archetypeMatchup, bullpenStatus, parkPitcher, pitcherVsTeam, windPark, catcherFraming, rookiePitcher, pitcherForm, teamFatigue, pitcherRecent, statcastMatchup, statcastQuality, sos, discSpeed]
      .filter(Boolean).length;
    const stage = Boolean(
      gamePkForTesi
      && selectedGameId
      && commenceTime
      && completeFactorFeeds >= 10
      && homeInjuryFeed.status === "VERIFIED"
      && awayInjuryFeed.status === "VERIFIED"
    ) ? "FINAL" as const : "PROVISIONAL" as const;
    const warnings = [
      ...(pq?.warnings || []),
      ...(stage === "PROVISIONAL" ? ["Snapshot provisional: faltan identificador oficial del juego o verificación completa de lesiones."] : []),
    ];

    const homeAuditResolution = resolveMlbPhaseBSelection(homeInjuryRoster, homeInjuryFeed, bullpenStatus?.home);
    const awayAuditResolution = resolveMlbPhaseBSelection(awayInjuryRoster, awayInjuryFeed, bullpenStatus?.away);
    const homeAuditRawImpact = calcMLBInjuryImpact(homeInjuryRoster, homePhaseBAutoApplied, homeInjuryGamesOut);
    const awayAuditRawImpact = calcMLBInjuryImpact(awayInjuryRoster, awayPhaseBAutoApplied, awayInjuryGamesOut);
    const homeAuditScaledRuns = scaleMlbPhaseBRuns(
      homeAuditRawImpact.runs,
      homeInjuryFeed.phaseB?.scale ?? 0,
      homeInjuryFeed.phaseB?.maxAbsRuns ?? 0,
    );
    const awayAuditScaledRuns = scaleMlbPhaseBRuns(
      awayAuditRawImpact.runs,
      awayInjuryFeed.phaseB?.scale ?? 0,
      awayInjuryFeed.phaseB?.maxAbsRuns ?? 0,
    );
    const homeSelectedNames = Array.from(homeInjuryMissing);
    const awaySelectedNames = Array.from(awayInjuryMissing);
    const homeAutoNames = Array.from(homePhaseBAutoApplied);
    const awayAutoNames = Array.from(awayPhaseBAutoApplied);
    const setMismatch = (left: string[], right: string[]) => {
      const rightSet = new Set(right);
      return left.length !== right.length || left.some((name) => !rightSet.has(name));
    };
    const homeManualOverride = homeInjuryFactors.type === "Manual"
      || homePhaseBStatus.includes("Override manual")
      || setMismatch(homeSelectedNames, homeAutoNames);
    const awayManualOverride = awayInjuryFactors.type === "Manual"
      || awayPhaseBStatus.includes("Override manual")
      || setMismatch(awaySelectedNames, awayAutoNames);
    const injuryAudit = buildMlbInjuryAuditSnapshot({
      capturedAt,
      home: {
        side: "HOME",
        teamName: homeTeam || "Local",
        teamId: homeTeamMlbId,
        feed: homeInjuryFeed,
        roster: homeInjuryRoster,
        selectedPlayerNames: homeInjuryMissing,
        autoAppliedPlayerNames: homePhaseBAutoApplied,
        rawAutomaticRuns: homeAuditRawImpact.runs,
        scaledAutomaticRuns: homeAuditScaledRuns,
        finalRuns: parseFloat(homeInjury) || 0,
        manualOverride: homeManualOverride,
        factors: homeInjuryFactors,
        bullpenSide: bullpenStatus?.home,
        blockedReason: homeAuditResolution.blockedReason,
        statusText: homePhaseBStatus,
      },
      away: {
        side: "AWAY",
        teamName: awayTeam || "Visitante",
        teamId: awayTeamMlbId,
        feed: awayInjuryFeed,
        roster: awayInjuryRoster,
        selectedPlayerNames: awayInjuryMissing,
        autoAppliedPlayerNames: awayPhaseBAutoApplied,
        rawAutomaticRuns: awayAuditRawImpact.runs,
        scaledAutomaticRuns: awayAuditScaledRuns,
        finalRuns: parseFloat(awayInjury) || 0,
        manualOverride: awayManualOverride,
        factors: awayInjuryFactors,
        bullpenSide: bullpenStatus?.away,
        blockedReason: awayAuditResolution.blockedReason,
        statusText: awayPhaseBStatus,
      },
    });

    const scientificSnapshot = createMlbScientificSnapshot({
      model: {
        name: "CourtEdge MLB",
        version: "predictor-full-snapshot-v2",
      },
      game: {
        ...(gamePkForTesi ? { gamePk: gamePkForTesi } : {}),
        gameDate: selectedDate,
        ...(commenceTime ? { commenceTime } : {}),
        homeTeam: homeTeam || "Local",
        awayTeam: awayTeam || "Visitante",
        ...(selectedGame?.venue ? { venue: String(selectedGame.venue) } : {}),
      },
      market: {
        type: mapMlbLedgerMarket(market),
        selection: pick,
        ...(parseMlbMarketLine(pick) != null ? { line: parseMlbMarketLine(pick) } : {}),
        oddsAmerican: Math.round(odds),
        book: normalizedMarket === "f5" && f5OddsSource === "consenso" ? "Consensus FD/BetMGM/DK" : "Hard Rock",
        capturedAt,
      },
      probabilities: {
        model: resolvedModelProb / 100,
        ...(implied != null ? { marketImplied: implied } : {}),
        ...(noVig != null ? { noVig } : {}),
        ...(edgePp != null ? { edgePp } : {}),
      },
      decision: {
        signal: pq?.recommendation || (normalizedMarket === "ml" ? result.mlSignal
          : normalizedMarket === "f5" ? result.f5Signal
            : normalizedMarket.includes("run line") ? result.runLine.signal
              : normalizedMarket.includes("f5 o/u") ? result.f5OuResult?.signal || "INFO"
                : result.ouResult.signal),
        confidenceLabel: pq?.rating || "MODEL",
        confidencePct: resolvedModelProb,
        stakeUnits: Math.round(operationalStake * 100) / 100,
        rationale: pq?.reasoning || result.bestPlay?.reason || "Mercado seleccionado por el usuario después del cálculo completo.",
      },
      analysis: {
        stage,
        warnings,
        injuryAudit,
        factors: (result.factorBreakdown?.notes || []).slice(0, 100).map((note) => ({
          name: note.slice(0, 120),
          direction: "NEUTRAL" as const,
          confidence: "PARTIAL" as const,
          source: "CourtEdge MLB predictor",
          note: note.slice(0, 500),
        })),
        sources: [
          {
            name: "MLB Stats API game feed",
            status: gamePkForTesi ? "VERIFIED" : "MISSING",
            fetchedAt: capturedAt,
            metadata: { selectedGameId, gamePk: gamePkForTesi },
          },
          {
            name: "BALLDONTLIE injuries home",
            status: injuryStatus(homeInjuryFeed.status),
            fetchedAt: isoDateTimeOrUndefined(homeInjuryFeed.fetchedAt) || capturedAt,
            sample: homeInjuryFeed.count,
            metadata: { autoApplyAllowed: homeInjuryFeed.autoApplyAllowed, stale: homeInjuryFeed.stale || false },
          },
          {
            name: "BALLDONTLIE injuries away",
            status: injuryStatus(awayInjuryFeed.status),
            fetchedAt: isoDateTimeOrUndefined(awayInjuryFeed.fetchedAt) || capturedAt,
            sample: awayInjuryFeed.count,
            metadata: { autoApplyAllowed: awayInjuryFeed.autoApplyAllowed, stale: awayInjuryFeed.stale || false },
          },
          {
            name: "CourtEdge MLB factor feeds",
            status: completeFactorFeeds >= 10 ? "VERIFIED" : completeFactorFeeds >= 5 ? "PARTIAL" : "MISSING",
            fetchedAt: capturedAt,
            sample: completeFactorFeeds,
          },
          {
            name: "Sportsbook price",
            status: "MANUAL",
            fetchedAt: capturedAt,
            metadata: { book: normalizedMarket === "f5" && f5OddsSource === "consenso" ? "Consensus FD/BetMGM/DK" : "Hard Rock" },
          },
        ],
        layers: {
          factorBreakdown: result.factorBreakdown,
          injuryEffect: {
            schemaVersion: "mlb-injury-effect.v1",
            source: "COUNTERFACTUAL_RECALCULATION_V1",
            scope: "HOME_ML_AND_GAME_TOTAL_COUNTERFACTUAL",
            homeProbabilityDeltaPp: result.factorBreakdown?.injuryHomeProbabilityDeltaPp ?? 0,
            totalRunsDelta: result.factorBreakdown?.injuryTotalRunsDelta ?? 0,
            dataQuality: result.factorBreakdown?.injuryDataQuality ?? "DEGRADED",
            hasAppliedAdjustment: result.factorBreakdown?.injuryHasAppliedAdjustment ?? false,
          },
          pickQualities: result.pickQualities,
          bestPlay: result.bestPlay,
          safePlay: result.safePlay,
          poisson: result.poisson,
        },
        rawInputs: {
          selectedDate,
          selectedGameId,
          gamePk: gamePkForTesi,
          teams: {
            home: { name: homeTeam, mlbId: homeTeamMlbId, ops: homeOps, rpg: homeRpg, obp: homeObp, avg: homeAvg, wOBA: homeWOBA, iso: homeISO, babip: homeBABIP, opsVsL: homeOpsVsL, opsVsR: homeOpsVsR },
            away: { name: awayTeam, mlbId: awayTeamMlbId, ops: awayOps, rpg: awayRpg, obp: awayObp, avg: awayAvg, wOBA: awayWOBA, iso: awayISO, babip: awayBABIP, opsVsL: awayOpsVsL, opsVsR: awayOpsVsR },
          },
          pitchers: {
            home: { name: homePitcherName, id: homePitcherIdTesi, era: homeEra, whip: homeWhip, fip: homeFip, k9: homeK9, bb9: homeBb9, rest: homeRest, hand: homeHand, recentEra: homeRecentEra, inningsPitched: homeIP, gamesStarted: homePitcherGS, kPct: homeKPct, bbPct: homeBbPct, siera: homeSiera },
            away: { name: awayPitcherName, id: awayPitcherIdTesi, era: awayEra, whip: awayWhip, fip: awayFip, k9: awayK9, bb9: awayBb9, rest: awayRest, hand: awayHand, recentEra: awayRecentEra, inningsPitched: awayIP, gamesStarted: awayPitcherGS, kPct: awayKPct, bbPct: awayBbPct, siera: awaySiera },
          },
          bullpens: {
            home: { era: homeBpEra, whip: homeBpWhip, tired: homeBpTired, closerAvailable: homeCloser, era14d: homeBpEra14d, ip48h: homeBpIp48h },
            away: { era: awayBpEra, whip: awayBpWhip, tired: awayBpTired, closerAvailable: awayCloser, era14d: awayBpEra14d, ip48h: awayBpIp48h },
          },
          injuries: {
            home: { adjustment: homeInjury, factors: homeInjuryFactors, feed: homeInjuryFeed, roster: homeInjuryRoster, missing: Array.from(homeInjuryMissing), gamesOut: homeInjuryGamesOut },
            away: { adjustment: awayInjury, factors: awayInjuryFactors, feed: awayInjuryFeed, roster: awayInjuryRoster, missing: Array.from(awayInjuryMissing), gamesOut: awayInjuryGamesOut },
          },
          lines: { mlOdds, mlOddsAway, runLine, rlOdds, rlOddsAway, ouLine, overOdds, underOdds, f5MlHome, f5MlAway, f5OddsSource, f5OuLine },
          context: { parkFactor, parkName, tempF, windFavorable, isNight, sharpDir, sharpGameKey, mlbCtxAdj, umpireData, advancedData },
          sourcePayloads: { lineupMatchup, archetypeMatchup, bullpenStatus, parkPitcher, pitcherVsTeam, windPark, catcherFraming, rookiePitcher, pitcherForm, teamFatigue, pitcherRecent, statcastMatchup, statcastQuality, sos, discSpeed },
        },
        rawOutput: result,
      },
    });

    dispatch({
      type: "ADD_MLB_PICK",
      payload: {
        date: selectedDate,
        sport: "MLB",
        team: homeTeam || "Local",
        opponent: awayTeam || "Visitante",
        market,
        pick,
        odds,
        modelProb: Math.round(resolvedModelProb * 100) / 100,
        stake: Math.round(operationalStake * 100) / 100,
        result: "P",
        scientificSnapshot,
      },
    });
    toast({
      title: "Pick MLB guardado en historial",
      description: stage === "FINAL" ? "Snapshot científico FINAL enviado al ledger" : "Snapshot PROVISIONAL enviado al ledger",
    });
  };

  // Auto-fill
  const [selectedGameId, setSelectedGameId] = useState("");
  const [autoStatus, setAutoStatus] = useState<"idle"|"loading"|"success"|"error">("idle");
  const [selectedDate, setSelectedDate] = useState<string>(todayFL()); // YYYY-MM-DD Florida
  const [mlbQueueView, setMlbQueueView] = useState<MlbGameQueueView>("priority");
  const [sharpGameKey, setSharpGameKey] = useState<string | null>(null);
  const [umpireData, setUmpireData] = useState<MLBUmpireImpact | null>(null);
  const [advancedData, setAdvancedData] = useState<{ totalAdjustment: number; notes: string[] } | null>(null);
  const [sharpDir, setSharpDir] = useState<SharpDirection | null>(null);
  const [mlbCtxAdj, setMlbCtxAdj] = useState<{ homeProbAdjPp: number; totalAdj: number }>({ homeProbAdjPp: 0, totalAdj: 0 });
  const [contextTri, setContextTri] = useState<{ home: string | null; away: string | null }>({ home: null, away: null });

  const { data: mlbData, isLoading: mlbLoading, refetch: refetchMLB, error: mlbError } = useQuery<{
    success: boolean;
    games: Array<{
      gameId: number; gameTime: string;
      homeTeam: { id: number; name: string };
      awayTeam: { id: number; name: string };
      homeStats: any; awayStats: any;
      homePitcher: any; awayPitcher: any;
      venue: string;
      gameDate?: string;
    }>;
  }>({
    queryKey: ["/api/mlb/all", selectedDate],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/mlb/all?date=${encodeURIComponent(selectedDate)}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    enabled: false,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  const mlbGames = mlbData?.games ?? [];

  // ── HOME TEAM STATE ────────────────────────────────────────────────────────
  const [homeTeam, setHomeTeam] = useState("");
  const [homeTeamMlbId, setHomeTeamMlbId] = useState<number | undefined>(undefined);
  const [awayTeamMlbId, setAwayTeamMlbId] = useState<number | undefined>(undefined);
  // TESI extras: gamePk + pitcher IDs/hands para pasar a tarjeta TESI v2
  const [gamePkForTesi, setGamePkForTesi] = useState<number | undefined>(undefined);
  const [homePitcherIdTesi, setHomePitcherIdTesi] = useState<number | undefined>(undefined);
  const [awayPitcherIdTesi, setAwayPitcherIdTesi] = useState<number | undefined>(undefined);
  const [homePitcherHandTesi, setHomePitcherHandTesi] = useState<"R" | "L" | undefined>(undefined);
  const [awayPitcherHandTesi, setAwayPitcherHandTesi] = useState<"R" | "L" | undefined>(undefined);

  // Home pitcher
  const [homePitcherName, setHomePitcherName] = useState("");
  const [homeEra, setHomeEra] = useState("3.80");
  const [homeWhip, setHomeWhip] = useState("1.20");
  const [homeFip, setHomeFip] = useState("3.70");
  const [homeK9, setHomeK9] = useState("9.0");
  const [homeBb9, setHomeBb9] = useState("3.0");
  const [homeRest, setHomeRest] = useState("5");
  const [homeHand, setHomeHand] = useState("R");
  const [homeRecord, setHomeRecord] = useState("8-5");
  const [homeRecentEra, setHomeRecentEra] = useState("")
  const [homeIP, setHomeIP] = useState("");
  // FIX: stats reales del SP local para FIP exacto (antes estimadas via k9/bb9)
  const [homeHR, setHomeHR] = useState<number | undefined>(undefined);
  const [homeWalks, setHomeWalks] = useState<number | undefined>(undefined);
  const [homeStrikeouts, setHomeStrikeouts] = useState<number | undefined>(undefined);

  // Home offense
  const [homeOps, setHomeOps] = useState("0.730");
  const [homeRpg, setHomeRpg] = useState("4.5");
  const [homeObp, setHomeObp] = useState("0.320");
  const [homeAvg, setHomeAvg] = useState("0.255");
  // Lesiones MLB: ajuste de runs por lesión + auto-tipo (Slugger/Contact/Defensor)
  const [homeInjury, setHomeInjury] = useState("0"); // ajuste de runs (-2 a +2)
  const [homeInjuryFactors, setHomeInjuryFactors] = useState<{off: number; def: number; type: string}>({off: 1.0, def: 0.5, type: "Mixto"});
  const [awayInjury, setAwayInjury] = useState("0");
  const [awayInjuryFactors, setAwayInjuryFactors] = useState<{off: number; def: number; type: string}>({off: 1.0, def: 0.5, type: "Mixto"});

  // Rosters de lesionados (auto-rellenados desde /api/mlb/all)
  const [homeInjuryRoster, setHomeInjuryRoster] = useState<MLBInjury[]>([]);
  const [awayInjuryRoster, setAwayInjuryRoster] = useState<MLBInjury[]>([]);
  const [homeInjuryFeed, setHomeInjuryFeed] = useState<MLBInjuryFeedMeta>(EMPTY_MLB_INJURY_FEED);
  const [awayInjuryFeed, setAwayInjuryFeed] = useState<MLBInjuryFeedMeta>(EMPTY_MLB_INJURY_FEED);
  const [homeInjuryMissing, setHomeInjuryMissing] = useState<Set<string>>(new Set());
  const [awayInjuryMissing, setAwayInjuryMissing] = useState<Set<string>>(new Set());
  const [homePhaseBAutoApplied, setHomePhaseBAutoApplied] = useState<Set<string>>(new Set());
  const [awayPhaseBAutoApplied, setAwayPhaseBAutoApplied] = useState<Set<string>>(new Set());
  const [homePhaseBStatus, setHomePhaseBStatus] = useState("");
  const [awayPhaseBStatus, setAwayPhaseBStatus] = useState("");
  // Override de juegos perdidos por jugador (si el usuario lo ajusta manualmente)
  const [homeInjuryGamesOut, setHomeInjuryGamesOut] = useState<Record<string, number>>({});
  const [awayInjuryGamesOut, setAwayInjuryGamesOut] = useState<Record<string, number>>({});

  // Lineup matchup hombre-por-hombre (lineup vs pitcher rival)
  const [lineupMatchup, setLineupMatchup] = useState<any | null>(null);

  // Pitcher Archetype Matchup — cómo le pega CADA equipo a CADA tipo de pitcher
  const [archetypeMatchup, setArchetypeMatchup] = useState<any | null>(null);

  // Bullpen Availability — closer disponible? top 3 cansados? predicción de cerrador HOY
  const [bullpenStatus, setBullpenStatus] = useState<any | null>(null);

  // Park-Pitcher Splits — cómo le va a este pitcher en ESTE estadio específico
  const [parkPitcher, setParkPitcher] = useState<any | null>(null);
  const [statcastQuality, setStatcastQuality] = useState<any | null>(null);
  const [sos, setSos] = useState<any | null>(null);
  const [discSpeed, setDiscSpeed] = useState<any | null>(null);

  // Pitcher vs Team — últimos 5 starts contra el rival
  const [pitcherVsTeam, setPitcherVsTeam] = useState<any | null>(null);

  // Wind-Park combinado — viento + estadio + temperatura
  const [windPark, setWindPark] = useState<any | null>(null);

  // Catcher Framing — cuánto valor genera el catcher robando strikes
  const [catcherFraming, setCatcherFraming] = useState<any | null>(null);

  // Rookie Pitcher Penalty — detecta SP con poca experiencia / bullpen games
  const [rookiePitcher, setRookiePitcher] = useState<any | null>(null);

  // Pitcher Form (Hueco #1+#2) — días descanso + splits home/road
  const [pitcherForm, setPitcherForm] = useState<any | null>(null);

  // Team Fatigue (Hueco #3) — day-after-night, travel, stretch
  const [teamFatigue, setTeamFatigue] = useState<any | null>(null);

  // Pitcher Recent (post-mortem fix) — forma reciente, implosion, early-exit
  const [pitcherRecent, setPitcherRecent] = useState<any | null>(null);

  // ⚡ STATCAST PITCH-BY-PITCH MATCHUP (motor real)
  const [statcastMatchup, setStatcastMatchup] = useState<any | null>(null);
  const [homeWOBA, setHomeWOBA] = useState<number | undefined>(undefined);
  const [homeISO, setHomeISO] = useState<number | undefined>(undefined);
  const [homeBABIP, setHomeBABIP] = useState<number | undefined>(undefined);
  const [homeOpsVsL, setHomeOpsVsL] = useState("0.720");
  const [homeOpsVsR, setHomeOpsVsR] = useState("0.730");

  // Home bullpen
  const [homeBpEra, setHomeBpEra] = useState("3.80");
  const [homeBpWhip, setHomeBpWhip] = useState("1.25");
  const [homeBpTired, setHomeBpTired] = useState(false);
  const [homeCloser, setHomeCloser] = useState(true);
  // Auto-cargado del backend, no editable manual
  const [homeBpEra14d, setHomeBpEra14d] = useState<number | undefined>(undefined);
  const [homeBpIp48h, setHomeBpIp48h] = useState<number | undefined>(undefined);
  const [homePitcherGS, setHomePitcherGS] = useState<number | undefined>(undefined);
  const [homeKPct, setHomeKPct] = useState<number | undefined>(undefined);
  const [homeBbPct, setHomeBbPct] = useState<number | undefined>(undefined);
  const [homeSiera, setHomeSiera] = useState<number | undefined>(undefined);

  // Home momentum
  const [homeStreak, setHomeStreak] = useState("0");
  const [homeWinRate, setHomeWinRate] = useState("0.55");

  // ── AWAY TEAM STATE ────────────────────────────────────────────────────────
  const [awayTeam, setAwayTeam] = useState("");

  // Away pitcher
  const [awayPitcherName, setAwayPitcherName] = useState("");
  const [awayEra, setAwayEra] = useState("3.80");
  const [awayWhip, setAwayWhip] = useState("1.20");
  const [awayFip, setAwayFip] = useState("3.70");
  const [awayK9, setAwayK9] = useState("9.0");
  const [awayBb9, setAwayBb9] = useState("3.0");
  const [awayRest, setAwayRest] = useState("5");
  const [awayHand, setAwayHand] = useState("R");
  const [awayRecord, setAwayRecord] = useState("8-5");
  const [awayRecentEra, setAwayRecentEra] = useState("")
  const [awayIP, setAwayIP] = useState("");
  const [awayHR, setAwayHR] = useState<number | undefined>(undefined);
  const [awayWalks, setAwayWalks] = useState<number | undefined>(undefined);
  const [awayStrikeouts, setAwayStrikeouts] = useState<number | undefined>(undefined);

  // Away offense
  const [awayOps, setAwayOps] = useState("0.730");
  const [awayRpg, setAwayRpg] = useState("4.5");
  const [awayObp, setAwayObp] = useState("0.320");
  const [awayAvg, setAwayAvg] = useState("0.255");
  const [awayWOBA, setAwayWOBA] = useState<number | undefined>(undefined);
  const [awayISO, setAwayISO] = useState<number | undefined>(undefined);
  const [awayBABIP, setAwayBABIP] = useState<number | undefined>(undefined);
  const [awayOpsVsL, setAwayOpsVsL] = useState("0.720");
  const [awayOpsVsR, setAwayOpsVsR] = useState("0.730");

  // Away bullpen
  const [awayBpEra, setAwayBpEra] = useState("3.80");
  const [awayBpWhip, setAwayBpWhip] = useState("1.25");
  const [awayBpTired, setAwayBpTired] = useState(false);
  const [awayCloser, setAwayCloser] = useState(true);
  // Auto-cargado del backend, no editable manual
  const [awayBpEra14d, setAwayBpEra14d] = useState<number | undefined>(undefined);
  const [awayBpIp48h, setAwayBpIp48h] = useState<number | undefined>(undefined);
  const [awayPitcherGS, setAwayPitcherGS] = useState<number | undefined>(undefined);
  const [awayKPct, setAwayKPct] = useState<number | undefined>(undefined);
  const [awayBbPct, setAwayBbPct] = useState<number | undefined>(undefined);
  const [awaySiera, setAwaySiera] = useState<number | undefined>(undefined);

  // Away momentum
  const [awayStreak, setAwayStreak] = useState("0");
  const [awayWinRate, setAwayWinRate] = useState("0.55");

  // ── CONTEXT ────────────────────────────────────────────────────────────────
  const [parkFactor, setParkFactor] = useState("1.0");
  const [parkName, setParkName] = useState("");
  const [tempF, setTempF] = useState("72");
  const [windFavorable, setWindFavorable] = useState(false);
  const [isNight, setIsNight] = useState(true);

  // ── LINES ──────────────────────────────────────────────────────────────────
  const [mlOdds, setMlOdds] = useState("-150");
  const [mlOddsAway, setMlOddsAway] = useState("+130");
  const [runLine, setRunLine] = useState("-1.5");
  const [rlOdds, setRlOdds] = useState("-110");
  const [rlOddsAway, setRlOddsAway] = useState("-110");
  const [ouLine, setOuLine] = useState("8.5");
  const [overOdds, setOverOdds] = useState("-110");
  const [underOdds, setUnderOdds] = useState("-110");
    const [f5OuLine, setF5OuLine] = useState("");
  // F5 odds (Hard Rock no las publica via API → consenso FD/BetMGM/DK + override manual)
  const [f5MlHome, setF5MlHome] = useState("");
  const [f5MlAway, setF5MlAway] = useState("");
  const [f5OddsSource, setF5OddsSource] = useState<"manual" | "consenso" | "">("");
  // Refs para detectar override manual sobre el consenso
  const f5ConsensoSnapshot = useRef<{ home: string; away: string } | null>(null);
  useEffect(() => {
    if (f5OddsSource === "consenso" && f5ConsensoSnapshot.current) {
      const snap = f5ConsensoSnapshot.current;
      if (f5MlHome !== snap.home || f5MlAway !== snap.away) setF5OddsSource("manual");
    } else if (f5OddsSource === "" && (f5MlHome || f5MlAway)) {
      setF5OddsSource("manual");
    }
  }, [f5MlHome, f5MlAway, f5OddsSource]);

  // ── H2H / SPLITS / SOS ───────────────────────────────────────────────────
  const [h2hLabel, setH2hLabel] = useState("");
  const [h2hHomeWins, setH2hHomeWins] = useState(0);
  const [h2hAwayWins, setH2hAwayWins] = useState(0);
  const [homeHomeRPG, setHomeHomeRPG] = useState("");
  const [homeHomeERA, setHomeHomeERA] = useState("");
  const [homeHomeRecord, setHomeHomeRecord] = useState("");
  const [homeAwayRPG, setHomeAwayRPG] = useState("");
  const [homeAwayERA, setHomeAwayERA] = useState("");
  const [homeAwayRecord, setHomeAwayRecord] = useState("");
  const [awayHomeRPG, setAwayHomeRPG] = useState("");
  const [awayHomeERA, setAwayHomeERA] = useState("");
  const [awayHomeRecord, setAwayHomeRecord] = useState("");
  const [awayAwayRPG, setAwayAwayRPG] = useState("");
  const [awayAwayERA, setAwayAwayERA] = useState("");
  const [awayAwayRecord, setAwayAwayRecord] = useState("");
  const [homeSeasonWR, setHomeSeasonWR] = useState("");
  const [awaySeasonWR, setAwaySeasonWR] = useState("");
  const [homeRecentGames, setHomeRecentGames] = useState<{ opp: string; oppAbbr: string; won: boolean; score: string; venue: string }[]>([]);
  const [awayRecentGames, setAwayRecentGames] = useState<{ opp: string; oppAbbr: string; won: boolean; score: string; venue: string }[]>([]);

  // ── RESULT ────────────────────────────────────────────────────────────────
  const [result, setResult] = useState<MLBResult | null>(null);

  // ── HOME TEAM SELECT HANDLER ───────────────────────────────────────────────
  const handleHomeTeamChange = useCallback((val: string) => {
    setHomeTeam(val);
    const park = TEAM_PARKS[val];
    if (park) {
      setParkName(park);
      const pf = PARK_FACTORS[park] ?? 1.0;
      setParkFactor(String(pf));
    }
  }, []);


  // ── AUTO-FILL HANDLER ──────────────────────────────────────────────────────
  const handleMLBAutoFill = async (gameId: string) => {
    setAutoStatus("loading");
    let games = mlbGames;
    if (games.length === 0) {
      const result = await refetchMLB();
      games = (result.data as any)?.games ?? [];
    }
    const game = games.find((g) => String(g.gameId) === gameId);
    if (!game) { setAutoStatus("error"); toast({ title: "Error al cargar", variant: "destructive" }); return; }

    const hs = game.homeStats;
    const as_ = game.awayStats;
    const hp = game.homePitcher;
    const ap = game.awayPitcher;

    // Capture tricodes for contextual signals (MLB uses abbreviation)
    const homeTri = (game.homeTeam as any).abbreviation || (game.homeTeam.name || "").slice(0, 3).toUpperCase();
    const awayTri = (game.awayTeam as any).abbreviation || (game.awayTeam.name || "").slice(0, 3).toUpperCase();
    setContextTri({ home: homeTri, away: awayTri });

    // Home team + park
    handleHomeTeamChange(game.homeTeam.name);
    setHomeTeamMlbId(game.homeTeam.id);
    setAwayTeamMlbId(game.awayTeam.id);
    // TESI extras
    setGamePkForTesi((game as any).gamePk);
    const hpAny = (game as any).homePitcher;
    const apAny = (game as any).awayPitcher;
    setHomePitcherIdTesi(hpAny?.id);
    setAwayPitcherIdTesi(apAny?.id);
    setHomePitcherHandTesi(hpAny?.hand === "R" || hpAny?.hand === "L" ? hpAny.hand : undefined);
    setAwayPitcherHandTesi(apAny?.hand === "R" || apAny?.hand === "L" ? apAny.hand : undefined);
    if (hs) {
      setHomeOps(String(hs.ops)); setHomeRpg(String(hs.rpg));
      if (hs.wOBA !== undefined) setHomeWOBA(hs.wOBA);
      if (hs.iso !== undefined) setHomeISO(hs.iso);
      if (hs.babip !== undefined) setHomeBABIP(hs.babip);
      setHomeObp(String(hs.obp)); setHomeAvg(String(hs.avg));
      setHomeOpsVsL(String(hs.opsVsL)); setHomeOpsVsR(String(hs.opsVsR));
      setHomeBpEra(String(hs.bullpenEra)); setHomeBpWhip(String(hs.bullpenWhip));
      setHomeBpEra14d(typeof hs.bullpenEra14d === "number" ? hs.bullpenEra14d : undefined);
      setHomeBpIp48h(typeof hs.bullpenIp48h === "number" ? hs.bullpenIp48h : undefined);
    }
    if (hp) {
      setHomePitcherName(hp.name || "");
      setHomeEra(String(hp.era)); setHomeWhip(String(hp.whip)); setHomeFip(String(hp.fip));
      setHomeK9(String(hp.k9)); setHomeBb9(String(hp.bb9)); setHomeRest(String(hp.daysRest));
      setHomeHand(hp.hand); setHomeRecord(hp.record);
      if (hp.recentEra !== undefined) setHomeRecentEra(String(hp.recentEra));
      if (hp.inningsPitched !== undefined) setHomeIP(String(hp.inningsPitched));
      // FIX: stats reales para FIP exacto
      if (typeof hp.homeRuns === "number") setHomeHR(hp.homeRuns);
      if (typeof hp.walks === "number") setHomeWalks(hp.walks);
      if (typeof hp.strikeouts === "number") setHomeStrikeouts(hp.strikeouts);
      setHomePitcherGS(typeof hp.gamesStarted === "number" ? hp.gamesStarted : undefined);
      setHomeKPct(typeof hp.kPct === "number" ? hp.kPct : undefined);
      setHomeBbPct(typeof hp.bbPct === "number" ? hp.bbPct : undefined);
      setHomeSiera(typeof hp.siera === "number" ? hp.siera : undefined);
    }
    // Home streak + win rate
    if (hs?.streak !== undefined) setHomeStreak(String(hs.streak));
    if (hs?.winRate !== undefined) setHomeWinRate(String(hs.winRate));

    // Away team
    setAwayTeam(game.awayTeam.name);
    if (as_) {
      setAwayOps(String(as_.ops)); setAwayRpg(String(as_.rpg));
      if (as_.wOBA !== undefined) setAwayWOBA(as_.wOBA);
      if (as_.iso !== undefined) setAwayISO(as_.iso);
      if (as_.babip !== undefined) setAwayBABIP(as_.babip);
      setAwayObp(String(as_.obp)); setAwayAvg(String(as_.avg));
      setAwayOpsVsL(String(as_.opsVsL)); setAwayOpsVsR(String(as_.opsVsR));
      setAwayBpEra(String(as_.bullpenEra)); setAwayBpWhip(String(as_.bullpenWhip));
      setAwayBpEra14d(typeof as_.bullpenEra14d === "number" ? as_.bullpenEra14d : undefined);
      setAwayBpIp48h(typeof as_.bullpenIp48h === "number" ? as_.bullpenIp48h : undefined);
    }
    if (ap) {
      setAwayPitcherName(ap.name || "");
      setAwayEra(String(ap.era)); setAwayWhip(String(ap.whip)); setAwayFip(String(ap.fip));
      setAwayK9(String(ap.k9)); setAwayBb9(String(ap.bb9)); setAwayRest(String(ap.daysRest));
      setAwayHand(ap.hand); setAwayRecord(ap.record);
      if (ap.recentEra !== undefined) setAwayRecentEra(String(ap.recentEra));
      if (ap.inningsPitched !== undefined) setAwayIP(String(ap.inningsPitched));
      if (typeof ap.homeRuns === "number") setAwayHR(ap.homeRuns);
      if (typeof ap.walks === "number") setAwayWalks(ap.walks);
      if (typeof ap.strikeouts === "number") setAwayStrikeouts(ap.strikeouts);
      setAwayPitcherGS(typeof ap.gamesStarted === "number" ? ap.gamesStarted : undefined);
      setAwayKPct(typeof ap.kPct === "number" ? ap.kPct : undefined);
      setAwayBbPct(typeof ap.bbPct === "number" ? ap.bbPct : undefined);
      setAwaySiera(typeof ap.siera === "number" ? ap.siera : undefined);
    }

    // Away streak + win rate
    if (as_?.streak !== undefined) setAwayStreak(String(as_.streak));
    if (as_?.winRate !== undefined) setAwayWinRate(String(as_.winRate));

    // H2H
    if ((game as any).h2h) setH2hLabel((game as any).h2h);
    if ((game as any).h2hHomeWins !== undefined) setH2hHomeWins((game as any).h2hHomeWins);
    if ((game as any).h2hAwayWins !== undefined) setH2hAwayWins((game as any).h2hAwayWins);

    // Home splits
    if (hs?.homeRPG !== undefined) setHomeHomeRPG(String(hs.homeRPG));
    if (hs?.homeERA !== undefined) setHomeHomeERA(String(hs.homeERA));
    if (hs?.homeRecord) setHomeHomeRecord(hs.homeRecord);
    if (hs?.awayRPG !== undefined) setHomeAwayRPG(String(hs.awayRPG));
    if (hs?.awayERA !== undefined) setHomeAwayERA(String(hs.awayERA));
    if (hs?.awayRecord) setHomeAwayRecord(hs.awayRecord);
    if (hs?.seasonWinRate !== undefined) setHomeSeasonWR(String(hs.seasonWinRate));
    // FIX stale state: siempre reemplazar (vacío si no viene). Antes el guard if
    // dejaba los recentGames del partido anterior si el nuevo no los traía.
    setHomeRecentGames(hs?.recentGames || []);

    // Away splits
    if (as_?.homeRPG !== undefined) setAwayHomeRPG(String(as_.homeRPG));
    if (as_?.homeERA !== undefined) setAwayHomeERA(String(as_.homeERA));
    if (as_?.homeRecord) setAwayHomeRecord(as_.homeRecord);
    if (as_?.awayRPG !== undefined) setAwayAwayRPG(String(as_.awayRPG));
    if (as_?.awayERA !== undefined) setAwayAwayERA(String(as_.awayERA));
    if (as_?.awayRecord) setAwayAwayRecord(as_.awayRecord);
    if (as_?.seasonWinRate !== undefined) setAwaySeasonWR(String(as_.seasonWinRate));
    setAwayRecentGames(as_?.recentGames || []);

    // Pitcher HR data
    if (hp?.homeRuns !== undefined) setHomeIP(String(hp.inningsPitched ?? ""));
    if (ap?.homeRuns !== undefined) setAwayIP(String(ap.inningsPitched ?? ""));

    // Lesiones — la Fase B espera la reconciliación con Bullpen Status antes de tocar la proyección.
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

    // Lineup matchup hombre-por-hombre (lineup vs pitcher rival)
    try {
      const lmRes = await fetch(`${API_BASE}/api/mlb/lineup-matchup/${gameId}`);
      if (lmRes.ok) {
        const lm = await lmRes.json();
        setLineupMatchup(lm);
      } else {
        setLineupMatchup(null);
      }
    } catch {
      setLineupMatchup(null);
    }

    // Archetype matchup — cómo le va al equipo vs ese tipo de pitcher en últimos 200 juegos
    try {
      const amRes = await fetch(`${API_BASE}/api/mlb/archetype-matchup/${gameId}`);
      if (amRes.ok) {
        const am = await amRes.json();
        setArchetypeMatchup(am);
      } else {
        setArchetypeMatchup(null);
      }
    } catch {
      setArchetypeMatchup(null);
    }

    // Bullpen status — reconciliación obligatoria antes de activar lesiones de relevistas.
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

    // Park-pitcher splits — cómo le va a este pitcher en este estadio específico
    try {
      const ppRes = await fetch(`${API_BASE}/api/mlb/park-pitcher/${gameId}`);
      if (ppRes.ok) {
        const pp = await ppRes.json();
        setParkPitcher(pp);
      } else {
        setParkPitcher(null);
      }
    } catch {
      setParkPitcher(null);
    }

    // Statcast Quality (Tier A): xwOBA-allowed + HardHit% + luck-delta
    try {
      const qRes = await fetch(`${API_BASE}/api/mlb/quality/${gameId}`);
      if (qRes.ok) {
        const q = await qRes.json();
        setStatcastQuality(q);
      } else {
        setStatcastQuality(null);
      }
    } catch {
      setStatcastQuality(null);
    }

    // SOS — Strength of Schedule del bateo reciente (anti-rachas-infladas)
    try {
      const sosRes = await fetch(`${API_BASE}/api/mlb/sos/${gameId}`);
      if (sosRes.ok) {
        const sosData = await sosRes.json();
        setSos(sosData);
      } else {
        setSos(null);
      }
    } catch {
      setSos(null);
    }

    // Tier B — strikePct (proxy CSW) + Sprint Speed para BABIP correction
    try {
      const dsRes = await fetch(`${API_BASE}/api/mlb/discipline-speed/${gameId}`);
      if (dsRes.ok) {
        const ds = await dsRes.json();
        setDiscSpeed(ds);
      } else {
        setDiscSpeed(null);
      }
    } catch {
      setDiscSpeed(null);
    }

    // Pitcher vs Team — últimos 5 starts contra el rival
    try {
      const pvtRes = await fetch(`${API_BASE}/api/mlb/pitcher-vs-team/${gameId}`);
      if (pvtRes.ok) {
        const pvt = await pvtRes.json();
        setPitcherVsTeam(pvt);
      } else {
        setPitcherVsTeam(null);
      }
    } catch {
      setPitcherVsTeam(null);
    }

    // Wind-Park — viento + estadio + temperatura
    try {
      const wpRes = await fetch(`${API_BASE}/api/mlb/wind-park/${gameId}`);
      if (wpRes.ok) {
        const wp = await wpRes.json();
        setWindPark(wp);
      } else {
        setWindPark(null);
      }
    } catch {
      setWindPark(null);
    }

    // Catcher Framing — cuánto strikes roba el catcher
    try {
      const cfRes = await fetch(`${API_BASE}/api/mlb/catcher-framing/${gameId}`);
      if (cfRes.ok) {
        const cf = await cfRes.json();
        setCatcherFraming(cf);
      } else {
        setCatcherFraming(null);
      }
    } catch {
      setCatcherFraming(null);
    }

    // Rookie Pitcher Penalty — detecta pitchers inexpertos / bullpen games
    try {
      const rpRes = await fetch(`${API_BASE}/api/mlb/rookie-pitcher/${gameId}`);
      if (rpRes.ok) {
        const rp = await rpRes.json();
        setRookiePitcher(rp);
      } else {
        setRookiePitcher(null);
      }
    } catch {
      setRookiePitcher(null);
    }

    // Hueco #1+#2: Pitcher Form (descanso + splits H/R)
    try {
      const pfRes = await fetch(`${API_BASE}/api/mlb/pitcher-form/${gameId}`);
      if (pfRes.ok) setPitcherForm(await pfRes.json()); else setPitcherForm(null);
    } catch { setPitcherForm(null); }

    // Hueco #3: Team Fatigue (day-after-night, travel, stretch)
    try {
      const tfRes = await fetch(`${API_BASE}/api/mlb/team-fatigue/${gameId}`);
      if (tfRes.ok) setTeamFatigue(await tfRes.json()); else setTeamFatigue(null);
    } catch { setTeamFatigue(null); }

    // ⚡ STATCAST PITCH-BY-PITCH MATCHUP (el motor real)
    try {
      const smRes = await fetch(`${API_BASE}/api/mlb/statcast-matchup/${gameId}`);
      if (smRes.ok) setStatcastMatchup(await smRes.json()); else setStatcastMatchup(null);
    } catch { setStatcastMatchup(null); }

    // Post-mortem fix: forma reciente del SP, splits H/R recientes, early-exit risk
    try {
      const prRes = await fetch(`${API_BASE}/api/mlb/pitcher-recent/${gameId}`);
      if (prRes.ok) {
        const pr = await prRes.json();
        setPitcherRecent(pr);
        // FIX auditoría: pitcher-recent calcula recentEra desde gameLog real (últimas 5 starts)
        // — unificar como fuente de verdad y sobreescribir lo embebido en /api/mlb/all
        if (pr?.home?.recentEra !== undefined && pr.home.startsAnalyzed >= 3) {
          setHomeRecentEra(String(pr.home.recentEra));
        }
        if (pr?.away?.recentEra !== undefined && pr.away.startsAnalyzed >= 3) {
          setAwayRecentEra(String(pr.away.recentEra));
        }
      } else {
        setPitcherRecent(null);
      }
    } catch { setPitcherRecent(null); }

    // FIX auditoría: cargar Umpire / Advanced / Contextual / Sharp en autofill
    // Antes dependían de cards UI o del botón "Cuotas HR" — si el usuario predecía rápido,
    // estos 4 factores llegaban como null y no entraban al modelo.
    try {
      const uRes = await fetch(`${API_BASE}/api/mlb/umpire/${gameId}`);
      if (uRes.ok) {
        const u = await uRes.json();
        // FIX NaN: el endpoint devuelve { success, umpire }, no el objeto plano
        const umpObj = u?.umpire ?? (u && u.runAdj !== undefined ? u : null);
        if (umpObj && !u.error) setUmpireData(umpObj);
      }
    } catch {}
    try {
      const aRes = await fetch(`${API_BASE}/api/mlb/advanced/${gameId}`);
      if (aRes.ok) {
        const a = await aRes.json();
        if (a && typeof a.totalAdjustment === "number") {
          setAdvancedData({ totalAdjustment: a.totalAdjustment, notes: a.notes ?? [] });
        }
      }
    } catch {}
    try {
      const cRes = await fetch(`${API_BASE}/api/mlb/context?home=${encodeURIComponent(homeTri)}&away=${encodeURIComponent(awayTri)}&gamePk=${gameId}`);
      if (cRes.ok) {
        const c = await cRes.json();
        if (c && (c.homeProbAdjPp !== undefined || c.totalAdj !== undefined)) {
          setMlbCtxAdj({ homeProbAdjPp: c.homeProbAdjPp ?? 0, totalAdj: c.totalAdj ?? 0 });
        }
      }
    } catch {}
    // Sharp signals: setear el gameKey desde el game seleccionado
    try {
      const ct = (game as any).commenceTime || game.gameDate || "";
      const sharpKey = `${game.awayTeam.name}@${game.homeTeam.name}@${ct}`;
      setSharpGameKey(sharpKey);
    } catch {}

    setAutoStatus("success");
    const totalInj = homeInj.length + awayInj.length;
    toast({
      title: "⚾ Todo cargado — solo agrega líneas de Hard Rock",
      description: totalInj > 0 ? `Lesionados detectados: ${totalInj} (${homeInj.length} local + ${awayInj.length} visitante)` : undefined,
    });
  };

  // ── PREDICT ───────────────────────────────────────────────────────────────
  const handlePredict = useCallback(() => {
    const homePitcher: MLBPitcher = {
      era: parseFloat(homeEra) || 3.80,
      whip: parseFloat(homeWhip) || 1.20,
      fip: parseFloat(homeFip) || 3.70,
      k9: parseFloat(homeK9) || 9.0,
      bb9: parseFloat(homeBb9) || 3.0,
      daysRest: parseInt(homeRest) || 5,
      hand: homeHand as "L" | "R",
      record: homeRecord,
      recentEra: homeRecentEra ? parseFloat(homeRecentEra) : undefined,
      inningsPitched: homeIP ? parseFloat(homeIP) : undefined,
      homeRuns: homeHR,
      walks: homeWalks,
      strikeouts: homeStrikeouts,
      gamesStarted: homePitcherGS,
      kPct: homeKPct,
      bbPct: homeBbPct,
      siera: homeSiera,
    };

    const awayPitcher: MLBPitcher = {
      era: parseFloat(awayEra) || 3.80,
      whip: parseFloat(awayWhip) || 1.20,
      fip: parseFloat(awayFip) || 3.70,
      k9: parseFloat(awayK9) || 9.0,
      bb9: parseFloat(awayBb9) || 3.0,
      daysRest: parseInt(awayRest) || 5,
      hand: awayHand as "L" | "R",
      record: awayRecord,
      recentEra: awayRecentEra ? parseFloat(awayRecentEra) : undefined,
      inningsPitched: awayIP ? parseFloat(awayIP) : undefined,
      homeRuns: awayHR,
      walks: awayWalks,
      strikeouts: awayStrikeouts,
      gamesStarted: awayPitcherGS,
      kPct: awayKPct,
      bbPct: awayBbPct,
      siera: awaySiera,
    };

    // Aplicar ajustes asimétricos por lesiones MLB
    // homeInjury en "runs" (-2 = perdimos 2 runs por lesion). offFactor escala impacto a OPS/wOBA, defFactor a bullpen.
    const hInjVal = parseFloat(homeInjury) || 0;
    const aInjVal = parseFloat(awayInjury) || 0;
    const hInjOff = hInjVal * homeInjuryFactors.off; // negative reduces offense
    const hInjDef = hInjVal * homeInjuryFactors.def; // negative makes defense worse → ERA up
    const aInjOff = aInjVal * awayInjuryFactors.off;
    const aInjDef = aInjVal * awayInjuryFactors.def;
    // Convert run delta to OPS/wOBA delta: -2 runs/game ≈ -0.040 wOBA, -0.060 OPS
    const hOpsDeltaInj = hInjOff * 0.030;
    const hWobaDeltaInj = hInjOff * 0.020;
    const hRpgDeltaInj = hInjOff * 0.50; // direct
    const aOpsDeltaInj = aInjOff * 0.030;
    const aWobaDeltaInj = aInjOff * 0.020;
    const aRpgDeltaInj = aInjOff * 0.50;
    // Bullpen ERA worsens: each -1 def factor = +0.30 ERA
    const hEraDelta = -hInjDef * 0.15;  // negative inj → positive ERA increase
    const aEraDelta = -aInjDef * 0.15;

    // «Lineup vs Pitcher» hombre-por-hombre — ajusta OPS/RPG según splits del lineup vs handedness rival
    // Anti doble-conteo: lineup-matchup (wOBA/BABIP/slot) y Statcast pitch-by-pitch
    // miden lo mismo. Cuando Statcast tiene FULL/PARTIAL, lineup-matchup queda al 30%.
    const smHomeOkForLm = statcastMatchup?.homeLineupVsAwaySP?.dataConfidence === "FULL" || statcastMatchup?.homeLineupVsAwaySP?.dataConfidence === "PARTIAL";
    const smAwayOkForLm = statcastMatchup?.awayLineupVsHomeSP?.dataConfidence === "FULL" || statcastMatchup?.awayLineupVsHomeSP?.dataConfidence === "PARTIAL";
    const lmHomeMult = smHomeOkForLm ? 0.30 : 1.0;
    const lmAwayMult = smAwayOkForLm ? 0.30 : 1.0;
    const lmHomeRunsDelta = (lineupMatchup?.adjustment?.homeRunsDelta ?? 0) * lmHomeMult;
    const lmAwayRunsDelta = (lineupMatchup?.adjustment?.awayRunsDelta ?? 0) * lmAwayMult;
    const lmHomeOpsDelta = (lineupMatchup?.adjustment?.homeOpsDelta ?? 0) * lmHomeMult;
    const lmAwayOpsDelta = (lineupMatchup?.adjustment?.awayOpsDelta ?? 0) * lmAwayMult;

    // «Rookie Pitcher Penalty» — SP rookie/bullpen game suprime ofensiva del rival
    // El SP local rookie → visitante anota MENOS (no tienen scouting)
    // El SP visitante rookie → local anota MENOS
    let rookieAwayRunsDelta = 0;  // visitante anota menos si SP local es rookie
    let rookieHomeRunsDelta = 0;  // local anota menos si SP visitante es rookie
    let rookieConfidenceCap = 1.0; // multiplicador para reducir confianza del favorito
    if (rookiePitcher?.home?.rivalRunsPenalty) {
      // SP local rookie: visitante "anotará menos de lo esperado"
      rookieAwayRunsDelta = rookiePitcher.home.rivalRunsPenalty;
    }
    if (rookiePitcher?.away?.rivalRunsPenalty) {
      // SP visitante rookie: local "anotará menos de lo esperado"
      rookieHomeRunsDelta = rookiePitcher.away.rivalRunsPenalty;
    }
    // Reducción de confianza: si el rival es rookie, el favorito no es tan fuerte como parece
    // + Post-mortem fix: si nuestro SP está COLD/IMPLOSION, no podemos confiar en favorito
    const recentConfPenalty = (pitcherRecent?.homeConfPenalty ?? 0) + (pitcherRecent?.awayConfPenalty ?? 0);
    const totalConfReduction = (rookiePitcher?.home?.confidenceReduction ?? 0) + (rookiePitcher?.away?.confidenceReduction ?? 0) + recentConfPenalty;
    if (totalConfReduction >= 12) rookieConfidenceCap = 0.78;
    else if (totalConfReduction >= 8) rookieConfidenceCap = 0.85;
    else if (totalConfReduction >= 4) rookieConfidenceCap = 0.92;

    // «Catcher Framing» — catcher élite ahorra ERA al SP propio, catcher pobre lo empeora
    // El catcher LOCAL afecta al SP LOCAL (su ERA mejora si framing es élite)
    let cfHomeEraDelta = 0;
    let cfAwayEraDelta = 0;
    if (catcherFraming?.homeEraImpact !== undefined) {
      cfHomeEraDelta = catcherFraming.homeEraImpact;
    }
    if (catcherFraming?.awayEraImpact !== undefined) {
      cfAwayEraDelta = catcherFraming.awayEraImpact;
    }
    // Si SP local tiene ERA empeorada por catcher pobre → visitante anota más
    // 1 ERA = 0.6 runs/juego. cfDelta es positivo cuando catcher es malo (= peor ERA)
    const cfAwayRunsDelta = cfHomeEraDelta * 0.6; // catcher local malo → away anota más
    const cfHomeRunsFromAway = cfAwayEraDelta * 0.6; // catcher visitante malo → home anota más

    // «Pitcher vs Team» — si el pitcher domina/sufre vs ESTE equipo específico
    // FIX DOBLE CONTEO: Cuando Statcast (pitch-by-pitch) tiene buena muestra,
    // PvT se vuelve tie-breaker (peso 20%) porque mide lo mismo desde otro ángulo.
    // Sin Statcast (LOW o ausente), PvT mantiene su peso 100% como fallback.
    // (Acceso directo al objeto porque smHomeConf/smAwayConf se definen más abajo)
    const _smHomeConfPvT = statcastMatchup?.homeLineupVsAwaySP?.dataConfidence;
    const _smAwayConfPvT = statcastMatchup?.awayLineupVsHomeSP?.dataConfidence;
    const statcastHomeOk = _smHomeConfPvT === "FULL" || _smHomeConfPvT === "PARTIAL";
    const statcastAwayOk = _smAwayConfPvT === "FULL" || _smAwayConfPvT === "PARTIAL";
    const pvtHomeMultiplier = statcastHomeOk ? 0.20 : 1.0; // 80% reducción si Statcast cubre
    const pvtAwayMultiplier = statcastAwayOk ? 0.20 : 1.0;

    let pvtHomeEraDelta = 0;
    let pvtAwayEraDelta = 0;
    if (pitcherVsTeam?.homeVsAway?.significantSample) {
      pvtHomeEraDelta = pitcherVsTeam.homeVsAway.eraDelta * 0.4 * pvtHomeMultiplier;
      // Bonus para trends fuertes (también reducidos por multiplicador)
      if (pitcherVsTeam.homeVsAway.recentTrend === "STRUGGLES") pvtHomeEraDelta += 0.3 * pvtHomeMultiplier;
      if (pitcherVsTeam.homeVsAway.recentTrend === "DOMINANCE") pvtHomeEraDelta -= 0.3 * pvtHomeMultiplier;
    }
    if (pitcherVsTeam?.awayVsHome?.significantSample) {
      pvtAwayEraDelta = pitcherVsTeam.awayVsHome.eraDelta * 0.4 * pvtAwayMultiplier;
      if (pitcherVsTeam.awayVsHome.recentTrend === "STRUGGLES") pvtAwayEraDelta += 0.3 * pvtAwayMultiplier;
      if (pitcherVsTeam.awayVsHome.recentTrend === "DOMINANCE") pvtAwayEraDelta -= 0.3 * pvtAwayMultiplier;
    }
    // Convertir delta ERA a delta runs (cada 1 ERA = 0.6 runs/juego)
    const pvtAwayRunsDelta = pvtHomeEraDelta * 0.6; // SP local malo → away anota más
    const pvtHomeRunsFromAway = pvtAwayEraDelta * 0.6; // SP visitante malo → home anota más

    // «Wind-Park» — viento + estadio + temperatura. Afecta TOTAL del partido (ambos lados)
    let wpRunsAdjustment = 0;
    if (windPark?.runsAdjustment) {
      wpRunsAdjustment = windPark.runsAdjustment;
    }
    // Se distribuye 50/50 a ambos lados (favorece anotación general, no a un equipo)
    const wpHomeRunsDelta = wpRunsAdjustment * 0.5;
    const wpAwayRunsDelta = wpRunsAdjustment * 0.5;

    // «Park-Pitcher Split» — cómo le va a ESTE pitcher en ESTE estadio
    // FIX DOBLE CONTEO: El park factor base ya viene en Wind-Park (windPark.runsAdjustment).
    // Para evitar contarlo dos veces, restamos el componente "park puro" del eraDelta
    // y dejamos solo el DELTA del pitcher respecto a su baseline en otros parques.
    // El park-pitcher delta ya viene calculado vs el resto de parques del pitcher en backend,
    // pero por seguridad reducimos su peso a 35% cuando Wind-Park está activo (park-extreme).
    const windParkActive = Math.abs(wpRunsAdjustment) > 0.20; // parque significativo (Coors/Tropicana)
    const ppMultiplier = windParkActive ? 0.35 : 0.50; // reduce al 35% si park ya cuenta fuerte

    // PISO ABSOLUTO: si el park-ERA real sigue siendo malo (>4.40), no puede contar como "mejora".
    // Un pitcher con season 6.35 que en este parque tira 5.30 NO ayuda al equipo —
    // su 5.30 sigue cediendo más runs que el league avg. Anular la mejora aparente.
    let ppHomeEraDelta = 0;  // delta del SP local en su propio estadio
    let ppAwayEraDelta = 0;  // delta del SP visitante en este estadio
    // Proxy por arquetipo entra con peso REDUCIDO según tamaño de muestra:
    // n≥5 starts en bucket → 50% (confianza MEDIA)
    // n=3-4 starts en bucket → 35% (confianza BAJA)
    const evalSplit = (split: any): number => {
      if (!split) return 0;
      let delta = split.eraDelta;
      if (delta < 0 && split.era > 4.40) delta = 0; // piso absoluto
      if (split.dataSource === "DIRECT" && split.significantSample) {
        return delta * ppMultiplier;
      }
      if (split.dataSource === "BUCKET_PROXY") {
        const n = split.bucketStarts ?? 0;
        if (n >= 5) return delta * ppMultiplier * 0.50;
        if (n >= 3) return delta * ppMultiplier * 0.35;
      }
      return 0;
    };
    ppHomeEraDelta = evalSplit(parkPitcher?.homeSplit);
    ppAwayEraDelta = evalSplit(parkPitcher?.awaySplit);
    // Si el SP local sufre en este parque (delta positivo) → visitante anotará más runs
    // Convertir delta ERA a delta runs/juego: cada 1 ERA ≈ 0.6 runs/juego
    const ppAwayRunsDelta = ppHomeEraDelta * 0.6; // SP local malo → away anota más
    const ppHomeRunsFromAwaySP = ppAwayEraDelta * 0.6; // SP visitante malo → home anota más

    // «Bullpen Status» — si el bullpen rival está comprometido, este equipo anotará más en 7-9
    // El ajuste se aplica al equipo que se BENEFICIA del bullpen rival débil
    let bpHomeRunsDelta = 0;
    let bpAwayRunsDelta = 0;
    if (bullpenStatus?.away?.runsAdjustment) {
      // Bullpen visitante débil → LOCAL anota más
      bpHomeRunsDelta = bullpenStatus.away.runsAdjustment;
    }
    if (bullpenStatus?.home?.runsAdjustment) {
      // Bullpen local débil → VISITANTE anota más
      bpAwayRunsDelta = bullpenStatus.home.runsAdjustment;
    }

    // «Archetype Matchup» — cómo le va a este equipo VS este tipo de pitcher en últimos 200 juegos
    // Usa runsScored vs liga promedio (4.5) como ajuste
    //
    // SEMANTICS (post-auditoría):
    //   - archetypeMatchup.home  = perfil del equipo LOCAL contra el arquetipo del SP visitante
    //   - archetypeMatchup.away  = perfil del equipo VISITANTE contra el arquetipo del SP local
    //   - .homeRecord            = cómo le pega el equipo cuando está EN CASA
    //   - .awayRecord            = cómo le pega el equipo cuando está DE VISITA
    //
    // Como el local siempre juega en casa hoy, usamos .homeRecord para el local.
    // El visitante siempre está de visita hoy, usamos .awayRecord para el visitante.
    // Esta correspondencia está documentada y blindada con assert.
    let archHomeRunsDelta = 0;
    let archAwayRunsDelta = 0;
    // ANTI-DOBLE-CONTEO: Statcast Pitch-by-Pitch (factor #13) ya mide lineup ACTUAL
    // vs CADA pitch del SP rival — más preciso que arquetipo histórico.
    // Cuando Statcast PvP tiene FULL/PARTIAL, archetypeMatchup queda al 30%.
    // Cuando Statcast PvP es LOW/sin datos (rookies, primeras 3 aperturas), peso 50%.
    const archSmHomeOk = statcastMatchup?.homeLineupVsAwaySP?.dataConfidence === "FULL" || statcastMatchup?.homeLineupVsAwaySP?.dataConfidence === "PARTIAL";
    const archSmAwayOk = statcastMatchup?.awayLineupVsHomeSP?.dataConfidence === "FULL" || statcastMatchup?.awayLineupVsHomeSP?.dataConfidence === "PARTIAL";
    const archHomeWeight = archSmHomeOk ? 0.30 : 0.50;
    const archAwayWeight = archSmAwayOk ? 0.30 : 0.50;
    if (archetypeMatchup?.home?.homeRecord?.significantSample) {
      archHomeRunsDelta = (archetypeMatchup.home.homeRecord.avgRunsScored - 4.5) * archHomeWeight;
    }
    if (archetypeMatchup?.away?.awayRecord?.significantSample) {
      archAwayRunsDelta = (archetypeMatchup.away.awayRecord.avgRunsScored - 4.5) * archAwayWeight;
    }
    // Sanity guard: si el delta sale extremo (>3 runs), capear — muestra ruidosa o bug semantic
    archHomeRunsDelta = Math.max(-2.5, Math.min(2.5, archHomeRunsDelta));
    archAwayRunsDelta = Math.max(-2.5, Math.min(2.5, archAwayRunsDelta));

    // Hueco #1 + #2: Pitcher Form (descanso + splits H/R)
    // home pitcher peor → visitante anota más, y vice versa
    // ANTI-DOBLE-CONTEO: si pitcherRecent tiene ≥3 starts, los splits H/R recientes
    // ya capturan parte de la señal. Dampear pitcherForm al 50% en ese caso.
    // El descanso (restEraDelta) no solapa con recent; queda 100%.
    const pfHasRecentHome = (pitcherRecent?.home?.startsAnalyzed ?? 0) >= 3;
    const pfHasRecentAway = (pitcherRecent?.away?.startsAnalyzed ?? 0) >= 3;
    const pfHomeBase = pitcherForm?.homeRivalRunsDelta ?? 0;
    const pfAwayBase = pitcherForm?.awayRivalRunsDelta ?? 0;
    // Separar el componente "splits" (que solapa) del "descanso" (que no solapa)
    // Approximación: si tenemos splitsEraDelta, ese componente queda al 50%; restEraDelta al 100%.
    const pfHomeRest = (pitcherForm?.home?.restEraDelta ?? 0) * 0.6; // ERA→runs scaling
    const pfAwayRest = (pitcherForm?.away?.restEraDelta ?? 0) * 0.6;
    const pfHomeSplits = pfHomeBase - pfHomeRest;
    const pfAwaySplits = pfAwayBase - pfAwayRest;
    const pfHomeRivalRunsDelta = pfHomeRest + (pfHasRecentHome ? pfHomeSplits * 0.50 : pfHomeSplits); // afecta RPG visitante
    const pfAwayRivalRunsDelta = pfAwayRest + (pfHasRecentAway ? pfAwaySplits * 0.50 : pfAwaySplits); // afecta RPG local

    // Hueco #3: Team Fatigue — cada equipo recibe su propio delta ofensivo
    const tfHomeOwnRunsDelta = teamFatigue?.homeRunsDelta ?? 0;
    const tfAwayOwnRunsDelta = teamFatigue?.awayRunsDelta ?? 0;

    // Post-mortem fix: Pitcher Recent (forma reciente + splits H/R recientes + early-exit)
    const prHomeRivalRunsDelta = pitcherRecent?.homeRivalRunsDelta ?? 0; // afecta runs visitante
    const prAwayRivalRunsDelta = pitcherRecent?.awayRivalRunsDelta ?? 0; // afecta runs local

    // ⚡ STATCAST: pitch-by-pitch + batter vs team
    // Es el motor real — cada equipo recibe su propio delta basado en cómo su lineup
    // confirmado le pega al repertorio del SP rival.
    // ── Auto-moderación por dataConfidence ──
    // Si el lineup analizado tiene LOW confidence (poca muestra Statcast), reducir el peso
    // del delta a 40% en lugar de 100%. Así la señal débil no domina la predicción.
    const smHomeConf = statcastMatchup?.homeLineupVsAwaySP?.dataConfidence as "FULL" | "PARTIAL" | "LOW" | undefined;
    const smAwayConf = statcastMatchup?.awayLineupVsHomeSP?.dataConfidence as "FULL" | "PARTIAL" | "LOW" | undefined;
    const smHomeWeight = smHomeConf === "LOW" ? 0.40 : smHomeConf === "PARTIAL" ? 0.75 : 1.0;
    const smAwayWeight = smAwayConf === "LOW" ? 0.40 : smAwayConf === "PARTIAL" ? 0.75 : 1.0;
    const smHomeOwnRunsDelta = (statcastMatchup?.homeRunsDelta ?? 0) * smHomeWeight;
    const smAwayOwnRunsDelta = (statcastMatchup?.awayRunsDelta ?? 0) * smAwayWeight;
    const prHomeConfPenalty = pitcherRecent?.homeConfPenalty ?? 0;
    const prAwayConfPenalty = pitcherRecent?.awayConfPenalty ?? 0;

    // Tier A Savant Quality — xwOBA-allowed + HardHit% del SP rival.
    // Anti doble-conteo: cuando Statcast Pitch-by-Pitch tiene FULL/PARTIAL,
    // el efecto del SP rival queda al 50% (Statcast ya mide actual lineup vs arsenal).
    // Cuando Statcast está LOW/sin datos, peso 100%.
    const smHomeOk = statcastMatchup?.homeLineupVsAwaySP?.dataConfidence === "FULL" || statcastMatchup?.homeLineupVsAwaySP?.dataConfidence === "PARTIAL";
    const smAwayOk = statcastMatchup?.awayLineupVsHomeSP?.dataConfidence === "FULL" || statcastMatchup?.awayLineupVsHomeSP?.dataConfidence === "PARTIAL";
    const qSpHomeDelta = (statcastQuality?.awaySP?.runsDelta ?? 0) * (smHomeOk ? 0.50 : 1.0); // SP visitante → afecta runs del LOCAL
    const qSpAwayDelta = (statcastQuality?.homeSP?.runsDelta ?? 0) * (smAwayOk ? 0.50 : 1.0); // SP local → afecta runs del VISITANTE

    // Tier B — strikePct (CSW proxy) + Sprint Speed.
    // Anti doble-conteo: el strikePct→K9-expected ya solapa parcial con pitcherScore;
    // peso al 50% cuando Statcast FULL/PARTIAL, 100% cuando no.
    const dsHomeWeight = smHomeOk ? 0.50 : 1.0;
    const dsAwayWeight = smAwayOk ? 0.50 : 1.0;
    const dsHomeRunsDelta = (discSpeed?.homeRunsDelta ?? 0) * dsHomeWeight;
    const dsAwayRunsDelta = (discSpeed?.awayRunsDelta ?? 0) * dsAwayWeight;

    // Combinar todos los factores — incluyendo nuevos huecos #1, #2, #3
    const hOpsDelta = hOpsDeltaInj + lmHomeOpsDelta;
    const hWobaDelta = hWobaDeltaInj + (lmHomeOpsDelta * 0.6);
    let hRpgDelta = hRpgDeltaInj + lmHomeRunsDelta + archHomeRunsDelta + bpHomeRunsDelta + ppHomeRunsFromAwaySP + pvtHomeRunsFromAway + wpHomeRunsDelta + cfHomeRunsFromAway + rookieHomeRunsDelta
      + pfAwayRivalRunsDelta + tfHomeOwnRunsDelta + prAwayRivalRunsDelta + smHomeOwnRunsDelta + qSpHomeDelta + dsHomeRunsDelta;
    const aOpsDelta = aOpsDeltaInj + lmAwayOpsDelta;
    const aWobaDelta = aWobaDeltaInj + (lmAwayOpsDelta * 0.6);
    let aRpgDelta = aRpgDeltaInj + lmAwayRunsDelta + archAwayRunsDelta + bpAwayRunsDelta + ppAwayRunsDelta + pvtAwayRunsDelta + wpAwayRunsDelta + cfAwayRunsDelta + rookieAwayRunsDelta
      + pfHomeRivalRunsDelta + tfAwayOwnRunsDelta + prHomeRivalRunsDelta + smAwayOwnRunsDelta + qSpAwayDelta + dsAwayRunsDelta;

    // ── CAP FINAL ──
    // Hard cap ±3.5 runs sobre el RPG base. Evita predicciones absurdas (11 vs 2)
    // cuando 15 factores se alinean en el mismo sentido por casualidad.
    const RPG_HARD_CAP = 3.5;
    hRpgDelta = Math.max(-RPG_HARD_CAP, Math.min(RPG_HARD_CAP, hRpgDelta));
    aRpgDelta = Math.max(-RPG_HARD_CAP, Math.min(RPG_HARD_CAP, aRpgDelta));
    // ANTI-DOBLE-CONTEO BULLPEN:
    // El factor bpHomeRunsDelta/bpAwayRunsDelta (línea ~1464) ya suma 0.15-0.70 runs al RPG
    // del equipo rival cuando el bullpen del propio está comprometido.
    // Antes aquí también se empeoraba el bullpenEra (+0.3 a +0.6) lo cual entraba al modelo
    // como bullpenDiff (peso 22% del logit). Era el MISMO evento contado dos veces.
    // Solución: dejar el runsAdjustment como única vía (es más directo y honesto).
    const hBpEraDelta = 0;
    const aBpEraDelta2 = 0;

    // SOS — corrige el RPG reciente del equipo si enfrentó pitcheo flojo/top.
    // Aplica al RPG BASE antes de los deltas (anti-rachas-infladas).
    const homeSosFactor = sos?.home?.sosFactor ?? 1.0;
    const awaySosFactor = sos?.away?.sosFactor ?? 1.0;

    const homeTeamObj: MLBTeam = {
      name: homeTeam || "Local",
      ops: (parseFloat(homeOps) || 0.730) + hOpsDelta,
      rpg: ((parseFloat(homeRpg) || 4.5) * homeSosFactor) + hRpgDelta,
      obp: parseFloat(homeObp) || 0.320,
      avg: parseFloat(homeAvg) || 0.255,
      opsVsL: parseFloat(homeOpsVsL) || 0.720,
      opsVsR: parseFloat(homeOpsVsR) || 0.730,
      wOBA: homeWOBA !== undefined ? homeWOBA + hWobaDelta : homeWOBA,
      iso: homeISO,
      babip: homeBABIP,
      bullpenEra: (parseFloat(homeBpEra) || 3.80) + hEraDelta + hBpEraDelta,
      bullpenWhip: parseFloat(homeBpWhip) || 1.25,
      bullpenEra14d: homeBpEra14d !== undefined ? homeBpEra14d + hBpEraDelta : undefined,
      bullpenIp48h: homeBpIp48h,
      bullpenTired: homeBpTired,
      closerAvailable: homeCloser,
      streak: parseInt(homeStreak) || 0,
      winRate: parseFloat(homeWinRate) || 0.55,
      pitcher: homePitcher,
      h2hWins: h2hHomeWins || undefined,
      h2hLosses: h2hAwayWins || undefined,
      homeRPG: homeHomeRPG ? parseFloat(homeHomeRPG) : undefined,
      homeERA: homeHomeERA ? parseFloat(homeHomeERA) : undefined,
      awayRPG: homeAwayRPG ? parseFloat(homeAwayRPG) : undefined,
      awayERA: homeAwayERA ? parseFloat(homeAwayERA) : undefined,
      homeRecord: homeHomeRecord || undefined,
      awayRecord: homeAwayRecord || undefined,
      seasonWinRate: homeSeasonWR ? parseFloat(homeSeasonWR) : undefined,
    };

    const awayTeamObj: MLBTeam = {
      name: awayTeam || "Visitante",
      ops: (parseFloat(awayOps) || 0.730) + aOpsDelta,
      rpg: ((parseFloat(awayRpg) || 4.5) * awaySosFactor) + aRpgDelta,
      obp: parseFloat(awayObp) || 0.320,
      avg: parseFloat(awayAvg) || 0.255,
      opsVsL: parseFloat(awayOpsVsL) || 0.720,
      opsVsR: parseFloat(awayOpsVsR) || 0.730,
      wOBA: awayWOBA !== undefined ? awayWOBA + aWobaDelta : awayWOBA,
      iso: awayISO,
      babip: awayBABIP,
      bullpenEra: (parseFloat(awayBpEra) || 3.80) + aEraDelta + aBpEraDelta2,
      bullpenWhip: parseFloat(awayBpWhip) || 1.25,
      bullpenEra14d: awayBpEra14d !== undefined ? awayBpEra14d + aBpEraDelta2 : undefined,
      bullpenIp48h: awayBpIp48h,
      bullpenTired: awayBpTired,
      closerAvailable: awayCloser,
      streak: parseInt(awayStreak) || 0,
      winRate: parseFloat(awayWinRate) || 0.55,
      travelPenalty: travelPenalty(getAwayTravelDistance(awayTeam || "", homeTeam || "", "mlb")),
      pitcher: awayPitcher,
      h2hWins: h2hAwayWins || undefined,
      h2hLosses: h2hHomeWins || undefined,
      homeRPG: awayHomeRPG ? parseFloat(awayHomeRPG) : undefined,
      homeERA: awayHomeERA ? parseFloat(awayHomeERA) : undefined,
      awayRPG: awayAwayRPG ? parseFloat(awayAwayRPG) : undefined,
      awayERA: awayAwayERA ? parseFloat(awayAwayERA) : undefined,
      homeRecord: awayHomeRecord || undefined,
      awayRecord: awayAwayRecord || undefined,
      seasonWinRate: awaySeasonWR ? parseFloat(awaySeasonWR) : undefined,
    };

    // FIX: Si windPark trae datos del endpoint, ya inflamos el RPG arriba.
    // Para evitar doble conteo, deshabilitamos windFavorable boolean cuando
    // ya tenemos windPark.runsAdjustment activo (que es la señal precisa).
    const windAlreadyApplied = !!(windPark?.runsAdjustment && Math.abs(windPark.runsAdjustment) > 0.05);
    // FIX auditoría: activar monthOfSeason e isPlayoff (antes muertos en el modelo)
    const now = new Date();
    const monthOfSeason = now.getMonth() + 1; // 1-12
    const isPlayoff = monthOfSeason >= 10;     // octubre+ = playoffs
    const ctx: MLBGameContext = {
      isHome: true,
      parkFactor: parseFloat(parkFactor) || 1.0,
      windFavorable: windAlreadyApplied ? false : windFavorable,
      tempF: parseInt(tempF) || 72,
      isNight,
      monthOfSeason,
      isPlayoff,
    };

    // Core predictions
    const mlOddsHomeNum = parseInt(mlOdds) || -150;
    const marketProb = americanToProb(mlOddsHomeNum);
    const rawHomeProb = predictMLB(homeTeamObj, awayTeamObj, ctx);
    const baseProb = rawHomeProb;

    // Medir impacto de lesiones: predict también SIN las lesiones para calcular delta
    const hasInjuries = Math.abs(hInjVal) > 0.001 || Math.abs(aInjVal) > 0.001;
    let injuryProbDelta = 0;
    let injuryTotalDelta = 0;
    const injuryDataQuality: "VERIFIED" | "DEGRADED" =
      homeInjuryFeed.status === "VERIFIED" && awayInjuryFeed.status === "VERIFIED"
        ? "VERIFIED"
        : "DEGRADED";
    if (hasInjuries) {
      const homeCleanObj: MLBTeam = {
        ...homeTeamObj,
        ops: parseFloat(homeOps) || 0.730,
        rpg: parseFloat(homeRpg) || 4.5,
        wOBA: homeWOBA,
        bullpenEra: parseFloat(homeBpEra) || 3.80,
      };
      const awayCleanObj: MLBTeam = {
        ...awayTeamObj,
        ops: parseFloat(awayOps) || 0.730,
        rpg: parseFloat(awayRpg) || 4.5,
        wOBA: awayWOBA,
        bullpenEra: parseFloat(awayBpEra) || 3.80,
      };
      const cleanProb = predictMLB(homeCleanObj, awayCleanObj, ctx);
      injuryProbDelta = (rawHomeProb - cleanProb) * 100; // pp
      const cleanTotal = predictTotalRuns(homeCleanObj, awayCleanObj, ctx);
      const dirtyTotal = predictTotalRuns(homeTeamObj, awayTeamObj, ctx);
      injuryTotalDelta = dirtyTotal - cleanTotal;
    }
    // Apply calibration (backtested k=1.4) then market regression
    const calibratedProb = mlbCalibrate(rawHomeProb);

    // REGRESIÓN ADAPTATIVA AL MERCADO
    // Cuantos más factores Élite tengamos detectados, MENOS regresamos al mercado
    // (porque tenemos info que las casas no procesan)
    const eliteFactorsActive = (
      (Math.abs(injuryProbDelta) >= 0.1 ? 1 : 0) +
      (Math.abs(injuryTotalDelta) >= 0.1 ? 1 : 0) +
      (lineupMatchup?.adjustment && (Math.abs(lineupMatchup.adjustment.homeRunsDelta) + Math.abs(lineupMatchup.adjustment.awayRunsDelta)) >= 0.1 ? 1 : 0) +
      ((Math.abs(archHomeRunsDelta) + Math.abs(archAwayRunsDelta)) >= 0.2 ? 1 : 0) +
      ((Math.abs(bpHomeRunsDelta) + Math.abs(bpAwayRunsDelta)) >= 0.1 ? 1 : 0) +
      ((Math.abs(ppHomeEraDelta) + Math.abs(ppAwayEraDelta)) >= 0.3 ? 1 : 0) +
      ((Math.abs(pvtHomeEraDelta) + Math.abs(pvtAwayEraDelta)) >= 0.3 ? 1 : 0) +
      (Math.abs(wpRunsAdjustment) >= 0.2 ? 1 : 0) +
      ((Math.abs(cfHomeEraDelta) + Math.abs(cfAwayEraDelta)) >= 0.15 ? 1 : 0) +
      (rookiePitcher?.rookieAlert ? 1 : 0) +
      ((Math.abs(pfHomeRivalRunsDelta) + Math.abs(pfAwayRivalRunsDelta)) >= 0.15 ? 1 : 0) +
      ((Math.abs(tfHomeOwnRunsDelta) + Math.abs(tfAwayOwnRunsDelta)) >= 0.15 ? 1 : 0) +
      (sharpDir?.mlSide && sharpDir.strength !== "none" ? 1 : 0) +
      ((Math.abs(prHomeRivalRunsDelta) + Math.abs(prAwayRivalRunsDelta)) >= 0.20 ? 1 : 0) +
      ((Math.abs(smHomeOwnRunsDelta) + Math.abs(smAwayOwnRunsDelta)) >= 0.20 ? 2 : 0) +
      (umpireData ? 1 : 0) +
      (advancedData && Math.abs(advancedData.totalAdjustment) >= 0.1 ? 1 : 0) +
      (mlbCtxAdj && (Math.abs(mlbCtxAdj.homeProbAdjPp) + Math.abs(mlbCtxAdj.totalAdj)) > 0.01 ? 1 : 0)
    );
    // Tabla de regresión adaptativa:
    // 0-2 factores → 25% (info débil, confiar más en mercado)
    // 3-5 factores → 15% (info media)
    // 6+ factores → 5% (info fuerte, confiar en nosotros)
    let adaptiveShrink: number;
    if (eliteFactorsActive >= 6) adaptiveShrink = 0.05;
    else if (eliteFactorsActive >= 3) adaptiveShrink = 0.15;
    else adaptiveShrink = 0.25;

    let homeProb = mlOdds ? mlbRegressToMarket(calibratedProb, marketProb, adaptiveShrink) : calibratedProb;

    // ÉLITE: aplicar ajuste por umpire HP
    const factorNotes: string[] = [];
    factorNotes.push(`Regresión al mercado: ${(adaptiveShrink * 100).toFixed(0)}% (${eliteFactorsActive} factores élite activos)`);
    if (Math.abs(injuryProbDelta) >= 0.1) {
      factorNotes.push(`Lesiones ${injuryProbDelta > 0 ? "+" : ""}${injuryProbDelta.toFixed(1)}pp`);
    }
    if (Math.abs(injuryTotalDelta) >= 0.1) {
      factorNotes.push(`Total lesiones ${injuryTotalDelta > 0 ? "+" : ""}${injuryTotalDelta.toFixed(1)} runs`);
    }
    // Matchup hombre-por-hombre lineup vs pitcher rival
    if (lineupMatchup?.adjustment) {
      const lmTotalRuns = (lineupMatchup.adjustment.homeRunsDelta || 0) + (lineupMatchup.adjustment.awayRunsDelta || 0);
      if (Math.abs(lmTotalRuns) >= 0.1) {
        const homeStr = lineupMatchup.adjustment.homeRunsDelta > 0 ? `+${lineupMatchup.adjustment.homeRunsDelta.toFixed(1)}` : lineupMatchup.adjustment.homeRunsDelta.toFixed(1);
        const awayStr = lineupMatchup.adjustment.awayRunsDelta > 0 ? `+${lineupMatchup.adjustment.awayRunsDelta.toFixed(1)}` : lineupMatchup.adjustment.awayRunsDelta.toFixed(1);
        factorNotes.push(`Lineup vs Pitcher (L:${homeStr} · V:${awayStr}) runs`);
      }
    }
    // Archetype matchup — patrón histórico vs tipo de pitcher
    if (Math.abs(archHomeRunsDelta) >= 0.2 || Math.abs(archAwayRunsDelta) >= 0.2) {
      const hStr = archHomeRunsDelta > 0 ? `+${archHomeRunsDelta.toFixed(1)}` : archHomeRunsDelta.toFixed(1);
      const aStr = archAwayRunsDelta > 0 ? `+${archAwayRunsDelta.toFixed(1)}` : archAwayRunsDelta.toFixed(1);
      factorNotes.push(`Arquetipo pitcher (L:${hStr} · V:${aStr}) runs`);
    }
    // Bullpen status — closer cansado / bullpen comprometido
    if (Math.abs(bpHomeRunsDelta) >= 0.1 || Math.abs(bpAwayRunsDelta) >= 0.1) {
      const hStr = bpHomeRunsDelta > 0 ? `+${bpHomeRunsDelta.toFixed(1)}` : bpHomeRunsDelta.toFixed(1);
      const aStr = bpAwayRunsDelta > 0 ? `+${bpAwayRunsDelta.toFixed(1)}` : bpAwayRunsDelta.toFixed(1);
      factorNotes.push(`Bullpen fatigue (L:${hStr} · V:${aStr}) runs`);
    }
    // Park-Pitcher — cómo le va al pitcher en este estadio
    if (Math.abs(ppHomeEraDelta) >= 0.3 || Math.abs(ppAwayEraDelta) >= 0.3) {
      const hStr = ppHomeEraDelta > 0 ? `+${ppHomeEraDelta.toFixed(2)}` : ppHomeEraDelta.toFixed(2);
      const aStr = ppAwayEraDelta > 0 ? `+${ppAwayEraDelta.toFixed(2)}` : ppAwayEraDelta.toFixed(2);
      factorNotes.push(`Park-Pitcher ERA Δ (L:${hStr} · V:${aStr})`);
    }
    // Pitcher vs Team — histórico contra este rival
    if (Math.abs(pvtHomeEraDelta) >= 0.3 || Math.abs(pvtAwayEraDelta) >= 0.3) {
      const hStr = pvtHomeEraDelta > 0 ? `+${pvtHomeEraDelta.toFixed(2)}` : pvtHomeEraDelta.toFixed(2);
      const aStr = pvtAwayEraDelta > 0 ? `+${pvtAwayEraDelta.toFixed(2)}` : pvtAwayEraDelta.toFixed(2);
      factorNotes.push(`Pitcher vs Team Δ (L:${hStr} · V:${aStr})`);
    }
    // Wind-Park — viento + estadio
    if (Math.abs(wpRunsAdjustment) >= 0.2) {
      const wpStr = wpRunsAdjustment > 0 ? `+${wpRunsAdjustment.toFixed(2)}` : wpRunsAdjustment.toFixed(2);
      factorNotes.push(`Wind-Park ${wpStr} runs`);
    }
    // Catcher Framing — catcher élite o pobre
    if (Math.abs(cfHomeEraDelta) >= 0.10 || Math.abs(cfAwayEraDelta) >= 0.10) {
      const hStr = cfHomeEraDelta > 0 ? `+${cfHomeEraDelta.toFixed(2)}` : cfHomeEraDelta.toFixed(2);
      const aStr = cfAwayEraDelta > 0 ? `+${cfAwayEraDelta.toFixed(2)}` : cfAwayEraDelta.toFixed(2);
      factorNotes.push(`Catcher framing ΔERA (L:${hStr} · V:${aStr})`);
    }
    // Rookie Pitcher Penalty
    if (rookiePitcher?.rookieAlert) {
      factorNotes.push(`⚠️ Rookie/Bullpen game detectado — confianza reducida`);
    } else if (Math.abs(rookieHomeRunsDelta) >= 0.3 || Math.abs(rookieAwayRunsDelta) >= 0.3) {
      const hStr = rookieHomeRunsDelta > 0 ? `+${rookieHomeRunsDelta.toFixed(1)}` : rookieHomeRunsDelta.toFixed(1);
      const aStr = rookieAwayRunsDelta > 0 ? `+${rookieAwayRunsDelta.toFixed(1)}` : rookieAwayRunsDelta.toFixed(1);
      factorNotes.push(`Pitcher inexperto (L:${hStr} · V:${aStr}) runs`);
    }
    // Hueco #1 + #2: Pitcher Form (descanso + splits H/R)
    if (Math.abs(pfHomeRivalRunsDelta) >= 0.15 || Math.abs(pfAwayRivalRunsDelta) >= 0.15) {
      const hStr = pfAwayRivalRunsDelta > 0 ? `+${pfAwayRivalRunsDelta.toFixed(2)}` : pfAwayRivalRunsDelta.toFixed(2);
      const aStr = pfHomeRivalRunsDelta > 0 ? `+${pfHomeRivalRunsDelta.toFixed(2)}` : pfHomeRivalRunsDelta.toFixed(2);
      factorNotes.push(`SP forma/descanso (RPG L:${hStr} · V:${aStr})`);
    }
    // Hueco #3: Team Fatigue
    if (Math.abs(tfHomeOwnRunsDelta) >= 0.15 || Math.abs(tfAwayOwnRunsDelta) >= 0.15) {
      const hStr = tfHomeOwnRunsDelta > 0 ? `+${tfHomeOwnRunsDelta.toFixed(2)}` : tfHomeOwnRunsDelta.toFixed(2);
      const aStr = tfAwayOwnRunsDelta > 0 ? `+${tfAwayOwnRunsDelta.toFixed(2)}` : tfAwayOwnRunsDelta.toFixed(2);
      factorNotes.push(`Fatiga/travel (L:${hStr} · V:${aStr}) RPG`);
    }
    // Post-mortem fix: SP recent form (implosion / cold / early-exit)
    if (pitcherRecent?.home?.trend === "IMPLOSION" || pitcherRecent?.home?.trend === "COLD") {
      factorNotes.push(`🔥 SP local ${pitcherRecent.home.trend} — ERA reciente ${pitcherRecent.home.recentEra.toFixed(2)}`);
    }
    if (pitcherRecent?.away?.trend === "IMPLOSION" || pitcherRecent?.away?.trend === "COLD") {
      factorNotes.push(`🔥 SP visit ${pitcherRecent.away.trend} — ERA reciente ${pitcherRecent.away.recentEra.toFixed(2)}`);
    }
    if (pitcherRecent?.home?.earlyExitRisk || pitcherRecent?.away?.earlyExitRisk) {
      factorNotes.push(`⚡ Riesgo salida temprana SP — bullpen cubre más IP`);
    }
    // ⚡ STATCAST pitch-by-pitch
    if (Math.abs(smHomeOwnRunsDelta) >= 0.20 || Math.abs(smAwayOwnRunsDelta) >= 0.20) {
      const hStr = smHomeOwnRunsDelta > 0 ? `+${smHomeOwnRunsDelta.toFixed(2)}` : smHomeOwnRunsDelta.toFixed(2);
      const aStr = smAwayOwnRunsDelta > 0 ? `+${smAwayOwnRunsDelta.toFixed(2)}` : smAwayOwnRunsDelta.toFixed(2);
      factorNotes.push(`⚡ Statcast pitch-by-pitch (L:${hStr} · V:${aStr}) RPG`);
    }
    if (umpireData) {
      const probPreUmp = homeProb;
      const hEra = parseFloat(homeEra) || 4.0;
      const aEra = parseFloat(awayEra) || 4.0;
      homeProb = applyUmpireAdjustment(homeProb, umpireData, hEra, aEra);
      const umpDelta = (homeProb - probPreUmp) * 100;
      if (Math.abs(umpDelta) >= 0.1) {
        factorNotes.push(`Umpire ${umpDelta > 0 ? "+" : ""}${umpDelta.toFixed(1)}pp`);
      }
    }

    // awayProb se calcula al final, después de TODOS los ajustes a homeProb
    // (umpire, contextual, rookie cap)

    let f5HomeProb = predictF5(homeTeamObj, awayTeamObj, ctx);

    // ─── FIX #1+#2+#3+#6: F5 hereda factores élite que faltaban (sharp, umpire, contextual, sanity) ───
    // Antes F5 dependia 100% de pitcher+offense. Ahora absorbe los mismos ajustes ML
    // pero a 50% de magnitud (las primeras 5 entradas son menos sensibles a contexto).
    if (sharpDir?.mlSide && sharpDir.strength !== "none") {
      const sharpToHome = sharpDir.mlSide === "home";
      const baseShift = (sharpDir.strength === "strong" ? 0.04 : 0.02) * 0.5;
      const modelOnHome = f5HomeProb >= 0.5;
      const sameSide = (sharpToHome && modelOnHome) || (!sharpToHome && !modelOnHome);
      const shift = sameSide ? baseShift * 0.4 : baseShift;
      f5HomeProb = Math.max(0.05, Math.min(0.95, f5HomeProb + (sharpToHome ? +shift : -shift)));
    }
    if (umpireData) {
      const hEra = parseFloat(homeEra) || 4.0;
      const aEra = parseFloat(awayEra) || 4.0;
      f5HomeProb = applyUmpireAdjustment(f5HomeProb, umpireData, hEra, aEra);
    }
    if (mlbCtxAdj.homeProbAdjPp !== 0) {
      f5HomeProb = Math.max(0.05, Math.min(0.95, f5HomeProb + (mlbCtxAdj.homeProbAdjPp / 100) * 0.5));
    }
    // CALIBRACIÓN F5 vs MERCADO (mismo patrón ML, 65/35) — usa cuota F5 real si existe; si no, ML como proxy débil
    let modelF5HomeProb = f5HomeProb;
    let marketF5HomeProb: number | undefined;
    const f5MlHomeNumPre = parseInt(f5MlHome) || 0;
    const f5MarketSourceOdds = f5MlHomeNumPre !== 0 ? f5MlHomeNumPre : mlOddsHomeNum;
    if (f5MarketSourceOdds) {
      marketF5HomeProb = americanToProb(f5MarketSourceOdds);
      let calF5 = f5HomeProb * 0.65 + marketF5HomeProb * 0.35;
      const gap = f5HomeProb - marketF5HomeProb;
      if (Math.abs(gap) >= 0.25 && (f5HomeProb >= 0.80 || f5HomeProb <= 0.20)) {
        calF5 = (calF5 + (marketF5HomeProb + gap * 0.4)) / 2;
      }
      f5HomeProb = Math.max(0.05, Math.min(0.95, calF5));
    }
    const f5AwayProb = 1 - f5HomeProb;

    const baseTotal = predictTotalRuns(homeTeamObj, awayTeamObj, ctx);
    let estimatedTotal = baseTotal;

    // ÉLITE: aplicar ajuste de umpire al total (con guarda anti-NaN)
    if (umpireData && typeof umpireData.runAdj === "number" && !isNaN(umpireData.runAdj)) {
      const adjTotal = applyUmpireTotalAdjustment(estimatedTotal, umpireData);
      if (!isNaN(adjTotal) && Math.abs(adjTotal - estimatedTotal) >= 0.1) {
        factorNotes.push(`Total umpire ${adjTotal > estimatedTotal ? "+" : ""}${(adjTotal - estimatedTotal).toFixed(1)} runs`);
      }
      if (!isNaN(adjTotal)) estimatedTotal = adjTotal;
    }

    // ÉLITE: aplicar Park + Weather + Opener al total (con guarda anti-NaN)
    if (advancedData && typeof advancedData.totalAdjustment === "number" && !isNaN(advancedData.totalAdjustment) && advancedData.totalAdjustment !== 0) {
      estimatedTotal += advancedData.totalAdjustment;
      factorNotes.push(`Park+Weather+Opener ${advancedData.totalAdjustment > 0 ? "+" : ""}${advancedData.totalAdjustment.toFixed(1)} runs`);
      // FIX #5: Park/Weather Advanced AHORA también ajusta homeProb leve.
      // Un parque pitcher-friendly favorece al equipo con peor SP (más coin-flip);
      // un parque hitter-friendly favorece al equipo con mejor ofensiva.
      // Ajuste pondrado: 1 run de adjustment ≈ ±1.5pp homeProb dependiendo de quién tiene ventaja
      const homeOffenseEdge = (parseFloat(homeOps) || 0.730) - (parseFloat(awayOps) || 0.730);
      const parkEffect = advancedData.totalAdjustment * 0.015 * Math.sign(homeOffenseEdge || 0.001);
      if (Math.abs(parkEffect) >= 0.005) {
        homeProb = Math.max(0.05, Math.min(0.95, homeProb + parkEffect));
        f5HomeProb = Math.max(0.05, Math.min(0.95, f5HomeProb + parkEffect * 0.5));
      }
    }

    // ÉLITE: aplicar contextuales (serie, divisional, rivalidad)
    if (mlbCtxAdj.homeProbAdjPp !== 0) {
      homeProb = Math.max(0.05, Math.min(0.95, homeProb + mlbCtxAdj.homeProbAdjPp / 100));
      factorNotes.push(`Contextual ${mlbCtxAdj.homeProbAdjPp > 0 ? "+" : ""}${mlbCtxAdj.homeProbAdjPp.toFixed(1)}pp`);
    }
    if (mlbCtxAdj && typeof mlbCtxAdj.totalAdj === "number" && !isNaN(mlbCtxAdj.totalAdj) && mlbCtxAdj.totalAdj !== 0) {
      estimatedTotal += mlbCtxAdj.totalAdj;
      factorNotes.push(`Contextual total ${mlbCtxAdj.totalAdj > 0 ? "+" : ""}${mlbCtxAdj.totalAdj.toFixed(1)} runs`);
    }

    // ÉLITE: aplicar reducción de confianza por rookie/bullpen-game pitcher
    // Si el SP es rookie/inexperto, el modelo no puede confiar tanto en el favorito.
    // Tira la prob del favorito hacia 0.50 con el factor cap (0.85 fuerte / 0.92 medio).
    if (rookieConfidenceCap < 1.0) {
      const probPreCap = homeProb;
      homeProb = 0.5 + (homeProb - 0.5) * rookieConfidenceCap;
      const capDelta = (homeProb - probPreCap) * 100;
      factorNotes.push(`Rookie cap x${rookieConfidenceCap.toFixed(2)} (${capDelta > 0 ? "+" : ""}${capDelta.toFixed(1)}pp local)`);
    }

    // Hueco #4: SHARP SIGNALS entran al modelo (antes solo eran badge informativo)
    // Si el dinero pesado se está yendo a un lado y nuestro modelo va al opuesto,
    // hay que escuchar al mercado: 2pp si es señal débil, 4pp si es steam (strong).
    // Si el sharp side coincide con nuestro favorito, refuerza ligeramente.
    if (sharpDir?.mlSide && sharpDir.strength !== "none") {
      const sharpToHome = sharpDir.mlSide === "home";
      const probPreSharp = homeProb;
      const baseShift = sharpDir.strength === "strong" ? 0.04 : 0.02;
      // Reduce el shift si vamos al MISMO lado que sharp (ya estamos de acuerdo)
      const modelOnHome = homeProb >= 0.5;
      const sameSide = (sharpToHome && modelOnHome) || (!sharpToHome && !modelOnHome);
      const shift = sameSide ? baseShift * 0.4 : baseShift; // refuerzo más débil cuando ya coincide
      const direction = sharpToHome ? +shift : -shift;
      homeProb = Math.max(0.05, Math.min(0.95, homeProb + direction));
      const sharpDelta = (homeProb - probPreSharp) * 100;
      factorNotes.push(`Sharp ${sharpDir.strength === "strong" ? "\ud83d\udd25STEAM" : "se\u00f1al"} → ${sharpDir.mlSide.toUpperCase()} (${sharpDelta > 0 ? "+" : ""}${sharpDelta.toFixed(1)}pp local)`);
    }

    // ── CALIBRACIÓN ML vs MERCADO (65% modelo + 35% mercado) ──
    // Aplicada SIEMPRE para coherencia con Run Line y O/U.
    // El modelo ML puro es una opinión; el mercado es información agregada.
    // El número final es siempre la mezcla calibrada.
    let modelHomeProb = homeProb;  // probabilidad pura del modelo (post todos los factores élite)
    let marketHomeProbCal: number | undefined;
    if (mlOddsHomeNum) {
      marketHomeProbCal = americanToProb(mlOddsHomeNum);
      const gap = homeProb - marketHomeProbCal;
      // Calibración base 65/35
      let calibratedHome = homeProb * 0.65 + marketHomeProbCal * 0.35;
      // Cap extremo adicional: si gap >25pp Y prob muy alta/baja, jalar más fuerte
      if (Math.abs(gap) >= 0.25 && (homeProb >= 0.80 || homeProb <= 0.20)) {
        const probPreCap = calibratedHome;
        const extraPull = marketHomeProbCal + gap * 0.4; // jala más cerca del mercado en extremos
        calibratedHome = (calibratedHome + extraPull) / 2;
        factorNotes.push(`⚠️ Sanity extremo activado (gap ${Math.abs(gap*100).toFixed(0)}pp)`);
      }
      const calDelta = (calibratedHome - homeProb) * 100;
      homeProb = Math.max(0.05, Math.min(0.95, calibratedHome));
      if (Math.abs(calDelta) >= 0.5) {
        factorNotes.push(`Calibración mercado (${(marketHomeProbCal*100).toFixed(0)}%) → ${calDelta > 0 ? "+" : ""}${calDelta.toFixed(1)}pp`);
      }
    }

    // Calcular awayProb DESPUÉS de todos los ajustes a homeProb
    const awayProb = 1 - homeProb;

    const estimatedF5Total = predictF5Total(homeTeamObj, awayTeamObj, ctx);

    const runLineVal = parseFloat(runLine) || -1.5;
    const runLineResult = evaluateRunLine(homeProb, runLineVal, parseInt(rlOdds) || undefined, parseInt(rlOddsAway) || undefined);

    const ouLineVal = parseFloat(ouLine) || 8.5;
    const ouResult = evaluateMLBTotal(estimatedTotal, ouLineVal, parseInt(overOdds) || undefined, parseInt(underOdds) || undefined);

    const f5OuLineVal = f5OuLine ? parseFloat(f5OuLine) : null;
    // F5 O/U: usa las mismas odds que O/U full (asumimos similar pricing)
    const f5OuResult = f5OuLineVal !== null ? evaluateMLBTotal(estimatedF5Total, f5OuLineVal, parseInt(overOdds) || undefined, parseInt(underOdds) || undefined) : null;

    // Poisson
    const poisson = mlbPoissonTotal(homeTeamObj, awayTeamObj, ctx, ouLineVal);

    // Safe Play
    const safePlay = mlbFindSafePlay(homeTeamObj, awayTeamObj, ctx, homeProb, poisson, ouLineVal, runLineVal);

    // Alt Lines
    const altLines = mlbGenerateAltLines(
      homeProb, runLineVal, ouLineVal, estimatedTotal,
      homeTeam || "Local", awayTeam || "Visitante"
    );

    // ML edge — evaluar AMBOS lados (no solo local)
    const mlOddsAwayNum = parseInt(mlOddsAway) || 130;
    const impliedHomeML = americanToProb(mlOddsHomeNum);
    const impliedAwayML = americanToProb(mlOddsAwayNum);
    const mlEdgeHome = mlbGetEdge(homeProb, impliedHomeML);
    const mlEdgeAway = mlbGetEdge(1 - homeProb, impliedAwayML);
    // FIX: el lado recomendado siempre es el que el MODELO cree ganador (>50%).
    // Antes el sistema recomendaba el lado con mayor edge matemático aunque el modelo
    // no lo vea ganar (value betting puro). Con modelos imperfectos, apostar contra
    // la propia predicción es regalar dinero. Ahora directional betting.
    const pickedSide: "home" | "away" = homeProb >= 0.5 ? "home" : "away";
    const mlEdgeVal = pickedSide === "home" ? mlEdgeHome : mlEdgeAway;
    const recommendedOdds = pickedSide === "home" ? mlOddsHomeNum : mlOddsAwayNum;
    const mlPickProb = pickedSide === "home" ? homeProb : (1 - homeProb);
    const impliedProb = pickedSide === "home" ? impliedHomeML : impliedAwayML;
    // ÉLITE: 70% confianza mínimo para BET
    const mlSignal = mlbGetSignal(mlEdgeVal, mlPickProb);

    // F5 edge — same bilateral evaluation (uses same ML odds approx)
    const f5EdgeHome = mlbGetEdge(f5HomeProb, impliedHomeML);
    const f5EdgeAway = mlbGetEdge(1 - f5HomeProb, impliedAwayML);
    // FIX directional betting: lado recomendado = el que el modelo F5 cree ganador.
    const f5PickedSide: "home" | "away" = f5HomeProb >= 0.5 ? "home" : "away";
    const f5EdgeVal = f5PickedSide === "home" ? f5EdgeHome : f5EdgeAway;
    const f5MlHomeNumRec = parseInt(f5MlHome) || 0;
    const f5MlAwayNumRec = parseInt(f5MlAway) || 0;
    const f5RecommendedOdds = f5PickedSide === "home"
      ? (f5MlHomeNumRec !== 0 ? f5MlHomeNumRec : mlOddsHomeNum)
      : (f5MlAwayNumRec !== 0 ? f5MlAwayNumRec : mlOddsAwayNum);
    const f5PickProb = f5PickedSide === "home" ? f5HomeProb : (1 - f5HomeProb);
    const f5Signal = mlbGetSignal(f5EdgeVal, f5PickProb);

    // Determine favored team name (matches picked side)
    const favTeam = pickedSide === "home" ? (homeTeam || "Local") : (awayTeam || "Visitante");
    const favF5Team = f5PickedSide === "home" ? (homeTeam || "Local") : (awayTeam || "Visitante");

    // Build confidence scores
    const mlConfidence = Math.round(Math.min(95, Math.max(50, Math.max(homeProb, awayProb) * 100)));
    const f5Confidence = Math.round(Math.min(95, Math.max(50, Math.max(f5HomeProb, f5AwayProb) * 100)));
    // FIX: confianza Run Line ahora usa la probabilidad Poisson real de cubrir,
    // no una heurística lineal sobre margen. Coherente con la sección Run Line.
    const rlAbsMargin = Math.abs(runLineResult.expectedMargin);
    const rlCoverProb = (runLineResult as any).coverProb ?? (runLineResult.coversRL ? 0.56 : 0.44);
    const rlConfidence = Math.round(Math.min(95, Math.max(50, rlCoverProb * 100)));
    const ouAbsDiff = Math.abs(ouResult.edge);
    const ouConfidence = Math.round(Math.min(90, 50 + ouAbsDiff * 6));
    const f5OuConfidence = f5OuResult ? Math.round(Math.min(90, 50 + Math.abs(f5OuResult.edge) * 6)) : 0;

    // Build candidate plays
    const candidates: MLBBestPlay[] = [
      {
        market: "ML",
        recommendation: `${favTeam} gana el partido (ML)`,
        signal: mlSignal,
        edgeLabel: `Edge ${mlEdgeVal.toFixed(1)}%`,
        confidence: mlConfidence,
        reason: "Análisis completo: pitching, ofensiva, bullpen y contexto",
      },
      {
        market: "F5",
        recommendation: `${favF5Team} lidera tras 5 entradas (F5)`,
        signal: f5Signal,
        edgeLabel: `Edge ${f5EdgeVal.toFixed(1)}%`,
        confidence: f5Confidence,
        reason: "Pitcher abridor domina las primeras 5 entradas",
      },
      {
        market: "Run Line",
        recommendation: `${runLineResult.pickedSide === "home" ? (homeTeam || "Local") : (awayTeam || "Visitante")} ${runLineResult.side.replace(/^Local |^Visitante /, "")}`,
        signal: runLineResult.signal,
        edgeLabel: `Margen: ${runLineResult.expectedMargin.toFixed(2)}`,
        confidence: rlConfidence,
        reason: "Basado en diferencial de calidad entre equipos",
      },
      {
        market: "O/U",
        recommendation: `${ouResult.side === "OVER" ? "Más" : "Menos"} de ${ouLineVal} carreras (${ouResult.side})`,
        signal: ouResult.signal,
        edgeLabel: `Total est: ${estimatedTotal.toFixed(1)}`,
        confidence: ouConfidence,
        reason: "Proyección de carreras vs línea de la casa",
      },
    ];

    if (f5OuResult && f5OuLineVal !== null) {
      candidates.push({
        market: "F5 O/U",
        recommendation: `${f5OuResult.side === "OVER" ? "Más" : "Menos"} de ${f5OuLineVal} en primeras 5 (F5 ${f5OuResult.side})`,
        signal: f5OuResult.signal,
        edgeLabel: `F5 est: ${estimatedF5Total.toFixed(1)}`,
        confidence: f5OuConfidence,
        reason: "Total primeras 5 entradas vs línea",
      });
    }

    const bestPlay = mlbGetBestPlay(candidates);

    setResult({
      homeProb,
      awayProb,
      f5HomeProb,
      f5AwayProb,
      estimatedTotal,
      estimatedF5Total,
      runLine: runLineResult,
      ouResult,
      f5OuResult,
      mlEdge: mlEdgeVal,
      mlSignal,
      f5Edge: f5EdgeVal,
      f5Signal,
      pickQualities: (() => {
        // Common inputs
        const sharpAgainstML = !!sharpDir?.mlSide && sharpDir.strength !== "none" && (
          (sharpDir.mlSide === "home" && pickedSide === "away") ||
          (sharpDir.mlSide === "away" && pickedSide === "home")
        );
        const sharpStrong = sharpDir?.strength === "strong";
        const recentImplosion = pitcherRecent?.home?.trend === "IMPLOSION" || pitcherRecent?.away?.trend === "IMPLOSION";
        const statcastDataQuality: "OK" | "MISSING" = statcastMatchup ? "OK" : "MISSING";
        const statcastSignal = Math.abs((statcastMatchup?.homeRunsDelta ?? 0) - (statcastMatchup?.awayRunsDelta ?? 0));
        const rookieAlert = !!rookiePitcher?.rookieAlert;

        // ML PQS
        const sideProbML = pickedSide === "away" ? (1 - homeProb) : homeProb;
        const sideOddsML = pickedSide === "away" ? (mlOddsAwayNum ?? 0) : (mlOddsHomeNum ?? 0);
        const impliedML = sideOddsML > 0 ? 100 / (sideOddsML + 100) : (-sideOddsML) / ((-sideOddsML) + 100);
        const marketGapML = marketHomeProbCal !== undefined ? Math.abs(modelHomeProb - marketHomeProbCal) : 0;
        const ml = computePickQualityGeneric({
          market: "ML", modelProb: sideProbML, marketImpliedProb: impliedML, oddsAmerican: sideOddsML,
          pickedSideLabel: pickedSide === "away" ? (awayTeam || "Visitante") : (homeTeam || "Local"),
          marketGap: marketGapML, eliteFactorsActive, rookieAlert, recentImplosion,
          statcastDataQuality, statcastSignal, injuryProbDelta, injuryDataQuality,
          sharpAgainst: sharpAgainstML, sharpStrong,
        });

        // F5 PQS — SOLO si tenemos cuotas F5 reales (Hard Rock manual o consenso FD/BetMGM)
        const f5PickedSideLocal: "home" | "away" = f5HomeProb >= f5AwayProb ? "home" : "away";
        const f5Prob = f5PickedSideLocal === "away" ? f5AwayProb : f5HomeProb;
        const f5MlHomeNum = parseInt(f5MlHome) || 0;
        const f5MlAwayNum = parseInt(f5MlAway) || 0;
        const hasF5Odds = f5MlHomeNum !== 0 && f5MlAwayNum !== 0;
        let f5: any;
        if (!hasF5Odds) {
          // Sin cuotas F5 reales no podemos calcular edge ni PQS — honestidad sobre optimismo
          f5 = {
            market: "F5" as const,
            score: 0,
            rating: "F" as const,
            recommendation: "PASS" as const,
            stakeUnits: 0,
            edgeReal: 0,
            factorsAlignment: eliteFactorsActive,
            marketGap: 0,
            warnings: ["Falta cuota F5 — ingresa la cuota de Hard Rock o usa ⚡ Cuotas F5 (consenso)"],
            confirms: [],
            reasoning: "Sin cuota F5 ingresada no se puede calcular edge ni PQS. Hard Rock no expone F5 vía API — míralo en la app y cópialo, o usa el botón de consenso.",
            pickedSideLabel: f5PickedSideLocal === "away" ? (awayTeam || "Visitante") : (homeTeam || "Local"),
            pickedSideOdds: 0,
            pickedSideExtra: "F5",
          };
        } else {
          const f5Odds = f5PickedSideLocal === "away" ? f5MlAwayNum : f5MlHomeNum;
          const f5Implied = f5Odds > 0 ? 100 / (f5Odds + 100) : (-f5Odds) / ((-f5Odds) + 100);
          const f5MarketGap = marketF5HomeProb !== undefined ? Math.abs(modelF5HomeProb - marketF5HomeProb) : 0;
          f5 = computePickQualityGeneric({
            market: "F5", modelProb: f5Prob, marketImpliedProb: f5Implied, oddsAmerican: f5Odds,
            pickedSideLabel: f5PickedSideLocal === "away" ? (awayTeam || "Visitante") : (homeTeam || "Local"),
            pickedSideExtra: "F5",
            marketGap: f5MarketGap, eliteFactorsActive, rookieAlert, recentImplosion,
            statcastDataQuality, statcastSignal, injuryProbDelta, injuryDataQuality,
            sharpAgainst: sharpAgainstML, sharpStrong,
          });
          // Si la fuente fue consenso (no manual de HR), avisar sobre incertidumbre de precio
          if (f5OddsSource === "consenso") {
            (f5.warnings = f5.warnings || []).push("Cuota F5 = consenso FD/BetMGM/DK. Verifica precio en Hard Rock antes de apostar.");
          }
        }

        // Run Line PQS
        const rlSideOdds = runLineResult.pickedSide === "away" ? (parseInt(rlOddsAway) || -110) : (parseInt(rlOdds) || -110);
        const rlImplied = rlSideOdds > 0 ? 100 / (rlSideOdds + 100) : (-rlSideOdds) / ((-rlSideOdds) + 100);
        const rlModelProb = (runLineResult as any).coverProb ?? 0.5;
        const rlMarketProb = (runLineResult as any).marketCoverProb ?? rlImplied;
        const rlMarketGap = Math.abs(((runLineResult as any).modelCoverProb ?? rlModelProb) - rlMarketProb);
        const runLine = computePickQualityGeneric({
          market: "RUN_LINE", modelProb: rlModelProb, marketImpliedProb: rlImplied, oddsAmerican: rlSideOdds,
          pickedSideLabel: runLineResult.pickedSide === "away" ? (awayTeam || "Visitante") : (homeTeam || "Local"),
          pickedSideExtra: runLineResult.side,
          marketGap: rlMarketGap, eliteFactorsActive, rookieAlert, recentImplosion,
          statcastDataQuality, statcastSignal, injuryProbDelta, injuryDataQuality,
          sharpAgainst: false, sharpStrong: false, // sharps de RL no se trackean separado
        });

        // O/U PQS
        const ouSideOdds = ouResult.side === "OVER" ? (parseInt(overOdds) || -110) : (parseInt(underOdds) || -110);
        const ouImplied = ouSideOdds > 0 ? 100 / (ouSideOdds + 100) : (-ouSideOdds) / ((-ouSideOdds) + 100);
        const ouModelProb = (ouResult as any).hitProb ?? 0.5;
        const ouMarketProb = (ouResult as any).marketHitProb ?? ouImplied;
        const ouMarketGap = Math.abs(((ouResult as any).modelHitProb ?? ouModelProb) - ouMarketProb);
        const ou = computePickQualityGeneric({
          market: "O/U", modelProb: ouModelProb, marketImpliedProb: ouImplied, oddsAmerican: ouSideOdds,
          pickedSideLabel: ouResult.side === "OVER" ? `Over ${ouLineVal}` : `Under ${ouLineVal}`,
          marketGap: ouMarketGap, eliteFactorsActive, rookieAlert, recentImplosion,
          statcastDataQuality, statcastSignal, injuryProbDelta, injuryDataQuality,
          sharpAgainst: false, sharpStrong: false,
        });

        return { ml, f5, runLine, ou };
      })(),
      impliedProb,
      pickedSide,
      recommendedOdds,
      f5PickedSide,
      f5RecommendedOdds,
      homeTeamName: homeTeam || "Local",
      awayTeamName: awayTeam || "Visitante",
      ouLine: ouLineVal,
      f5OuLine: f5OuLineVal,
      bestPlay,
      poisson,
      safePlay,
      altLines,
      factorBreakdown: {
        baseProb: baseProb * 100,
        finalProb: homeProb * 100,
        baseTotal,
        finalTotal: estimatedTotal,
        injuryHomeProbabilityDeltaPp: injuryProbDelta,
        injuryTotalRunsDelta: injuryTotalDelta,
        injuryDataQuality,
        injuryHasAppliedAdjustment: hasInjuries,
        notes: factorNotes,
        modelHomeProb: modelHomeProb * 100,
        marketHomeProb: marketHomeProbCal !== undefined ? marketHomeProbCal * 100 : undefined,
        modelF5HomeProb: modelF5HomeProb * 100,
        marketF5HomeProb: marketF5HomeProb !== undefined ? marketF5HomeProb * 100 : undefined,
      },
    });

    toast({ title: "Predicción generada", description: "Análisis MLB completado" });
  }, [
    homeTeam, awayTeam,
    homeEra, homeWhip, homeFip, homeK9, homeBb9, homeRest, homeHand, homeRecord, homeRecentEra, homeIP,
    homeOps, homeRpg, homeObp, homeAvg, homeOpsVsL, homeOpsVsR,
    homeWOBA, homeISO, homeBABIP, awayWOBA, awayISO, awayBABIP,
    homeHR, homeWalks, homeStrikeouts, awayHR, awayWalks, awayStrikeouts,
    homeBpEra, homeBpWhip, homeBpTired, homeCloser, homeBpEra14d, homeBpIp48h, homePitcherGS,
    homeKPct, homeBbPct, homeSiera,
    homeStreak, homeWinRate,
    homeInjury, homeInjuryFactors, awayInjury, awayInjuryFactors, homeInjuryFeed, awayInjuryFeed,
    lineupMatchup, archetypeMatchup, bullpenStatus, parkPitcher, pitcherVsTeam, windPark, catcherFraming, rookiePitcher,
    pitcherForm, teamFatigue, pitcherRecent, statcastMatchup, sharpDir,
    mlbCtxAdj,
    awayEra, awayWhip, awayFip, awayK9, awayBb9, awayRest, awayHand, awayRecord, awayRecentEra, awayIP,
    awayOps, awayRpg, awayObp, awayAvg, awayOpsVsL, awayOpsVsR,
    awayBpEra, awayBpWhip, awayBpTired, awayCloser, awayBpEra14d, awayBpIp48h, awayPitcherGS,
    awayKPct, awayBbPct, awaySiera,
    awayStreak, awayWinRate,
    parkFactor, tempF, windFavorable, isNight,
    mlOdds, mlOddsAway, runLine, ouLine, f5OuLine, f5MlHome, f5MlAway, f5OddsSource,
    h2hHomeWins, h2hAwayWins,
    homeHomeRPG, homeHomeERA, homeAwayRPG, homeAwayERA,
    awayHomeRPG, awayHomeERA, awayAwayRPG, awayAwayERA,
    homeSeasonWR, awaySeasonWR,
    umpireData, advancedData,
    toast,
  ]);

  // ── INLINE HELPERS (not components) ───────────────────────────────────────
  const numInput = (
    label: string,
    value: string,
    setter: (v: string) => void,
    testid: string,
    mode: "decimal" | "numeric" = "decimal",
    placeholder?: string
  ) => (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="text"
        inputMode={mode}
        value={value}
        onChange={(e) => setter(e.target.value)}
        data-testid={testid}
        placeholder={placeholder ?? ""}
        className="mt-1"
      />
    </div>
  );

  // ── TEAM CARD BUILDER (inline function returning JSX, not a component) ─────
  const buildTeamCard = (side: "home" | "away") => {
    const isHome = side === "home";
    const label = isHome ? "Local" : "Visitante";
    const borderColor = isHome ? "border-blue-500/30" : "border-purple-500/30";
    const titleColor = isHome ? "text-blue-400" : "text-purple-400";

    // State references
    const team = isHome ? homeTeam : awayTeam;
    const setTeam = isHome ? (v: string) => (isHome ? handleHomeTeamChange(v) : setAwayTeam(v)) : setAwayTeam;
    const pitcherName = isHome ? homePitcherName : awayPitcherName;
    const era = isHome ? homeEra : awayEra;
    const setEra = isHome ? setHomeEra : setAwayEra;
    const whip = isHome ? homeWhip : awayWhip;
    const setWhip = isHome ? setHomeWhip : setAwayWhip;
    const fip = isHome ? homeFip : awayFip;
    const setFip = isHome ? setHomeFip : setAwayFip;
    const k9 = isHome ? homeK9 : awayK9;
    const setK9 = isHome ? setHomeK9 : setAwayK9;
    const bb9 = isHome ? homeBb9 : awayBb9;
    const setBb9 = isHome ? setHomeBb9 : setAwayBb9;
    const rest = isHome ? homeRest : awayRest;
    const setRest = isHome ? setHomeRest : setAwayRest;
    const hand = isHome ? homeHand : awayHand;
    const setHand = isHome ? setHomeHand : setAwayHand;
    const record = isHome ? homeRecord : awayRecord;
    const setRecord = isHome ? setHomeRecord : setAwayRecord;
    const recentEra = isHome ? homeRecentEra : awayRecentEra;
    const setRecentEra = isHome ? setHomeRecentEra : setAwayRecentEra;
    const ops = isHome ? homeOps : awayOps;
    const setOps = isHome ? setHomeOps : setAwayOps;
    const rpg = isHome ? homeRpg : awayRpg;
    const setRpg = isHome ? setHomeRpg : setAwayRpg;
    const obp = isHome ? homeObp : awayObp;
    const setObp = isHome ? setHomeObp : setAwayObp;
    const avg = isHome ? homeAvg : awayAvg;
    const setAvg = isHome ? setHomeAvg : setAwayAvg;
    const opsVsL = isHome ? homeOpsVsL : awayOpsVsL;
    const setOpsVsL = isHome ? setHomeOpsVsL : setAwayOpsVsL;
    const opsVsR = isHome ? homeOpsVsR : awayOpsVsR;
    const setOpsVsR = isHome ? setHomeOpsVsR : setAwayOpsVsR;
    const bpEra = isHome ? homeBpEra : awayBpEra;
    const setBpEra = isHome ? setHomeBpEra : setAwayBpEra;
    const bpWhip = isHome ? homeBpWhip : awayBpWhip;
    const setBpWhip = isHome ? setHomeBpWhip : setAwayBpWhip;
    const bpTired = isHome ? homeBpTired : awayBpTired;
    const setBpTired = isHome ? setHomeBpTired : setAwayBpTired;
    const closer = isHome ? homeCloser : awayCloser;
    const setCloser = isHome ? setHomeCloser : setAwayCloser;
    const streak = isHome ? homeStreak : awayStreak;
    const setStreak = isHome ? setHomeStreak : setAwayStreak;
    const injury = isHome ? homeInjury : awayInjury;
    const setInjury = isHome ? setHomeInjury : setAwayInjury;
    const injuryFactors = isHome ? homeInjuryFactors : awayInjuryFactors;
    const setInjuryFactors = isHome ? setHomeInjuryFactors : setAwayInjuryFactors;
    const injuryRoster = isHome ? homeInjuryRoster : awayInjuryRoster;
    const injuryFeed = isHome ? homeInjuryFeed : awayInjuryFeed;
    const injuryMissing = isHome ? homeInjuryMissing : awayInjuryMissing;
    const setInjuryMissing = isHome ? setHomeInjuryMissing : setAwayInjuryMissing;
    const phaseBAutoApplied = isHome ? homePhaseBAutoApplied : awayPhaseBAutoApplied;
    const setPhaseBAutoApplied = isHome ? setHomePhaseBAutoApplied : setAwayPhaseBAutoApplied;
    const phaseBStatus = isHome ? homePhaseBStatus : awayPhaseBStatus;
    const setPhaseBStatus = isHome ? setHomePhaseBStatus : setAwayPhaseBStatus;
    const injuryGamesOut = isHome ? homeInjuryGamesOut : awayInjuryGamesOut;
    const setInjuryGamesOut = isHome ? setHomeInjuryGamesOut : setAwayInjuryGamesOut;
    const winRate = isHome ? homeWinRate : awayWinRate;
    const setWinRate = isHome ? setHomeWinRate : setAwayWinRate;
    const p = side; // prefix for data-testid

    return (
      <Card className={`border ${borderColor} bg-slate-900/50`}>
        <CardHeader className="pb-3">
          <CardTitle className={`text-lg ${titleColor}`}>
            ⚾ Equipo {label}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Team selector */}
          <div>
            <Label className="text-xs text-muted-foreground">Equipo</Label>
            <Select
              value={team}
              onValueChange={isHome ? handleHomeTeamChange : setAwayTeam}
            >
              <SelectTrigger className="mt-1" data-testid={`${p}-team`}>
                <SelectValue placeholder="Seleccionar equipo…" />
              </SelectTrigger>
              <SelectContent>
                {MLB_TEAMS.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* PITCHER */}
          <div className="border border-green-500/30 rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-green-400 uppercase tracking-wider">Pitcher Abridor</p>
              {pitcherName && (
                <span className="text-sm font-bold text-white bg-green-500/20 border border-green-500/40 rounded-full px-3 py-0.5">
                  {pitcherName} ({hand})
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {numInput("ERA", era, setEra, `${p}-era`)}
              {numInput("WHIP", whip, setWhip, `${p}-whip`)}
              {numInput("FIP", fip, setFip, `${p}-fip`)}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {numInput("K/9", k9, setK9, `${p}-k9`)}
              {numInput("BB/9", bb9, setBb9, `${p}-bb9`)}
              {numInput("Días descanso", rest, setRest, `${p}-rest`, "numeric")}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">Mano</Label>
                <Select value={hand} onValueChange={setHand}>
                  <SelectTrigger className="mt-1" data-testid={`${p}-hand`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="R">Derecho</SelectItem>
                    <SelectItem value="L">Zurdo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {numInput("Registro", record, setRecord, `${p}-record`, "decimal", "8-5")}
            </div>
            {numInput("ERA últimas 3 (opcional)", recentEra, setRecentEra, `${p}-recent-era`, "decimal", "3.50")}
          </div>

          {/* OFENSIVA */}
          <div className="border border-blue-500/30 rounded-lg p-3 space-y-3">
            <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Ofensiva</p>
            <div className="grid grid-cols-3 gap-2">
              {numInput("OPS", ops, setOps, `${p}-ops`)}
              {numInput("RPG", rpg, setRpg, `${p}-rpg`)}
              {numInput("OBP", obp, setObp, `${p}-obp`)}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {numInput("AVG", avg, setAvg, `${p}-avg`)}
              {numInput("OPS vs Zurdo", opsVsL, setOpsVsL, `${p}-ops-vsl`)}
              {numInput("OPS vs Derecho", opsVsR, setOpsVsR, `${p}-ops-vsr`)}
            </div>
          </div>

          {/* BULLPEN */}
          <div className="border border-purple-500/30 rounded-lg p-3 space-y-3">
            <p className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Bullpen</p>
            <div className="grid grid-cols-2 gap-2">
              {numInput("Bullpen ERA", bpEra, setBpEra, `${p}-bp-era`)}
              {numInput("Bullpen WHIP", bpWhip, setBpWhip, `${p}-bp-whip`)}
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">Bullpen cansado</Label>
              <Switch
                checked={bpTired}
                onCheckedChange={setBpTired}
                data-testid={`${p}-bp-tired`}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm text-muted-foreground">Closer disponible</Label>
              <Switch
                checked={closer}
                onCheckedChange={setCloser}
                data-testid={`${p}-closer`}
              />
            </div>
          </div>

          {/* MOMENTO */}
          <div className="border border-amber-500/30 rounded-lg p-3 space-y-3">
            <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Momento</p>
            <div className="grid grid-cols-2 gap-2">
              {numInput("Racha (+win/-loss)", streak, setStreak, `${p}-streak`, "numeric", "0")}
              {numInput("Win Rate últimos 10", winRate, setWinRate, `${p}-winrate`, "decimal", "0.55")}
              <div className="col-span-2 mt-1 border border-amber-500/20 rounded p-2 bg-amber-500/5 space-y-1">
                <Label className="text-xs text-amber-400 font-medium flex items-center gap-1">
                  Lesiones (± runs/juego)
                </Label>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={injury}
                  onChange={(e) => {
                    setInjury(e.target.value);
                    setPhaseBAutoApplied(new Set());
                    setPhaseBStatus("Override manual del ajuste agregado");
                    // manual edit → default seguro
                    setInjuryFactors({ off: 1.0, def: 0.5, type: "Manual" });
                  }}
                  placeholder="0"
                  className="h-8 border-amber-500/30 text-xs"
                />
                {injury && injury !== "0" && parseFloat(injury) !== 0 && (
                  <div className="text-[11px] text-amber-200/80">
                    <span className="font-medium">Auto-tipo: </span>
                    {injuryFactors.type}
                    <span className="text-muted-foreground ml-1">(off {(injuryFactors.off * 100).toFixed(0)}% · def {(injuryFactors.def * 100).toFixed(0)}%)</span>
                  </div>
                )}

                {/* Estado verificable de la fuente de lesiones */}
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

                {injuryFeed.phaseB?.enabled && injuryFeed.shadowSummary ? (
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

                {/* Auto-rellenado de lesionados desde BALLDONTLIE (solo listas confiables) */}
                {injuryRoster.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-amber-500/20 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-semibold text-amber-300 uppercase tracking-wider">
                        Lesionados detectados ({injuryRoster.length}) — clasificados automáticamente; toque solo para override manual:
                      </p>
                      <span className="text-[9px] text-cyan-400/70">via BALLDONTLIE</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {injuryRoster.map((pl) => {
                        const isOut = injuryMissing.has(pl.name);
                        const isPhaseBAuto = phaseBAutoApplied.has(pl.name);
                        const isPhaseBWithheld = injuryFeed.phaseB?.withheldCandidateNames.includes(pl.name) === true;
                        const t = detectMLBPlayerType(pl);
                        const statSnip = pl.isPitcher
                          ? `ERA ${(pl.era ?? 0).toFixed(2)}`
                          : `OPS ${(pl.ops ?? 0).toFixed(3)}`;
                        return (
                          <button
                            key={pl.name}
                            type="button"
                            onClick={() => {
                              const next = new Set(injuryMissing);
                              if (isOut) next.delete(pl.name); else next.add(pl.name);
                              setInjuryMissing(next);
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
                            }}
                            className={`text-[10px] px-1.5 py-0.5 rounded border transition-all ${
                              isPhaseBAuto
                                ? "bg-emerald-500/25 border-emerald-400 text-emerald-100 font-bold"
                                : isOut
                                  ? "bg-red-500/30 border-red-400 text-red-200 font-bold"
                                  : "bg-slate-700/40 border-slate-600 text-slate-400"
                            }`}
                            title={`${t.type} · ${pl.status}${pl.officialStatus ? `\nMLB: ${pl.officialStatus}` : ""}${pl.shadow?.reason ? `\nAutomático: ${pl.shadow.reason}` : ""}${pl.returnDate ? `\nRegreso: ${new Date(pl.returnDate).toLocaleDateString("es-ES")}` : ""}${pl.shortComment ? `\n\n${pl.shortComment}` : ""}`}
                          >
                            <span className={isOut ? "line-through" : ""}>{pl.name}</span>
                            <span className="text-[9px] text-muted-foreground ml-1">({pl.position} · {statSnip})</span>
                            {pl.shadow && (
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
                          </button>
                        );
                      })}
                    </div>
                    {injuryMissing.size > 0 && (
                      <div className="mt-1 p-1.5 rounded bg-red-500/10 border border-red-500/20 space-y-1">
                        {Array.from(injuryMissing).map((nm) => {
                          const gm = injuryGamesOut[nm] ?? 0;
                          return (
                            <div key={nm} className="flex items-center gap-2">
                              <span className="text-[10px] text-red-300 flex-1 truncate">{nm}</span>
                              <span className="text-[10px] text-muted-foreground">Juegos fuera:</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={String(gm)}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value) || 0;
                                  const nextGO = { ...injuryGamesOut, [nm]: val };
                                  setInjuryGamesOut(nextGO);
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
                                }}
                                className="w-10 text-center text-[10px] bg-slate-800 border border-red-500/30 rounded px-1 py-0.5 text-white"
                              />
                            </div>
                          );
                        })}
                        <div className="pt-1 border-t border-red-500/20 space-y-0.5">
                          {calcMLBInjuryImpact(injuryRoster, injuryMissing, injuryGamesOut).details.map((d, i) => (
                            <p key={i} className="text-[10px] text-red-300/90">• {d}</p>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground">
                  Slugger OUT: -1 a -2 · Catcher OUT: -0.5 · SS OUT: -0.5
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const mlbReviewQueue = buildMlbReviewQueue(mlbGames);
  const visibleMlbGameEntries = mlbQueueView === "priority"
    ? mlbReviewQueue.priority
    : mlbQueueView === "pending"
      ? mlbReviewQueue.pending
      : mlbReviewQueue.all;
  const currentDecisionReview = classifyMlbDecisionReview(result?.pickQualities);

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white pb-16">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center">
            <Brain className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">⚾ Predictor MLB</h1>
            <p className="text-sm text-muted-foreground">Análisis de béisbol: ML · F5 · Run Line · O/U</p>
          </div>
        </div>

        {/* ── AUTO-LLENADO MLB ── */}
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold text-primary">Auto-llenar desde MLB Stats</span>
          </div>
          <DatePickerFL
            value={selectedDate}
            onChange={(date) => {
              setSelectedDate(date);
              setSelectedGameId("");
              setMlbQueueView("priority");
            }}
          />
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              variant="outline" size="sm"
              onClick={() => refetchMLB()}
              disabled={mlbLoading}
              className="shrink-0 border-primary/30 text-primary hover:bg-primary/10"
              data-testid="button-load-mlb"
            >
              {mlbLoading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              {mlbLoading ? "Cargando..." : "Cargar partidos"}
            </Button>
            {mlbGames.length > 0 && (
              <div className="flex flex-col gap-2 flex-1 min-w-0">
                <div className="grid grid-cols-3 gap-1" aria-label="Prioridad de partidos MLB">
                  <Button
                    type="button"
                    size="sm"
                    variant={mlbQueueView === "priority" ? "default" : "outline"}
                    onClick={() => setMlbQueueView("priority")}
                    data-testid="button-mlb-priority"
                  >
                    Prioridad {mlbReviewQueue.priority.length}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={mlbQueueView === "pending" ? "default" : "outline"}
                    onClick={() => setMlbQueueView("pending")}
                    data-testid="button-mlb-pending"
                  >
                    Pendientes {mlbReviewQueue.pending.length}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={mlbQueueView === "all" ? "default" : "outline"}
                    onClick={() => setMlbQueueView("all")}
                    data-testid="button-mlb-all"
                  >
                    Todos {mlbReviewQueue.all.length}
                  </Button>
                </div>
                {visibleMlbGameEntries.length > 0 ? (
                  <Select value={selectedGameId} onValueChange={setSelectedGameId}>
                    <SelectTrigger className="w-full border-primary/30" data-testid="select-mlb-game">
                      <SelectValue placeholder="Selecciona un partido" />
                    </SelectTrigger>
                    <SelectContent>
                      {visibleMlbGameEntries.map(({ game: g, readiness }) => {
                        const awayPitcher = g.awayPitcher?.name ?? g.awayPitcher?.fullName ?? "TBD";
                        const homePitcher = g.homePitcher?.name ?? g.homePitcher?.fullName ?? "TBD";
                        const prefix = readiness === "READY" ? "✓" : readiness === "PENDING" ? "⏳" : "•";
                        return (
                          <SelectItem
                            key={g.gameId}
                            value={String(g.gameId)}
                            disabled={readiness === "CLOSED"}
                          >
                            {prefix} {g.awayTeam?.name} @ {g.homeTeam?.name} · {awayPitcher} vs {homePitcher}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="rounded-md border border-dashed border-primary/30 px-3 py-2 text-xs text-muted-foreground">
                    {mlbQueueView === "priority"
                      ? "Todavía no hay juegos pregame con ambos pitchers identificados. Revisa Pendientes."
                      : mlbQueueView === "pending"
                        ? "No hay partidos pendientes de pitcher en esta jornada."
                        : "No hay partidos disponibles para esta fecha."}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">
                  Prioridad = pregame con ambos pitchers identificados. La oportunidad real se clasifica después de generar la predicción.
                </p>
              </div>
            )}
            {selectedGameId && (
              <Button size="sm" onClick={() => handleMLBAutoFill(selectedGameId)} disabled={autoStatus === "loading"} data-testid="button-mlb-autofill">
                {autoStatus === "loading" ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
                Auto-llenar
              </Button>
            )}
            {homeTeam && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                onClick={async () => {
                  try {
                    const res = await apiRequest("GET", `/api/odds/mlb?date=${encodeURIComponent(selectedDate)}`);
                    const data = await res.json();
                    if (data.success === false) {
                      toast({ title: "Cuotas HR no disponibles", description: data.error || "Error desconocido", variant: "destructive" });
                      return;
                    }
                    const games = data.games ?? [];
                    const matched = games.find((g: any) =>
                      g.homeTeam?.toLowerCase().includes(homeTeam.toLowerCase()) ||
                      homeTeam.toLowerCase().includes(g.homeTeam?.toLowerCase())
                    );
                    if (!matched) {
                      toast({ title: "No se encontraron cuotas para este partido", variant: "destructive" });
                      return;
                    }
                    if (matched.ml) { setMlOdds(String(matched.ml.home)); setMlOddsAway(String(matched.ml.away)); }
                    if (matched.spread) { setRunLine(String(matched.spread.line)); setRlOdds(String(matched.spread.homeOdds)); setRlOddsAway(String(matched.spread.awayOdds)); }
                    if (matched.total) { setOuLine(String(matched.total.line)); setOverOdds(String(matched.total.overOdds)); setUnderOdds(String(matched.total.underOdds)); }
                    if (matched.gameKey) setSharpGameKey(matched.gameKey);
                    toast({ title: "Cuotas Hard Rock cargadas" });
                  } catch {
                    toast({ title: "No se encontraron cuotas para este partido", variant: "destructive" });
                  }
                }}
              >
                ⚡ Cuotas HR
              </Button>
            )}
            {homeTeam && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10"
                onClick={async () => {
                  try {
                    const res = await apiRequest("GET", `/api/odds/mlb/f5?date=${encodeURIComponent(selectedDate)}`);
                    const data = await res.json();
                    if (data.success === false) {
                      toast({ title: "Cuotas F5 no disponibles", description: data.error || "Error desconocido", variant: "destructive" });
                      return;
                    }
                    const games = data.games ?? [];
                    const matched = games.find((g: any) =>
                      g.homeTeam?.toLowerCase().includes(homeTeam.toLowerCase()) ||
                      homeTeam.toLowerCase().includes(g.homeTeam?.toLowerCase())
                    );
                    if (!matched || !matched.f5Ml || matched.f5Ml.home == null) {
                      toast({ title: "Sin cuotas F5 para este juego", description: "FanDuel/BetMGM/DK no las publicaron aún", variant: "destructive" });
                      return;
                    }
                    const homeStr = String(matched.f5Ml.home);
                    const awayStr = String(matched.f5Ml.away);
                    setF5MlHome(homeStr);
                    setF5MlAway(awayStr);
                    f5ConsensoSnapshot.current = { home: homeStr, away: awayStr };
                    setF5OddsSource("consenso");
                    if (matched.f5Total?.line != null) setF5OuLine(String(matched.f5Total.line));
                    toast({ title: "F5 consenso cargado", description: `Mediana de ${matched.source}. Verifica en Hard Rock antes de apostar.` });
                  } catch {
                    toast({ title: "Error cargando F5", variant: "destructive" });
                  }
                }}
              >
                ⚡ Cuotas F5
              </Button>
            )}
          </div>
          {mlbError && <p className="text-xs text-red-400">No se pudo conectar con MLB. Llena manual.</p>}
          {autoStatus === "success" && <p className="text-xs text-green-400">✅ Pitchers + Stats + Bullpen cargados — solo agrega líneas</p>}
          {result && currentDecisionReview.status !== "UNAVAILABLE" && (
            <div className={`rounded-md border p-3 ${
              currentDecisionReview.status === "ACTIONABLE"
                ? "border-emerald-500/40 bg-emerald-500/10"
                : currentDecisionReview.status === "REVIEW"
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-slate-500/40 bg-slate-500/10"
            }`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{currentDecisionReview.label}</span>
                {currentDecisionReview.market && (
                  <Badge variant="outline" className="text-[10px]">{currentDecisionReview.market}</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{currentDecisionReview.detail}</p>
            </div>
          )}
          <div className="text-xs text-muted-foreground border-t border-border pt-2">
            <span className="font-medium text-foreground">Se llena solo:</span> Pitcher (ERA, WHIP, FIP, K/9, BB/9, mano, registro, descanso) · Ofensiva (OPS, RPG, OBP, AVG, splits) · Bullpen · Park Factor
            &nbsp;&nbsp;<span className="font-medium text-amber-400">Tú:</span> Líneas Hard Rock
          </div>

          <EliteBanner sport="MLB" />
          {selectedGameId && <MLBUmpireCard gamePk={selectedGameId} onUmpire={(u) => setUmpireData(u || null)} />}
          {contextTri.home && contextTri.away && (
            <MLBContextualCard
              homeTri={contextTri.home}
              awayTri={contextTri.away}
              gameDate={selectedDate}
              onContext={setMlbCtxAdj}
            />
          )}
          {selectedGameId && <MLBAdvancedCard gamePk={selectedGameId} onAdvanced={(d) => {
            if (d && d.totalAdjustment !== undefined) {
              const notes: string[] = [];
              if (d.breakdown) {
                if (Math.abs(d.breakdown.park) >= 0.2) notes.push(`parque ${d.breakdown.park > 0 ? "+" : ""}${d.breakdown.park}`);
                if (Math.abs(d.breakdown.wind) >= 0.2) notes.push(`viento ${d.breakdown.wind > 0 ? "+" : ""}${d.breakdown.wind}`);
                if (Math.abs(d.breakdown.temp) >= 0.2) notes.push(`temp ${d.breakdown.temp > 0 ? "+" : ""}${d.breakdown.temp}`);
              }
              setAdvancedData({ totalAdjustment: d.totalAdjustment, notes });
            }
          }} />}
          {sharpGameKey && <SharpSignalsCard sport="mlb" gameKey={sharpGameKey} onDirection={setSharpDir} />}

          {/* PARK-PITCHER SPLITS — cómo le va a este pitcher en ESTE estadio específico */}
          {parkPitcher && (parkPitcher.homeSplit || parkPitcher.awaySplit) && (
            <Card className="border-emerald-500/40 bg-emerald-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-emerald-400">🏟️ Park-Pitcher Splits</span>
                  <Badge variant="outline" className="text-[9px] border-emerald-500/40 text-emerald-300">
                    {parkPitcher.venueName || "Estadio"}
                  </Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Cómo cada pitcher se desempeña en ESTE estadio (últimos 3 años). Si no hay historial directo, usamos proxy por arquetipo de parque (pitcher/neutral/hitter-friendly).
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  { side: "home", label: "SP Local", team: homeTeam, split: parkPitcher.homeSplit, fallbackName: homePitcherName },
                  { side: "away", label: "SP Visitante", team: awayTeam, split: parkPitcher.awaySplit, fallbackName: awayPitcherName },
                ].map((s) => {
                  const sp = s.split;
                  // Si no hay datos, mostrar placeholder con disclaimer
                  if (!sp) {
                    return (
                      <div key={s.side} className="p-2.5 rounded border bg-slate-700/20 border-slate-600/50 border-dashed">
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                            <p className="text-sm font-bold text-slate-300 truncate">{s.fallbackName || "—"}</p>
                          </div>
                          <Badge variant="outline" className="text-[9px] border-slate-500/40 text-slate-400">
                            Sin historial en este parque
                          </Badge>
                        </div>
                        <p className="text-[10px] text-slate-400/80 mt-1.5">
                          Nunca ha lanzado en {parkPitcher.venueName || "este estadio"} — factor no aplicado a la predicción por este lado.
                        </p>
                      </div>
                    );
                  }
                  const isProxy = sp.dataSource === "BUCKET_PROXY";
                  const proxyN = sp.bucketStarts ?? 0;
                  const proxyValid = isProxy && proxyN >= 3;
                  const proxyConf = proxyN >= 5 ? "MEDIA" : "BAJA";
                  const helping = sp.eraDelta < -0.5 && (sp.significantSample || proxyValid);
                  const hurting = sp.eraDelta > 0.5 && (sp.significantSample || proxyValid);
                  const insufficient = !sp.significantSample && !proxyValid;
                  const bucketLabel = sp.bucket === "PITCHER" ? "pitcher-friendly" : sp.bucket === "HITTER" ? "hitter-friendly" : "neutrales";
                  return (
                    <div key={s.side} className={`p-2.5 rounded border ${
                      insufficient ? "bg-slate-700/20 border-slate-600/50 border-dashed" :
                      helping ? "bg-green-500/10 border-green-500/40" :
                      hurting ? "bg-red-500/10 border-red-500/40" :
                      "bg-slate-700/30 border-slate-600"
                    }`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground uppercase flex items-center gap-1.5">
                            {s.label}
                            {isProxy && (
                              <span className={`text-[8px] px-1 py-0.5 rounded border ${proxyConf === "MEDIA" ? "bg-blue-500/20 text-blue-300 border-blue-500/40" : "bg-amber-500/20 text-amber-300 border-amber-500/40"}`}>
                                📊 Proxy {bucketLabel} · n={proxyN} · conf {proxyConf}
                              </span>
                            )}
                          </p>
                          <p className="text-sm font-bold text-white truncate">{sp.pitcherName}</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-lg font-mono font-bold ${
                            insufficient ? "text-slate-400" :
                            helping ? "text-green-400" : hurting ? "text-red-400" : "text-slate-300"
                          }`}>
                            {sp.era.toFixed(2)}
                          </p>
                          <p className="text-[9px] text-muted-foreground">{isProxy ? `ERA en parques ${bucketLabel}` : `ERA en ${(parkPitcher.venueName || "estadio").split(" ")[0]}`}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-1 text-[10px]">
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">Starts</p>
                          <p className="font-mono text-white">{sp.starts}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">WHIP</p>
                          <p className="font-mono text-white">{sp.whip.toFixed(2)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">HR/9</p>
                          <p className="font-mono text-white">{sp.hr9.toFixed(2)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">vs Season</p>
                          <p className={`font-mono ${sp.eraDelta > 0 ? "text-red-400" : sp.eraDelta < 0 ? "text-green-400" : "text-white"}`}>
                            {sp.eraDelta > 0 ? "+" : ""}{sp.eraDelta.toFixed(2)}
                          </p>
                        </div>
                      </div>
                      <p className="text-[10px] text-amber-200/90 mt-1.5">{sp.signal}</p>
                      {insufficient && (
                        <p className="text-[10px] text-slate-400/90 mt-1">
                          ⚠️ Muestra insuficiente ({sp.starts} start{sp.starts === 1 ? "" : "s"}) — factor NO aplicado a la predicción.
                        </p>
                      )}
                    </div>
                  );
                })}
                <p className="text-[9px] text-muted-foreground border-t border-emerald-500/20 pt-2">
                  Verde: pitcher domina aquí. Rojo: sufre aquí. Punteado: sin muestra. 📊 Proxy por arquetipo: cuando no hay starts directos, estimamos con parques del mismo tipo (peso 50%).
                </p>
              </CardContent>
            </Card>
          )}

          {/* PITCHER VS TEAM HISTORY — últimos 5 starts vs ESTE equipo */}
          {pitcherVsTeam && (
            <Card className="border-violet-500/40 bg-violet-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-violet-400">📜 Pitcher vs Team — histórico</span>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Últimos 5 starts del pitcher contra ESTE equipo específico (3 años). Detecta dominance/struggles repetidas.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  { side: "home", label: "SP Local vs Visitante", split: pitcherVsTeam.homeVsAway, fallbackName: homePitcherName, fallbackOpp: awayTeam },
                  { side: "away", label: "SP Visitante vs Local", split: pitcherVsTeam.awayVsHome, fallbackName: awayPitcherName, fallbackOpp: homeTeam },
                ].map((s) => {
                  const sp = s.split;
                  // Sin historial — placeholder con disclaimer
                  if (!sp) {
                    return (
                      <div key={s.side} className="p-2.5 rounded border bg-slate-700/20 border-slate-600/50 border-dashed">
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                            <p className="text-sm font-bold text-slate-300 truncate">
                              {s.fallbackName || "—"} <span className="text-violet-300/60">vs {s.fallbackOpp}</span>
                            </p>
                          </div>
                          <Badge variant="outline" className="text-[9px] border-slate-500/40 text-slate-400">
                            Sin enfrentamientos previos
                          </Badge>
                        </div>
                        <p className="text-[10px] text-slate-400/80 mt-1.5">
                          Nunca ha lanzado contra {s.fallbackOpp} en últimos 3 años — factor no aplicado por este lado.
                        </p>
                      </div>
                    );
                  }
                  const dominating = sp.recentTrend === "DOMINANCE";
                  const struggling = sp.recentTrend === "STRUGGLES";
                  return (
                    <div key={s.side} className={`p-2.5 rounded border ${
                      dominating ? "bg-green-500/10 border-green-500/40" :
                      struggling ? "bg-red-500/10 border-red-500/40" :
                      "bg-slate-700/30 border-slate-600"
                    }`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                          <p className="text-sm font-bold text-white truncate">
                            {sp.pitcherName} <span className="text-violet-300">vs {sp.opponentTeamName}</span>
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={`text-lg font-mono font-bold ${
                            dominating ? "text-green-400" : struggling ? "text-red-400" : "text-slate-300"
                          }`}>
                            {sp.era.toFixed(2)}
                          </p>
                          <p className="text-[9px] text-muted-foreground">ERA en {sp.totalStarts} starts</p>
                        </div>
                      </div>
                      {sp.starts.length > 0 && (
                        <div className="space-y-0.5">
                          {sp.starts.slice(0, 5).map((st: any, i: number) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <span className="text-muted-foreground w-20 shrink-0">{st.date}</span>
                              <span className="font-mono text-white">{st.ip} IP</span>
                              <span className={`font-mono font-bold ${st.er <= 2 ? "text-green-400" : st.er >= 4 ? "text-red-400" : "text-amber-400"}`}>
                                {st.er} ER
                              </span>
                              <span className="font-mono text-slate-400">{st.k} K</span>
                              {st.hr > 0 && <span className="font-mono text-rose-400">{st.hr} HR</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="text-[10px] text-amber-200/90 mt-1.5">{sp.signal}</p>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* ⚡ TIER B — Pitcher Discipline (strikePct) + Sprint Speed */}
          {discSpeed && (discSpeed.homeSPDiscipline || discSpeed.awaySPDiscipline || discSpeed.homeBatterSpeed?.length || discSpeed.awayBatterSpeed?.length) && (
            <Card className="border border-teal-500/40 bg-gradient-to-br from-teal-500/5 to-cyan-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-teal-300">⚡ Disciplina SP + Velocidad de Lineup</span>
                  <Badge variant="outline" className="text-[9px] border-teal-500/40 text-teal-300">strike% · sprint speed</Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  strike% del SP → predice K9 sostenible. Sprint speed del lineup → corrige BABIP regression a la baja.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  { side: "home", label: "SP LOCAL", disc: discSpeed.homeSPDiscipline },
                  { side: "away", label: "SP VISITANTE", disc: discSpeed.awaySPDiscipline },
                ].map((s) => {
                  const d = s.disc;
                  if (!d) return (
                    <div key={s.side} className="p-2 rounded border border-dashed border-slate-600/50 bg-slate-700/20">
                      <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                      <p className="text-xs text-slate-400 mt-1">Sin datos (menos de 200 pitches)</p>
                    </div>
                  );
                  const above = d.expectedK9Delta >= 0.8;
                  const below = d.expectedK9Delta <= -0.8;
                  return (
                    <div key={s.side} className={`p-2 rounded border ${above ? "bg-emerald-500/10 border-emerald-500/40" : below ? "bg-red-500/10 border-red-500/40" : "bg-slate-700/30 border-slate-600"}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                          <p className="text-sm font-bold text-white truncate">{d.pitcherName}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-mono">strike% <span className="font-bold">{(d.strikePct*100).toFixed(1)}%</span></p>
                          <p className="text-xs font-mono">K9 actual <span className="font-bold">{d.k9.toFixed(1)}</span></p>
                        </div>
                      </div>
                      <p className="text-[10px] mt-1 text-slate-300">{d.signal}</p>
                    </div>
                  );
                })}
                {/* Sprint Speed por equipo */}
                {[
                  { side: "home", label: "LOCAL", batters: discSpeed.homeBatterSpeed || [] },
                  { side: "away", label: "VISITANTE", batters: discSpeed.awayBatterSpeed || [] },
                ].map((s) => {
                  if (!s.batters.length) return null;
                  const elite = s.batters.filter((b: any) => b.tier === "ELITE");
                  const fast = s.batters.filter((b: any) => b.tier === "FAST");
                  if (elite.length === 0 && fast.length === 0) return null;
                  return (
                    <div key={`spd-${s.side}`} className="p-2 rounded border border-teal-500/20 bg-teal-500/5">
                      <p className="text-[10px] text-teal-200 font-bold uppercase mb-1">{s.label} · Lineup rápido ({elite.length} elite + {fast.length} fast)</p>
                      {elite.slice(0, 3).map((b: any) => (
                        <p key={b.playerId} className="text-[10px] text-emerald-300">⚡ {b.name}: {b.sprintSpeed.toFixed(1)} ft/s → BABIP floor {b.babipFloor.toFixed(3)}</p>
                      ))}
                      {fast.slice(0, 3).map((b: any) => (
                        <p key={b.playerId} className="text-[10px] text-teal-300">• {b.name}: {b.sprintSpeed.toFixed(1)} ft/s</p>
                      ))}
                    </div>
                  );
                })}
                <p className="text-[9px] text-muted-foreground border-t border-teal-500/20 pt-2">
                  Verde SP: K9 subiendo (regresión positiva). Rojo SP: K9 bajando. Speed boost por bateador ELITE (+0.03 runs) y FAST (+0.015). Peso 50% al modelo cuando Statcast Pitch-by-Pitch ya tiene FULL/PARTIAL.
                </p>
              </CardContent>
            </Card>
          )}

          {/* 🎯 SOS — Strength of Schedule del bateo reciente */}
          {sos && (sos.home || sos.away) && (
            <Card className="border border-orange-500/40 bg-gradient-to-br from-orange-500/5 to-amber-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-orange-300">🎯 Calidad de Pitcheo Enfrentado (SOS)</span>
                  <Badge variant="outline" className="text-[9px] border-orange-500/40 text-orange-300">Últimos 10 juegos</Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Ajusta RPG reciente según a quién se enfrentó el equipo. Racha vs Rockies/White Sox = inflada. Racha vs Dodgers/Mets = real.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  { side: "home", label: "LOCAL", data: sos.home },
                  { side: "away", label: "VISITANTE", data: sos.away },
                ].map((s) => {
                  const d = s.data;
                  if (!d) return (
                    <div key={s.side} className="p-2.5 rounded border border-dashed border-slate-600/50 bg-slate-700/20">
                      <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                      <p className="text-xs text-slate-400 mt-1">Sin datos SOS (menos de 5 juegos en últimos 30 días)</p>
                    </div>
                  );
                  const inflated = d.tier === "INFLATED";
                  const deflated = d.tier === "DEFLATED";
                  return (
                    <div key={s.side} className={`p-2.5 rounded border ${inflated ? "bg-red-500/10 border-red-500/40" : deflated ? "bg-emerald-500/10 border-emerald-500/40" : "bg-slate-700/30 border-slate-600"}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                          <p className="text-sm font-bold text-white truncate">{d.teamName}</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-lg font-mono font-bold ${inflated ? "text-red-300" : deflated ? "text-emerald-300" : "text-slate-300"}`}>
                            ×{d.sosFactor.toFixed(2)}
                          </p>
                          <p className="text-[9px] text-muted-foreground">factor SOS</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[10px]">
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">SP ERA</p>
                          <p className="font-mono font-bold">{d.avgSpEraFaced.toFixed(2)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">Staff ERA</p>
                          <p className="font-mono font-bold">{d.avgBullpenEraFaced.toFixed(2)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">RPG aj.</p>
                          <p className="font-mono font-bold">{d.recentRpg.toFixed(1)} → {d.adjustedRpg.toFixed(1)}</p>
                        </div>
                      </div>
                      <p className="text-[10px] mt-1.5 text-slate-300">{d.signal}</p>
                    </div>
                  );
                })}
                <p className="text-[9px] text-muted-foreground border-t border-orange-500/20 pt-2">
                  Rojo: racha INFLADA (enfrentó pitcheo flojo). Verde: racha REAL (enfrentó pitcheo top). Factor SOS multiplica el RPG base del equipo (cap ±20%).
                </p>
              </CardContent>
            </Card>
          )}

          {/* 🔬 TIER A SAVANT QUALITY — xwOBA-allowed + HardHit% del SP rival */}
          {statcastQuality && (statcastQuality.homeSP || statcastQuality.awaySP) && (
            <Card className="border border-purple-500/40 bg-gradient-to-br from-purple-500/5 to-fuchsia-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-purple-300">🔬 Calidad de Pitcheo — Statcast Expected</span>
                  <Badge variant="outline" className="text-[9px] border-purple-500/40 text-purple-300">xwOBA · xERA · HardHit%</Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Lo que el SP MERECE ceder vs lo que ha cedido. Detector de regresión (sobrerendimiento) y oportunidad (subrendimiento).
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  { side: "home", label: "SP LOCAL", data: statcastQuality.homeSP },
                  { side: "away", label: "SP VISITANTE", data: statcastQuality.awaySP },
                ].map((s) => {
                  const q = s.data;
                  if (!q) return (
                    <div key={s.side} className="p-2.5 rounded border border-dashed border-slate-600/50 bg-slate-700/20">
                      <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                      <p className="text-xs text-slate-400 mt-1">Sin datos en Savant (muestra menor a 50 PA o pitcher nuevo)</p>
                    </div>
                  );
                  const bad = q.runsDelta >= 0.20;     // regresión → más runs
                  const good = q.runsDelta <= -0.20;   // mejor de lo que ERA muestra
                  return (
                    <div key={s.side} className={`p-2.5 rounded border ${bad ? "bg-red-500/10 border-red-500/40" : good ? "bg-emerald-500/10 border-emerald-500/40" : "bg-slate-700/30 border-slate-600"}`}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground uppercase">{s.label}</p>
                          <p className="text-sm font-bold text-white truncate">{q.pitcherName}</p>
                        </div>
                        <div className="text-right">
                          <p className={`text-lg font-mono font-bold ${bad ? "text-red-300" : good ? "text-emerald-300" : "text-slate-300"}`}>
                            {q.runsDelta > 0 ? "+" : ""}{q.runsDelta.toFixed(2)}
                          </p>
                          <p className="text-[9px] text-muted-foreground">runs delta esperado</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-1 text-[10px]">
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">ERA</p>
                          <p className="font-mono font-bold">{q.era.toFixed(2)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">xERA</p>
                          <p className="font-mono font-bold">{q.xera.toFixed(2)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">xwOBA</p>
                          <p className="font-mono font-bold">{q.xwoba.toFixed(3)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">HardHit%</p>
                          <p className="font-mono font-bold">{q.hardHitPct.toFixed(0)}%</p>
                        </div>
                      </div>
                      <p className="text-[10px] mt-1.5 text-slate-300">{q.signal}</p>
                    </div>
                  );
                })}
                {/* Bateadores luck-delta como info adicional (no entra al modelo) */}
                {(statcastQuality.homeBatters?.length > 0 || statcastQuality.awayBatters?.length > 0) && (
                  <div className="pt-2 border-t border-purple-500/20">
                    <p className="text-[10px] text-purple-200 font-bold mb-1">Bateadores con luck-delta significativo (≥ ±.030):</p>
                    <div className="space-y-0.5">
                      {[...(statcastQuality.homeBatters || []), ...(statcastQuality.awayBatters || [])]
                        .filter((b: any) => b.tier !== "REAL")
                        .slice(0, 8)
                        .map((b: any) => (
                          <p key={b.playerId} className="text-[10px] text-slate-300">{b.signal}</p>
                        ))}
                      {[...(statcastQuality.homeBatters || []), ...(statcastQuality.awayBatters || [])].filter((b: any) => b.tier !== "REAL").length === 0 && (
                        <p className="text-[10px] text-slate-500 italic">Ningún bateador con luck-delta significativo en estos lineups.</p>
                      )}
                    </div>
                  </div>
                )}
                <p className="text-[9px] text-muted-foreground border-t border-purple-500/20 pt-2">
                  Rojo: pitcher sobrerendiendo (regresión pendiente → más runs). Verde: pitcher subrendiendo (más real que su ERA). Peso al 50% del modelo cuando Statcast Pitch-by-Pitch ya tiene FULL/PARTIAL (anti doble-conteo).
                </p>
              </CardContent>
            </Card>
          )}

          {/* ⚡ STATCAST PITCH-BY-PITCH MATCHUP — EL MOTOR REAL */}
          {statcastMatchup && (statcastMatchup.homeLineupVsAwaySP || statcastMatchup.awayLineupVsHomeSP) && (
            <Card className="border border-cyan-500/40 bg-gradient-to-br from-cyan-500/5 to-blue-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-cyan-300">⚡ Statcast Matchup — Pitch-by-Pitch</span>
                  <Badge variant="outline" className="text-[9px] border-cyan-500/40 text-cyan-300">vs repertorio real</Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Cómo cada bateador del lineup confirmado le pega a CADA tipo de pitch del SP rival (Baseball Savant). El motor real de matchups, no stats agregadas.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { side: "home", label: "Lineup LOCAL vs SP Visitante", data: statcastMatchup.homeLineupVsAwaySP, hist: statcastMatchup.homeLineupVsAwayTeam },
                  { side: "away", label: "Lineup VISITANTE vs SP Local", data: statcastMatchup.awayLineupVsHomeSP, hist: statcastMatchup.awayLineupVsHomeTeam },
                ].map((g) => {
                  const d = g.data;
                  if (!d) return null;
                  const helping = d.expectedTeamRunsDelta >= 0.20;
                  const hurting = d.expectedTeamRunsDelta <= -0.20;
                  return (
                    <div key={g.side} className={`p-3 rounded border ${
                      helping ? "bg-green-500/10 border-green-500/40" :
                      hurting ? "bg-red-500/10 border-red-500/40" :
                      "bg-slate-800/30 border-slate-600/40"
                    }`}>
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase">{g.label}</p>
                          <p className="text-sm font-bold text-white">{d.pitcherName} <span className="text-slate-400 font-normal text-xs">({d.battersAnalyzed}/{d.lineupSize} analizados)</span></p>
                        </div>
                        <div className="text-right">
                          <p className={`text-lg font-mono font-bold ${
                            helping ? "text-green-400" : hurting ? "text-red-400" : "text-slate-300"
                          }`}>
                            {d.expectedTeamRunsDelta >= 0 ? "+" : ""}{d.expectedTeamRunsDelta.toFixed(2)}
                          </p>
                          <p className="text-[9px] text-muted-foreground">runs vs liga</p>
                        </div>
                      </div>
                      <p className="text-[11px] text-cyan-200/90 mb-2">{d.signal}</p>
                      {/* 🎯 Fuente del lineup — honestidad ante todo */}
                      {d.lineupSource && (
                        <div className={`mb-2 px-2 py-1 rounded border text-[10px] flex items-center gap-1.5 ${
                          d.lineupSource === "CONFIRMED" ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300" :
                          d.lineupSource === "PROJECTED_LAST_GAME" ? "bg-blue-500/10 border-blue-500/30 text-blue-300" :
                          d.lineupSource === "PROJECTED_ROSTER" ? "bg-red-500/10 border-red-500/40 text-red-300" :
                          "bg-slate-700/30 border-slate-600/30 text-slate-300"
                        }`}>
                          <span className="font-semibold">
                            {d.lineupSource === "CONFIRMED" ? "✅ Lineup CONFIRMADO" :
                             d.lineupSource === "PROJECTED_LAST_GAME" ? "📝 Lineup PROYECTADO (último juego)" :
                             d.lineupSource === "PROJECTED_ROSTER" ? "⚠ LINEUP INCIERTO (roster genérico)" :
                             "⛔ Lineup NO DISPONIBLE"}
                          </span>
                          {d.lineupSource === "PROJECTED_ROSTER" && (
                            <span className="text-[9px] opacity-80">— puede incluir lesionados/banca</span>
                          )}
                        </div>
                      )}
                      {/* ⚠️ Calidad de los datos — honestidad sobre la confianza del análisis */}
                      {(d.dataConfidence === "LOW" || d.dataConfidence === "PARTIAL" || d.reason) && (
                        <div className={`mb-2 p-2 rounded border text-[10px] ${
                          d.dataConfidence === "LOW" ? "bg-amber-500/10 border-amber-500/40 text-amber-200" :
                          d.dataConfidence === "PARTIAL" ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-200" :
                          "bg-slate-800/40 border-slate-600/30 text-slate-300"
                        }`}>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="font-semibold">
                              {d.dataConfidence === "LOW" ? "⚠️ Confianza BAJA" : d.dataConfidence === "PARTIAL" ? "⚠ Confianza PARCIAL" : "ℹ Estado"}
                            </span>
                            {typeof d.directCount === "number" && (
                              <span className="text-[9px] opacity-80">({d.directCount} directos + {d.proxyCount ?? 0} proxy)</span>
                            )}
                          </div>
                          {d.reason && <p className="text-[10px] opacity-90">{d.reason}</p>}
                          {d.dataConfidence === "LOW" && !d.reason && (
                            <p className="text-[10px] opacity-90">Modelo aplica peso 40% al delta Statcast en lugar de 100%.</p>
                          )}
                          {d.dataConfidence === "PARTIAL" && (
                            <p className="text-[10px] opacity-90">Modelo aplica peso 75% al delta Statcast.</p>
                          )}
                        </div>
                      )}
                      {/* Repertorio del pitcher */}
                      {d.arsenal?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {d.arsenal.map((p: any, i: number) => (
                            <Badge key={i} variant="outline" className="text-[9px] border-slate-500/40 text-slate-300">
                              {p.name} {p.usage.toFixed(0)}%
                            </Badge>
                          ))}
                        </div>
                      )}
                      {/* Bullpen breakdown */}
                      {d.bullpenMatchup?.length > 0 && (
                        <div className="mb-2 bg-slate-900/40 rounded p-2">
                          <p className="text-[10px] font-semibold text-cyan-300 mb-1">🔥 Bullpen probable (últimos 3-4 IP):</p>
                          {d.bullpenMatchup.map((rp: any) => (
                            <div key={rp.pitcherId} className="flex justify-between items-center text-[10px] text-slate-300 mb-0.5">
                              <span><span className="text-cyan-400 font-mono">{rp.role}</span> {rp.pitcherName}</span>
                              <span className={`font-mono ${rp.expectedRunsDelta > 0.10 ? "text-green-400" : rp.expectedRunsDelta < -0.10 ? "text-red-400" : "text-slate-400"}`}>
                                {rp.expectedRunsDelta >= 0 ? "+" : ""}{rp.expectedRunsDelta.toFixed(2)} runs
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Top vulnerabilities — con filtro de forma reciente */}
                      {d.topVulnerabilities?.length > 0 && (
                        <div className="mb-2">
                          <p className="text-[10px] font-semibold text-red-300 mb-1">🔴 Bateadores en problemas:</p>
                          {d.topVulnerabilities.map((b: any) => {
                            const neutralized = b.vulnerabilitiesAnnotated?.some((v: any) => v.tier === "NEUTRALIZED");
                            return (
                              <div key={b.batterId} className={`text-[10px] text-slate-300 rounded p-1.5 mb-1 ${neutralized ? "bg-orange-950/30 border border-orange-500/30" : "bg-slate-900/50"}`}>
                                <div className="flex items-center flex-wrap gap-1">
                                  <span className="font-semibold">{b.battingOrder}. {b.batterName}</span>
                                  <span className="text-red-400 font-mono">xwOBA {b.expectedXwoba.toFixed(3)}</span>
                                  {b.momentumTier && b.momentumTier !== "UNKNOWN" && (
                                    <span className={`text-[9px] font-mono px-1 rounded ${
                                      b.momentumTier === "HOT" ? "bg-orange-500/30 text-orange-300" :
                                      b.momentumTier === "WARM" ? "bg-yellow-500/30 text-yellow-300" :
                                      b.momentumTier === "COLD" ? "bg-blue-500/30 text-blue-300" :
                                      b.momentumTier === "COOL" ? "bg-cyan-500/30 text-cyan-300" : "text-slate-400"
                                    }`}>
                                      {b.momentumTier} 15d {b.recentOps?.toFixed(3)}
                                    </span>
                                  )}
                                  {b.vsPitcherCareer && b.vsPitcherCareer.pa >= 8 && (
                                    <span className="text-[9px] font-mono text-violet-300">vs SP {b.vsPitcherCareer.pa}PA OPS {b.vsPitcherCareer.ops.toFixed(3)}</span>
                                  )}
                                </div>
                                {neutralized ? (
                                  <p className="text-orange-300 mt-0.5 text-[9px] font-semibold">⚠ Bateador caliente — vulnerabilidades históricas NEUTRALIZADAS</p>
                                ) : null}
                                {b.vulnerabilitiesAnnotated?.length > 0 && (
                                  <p className="text-slate-400 mt-0.5">{b.vulnerabilitiesAnnotated.slice(0, 3).map((v: any) => (
                                    `${v.tier === "NEUTRALIZED" ? "⚠" : "→"} ${v.pitch} (${v.xwoba.toFixed(3)})`
                                  )).join(" · ")}</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Top strengths — con filtro de forma reciente */}
                      {d.topStrengths?.length > 0 && d.topStrengths[0]?.expectedXwoba >= 0.330 && (
                        <div>
                          <p className="text-[10px] font-semibold text-green-300 mb-1">🟢 Bateadores en ventaja:</p>
                          {d.topStrengths.slice(0, 3).map((b: any) => {
                            const totalStr = b.strengthsAnnotated?.length || 0;
                            const realStr = b.strengthsAnnotated?.filter((s: any) => s.tier === "REAL").length || 0;
                            const allPapel = totalStr > 0 && realStr === 0;
                            return (
                              <div key={b.batterId} className={`text-[10px] text-slate-300 rounded p-1.5 mb-1 ${allPapel ? "bg-amber-950/30 border border-amber-500/30" : "bg-slate-900/50"}`}>
                                <div className="flex items-center flex-wrap gap-1">
                                  <span className="font-semibold">{b.battingOrder}. {b.batterName}</span>
                                  <span className="text-green-400 font-mono">xwOBA {b.expectedXwoba.toFixed(3)}</span>
                                  {b.momentumTier && b.momentumTier !== "UNKNOWN" && (
                                    <span className={`text-[9px] font-mono px-1 rounded ${
                                      b.momentumTier === "HOT" ? "bg-orange-500/30 text-orange-300" :
                                      b.momentumTier === "WARM" ? "bg-yellow-500/30 text-yellow-300" :
                                      b.momentumTier === "COLD" ? "bg-blue-500/30 text-blue-300" :
                                      b.momentumTier === "COOL" ? "bg-cyan-500/30 text-cyan-300" : "text-slate-400"
                                    }`}>
                                      {b.momentumTier} 15d {b.recentOps?.toFixed(3)}
                                    </span>
                                  )}
                                </div>
                                {allPapel && (
                                  <p className="text-amber-300 mt-0.5 text-[9px] font-semibold">⚠ Ventaja en papel — bateador frío, no contar al 100%</p>
                                )}
                                {b.strengthsAnnotated?.length > 0 && (
                                  <p className="text-slate-400 mt-0.5">{b.strengthsAnnotated.slice(0, 3).map((s: any) => (
                                    `${s.tier === "PAPEL" ? "⚠" : "⚡"} ${s.pitch} (${s.xwoba.toFixed(3)})`
                                  )).join(" · ")}</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Hot streaks ocultos — bateadores en forma reciente que el matchup pitch-by-pitch no destacaba */}
                      {d.perBatter?.some((b: any) => b.hotStreakHidden) && (
                        <div className="mt-2 p-2 rounded bg-orange-950/30 border border-orange-500/30">
                          <p className="text-[10px] font-semibold text-orange-300 mb-1">🔥 En forma reciente (el matchup pitch-by-pitch no los destacó):</p>
                          {d.perBatter.filter((b: any) => b.hotStreakHidden).map((b: any) => {
                            const isHotTier = b.momentumTier === "HOT";
                            return (
                              <div key={b.batterId} className="text-[10px] text-slate-200">
                                <span className="font-semibold">{b.battingOrder}. {b.batterName}</span>
                                <span className={`font-mono ml-2 ${isHotTier ? "text-orange-300" : "text-yellow-300"}`}>{isHotTier ? "HOT" : "WARM"} 15d OPS {b.recentOps?.toFixed(3)}</span>
                                <span className="text-orange-200/80 ml-2 text-[9px]">(+{isHotTier ? "0.040" : "0.020"} xwOBA aplicado al modelo)</span>
                              </div>
                            );
                          })}
                          <p className="text-[9px] text-orange-200/70 italic mt-1">El modelo sube su xwOBA esperado aunque su perfil pitch-by-pitch no lo capture (ej: bateadores con K% alto que igual conectan).</p>
                        </div>
                      )}
                      {/* Historic vs team */}
                      {g.hist && g.hist.signal && (
                        <p className="text-[10px] text-violet-300/80 mt-2 pt-2 border-t border-cyan-500/15">
                          📜 Histórico: {g.hist.signal}
                        </p>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* ROOKIE / BULLPEN GAME ALERT — lo más arriba para que el usuario lo vea PRIMERO */}
          {rookiePitcher && (rookiePitcher.home || rookiePitcher.away) && (
            <Card className={`${
              rookiePitcher.rookieAlert
                ? "border-red-500/60 bg-red-500/10"
                : "border-amber-500/40 bg-amber-500/5"
            }`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className={rookiePitcher.rookieAlert ? "text-red-400" : "text-amber-400"}>
                    {rookiePitcher.rookieAlert ? "🚨 ALERTA: Pitcher Rookie / Bullpen Game" : "📦 Experiencia de Pitchers"}
                  </span>
                </CardTitle>
                {rookiePitcher.rookieAlert && (
                  <p className="text-[11px] text-red-300 font-bold mt-1">
                    {rookiePitcher.alertText}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  { side: "home", label: "SP Local", team: homeTeam, info: rookiePitcher.home },
                  { side: "away", label: "SP Visitante", team: awayTeam, info: rookiePitcher.away },
                ].map((s) => {
                  if (!s.info) return null;
                  const i = s.info;
                  const danger = i.shouldPassPick;
                  return (
                    <div key={s.side} className={`p-2.5 rounded border ${
                      danger ? "bg-red-500/15 border-red-500/50" :
                      i.tier === "DEVELOPING" ? "bg-amber-500/10 border-amber-500/40" :
                      "bg-slate-700/30 border-slate-600"
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="text-[10px] text-muted-foreground uppercase">{s.label} ({s.team})</p>
                          <p className="text-sm font-bold text-white truncate">{i.pitcherName}</p>
                        </div>
                        <div className="text-right">
                          <Badge variant="outline" className={`text-[10px] ${
                            i.tier === "EXPERIENCED" ? "border-green-500/40 text-green-400" :
                            i.tier === "DEVELOPING" ? "border-amber-500/50 text-amber-400" :
                            "border-red-500/60 text-red-300"
                          }`}>
                            {i.tier === "DEBUT" ? "DEBUT" :
                             i.tier === "VERY_GREEN" ? "MUY VERDE" :
                             i.tier === "GREEN" ? "ROOKIE" :
                             i.tier === "DEVELOPING" ? "DESARROLLO" :
                             i.tier === "BULLPEN_GAME" ? "BULLPEN GAME" :
                             i.tier === "EXPERIENCED" ? "EXPERIMENTADO" : "?"}
                          </Badge>
                        </div>
                      </div>
                      <div className="mt-1.5 grid grid-cols-3 gap-1 text-[10px]">
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">Career starts</p>
                          <p className="font-mono text-white">{i.careerStarts}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">Career IP</p>
                          <p className="font-mono text-white">{i.careerIP.toFixed(0)}</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">Penalty</p>
                          <p className={`font-mono ${i.rivalRunsPenalty < 0 ? "text-red-400" : "text-white"}`}>
                            {i.rivalRunsPenalty.toFixed(1)} runs
                          </p>
                        </div>
                      </div>
                      <p className="text-[10px] text-amber-200/90 mt-1.5">{i.signal}</p>
                    </div>
                  );
                })}
                <p className="text-[9px] text-muted-foreground border-t border-amber-500/20 pt-2">
                  Pitchers rookies dominan sus primeros 2-3 starts MLB porque los bateadores no tienen scouting.
                  Cuando tu modelo da &gt;70% al equipo bueno y el rival manda rookie/bullpen game, considera PASS.
                </p>
              </CardContent>
            </Card>
          )}

          {/* CATCHER FRAMING — cuánto valor genera el catcher robando strikes */}
          {catcherFraming && (catcherFraming.homeCatcher?.framing || catcherFraming.awayCatcher?.framing) && (
            <Card className="border-fuchsia-500/40 bg-fuchsia-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-fuchsia-400">🥎 Catcher Framing</span>
                  <Badge variant="outline" className={`text-[9px] ${
                    catcherFraming.bothLineupsConfirmed
                      ? "border-green-500/50 text-green-400"
                      : "border-amber-500/40 text-amber-400"
                  }`}>
                    {catcherFraming.bothLineupsConfirmed ? "✓ Lineup confirmado" : "Proyectado"}
                  </Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Cuántos strikes roba el catcher en zonas borde (Statcast). Élite ahorra ~0.30 ERA al SP. Las casas no procesan esto.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  { side: "home", label: "Local", team: homeTeam, info: catcherFraming.homeCatcher },
                  { side: "away", label: "Visitante", team: awayTeam, info: catcherFraming.awayCatcher },
                ].map((s) => {
                  if (!s.info?.framing) return null;
                  const f = s.info.framing;
                  const elite = f.tier === "ELITE";
                  const good = f.tier === "GOOD";
                  const poor = f.tier === "POOR";
                  const terrible = f.tier === "TERRIBLE";
                  return (
                    <div key={s.side} className={`p-2.5 rounded border ${
                      elite ? "bg-green-500/15 border-green-500/50" :
                      good ? "bg-green-500/8 border-green-500/30" :
                      terrible ? "bg-red-500/15 border-red-500/50" :
                      poor ? "bg-red-500/8 border-red-500/30" :
                      "bg-slate-700/30 border-slate-600"
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <p className="text-[10px] text-muted-foreground uppercase">{s.label} ({s.team})</p>
                            <Badge variant="outline" className={`text-[8px] py-0 px-1 ${
                              s.info?.source === "lineup_confirmado"
                                ? "border-green-500/50 text-green-400"
                                : "border-amber-500/40 text-amber-400"
                            }`}>
                              {s.info?.source === "lineup_confirmado" ? "✓" : "~"}
                            </Badge>
                          </div>
                          <p className="text-sm font-bold text-white truncate">{f.name}</p>
                          <p className="text-[10px] text-muted-foreground">{f.pitches} framing chances</p>
                        </div>
                        <div className="text-right">
                          <Badge variant="outline" className={`text-[10px] mb-1 ${
                            elite ? "border-green-500/60 text-green-300" :
                            good ? "border-green-500/40 text-green-400" :
                            terrible ? "border-red-500/60 text-red-300" :
                            poor ? "border-red-500/40 text-red-400" :
                            "border-slate-500/40 text-slate-400"
                          }`}>
                            {f.tier}
                          </Badge>
                          <p className={`text-lg font-mono font-bold ${
                            f.runValueTotal > 1 ? "text-green-400" :
                            f.runValueTotal < -1 ? "text-red-400" : "text-slate-300"
                          }`}>
                            {f.runValueTotal > 0 ? "+" : ""}{f.runValueTotal.toFixed(2)}
                          </p>
                          <p className="text-[9px] text-muted-foreground">runs salvados</p>
                        </div>
                      </div>
                      <div className="mt-1.5 grid grid-cols-2 gap-2 text-[10px]">
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">% strikes en shadow</p>
                          <p className="font-mono text-white">{(f.framingPctTotal * 100).toFixed(1)}%</p>
                        </div>
                        <div className="text-center bg-slate-800/40 rounded p-1">
                          <p className="text-muted-foreground">Impacto al SP propio</p>
                          <p className={`font-mono ${f.eraImpact < 0 ? "text-green-400" : f.eraImpact > 0 ? "text-red-400" : "text-white"}`}>
                            {f.eraImpact > 0 ? "+" : ""}{f.eraImpact.toFixed(2)} ERA
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <p className="text-[10px] text-amber-200/90">{catcherFraming.signal}</p>
                <p className="text-[9px] text-muted-foreground border-t border-fuchsia-500/20 pt-2">
                  RV positivo (verde) = framer élite. RV negativo (rojo) = framer pobre. ELITE ≥+3.0 RV → -0.30 ERA al SP.
                </p>
              </CardContent>
            </Card>
          )}

          {/* WIND-PARK COMBINADO */}
          {windPark && Math.abs(windPark.runsAdjustment ?? 0) >= 0.1 && (
            <Card className="border-sky-500/40 bg-sky-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-sky-400">🌬️ Wind-Park — viento + estadio</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className={`p-2.5 rounded border ${
                  windPark.runsAdjustment > 0.5 ? "bg-orange-500/15 border-orange-500/50" :
                  windPark.runsAdjustment < -0.5 ? "bg-blue-500/15 border-blue-500/50" :
                  "bg-slate-700/30 border-slate-600"
                }`}>
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <div>
                      <p className="text-[10px] text-muted-foreground">Viento</p>
                      <p className="text-xs font-mono text-white">{windPark.windDirection}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Temperatura</p>
                      <p className="text-xs font-mono text-white">{windPark.temperature}°F</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Condición</p>
                      <p className="text-xs font-mono text-white">{windPark.condition}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-700 pt-2">
                    <div>
                      <p className="text-[10px] text-muted-foreground">Ajuste runs total</p>
                      <p className={`text-lg font-mono font-bold ${
                        windPark.runsAdjustment > 0.3 ? "text-orange-400" :
                        windPark.runsAdjustment < -0.3 ? "text-blue-400" :
                        "text-slate-300"
                      }`}>
                        {windPark.runsAdjustment > 0 ? "+" : ""}{windPark.runsAdjustment.toFixed(2)}
                      </p>
                    </div>
                    {windPark.hrFactor && Math.abs(windPark.hrFactor - 1) > 0.05 && (
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">HR factor</p>
                        <p className={`text-lg font-mono font-bold ${
                          windPark.hrFactor > 1.05 ? "text-orange-400" :
                          windPark.hrFactor < 0.95 ? "text-blue-400" : "text-slate-300"
                        }`}>
                          ×{windPark.hrFactor.toFixed(2)}
                        </p>
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-amber-200/90 mt-2">{windPark.signal}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* BULLPEN AVAILABILITY — closer cansado, bullpen comprometido, predicción de cerrador HOY */}
          {bullpenStatus && (bullpenStatus.home || bullpenStatus.away) && (
            <Card className="border-rose-500/40 bg-rose-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-rose-400">🔧 Bullpen Availability</span>
                  <Badge variant="outline" className="text-[9px] border-rose-500/40 text-rose-300">Closer fatigue</Badge>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Cómo el bullpen llegó hoy basado en últimos 3 días. Las casas casi nunca ajustan por esto.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { side: "home", label: "Local", team: homeTeam, data: bullpenStatus.home },
                  { side: "away", label: "Visitante", team: awayTeam, data: bullpenStatus.away },
                ].map((s) => {
                  if (!s.data) return null;
                  const top: any[] = [s.data.closer, ...(s.data.setupMen ?? [])].filter(Boolean);
                  return (
                    <div key={s.side} className={`p-2.5 rounded border ${
                      s.data.bullpenCompromised ? "bg-red-500/15 border-red-500/50" :
                      !s.data.closerAvailable ? "bg-amber-500/15 border-amber-500/40" :
                      "bg-slate-700/30 border-slate-600"
                    }`}>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {s.label} ({s.team || s.data.teamName})
                        </p>
                        <Badge variant="outline" className={`text-[9px] ${
                          s.data.bullpenCompromised ? "border-red-500/60 text-red-300" :
                          !s.data.closerAvailable ? "border-amber-500/60 text-amber-300" :
                          "border-green-500/40 text-green-400"
                        }`}>
                          {s.data.bullpenCompromised ? "COMPROMETIDO" : !s.data.closerAvailable ? "Closer fuera" : "Bullpen OK"}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        {top.slice(0, 4).map((p: any) => (
                          <div key={p.id} className="flex items-center gap-2 text-[10px]">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${
                              p.availability === "DISPONIBLE" ? "bg-green-400" :
                              p.availability === "RIESGO" ? "bg-amber-400" :
                              "bg-red-400"
                            }`}></span>
                            <span className="text-white font-medium truncate flex-1">{p.name}</span>
                            <Badge variant="outline" className="text-[9px] px-1 py-0">
                              {p.role === "CLOSER" ? "CL" : p.role === "SETUP" ? "SU" : p.role === "LONG" ? "LR" : "MR"}
                            </Badge>
                            <span className="text-muted-foreground">ERA {p.era?.toFixed(2) ?? "—"}</span>
                            <span className="text-amber-300/80 truncate max-w-[140px]">{p.reason}</span>
                          </div>
                        ))}
                      </div>
                      {s.data.predictedCloser && !s.data.closerAvailable && (
                        <div className="mt-2 p-1.5 rounded bg-cyan-500/10 border border-cyan-500/30">
                          <p className="text-[10px] text-cyan-300">
                            <strong>Cerrará hoy:</strong> {s.data.predictedCloser.name} ({s.data.predictedCloser.role})
                            — ERA {s.data.predictedCloser.era?.toFixed(2) ?? "—"}
                          </p>
                        </div>
                      )}
                      <p className="text-[10px] text-amber-200/90 mt-2">{s.data.signal}</p>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* PITCHER ARCHETYPE MATCHUP — cómo le pega el equipo a ESTE tipo de pitcher históricamente */}
          {archetypeMatchup && (archetypeMatchup.home || archetypeMatchup.away) && (
            <Card className="border-orange-500/40 bg-orange-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-orange-400">🎯 Arquetipo de Pitcher — patrón histórico</span>
                </CardTitle>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Cómo le pega CADA equipo a CADA tipo de pitcher en últimos ~200 juegos. Esto las casas no lo procesan.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                {[archetypeMatchup.home, archetypeMatchup.away].filter(Boolean).map((m: any, idx: number) => {
                  const isHomeAttacker = idx === 0; // home enfrenta pitcher visitante
                  const teamName = isHomeAttacker ? homeTeam : awayTeam;
                  const rec = isHomeAttacker ? m.homeRecord : m.awayRecord;
                  const advantageStrong = rec.significantSample && rec.avgRunsScored >= 5.5;
                  const advantageWeak = rec.significantSample && rec.avgRunsScored <= 3.0;
                  return (
                    <div key={idx} className={`p-2.5 rounded border ${
                      advantageStrong ? "bg-green-500/10 border-green-500/40" :
                      advantageWeak ? "bg-red-500/10 border-red-500/40" :
                      "bg-slate-700/30 border-slate-600"
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex-1">
                          <p className="text-[10px] text-muted-foreground uppercase">
                            {isHomeAttacker ? "Local" : "Visitante"} ({teamName}) vs {m.pitcherName}
                          </p>
                          <p className="text-xs font-bold text-cyan-300 mt-0.5">
                            Tipo: {m.archetypeLabel}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={`text-lg font-bold font-mono ${
                            advantageStrong ? "text-green-400" :
                            advantageWeak ? "text-red-400" :
                            "text-slate-300"
                          }`}>
                            {rec.games > 0 ? rec.avgRunsScored.toFixed(1) : "—"}
                          </p>
                          <p className="text-[9px] text-muted-foreground">runs/juego</p>
                        </div>
                      </div>
                      {rec.games > 0 && (
                        <div className="mt-1.5 grid grid-cols-3 gap-1 text-[10px]">
                          <div className="text-center bg-slate-800/40 rounded p-1">
                            <p className="text-muted-foreground">Juegos</p>
                            <p className="font-mono text-white">{rec.games}</p>
                          </div>
                          <div className="text-center bg-slate-800/40 rounded p-1">
                            <p className="text-muted-foreground">Record</p>
                            <p className="font-mono text-white">{rec.wins}-{rec.losses}</p>
                          </div>
                          <div className="text-center bg-slate-800/40 rounded p-1">
                            <p className="text-muted-foreground">% Win</p>
                            <p className={`font-mono ${rec.winRate >= 0.55 ? "text-green-400" : rec.winRate <= 0.45 ? "text-red-400" : "text-white"}`}>
                              {(rec.winRate * 100).toFixed(0)}%
                            </p>
                          </div>
                        </div>
                      )}
                      <p className="text-[10px] text-amber-200/90 mt-1.5">{m.signal}</p>
                    </div>
                  );
                })}
                <p className="text-[9px] text-muted-foreground border-t border-orange-500/20 pt-2 mt-2">
                  Verde: equipo le pega fuerte (≥5.5 r/g). Rojo: sufre (≤3.0 r/g). Mensaje basado en muestra significativa (≥5 juegos).
                </p>
              </CardContent>
            </Card>
          )}

          {lineupMatchup && (
            <Card className="border-blue-500/30 bg-blue-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <span className="text-blue-400">⚾ Matchup hombre-por-hombre</span>
                  <Badge variant="outline" className="text-[10px]">
                    {lineupMatchup.homeLineup?.confirmed && lineupMatchup.awayLineup?.confirmed ? "Lineup confirmado" : "Lineup proyectado"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { side: "home", label: "Local", lineup: lineupMatchup.homeLineup, oppPitcher: lineupMatchup.awayPitcher, runsDelta: lineupMatchup.adjustment?.homeRunsDelta },
                    { side: "away", label: "Visitante", lineup: lineupMatchup.awayLineup, oppPitcher: lineupMatchup.homePitcher, runsDelta: lineupMatchup.adjustment?.awayRunsDelta },
                  ].map((s) => (
                    <div key={s.side} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground uppercase">{s.label}</span>
                        <span className={`text-[10px] font-mono font-bold ${(s.runsDelta ?? 0) > 0 ? "text-green-400" : (s.runsDelta ?? 0) < 0 ? "text-red-400" : "text-slate-400"}`}>
                          {(s.runsDelta ?? 0) > 0 ? "+" : ""}{(s.runsDelta ?? 0).toFixed(2)} runs
                        </span>
                      </div>
                      <p className="text-[10px] text-cyan-300">
                        vs {s.oppPitcher?.fullName ?? "?"} ({s.oppPitcher?.hand === "L" ? "LHP" : s.oppPitcher?.hand === "R" ? "RHP" : "?"})
                      </p>
                      <div className="text-[10px] text-slate-400 flex items-center flex-wrap gap-1.5">
                        <span>OPS: <span className="font-mono text-white">{s.lineup?.avgOps ? s.lineup.avgOps.toFixed(3) : "N/A"}</span></span>
                        {s.lineup?.avgWeightedWoba != null && (
                          <span>wOBA pond: <span className="font-mono text-cyan-300" title="wOBA ponderado por slot de bateo (slot 3-4 pesa 25% más)">{s.lineup.avgWeightedWoba.toFixed(3)}</span></span>
                        )}
                        {s.lineup?.seasonUsed === "current" && (
                          <span className="text-[9px] px-1 rounded bg-emerald-500/20 text-emerald-300">2026</span>
                        )}
                        {s.lineup?.seasonUsed === "previous" && (
                          <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-300" title="Lineup con poca muestra 2026 — usa splits 2025 como proxy">2025 (proxy)</span>
                        )}
                        {s.lineup?.seasonUsed === "mixed" && (
                          <span className="text-[9px] px-1 rounded bg-yellow-500/20 text-yellow-300">mix 2026/2025</span>
                        )}
                      </div>
                      <div className="space-y-0.5 max-h-60 overflow-y-auto">
                        {(s.lineup?.players ?? []).slice(0, 9).map((p: any, idx: number) => {
                          const slot = p.slot ?? (idx + 1);
                          const isCleanup = slot === 3 || slot === 4;
                          const contactColor = p.contactQuality === "ELITE" ? "text-purple-300" :
                            p.contactQuality === "BUENO" ? "text-cyan-300" :
                            p.contactQuality === "LIMITADO" ? "text-red-300" : "text-slate-400";
                          const opsColor = (p.ops ?? 0) >= 0.800 ? "text-green-400" : (p.ops ?? 0) >= 0.700 ? "text-amber-300" : (p.ops ?? 0) >= 0.600 ? "text-slate-300" : "text-red-400";
                          return (
                            <div key={p.id ?? idx} className="text-[10px] border-b border-slate-800/50 pb-1">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-slate-300 truncate flex-1">
                                  <span className={isCleanup ? "text-yellow-300 font-bold" : ""}>{slot}.</span>{" "}
                                  {p.name?.split(" ").slice(-1)[0]}
                                  <span className="text-muted-foreground"> ({p.position})</span>
                                </span>
                                <span className={`font-mono ${opsColor}`}>
                                  {p.ops ? p.ops.toFixed(3) : "—"}
                                </span>
                              </div>
                              {/* Métricas avanzadas */}
                              <div className="flex items-center gap-2 text-[9px] text-slate-500 mt-0.5">
                                {p.wobaAdjusted != null && p.wobaAdjusted > 0 && (
                                  <span title="wOBA ajustado por BABIP">wOBA <span className="font-mono text-slate-300">{p.wobaAdjusted.toFixed(3)}</span></span>
                                )}
                                {p.iso != null && p.iso > 0 && (
                                  <span title="Isolated Power (SLG-AVG)">ISO <span className="font-mono text-slate-300">{p.iso.toFixed(3)}</span></span>
                                )}
                                {p.kPct != null && (
                                  <span title="Strikeout %" className={p.kPct >= 0.30 ? "text-red-300" : p.kPct <= 0.18 ? "text-green-300" : ""}>K% <span className="font-mono">{(p.kPct * 100).toFixed(0)}</span></span>
                                )}
                                {p.contactQuality && p.contactQuality !== "PROMEDIO" && (
                                  <span className={`text-[8px] px-1 rounded ${contactColor} bg-slate-800/50`} title={`Calidad de contacto: ${p.contactQuality}`}>{p.contactQuality}</span>
                                )}
                                {p.slotWt && p.slotWt !== 1 && (
                                  <span className="text-[8px] opacity-60" title={`Peso por slot: ${p.slotWt}x`}>×{p.slotWt.toFixed(2)}</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-muted-foreground border-t border-slate-700/50 pt-2 space-y-1">
                  <p><strong className="text-cyan-300">Métricas mostradas:</strong> wOBA (ponderado por BABIP + slot), ISO (poder isolado), K% (strikeout rate), calidad de contacto (ELITE/BUENO/LIMITADO).</p>
                  <p><strong className="text-yellow-300">Slot 3-4 (cleanup)</strong> pesa 25% más que slot 8-9 — PA proyectadas reales por turno.</p>
                  <p>Splits temporada 2026 (cae a 2025 si &lt;30 PA — aparece etiqueta naranja). El delta de runs entra a la predicción usando ΔwOBA × 12 (estandar sabermetric).</p>
                </div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      {/* Team Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {buildTeamCard("home")}
          {buildTeamCard("away")}
        </div>

        {/* CONTEXTO — todo automático */}
        <Card className="border border-slate-700/50 bg-slate-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-slate-300">Contexto del Juego <span className="text-xs text-muted-foreground font-normal ml-2">automático</span></CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
              {/* Park Factor */}
              <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Estadio</p>
                <p className="text-lg font-bold font-mono text-blue-400">{parkFactor}</p>
                {parkName && <p className="text-xs text-slate-500 truncate mt-1">{parkName}</p>}
              </div>
              {/* Temperatura */}
              <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                <p className="text-xs text-muted-foreground mb-1">Temperatura</p>
                <p className="text-lg font-bold font-mono">{tempF}°F</p>
                <p className={`text-xs mt-1 ${parseInt(tempF) > 85 ? "text-red-400" : parseInt(tempF) < 55 ? "text-blue-400" : "text-muted-foreground"}`}>
                  {parseInt(tempF) > 85 ? "Calor → +carreras" : parseInt(tempF) < 55 ? "Frío → -carreras" : "Templado"}
                </p>
              </div>
              {/* Viento */}
              <div className={`rounded-lg p-3 text-center ${windFavorable ? "bg-green-500/10 border border-green-500/20" : "bg-slate-800/50"}`}>
                <p className="text-xs text-muted-foreground mb-1">Viento</p>
                <p className={`text-lg font-bold ${windFavorable ? "text-green-400" : "text-muted-foreground"}`}>
                  {windFavorable ? "↗ Salida" : "↙ Entrada"}
                </p>
                <p className={`text-xs mt-1 ${windFavorable ? "text-green-400" : "text-muted-foreground"}`}>
                  {windFavorable ? "Favorable → +HR" : "No favorable"}
                </p>
              </div>
              {/* Horario */}
              <div className={`rounded-lg p-3 text-center ${isNight ? "bg-indigo-500/10 border border-indigo-500/20" : "bg-amber-500/10 border border-amber-500/20"}`}>
                <p className="text-xs text-muted-foreground mb-1">Horario</p>
                <p className={`text-lg font-bold ${isNight ? "text-indigo-400" : "text-amber-400"}`}>
                  {isNight ? "🌙 Noche" : "☀️ Día"}
                </p>
              </div>
              {/* Park effect */}
              <div className={`rounded-lg p-3 text-center ${parseFloat(parkFactor) > 1.05 ? "bg-red-500/10 border border-red-500/20" : parseFloat(parkFactor) < 0.95 ? "bg-blue-500/10 border border-blue-500/20" : "bg-slate-800/50"}`}>
                <p className="text-xs text-muted-foreground mb-1">Efecto Park</p>
                <p className={`text-lg font-bold ${parseFloat(parkFactor) > 1.05 ? "text-red-400" : parseFloat(parkFactor) < 0.95 ? "text-blue-400" : "text-muted-foreground"}`}>
                  {parseFloat(parkFactor) > 1.05 ? "+Carreras" : parseFloat(parkFactor) < 0.95 ? "-Carreras" : "Neutro"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* LÍNEAS */}
        <Card className="border border-slate-700/50 bg-slate-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-slate-300">Líneas de Apuesta</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground font-medium">Moneyline</p>
            <div className="grid grid-cols-2 gap-3">
              {numInput("ML Local", mlOdds, setMlOdds, "line-ml-odds", "numeric", "-150")}
              {numInput("ML Visitante", mlOddsAway, setMlOddsAway, "line-ml-away", "numeric", "+130")}
            </div>
            <p className="text-xs text-muted-foreground font-medium">Run Line</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {numInput("Línea Run Line", runLine, setRunLine, "line-run-line", "decimal", "-1.5")}
              {numInput("Cuota Local", rlOdds, setRlOdds, "input-rl-odds", "numeric", "-110")}
              {numInput("Cuota Visitante", rlOddsAway, setRlOddsAway, "input-rl-away", "numeric", "-110")}
            </div>
            <p className="text-xs text-muted-foreground font-medium">Over/Under</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {numInput("Línea O/U", ouLine, setOuLine, "line-ou", "decimal", "8.5")}
              {numInput("Cuota OVER", overOdds, setOverOdds, "input-over-odds", "numeric", "-110")}
              {numInput("Cuota UNDER", underOdds, setUnderOdds, "input-under-odds", "numeric", "-110")}
            </div>
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground font-medium">F5 Moneyline (1-5 entradas)</p>
              {f5OddsSource === "consenso" && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">consenso FD/BetMGM</span>
              )}
              {f5OddsSource === "manual" && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Hard Rock manual</span>
              )}
            </div>
            <p className="text-[10px] text-amber-400/80 -mt-2">Hard Rock no expone F5 vía API. Usa ⚡ Cuotas F5 (consenso) o ingresa manual desde Hard Rock.</p>
            <div className="grid grid-cols-2 gap-3">
              {numInput("F5 ML Local", f5MlHome, setF5MlHome, "line-f5-ml-home", "numeric", "-130")}
              {numInput("F5 ML Visitante", f5MlAway, setF5MlAway, "line-f5-ml-away", "numeric", "+110")}
            </div>
            <p className="text-xs text-muted-foreground font-medium">F5 Over/Under (opcional)</p>
            <div className="grid grid-cols-1 gap-3">
              {numInput("Línea F5 O/U", f5OuLine, setF5OuLine, "line-f5-ou", "decimal", "4.5")}
            </div>
            <Button
              onClick={handlePredict}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3"
              data-testid="btn-predict"
            >
              <Brain className="w-4 h-4 mr-2" />
              Generar Predicción
            </Button>
          </CardContent>
        </Card>

        {/* RESULTS */}
        {result && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-slate-200 flex items-center gap-2">
              <Star className="w-5 h-5 text-yellow-400" />
              Resultados del Análisis
            </h2>

            {/* ⚭ PICK QUALITY SCORES — UNO POR MERCADO */}
            {result.pickQualities && (() => {
              const allPqs = [
                { key: "ml", label: "Moneyline", pq: result.pickQualities.ml },
                { key: "f5", label: "F5 (5 entradas)", pq: result.pickQualities.f5 },
                { key: "runLine", label: "Run Line", pq: result.pickQualities.runLine },
                { key: "ou", label: "Total O/U", pq: result.pickQualities.ou },
              ].filter(x => x.pq);
              const playable = allPqs.filter(x => x.pq!.recommendation !== "PASS");
              const bestPick = playable.length > 0
                ? playable.reduce((a, b) => (b.pq!.score > a.pq!.score) ? b : a)
                : null;
              return (
              <div className="space-y-3">
                {/* ⭐ LA ÚNICA RECOMENDACIÓN */}
                {bestPick ? (
                  <Card className="border-2 border-emerald-500/60 bg-gradient-to-br from-emerald-500/15 to-cyan-500/10">
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[10px] text-emerald-300 uppercase tracking-wider font-semibold">⭐ ÚNICA JUGADA RECOMENDADA</p>
                          <p className="text-2xl font-bold text-white mt-1">
                            {bestPick.pq!.pickedSideLabel}
                            {bestPick.pq!.pickedSideExtra && <span className="text-cyan-300 ml-2">{bestPick.pq!.pickedSideExtra}</span>}
                          </p>
                          <p className="text-sm text-slate-300 mt-1">
                            <span className="text-slate-400">{bestPick.label}</span>
                            <span className="text-yellow-300 font-mono ml-2">{bestPick.pq!.pickedSideOdds > 0 ? "+" : ""}{bestPick.pq!.pickedSideOdds}</span>
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={`text-3xl font-bold ${
                            bestPick.pq!.recommendation === "BET_FUERTE" ? "text-emerald-300" :
                            bestPick.pq!.recommendation === "BET" ? "text-green-300" : "text-yellow-300"
                          }`}>
                            {bestPick.pq!.recommendation === "BET_FUERTE" ? "🔥 BET FUERTE" :
                             bestPick.pq!.recommendation === "BET" ? "✅ BET" : "⚠️ LEAN"}
                          </p>
                          <p className="text-base text-white mt-1"><span className="font-bold">{bestPick.pq!.stakeUnits.toFixed(1)}</span> unidades</p>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-300 italic border-t border-emerald-500/20 pt-2">
                        🎯 {bestPick.pq!.reasoning}
                      </p>
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="border-2 border-red-500/40 bg-red-500/5">
                    <CardContent className="p-4 text-center">
                      <p className="text-2xl font-bold text-red-300">🚫 PASS — Sin jugada en este partido</p>
                      <p className="text-sm text-slate-400 mt-1">Ningún mercado tiene edge suficiente. Proteger banca.</p>
                    </CardContent>
                  </Card>
                )}
                <h3 className="text-sm font-semibold text-slate-400 flex items-center gap-2 pt-2">
                  <span>📊 Análisis por Mercado</span>
                  <Badge variant="outline" className="text-[9px] border-slate-500/40 text-slate-500">solo informativo</Badge>
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {(["ml", "f5", "runLine", "ou"] as const).map((key) => {
                    const pq = result.pickQualities![key];
                    if (!pq) return null;
                    const isBest = bestPick?.key === key;
                    const marketLabel = pq.market === "ML" ? "Moneyline" : pq.market === "F5" ? "F5 (5 entradas)" : pq.market === "RUN_LINE" ? "Run Line" : "Total O/U";
                    return (
                      <Card key={key} className={`border transition-opacity ${isBest ? "" : "opacity-50"} ${
                        pq.recommendation === "BET_FUERTE" ? "border-emerald-500/60 bg-emerald-500/10" :
                        pq.recommendation === "BET" ? "border-green-500/50 bg-green-500/5" :
                        pq.recommendation === "LEAN" ? "border-yellow-500/50 bg-yellow-500/5" :
                        "border-slate-600/40 bg-slate-800/20"
                      }`}>
                        <CardContent className="p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-[10px] text-slate-500 uppercase tracking-wider">{marketLabel}</p>
                              <p className={`text-lg font-bold ${
                                pq.recommendation === "BET_FUERTE" ? "text-emerald-300" :
                                pq.recommendation === "BET" ? "text-green-300" :
                                pq.recommendation === "LEAN" ? "text-yellow-300" :
                                "text-slate-400"
                              }`}>
                                {pq.recommendation === "BET_FUERTE" ? "🔥 BET FUERTE" :
                                 pq.recommendation === "BET" ? "✅ BET" :
                                 pq.recommendation === "LEAN" ? "⚠️ LEAN" :
                                 "🚫 PASS"}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className={`text-2xl font-bold font-mono ${
                                pq.score >= 8 ? "text-emerald-400" :
                                pq.score >= 7 ? "text-green-400" :
                                pq.score >= 6 ? "text-yellow-400" :
                                "text-red-400"
                              }`}>{pq.score.toFixed(1)}</p>
                              <p className="text-[9px] text-slate-500">tier {pq.rating}</p>
                            </div>
                          </div>
                          {pq.recommendation !== "PASS" && (
                            <div className="bg-slate-900/40 rounded p-2 text-xs">
                              <p className="text-white">
                                <span className="text-slate-400">Lado:</span> <span className="font-bold text-cyan-300">{pq.pickedSideLabel}</span>
                                {pq.pickedSideExtra && <span className="text-cyan-300 ml-1">{pq.pickedSideExtra}</span>}
                                <span className="text-yellow-300 font-mono ml-2">{pq.pickedSideOdds > 0 ? "+" : ""}{pq.pickedSideOdds}</span>
                              </p>
                              <p className="text-slate-300 mt-1">
                                Stake: <span className="font-bold text-white">{pq.stakeUnits.toFixed(1)} u</span>
                              </p>
                            </div>
                          )}
                          <div className="grid grid-cols-3 gap-1 text-[10px] text-center">
                            <div className="bg-slate-800/50 rounded p-1">
                              <p className="text-slate-500 text-[8px]">EDGE</p>
                              <p className={`font-mono font-bold ${
                                pq.edgeReal >= 5 ? "text-emerald-400" :
                                pq.edgeReal >= 0 ? "text-yellow-400" :
                                "text-red-400"
                              }`}>{pq.edgeReal >= 0 ? "+" : ""}{pq.edgeReal.toFixed(1)}pp</p>
                            </div>
                            <div className="bg-slate-800/50 rounded p-1">
                              <p className="text-slate-500 text-[8px]">FACT</p>
                              <p className="text-cyan-400 font-mono font-bold">{pq.factorsAlignment}</p>
                            </div>
                            <div className="bg-slate-800/50 rounded p-1">
                              <p className="text-slate-500 text-[8px]">GAP</p>
                              <p className={`font-mono font-bold ${
                                pq.marketGap >= 25 ? "text-red-400" :
                                pq.marketGap >= 15 ? "text-yellow-400" :
                                "text-green-400"
                              }`}>{pq.marketGap.toFixed(0)}pp</p>
                            </div>
                          </div>
                          {pq.warnings.length > 0 && (
                            <div className="space-y-0.5 bg-red-500/5 border border-red-500/20 rounded p-1.5">
                              {pq.warnings.slice(0, 3).map((w, i) => (
                                <p key={i} className="text-[10px] text-red-300">{w}</p>
                              ))}
                            </div>
                          )}
                          {pq.confirms.length > 0 && pq.recommendation !== "PASS" && (
                            <div className="space-y-0.5">
                              {pq.confirms.slice(0, 3).map((c, i) => (
                                <p key={i} className="text-[10px] text-green-300">{c}</p>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
              );
            })()}

            {/* JUGADA ESTRELLA — oculta cuando hay PQS (la Única jugada de arriba ya cumple esta función) */}
            {!result.pickQualities && result.bestPlay ? (
              <Card className="border border-yellow-500/40 bg-yellow-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-yellow-400 flex items-center gap-2">
                    <Star className="w-4 h-4" />
                    Jugada Estrella — {result.bestPlay.market}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xl font-bold text-white">{result.bestPlay.recommendation}</span>
                    <Badge className={`border ${signalColor(result.bestPlay.signal)}`}>
                      {result.bestPlay.signal}
                    </Badge>
                    <span className="text-sm text-slate-400">{result.bestPlay.edgeLabel}</span>
                  </div>
                  <p className="text-sm text-slate-400">{result.bestPlay.reason}</p>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Confianza</span>
                      <span className={`font-semibold ${confidenceColor(result.bestPlay.confidence)}`}>
                        {result.bestPlay.confidence}%
                      </span>
                    </div>
                    <Progress value={result.bestPlay.confidence} className="h-2" />
                  </div>
                </CardContent>
              </Card>
            ) : !result.pickQualities ? (
              <Card className="border border-red-500/40 bg-red-500/5">
                <CardContent className="py-6 flex items-center gap-3">
                  <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                  <div>
                    <p className="font-bold text-red-400 text-lg">NO APOSTAR</p>
                    <p className="text-sm text-slate-400">Ningún mercado presenta edge suficiente en este juego.</p>
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {/* AJUSTE AUTOMATICO POR POCAS APERTURAS */}
            {(() => {
              const hIP = parseFloat(homeIP) || 999;
              const aIP = parseFloat(awayIP) || 999;
              const shrinkTier = (ip: number): string | null => {
                if (ip >= 60) return null;                                  // sin shrinkage
                if (ip >= 40) return "shrinkage LEVE (15% liga)";
                if (ip >= 20) return "shrinkage MODERADO (40% liga)";
                return "shrinkage AGRESIVO (70% liga — muestra muy chica)";
              };
              const msgs: string[] = [];
              const ht = shrinkTier(hIP);
              const at = shrinkTier(aIP);
              if (ht) msgs.push(`Pitcher local (${hIP.toFixed(0)} IP) — ${ht}`);
              if (at) msgs.push(`Pitcher visitante (${aIP.toFixed(0)} IP) — ${at}`);
              if (msgs.length === 0) return null;
              return (
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3 space-y-1">
                  {msgs.map((m, i) => (
                    <p key={i} className="text-xs text-blue-300">Ajuste: {m}</p>
                  ))}
                </div>
              );
            })()}

            {/* ML PARTIDO COMPLETO */}
            <Card className="border border-blue-500/30 bg-slate-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-blue-400 uppercase tracking-wider">ML — Partido Completo</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>{result.homeTeamName}</span>
                    <span>{result.awayTeamName}</span>
                  </div>
                  <div className="relative h-4 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 top-0 h-full bg-blue-500 rounded-full transition-all"
                      style={{ width: `${(result.homeProb * 100).toFixed(1)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs font-semibold">
                    <span className="text-blue-400">{(result.homeProb * 100).toFixed(1)}%</span>
                    <span className="text-slate-400">{(result.awayProb * 100).toFixed(1)}%</span>
                  </div>
                </div>

                {result.factorBreakdown && result.factorBreakdown.notes.length > 0 && (
                  <div className="text-[11px] text-purple-300/90 bg-purple-500/5 border border-purple-500/20 rounded px-2 py-1">
                    <span className="font-medium">Factores Élite aplicados: </span>
                    {result.factorBreakdown.notes.join(" · ")}
                    <div className="text-muted-foreground mt-0.5">
                      Prob base {result.factorBreakdown.baseProb.toFixed(1)}% → final {result.factorBreakdown.finalProb.toFixed(1)}%
                      {" · "}
                      Total base {result.factorBreakdown.baseTotal.toFixed(1)} → final {result.factorBreakdown.finalTotal.toFixed(1)}
                    </div>
                  </div>
                )}

                {/* TRANSPARENCIA ML: 3 números (modelo / mercado / calibrado) */}
                {result.factorBreakdown?.modelHomeProb !== undefined && (
                  <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Modelo (puro)</p>
                      <p className="text-amber-400 font-mono">{result.factorBreakdown.modelHomeProb.toFixed(1)}%</p>
                    </div>
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Mercado</p>
                      <p className="text-cyan-400 font-mono">{result.factorBreakdown.marketHomeProb !== undefined ? `${result.factorBreakdown.marketHomeProb.toFixed(1)}%` : "—"}</p>
                    </div>
                    <div className="bg-emerald-900/30 rounded p-1.5 border border-emerald-500/30">
                      <p className="text-emerald-300 text-[9px] uppercase">Calibrado</p>
                      <p className="text-emerald-400 font-mono font-bold">{result.factorBreakdown.finalProb.toFixed(1)}%</p>
                    </div>
                  </div>
                )}

                {result.pickedSide && (
                  <div className="flex items-center justify-between p-2 rounded bg-cyan-500/10 border border-cyan-500/30">
                    <div>
                      <p className="text-[10px] text-muted-foreground">Lado recomendado</p>
                      <p className={`text-sm font-bold ${result.pickedSide === "home" ? "text-blue-400" : "text-amber-400"}`}>
                        {result.pickedSide === "home" ? result.homeTeamName : result.awayTeamName} ML
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-muted-foreground">Cuota</p>
                      <p className="text-sm font-mono font-bold text-white">
                        {(result.recommendedOdds ?? 0) > 0 ? "+" : ""}{result.recommendedOdds}
                      </p>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-3 text-sm">
                  <div className="flex items-center gap-1">
                    <Badge className={`border ${signalColor(result.mlSignal)}`}>{result.mlSignal}</Badge>
                    {(() => {
                      const badge = sharpBadgeFor(result.pickedSide ?? null, sharpDir, "ml");
                      return badge ? (
                        <Badge variant="outline" className={`text-xs px-1.5 ${badge.className}`} title={badge.tooltip}>
                          {badge.label}
                        </Badge>
                      ) : null;
                    })()}
                  </div>
                  <span className="text-slate-400">
                    Edge (lado): <span className={result.mlEdge > 0 ? "text-green-400" : "text-red-400"}>
                      {result.mlEdge.toFixed(1)}%
                    </span>
                  </span>
                  <span className="text-slate-400">
                    Prob implícita: <span className="text-white">{(result.impliedProb * 100).toFixed(1)}%</span>
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* F5 PRIMERAS 5 ENTRADAS */}
            <Card className="border border-teal-500/30 bg-slate-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-teal-400 uppercase tracking-wider">F5 — Primeras 5 Entradas</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>{result.homeTeamName}</span>
                    <span>{result.awayTeamName}</span>
                  </div>
                  <div className="relative h-4 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="absolute left-0 top-0 h-full bg-teal-500 rounded-full transition-all"
                      style={{ width: `${(result.f5HomeProb * 100).toFixed(1)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs font-semibold">
                    <span className="text-teal-400">{(result.f5HomeProb * 100).toFixed(1)}%</span>
                    <span className="text-slate-400">{(result.f5AwayProb * 100).toFixed(1)}%</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  <Badge className={`border ${signalColor(result.f5Signal)}`}>{result.f5Signal}</Badge>
                  <span className="text-slate-400">
                    Edge: <span className={result.f5Edge > 0 ? "text-green-400" : "text-red-400"}>
                      {result.f5Edge.toFixed(1)}%
                    </span>
                  </span>
                </div>
                {/* TRANSPARENCIA F5: 3 números */}
                {result.factorBreakdown?.modelF5HomeProb !== undefined && (
                  <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Modelo (puro)</p>
                      <p className="text-amber-400 font-mono">{result.factorBreakdown.modelF5HomeProb.toFixed(1)}%</p>
                    </div>
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Mercado</p>
                      <p className="text-cyan-400 font-mono">{result.factorBreakdown.marketF5HomeProb !== undefined ? `${result.factorBreakdown.marketF5HomeProb.toFixed(1)}%` : "—"}</p>
                    </div>
                    <div className="bg-emerald-900/30 rounded p-1.5 border border-emerald-500/30">
                      <p className="text-emerald-300 text-[9px] uppercase">Calibrado</p>
                      <p className="text-emerald-400 font-mono font-bold">{(result.f5HomeProb * 100).toFixed(1)}%</p>
                    </div>
                  </div>
                )}
                <p className="text-xs text-slate-500 italic">Depende casi 100% del pitcher abridor</p>
              </CardContent>
            </Card>

            {/* RUN LINE */}
            <Card className="border border-purple-500/30 bg-slate-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-purple-400 uppercase tracking-wider">Run Line</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-3 items-center text-sm">
                  <span className={`font-semibold ${result.runLine.pickedSide === "home" ? "text-blue-400" : "text-amber-400"}`}>
                    {result.runLine.pickedSide === "home" ? homeTeam : awayTeam} {result.runLine.side.replace(/^Local |^Visitante /, "")}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Cuota: {result.runLine.pickedSide === "away" ? rlOddsAway : rlOdds}
                  </span>
                  <Badge className={`border ${signalColor(result.runLine.signal)}`}>{result.runLine.signal}</Badge>
                  {(result.runLine as any).coverProb !== undefined && (
                    <Badge variant="outline" className={`text-xs ${
                      (result.runLine as any).coverProb >= 0.60 ? "border-green-500/60 text-green-300" :
                      (result.runLine as any).coverProb >= 0.52 ? "border-amber-500/60 text-amber-300" :
                      "border-red-500/60 text-red-300"
                    }`}>
                      {((result.runLine as any).coverProb * 100).toFixed(1)}% · {(result.runLine as any).confidence}
                    </Badge>
                  )}
                  <span className="text-slate-400">
                    Margen esperado: <span className="text-white">{result.runLine.expectedMargin.toFixed(2)}</span>
                  </span>
                  <span className={`text-sm ${result.runLine.coversRL ? "text-green-400" : "text-red-400"}`}>
                    {result.runLine.coversRL ? "Cubre -1.5" : "No cubre -1.5"}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  Recomendación: <span className="text-slate-300 font-medium">
                    {result.runLine.signal === "PASS" ? "Sin apuesta" : `${result.runLine.pickedSide === "home" ? homeTeam : awayTeam} ${result.runLine.side.replace(/^Local |^Visitante /, "")}`}
                  </span>
                </div>
                {/* TRANSPARENCIA: los 3 números honestos */}
                {(result.runLine as any).modelCoverProb !== undefined && (
                  <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-purple-500/15 text-center text-[11px]">
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Modelo (Poisson)</p>
                      <p className="text-amber-400 font-mono">{((result.runLine as any).modelCoverProb * 100).toFixed(1)}%</p>
                    </div>
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Mercado</p>
                      <p className="text-cyan-400 font-mono">{(result.runLine as any).marketCoverProb !== undefined ? `${((result.runLine as any).marketCoverProb * 100).toFixed(1)}%` : "—"}</p>
                    </div>
                    <div className="bg-emerald-900/30 rounded p-1.5 border border-emerald-500/30">
                      <p className="text-emerald-300 text-[9px] uppercase">Calibrado</p>
                      <p className="text-emerald-400 font-mono font-bold">{((result.runLine as any).coverProb * 100).toFixed(1)}%</p>
                    </div>
                  </div>
                )}
                {(() => {
                  // CRÍTICO: usa la cuota del LADO recomendado, no siempre el local
                  const _o = result.runLine.pickedSide === "away" ? (parseInt(rlOddsAway) || -110) : (parseInt(rlOdds) || -110);
                  const _i = _o > 0 ? 100/(_o+100) : Math.abs(_o)/(Math.abs(_o)+100);
                  const _p = (result.runLine as any).coverProb ?? (result.runLine.coversRL ? 0.56 : 0.44);
                  const _e = (_p - _i) * 100;
                  const _b = _o > 0 ? _o/100 : 100/Math.abs(_o);
                  const _k = Math.max(0, (_b*_p-(1-_p))/_b) * 0.25 * 1000;
                  return (
                    <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-purple-500/10 text-center">
                      <div><p className="text-xs text-slate-500">Cuota ({result.runLine.pickedSide === "away" ? "V" : "L"})</p><p className="text-sm font-mono">{_o > 0 ? "+" : ""}{_o}</p></div>
                      <div><p className="text-xs text-slate-500">Edge</p><p className={`text-base font-bold ${_e > 0 ? "text-green-400" : "text-red-400"}`}>{_e > 0 ? "+" : ""}{_e.toFixed(1)}%</p></div>
                      <div>
                          <p className="text-xs text-slate-500">Kelly teórico</p>
                          <p className="text-base font-bold text-green-400">{(_k / 10).toFixed(1)}% banca</p>
                          <p className="text-[9px] text-cyan-300">Stake permitido: máx. 1.0u</p>
                        </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* O/U PARTIDO COMPLETO */}
            <Card className="border border-amber-500/30 bg-slate-900/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-amber-400 uppercase tracking-wider">O/U — Partido Completo</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-3 items-center text-sm">
                  <span className={`text-xl font-bold ${result.ouResult.side === "OVER" ? "text-green-400" : "text-blue-400"}`}>
                    {result.ouResult.side}
                  </span>
                  <Badge className={`border ${signalColor(result.ouResult.signal)}`}>{result.ouResult.signal}</Badge>
                  {(result.ouResult as any).hitProb !== undefined && (
                    <Badge variant="outline" className={`text-xs ${
                      (result.ouResult as any).hitProb >= 0.60 ? "border-green-500/60 text-green-300" :
                      (result.ouResult as any).hitProb >= 0.52 ? "border-amber-500/60 text-amber-300" :
                      "border-red-500/60 text-red-300"
                    }`}>
                      {((result.ouResult as any).hitProb * 100).toFixed(1)}% · {(result.ouResult as any).confidence}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-slate-500">Total estimado</p>
                    <p className="text-white font-semibold text-lg">{result.estimatedTotal.toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Línea</p>
                    <p className="text-white font-semibold text-lg">{result.ouLine}</p>
                  </div>
                </div>
                <div className="text-xs text-slate-400">
                  Diferencia: <span className={result.ouResult.edge > 0 ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>
                    {result.ouResult.edge > 0 ? "+" : ""}{result.ouResult.edge.toFixed(1)} carreras
                  </span>
                </div>
                {/* TRANSPARENCIA O/U: 3 números */}
                {(result.ouResult as any).modelHitProb !== undefined && (
                  <div className="grid grid-cols-3 gap-2 mt-1 pt-2 border-t border-amber-500/15 text-center text-[11px]">
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Modelo</p>
                      <p className="text-amber-400 font-mono">{((result.ouResult as any).modelHitProb * 100).toFixed(1)}%</p>
                    </div>
                    <div className="bg-slate-800/40 rounded p-1.5">
                      <p className="text-slate-500 text-[9px] uppercase">Mercado</p>
                      <p className="text-cyan-400 font-mono">{(result.ouResult as any).marketHitProb !== undefined ? `${((result.ouResult as any).marketHitProb * 100).toFixed(1)}%` : "—"}</p>
                    </div>
                    <div className="bg-emerald-900/30 rounded p-1.5 border border-emerald-500/30">
                      <p className="text-emerald-300 text-[9px] uppercase">Calibrado</p>
                      <p className="text-emerald-400 font-mono font-bold">{((result.ouResult as any).hitProb * 100).toFixed(1)}%</p>
                    </div>
                  </div>
                )}
                {(() => {
                  const _o = parseInt(result.ouResult.side === "OVER" ? overOdds : underOdds) || -110;
                  const _i = _o > 0 ? 100/(_o+100) : Math.abs(_o)/(Math.abs(_o)+100);
                  const _p = (result.ouResult as any).hitProb ?? Math.min(0.8, Math.max(0.2, 0.5 + Math.abs(result.ouResult.edge) / 15));
                  const _e = (_p - _i) * 100;
                  const _b = _o > 0 ? _o/100 : 100/Math.abs(_o);
                  const _k = Math.max(0, (_b*_p-(1-_p))/_b) * 0.25 * 1000;
                  return (
                    <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-amber-500/10 text-center">
                      <div><p className="text-xs text-slate-500">Cuota O/U</p><p className="text-sm font-mono">{_o > 0 ? "+" : ""}{_o}</p></div>
                      <div><p className="text-xs text-slate-500">Edge</p><p className={`text-base font-bold ${_e > 0 ? "text-green-400" : "text-red-400"}`}>{_e > 0 ? "+" : ""}{_e.toFixed(1)}%</p></div>
                      <div>
                          <p className="text-xs text-slate-500">Kelly teórico</p>
                          <p className="text-base font-bold text-green-400">{(_k / 10).toFixed(1)}% banca</p>
                          <p className="text-[9px] text-cyan-300">Stake permitido: máx. 1.0u</p>
                        </div>
                    </div>
                  );
                })()}
              </CardContent>
            </Card>

            {/* F5 O/U (optional) */}
            {result.f5OuResult && result.f5OuLine !== null && (
              <Card className="border border-emerald-500/30 bg-slate-900/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-emerald-400 uppercase tracking-wider">F5 O/U — Primeras 5 Entradas</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-3 items-center text-sm">
                    <span className={`text-xl font-bold ${result.f5OuResult.side === "OVER" ? "text-green-400" : "text-blue-400"}`}>
                      {result.f5OuResult.side}
                    </span>
                    <Badge className={`border ${signalColor(result.f5OuResult.signal)}`}>{result.f5OuResult.signal}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-slate-500">Total F5 estimado</p>
                      <p className="text-white font-semibold text-lg">{result.estimatedF5Total.toFixed(1)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Línea F5</p>
                      <p className="text-white font-semibold text-lg">{result.f5OuLine}</p>
                    </div>
                  </div>
                  <div className="text-xs text-slate-400">
                    Diferencia: <span className={result.f5OuResult.edge > 0 ? "text-green-400 font-semibold" : "text-red-400 font-semibold"}>
                      {result.f5OuResult.edge > 0 ? "+" : ""}{result.f5OuResult.edge.toFixed(1)} carreras
                    </span>
                  </div>
                  {(() => {
                    const _o = -110; // Hard Rock no ofrece cuotas F5
                    const _i = _o > 0 ? 100/(_o+100) : Math.abs(_o)/(Math.abs(_o)+100);
                    const _p = Math.min(0.8, Math.max(0.2, 0.5 + Math.abs(result.f5OuResult.edge) / 12));
                    const _e = (_p - _i) * 100;
                    const _b = _o > 0 ? _o/100 : 100/Math.abs(_o);
                    const _k = Math.max(0, (_b*_p-(1-_p))/_b) * 0.25 * 1000;
                    return (
                      <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-emerald-500/10 text-center">
                        <div><p className="text-xs text-slate-500">Cuota F5 O/U</p><p className="text-sm font-mono">{_o > 0 ? "+" : ""}{_o}</p></div>
                        <div><p className="text-xs text-slate-500">Edge</p><p className={`text-base font-bold ${_e > 0 ? "text-green-400" : "text-red-400"}`}>{_e > 0 ? "+" : ""}{_e.toFixed(1)}%</p></div>
                        <div>
                          <p className="text-xs text-slate-500">Kelly teórico</p>
                          <p className="text-base font-bold text-green-400">{(_k / 10).toFixed(1)}% banca</p>
                          <p className="text-[9px] text-cyan-300">Stake permitido: máx. 1.0u</p>
                        </div>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            {/* JUGADA SEGURA 90%+ */}
            {result.safePlay && (
              <Card className="border border-green-500/40 bg-green-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-green-400 flex items-center gap-2">
                    Jugada Segura 90%+
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xl font-bold text-white">{result.safePlay.description}</span>
                    <Badge className="border bg-green-500/20 text-green-400 border-green-500/30">
                      {(result.safePlay.probability * 100).toFixed(1)}%
                    </Badge>
                    <Badge className="border bg-green-500/20 text-green-400 border-green-500/30">
                      {result.safePlay.type}
                    </Badge>
                  </div>
                  {result.safePlay.details.length > 0 && (
                    <ul className="text-sm text-slate-400 space-y-1">
                      {result.safePlay.details.map((d, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-green-400 mt-0.5">+</span>
                          <span>{d}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {/* LÍNEAS ALTERNATIVAS */}
            {result.altLines.length > 0 && (
              <Card className="border border-amber-500/40 bg-amber-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-amber-400 uppercase tracking-wider">Líneas Alternativas</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {result.altLines.map((alt, i) => (
                      <div key={i} className="flex items-center justify-between bg-slate-800/50 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Badge className={`border text-xs ${alt.confidence === "ULTRA" ? "bg-green-500/20 text-green-400 border-green-500/30" : alt.confidence === "ALTA" ? "bg-blue-500/20 text-blue-400 border-blue-500/30" : "bg-slate-500/20 text-slate-400 border-slate-500/30"}`}>
                            {alt.confidence}
                          </Badge>
                          <span className="text-sm text-white font-medium">{alt.description}</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          <span className="text-slate-400">{(alt.coverProb * 100).toFixed(1)}%</span>
                          <span className="text-xs text-slate-500">{alt.estOdds}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ANÁLISIS POISSON (O/U) */}
            {result.poisson && (
              <Card className="border border-violet-500/30 bg-violet-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-violet-400 uppercase tracking-wider">Análisis Poisson (O/U)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-xs text-slate-500">Carreras {result.homeTeamName}</p>
                      <p className="text-lg font-bold text-blue-400">{result.poisson.homeExpRuns}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Total esperado</p>
                      <p className="text-lg font-bold text-white">{result.poisson.totalExpRuns}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Carreras {result.awayTeamName}</p>
                      <p className="text-lg font-bold text-purple-400">{result.poisson.awayExpRuns}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-center bg-slate-800/50 rounded-lg p-3">
                    <div>
                      <p className="text-xs text-slate-500">OVER {result.ouLine}</p>
                      <p className={`text-lg font-bold ${result.poisson.overProb > 0.55 ? "text-green-400" : "text-slate-400"}`}>
                        {(result.poisson.overProb * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">UNDER {result.ouLine}</p>
                      <p className={`text-lg font-bold ${result.poisson.underProb > 0.55 ? "text-blue-400" : "text-slate-400"}`}>
                        {(result.poisson.underProb * 100).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                  {result.poisson.exactScoreProbs.length > 0 && (
                    <div>
                      <p className="text-xs text-slate-500 mb-2">Marcadores más probables</p>
                      <div className="flex flex-wrap gap-2">
                        {result.poisson.exactScoreProbs.map((sp, i) => (
                          <Badge key={i} variant="outline" className="border-violet-500/30 text-violet-300">
                            {sp.score} ({(sp.prob * 100).toFixed(1)}%)
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* H2H BADGE */}
            {h2hLabel && (h2hHomeWins + h2hAwayWins) > 0 && (
              <div className="flex items-center gap-3 bg-teal-500/10 border border-teal-500/20 rounded-lg px-4 py-3">
                <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30 border">H2H esta temporada</Badge>
                <span className="text-sm font-semibold text-white">{h2hLabel}</span>
                {(h2hHomeWins + h2hAwayWins) >= 3 && (
                  <span className="text-xs text-teal-300 ml-auto">
                    {h2hHomeWins > h2hAwayWins ? `${result.homeTeamName} domina` : h2hAwayWins > h2hHomeWins ? `${result.awayTeamName} domina` : "Serie pareja"}
                  </span>
                )}
              </div>
            )}

            {/* HOME/AWAY SPLITS */}
            {(homeHomeRPG || awayAwayRPG) && (
              <Card className="border border-cyan-500/30 bg-slate-900/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-cyan-400 uppercase tracking-wider">Rendimiento Local / Visitante</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-blue-400">{result.homeTeamName} (Local)</p>
                      {homeHomeRPG && (
                        <div className="bg-slate-800/50 rounded-lg p-2 text-center">
                          <p className="text-xs text-slate-500">En casa</p>
                          <p className="text-sm text-white font-mono">{homeHomeRPG} RPG / {homeHomeERA} ERA</p>
                          {homeHomeRecord && <p className="text-xs text-slate-400">({homeHomeRecord})</p>}
                        </div>
                      )}
                      {homeAwayRPG && (
                        <div className="bg-slate-800/50 rounded-lg p-2 text-center">
                          <p className="text-xs text-slate-500">Fuera</p>
                          <p className="text-sm text-white font-mono">{homeAwayRPG} RPG / {homeAwayERA} ERA</p>
                          {homeAwayRecord && <p className="text-xs text-slate-400">({homeAwayRecord})</p>}
                        </div>
                      )}
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-purple-400">{result.awayTeamName} (Visitante)</p>
                      {awayHomeRPG && (
                        <div className="bg-slate-800/50 rounded-lg p-2 text-center">
                          <p className="text-xs text-slate-500">En casa</p>
                          <p className="text-sm text-white font-mono">{awayHomeRPG} RPG / {awayHomeERA} ERA</p>
                          {awayHomeRecord && <p className="text-xs text-slate-400">({awayHomeRecord})</p>}
                        </div>
                      )}
                      {awayAwayRPG && (
                        <div className="bg-slate-800/50 rounded-lg p-2 text-center">
                          <p className="text-xs text-slate-500">Fuera</p>
                          <p className="text-sm text-white font-mono">{awayAwayRPG} RPG / {awayAwayERA} ERA</p>
                          {awayAwayRecord && <p className="text-xs text-slate-400">({awayAwayRecord})</p>}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* AGENDA L10 (SOS) */}
            {(homeRecentGames.length > 0 || awayRecentGames.length > 0) && (
              <Card className="border border-cyan-500/30 bg-cyan-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-cyan-400 uppercase tracking-wider">Agenda L10 (Rivales Recientes)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { label: result.homeTeamName, games: homeRecentGames, color: "blue" },
                      { label: result.awayTeamName, games: awayRecentGames, color: "purple" },
                    ].map(({ label, games, color }) => (
                      <div key={label} className="space-y-1">
                        <p className={`text-xs font-semibold text-${color}-400 mb-2`}>{label}</p>
                        {games.slice(0, 10).map((g, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${g.won ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                              {g.won ? "W" : "L"}
                            </span>
                            <span className="text-slate-400">{g.venue}</span>
                            <span className="text-white">{g.oppAbbr}</span>
                            <span className="text-slate-500 ml-auto font-mono">{g.score}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* GUARDAR PICKS */}
            <Card className="border border-slate-600/30 bg-slate-900/50">
              <CardContent className="p-4">
                <p className="text-sm font-medium text-slate-300 mb-3">
                  <Save className="h-4 w-4 inline mr-2" />
                  Guardar picks en historial MLB
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="border-blue-500/30 text-blue-400"
                    onClick={() => savePick("ML", `${(result.pickedSide ?? (result.homeProb > 0.5 ? "home" : "away")) === "home" ? homeTeam : awayTeam} ML`, result.recommendedOdds ?? (parseInt(mlOdds) || -150), Math.max(result.homeProb * 100, result.awayProb * 100))}>
                    <Check className="h-3 w-3 mr-1" /> ML
                  </Button>
                  <Button size="sm" variant="outline" className="border-teal-500/30 text-teal-400"
                    onClick={() => savePick("F5", `${(result.f5PickedSide ?? (result.f5HomeProb > 0.5 ? "home" : "away")) === "home" ? homeTeam : awayTeam} F5`, result.f5RecommendedOdds ?? -130, Math.max(result.f5HomeProb * 100, result.f5AwayProb * 100))}>
                    <Check className="h-3 w-3 mr-1" /> F5
                  </Button>
                  <Button size="sm" variant="outline" className="border-purple-500/30 text-purple-400"
                    onClick={() => savePick("Run Line", `${result.runLine.side} (${result.runLine.pickedSide === "home" ? homeTeam : awayTeam})`, result.runLine.pickedSide === "away" ? (parseInt(rlOddsAway) || -110) : (parseInt(rlOdds) || -110), Math.round(((result.runLine as any).coverProb ?? (result.runLine.coversRL ? 0.56 : 0.44)) * 100))}>
                    <Check className="h-3 w-3 mr-1" /> Run Line
                  </Button>
                  <Button size="sm" variant="outline" className="border-amber-500/30 text-amber-400"
                    onClick={() => savePick("O/U", `${result.ouResult.side} ${result.ouLine}`, parseInt(result.ouResult.side === "OVER" ? overOdds : underOdds) || -110, 55)}>
                    <Check className="h-3 w-3 mr-1" /> {result.ouResult.side}
                  </Button>
                  {result.f5OuResult && (
                    <Button size="sm" variant="outline" className="border-emerald-500/30 text-emerald-400"
                      onClick={() => savePick("F5 O/U", `${result.f5OuResult!.side} F5 ${result.f5OuLine}`, -110, 55)}>
                      <Check className="h-3 w-3 mr-1" /> F5 {result.f5OuResult.side}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-2">Solo se guardan los mercados que selecciones</p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
      {/* ERE v3 — Early Run Environment, 16 variables ponderadas */}
      {(homeTeamMlbId || awayTeamMlbId) && (
        <div className="mt-4">
          <MlbEreCard
            homeTeamId={homeTeamMlbId}
            awayTeamId={awayTeamMlbId}
            homeTeamName={homeTeam}
            awayTeamName={awayTeam}
            gamePk={gamePkForTesi}
            homePitcherId={homePitcherIdTesi}
            homePitcherHand={homePitcherHandTesi}
            awayPitcherId={awayPitcherIdTesi}
            awayPitcherHand={awayPitcherHandTesi}
          />
        </div>
      )}
      {/* Mercados Early derivados de ERE: F5, NRFI/YRFI, 1°/2°/3° inning ML */}
      {(homeTeamMlbId && awayTeamMlbId) && (
        <div className="mt-4">
          <MlbEarlyMarketsCard
            homeTeamId={homeTeamMlbId}
            awayTeamId={awayTeamMlbId}
            homeTeamName={homeTeam}
            awayTeamName={awayTeam}
            gamePk={gamePkForTesi}
            homePitcherId={homePitcherIdTesi}
            homePitcherHand={homePitcherHandTesi}
            awayPitcherId={awayPitcherIdTesi}
            awayPitcherHand={awayPitcherHandTesi}
          />
        </div>
      )}
      <PrintFab />
    </div>
  );
}

import { ApiError, fetchJson } from "./queryClient";
import type {
  WNBABestPlay,
  WNBAPickQuality,
  WNBATeamStats,
} from "./wnba-model";

const OUTBOX_KEY = "courtedge.wnbaEvaluationOutbox.v1";
const OUTBOX_LIMIT = 100;
const CAPTURE_WINDOW_MS = 5_000;

interface ProbabilityCapture {
  capturedAtMs: number;
  homeInput: WNBATeamStats;
  awayInput: WNBATeamStats;
  marketImpliedHomeProbability: number | null;
  homeProbability: number;
}

interface TotalCapture {
  capturedAtMs: number;
  estimatedTotal: number;
}

interface PendingEvaluation {
  probability: ProbabilityCapture | null;
  total: TotalCapture | null;
  qualities: WNBAPickQuality[];
}

interface EmissionMarket {
  market: "ML" | "SPREAD" | "TOTAL";
  selection: string;
  selectedTeam: string | null;
  opponent: string | null;
  modelProbability: number;
  marketImpliedProbability: number;
  oddsAmerican: number;
  line: number | null;
  signal: "BET" | "LEAN" | "PASS";
  recommendation: "BET_FUERTE" | "BET" | "LEAN" | "PASS";
  accepted: boolean;
  confidencePct: number;
  edgePp: number;
  quality: {
    score: number;
    tier: string;
    shadowStakeUnits: number;
    warnings: string[];
    confirms: string[];
    reasoning: string;
  };
}

export interface WnbaEvaluationEmissionEnvelope {
  schemaVersion: "wnba-evaluation-emission.v1";
  evaluationId: string;
  evaluatedAt: string;
  gameDate: string;
  homeTeam: string;
  awayTeam: string;
  gameId: string | null;
  source: "WNBA_PREDICTOR_UI";
  captureVersion: "s6e-ui.v1";
  model: {
    homeInput: Record<string, unknown>;
    awayInput: Record<string, unknown>;
    marketImpliedHomeProbability: number | null;
    homeProbability: number;
    awayProbability: number;
    estimatedTotal: number;
  };
  markets: EmissionMarket[];
  bestPlay: {
    market: "ML" | "SPREAD" | "TOTAL" | null;
    recommendation: string | null;
    signal: "BET" | "LEAN" | "PASS" | null;
    confidencePct: number | null;
    edgeLabel: string | null;
  };
  visibleMarket: {
    homeMoneyline: number;
    awayMoneyline: number;
    spreadLine: number;
    homeSpreadOdds: number;
    awaySpreadOdds: number;
    totalLine: number;
    overOdds: number;
    underOdds: number;
  };
}

let pending: PendingEvaluation = { probability: null, total: null, qualities: [] };
let flushing = false;
let authBlocked = false;
let listenersInstalled = false;

function browserAvailable(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function testIdText(testId: string): string | null {
  if (!browserAvailable()) return null;
  const node = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const value = node?.textContent?.trim();
  return value || null;
}

function testIdNumber(testId: string): number | null {
  if (!browserAvailable()) return null;
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (!input) return null;
  const parsed = Number(input.value.replace(/^\+/, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function selectedGameDate(): string | null {
  if (!browserAvailable()) return null;
  const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  const value = candidates.map((input) => input.value).find((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
  return value || null;
}

function normalizeTeam(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sideTeams(selection: string, homeTeam: string, awayTeam: string): { selectedTeam: string | null; opponent: string | null } {
  const normalized = normalizeTeam(selection);
  const home = normalizeTeam(homeTeam);
  const away = normalizeTeam(awayTeam);
  if (normalized.includes(home)) return { selectedTeam: homeTeam, opponent: awayTeam };
  if (normalized.includes(away)) return { selectedTeam: awayTeam, opponent: homeTeam };
  return { selectedTeam: null, opponent: null };
}

function mapMarket(value: WNBAPickQuality["market"] | WNBABestPlay["market"]): "ML" | "SPREAD" | "TOTAL" {
  if (value === "Spread") return "SPREAD";
  if (value === "O/U") return "TOTAL";
  return "ML";
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `wnba-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function readOutbox(): WnbaEvaluationEmissionEnvelope[] {
  if (!browserAvailable()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOutbox(rows: WnbaEvaluationEmissionEnvelope[]): void {
  if (!browserAvailable()) return;
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(rows.slice(-OUTBOX_LIMIT)));
  } catch {
    // A failed local write must never affect the predictor result.
  }
}

function enqueue(envelope: WnbaEvaluationEmissionEnvelope): void {
  const rows = readOutbox();
  if (!rows.some((row) => row.evaluationId === envelope.evaluationId)) rows.push(envelope);
  writeOutbox(rows);
  void flushWnbaEvaluationOutbox();
}

function marketSignal(plays: WNBABestPlay[], market: "ML" | "SPREAD" | "TOTAL"): "BET" | "LEAN" | "PASS" {
  const match = plays.find((play) => mapMarket(play.market) === market);
  return match?.signal ?? "PASS";
}

export function buildWnbaEvaluationEnvelope(
  probabilityCapture: ProbabilityCapture,
  totalCapture: TotalCapture,
  qualities: WNBAPickQuality[],
  plays: WNBABestPlay[],
  bestPlay: WNBABestPlay | null,
): WnbaEvaluationEmissionEnvelope | null {
  if (!browserAvailable()) return null;
  const homeTeam = testIdText("select-home-team");
  const awayTeam = testIdText("select-away-team");
  const gameDate = selectedGameDate();
  const visibleMarket = {
    homeMoneyline: testIdNumber("input-ml-home"),
    awayMoneyline: testIdNumber("input-ml-away"),
    spreadLine: testIdNumber("input-spread-line"),
    homeSpreadOdds: testIdNumber("input-spread-home"),
    awaySpreadOdds: testIdNumber("input-spread-away"),
    totalLine: testIdNumber("input-ou-line"),
    overOdds: testIdNumber("input-over-odds"),
    underOdds: testIdNumber("input-under-odds"),
  };
  if (!homeTeam || !awayTeam || !gameDate || Object.values(visibleMarket).some((value) => value === null)) return null;
  const qualityByMarket = new Map(qualities.map((quality) => [mapMarket(quality.market), quality]));
  if (qualityByMarket.size !== 3) return null;

  const markets: EmissionMarket[] = (["ML", "SPREAD", "TOTAL"] as const).map((market) => {
    const quality = qualityByMarket.get(market);
    if (!quality) throw new Error(`Missing ${market} quality output`);
    const teams = sideTeams(quality.pickedSideLabel, homeTeam, awayTeam);
    const line = market === "SPREAD"
      ? visibleMarket.spreadLine
      : market === "TOTAL" ? visibleMarket.totalLine : null;
    return {
      market,
      selection: quality.pickedSideLabel,
      selectedTeam: teams.selectedTeam,
      opponent: teams.opponent,
      modelProbability: quality.modelProb,
      marketImpliedProbability: quality.marketImpliedProb,
      oddsAmerican: quality.pickedSideOdds,
      line,
      signal: marketSignal(plays, market),
      recommendation: quality.recommendation,
      accepted: quality.recommendation !== "PASS",
      confidencePct: quality.modelProb * 100,
      edgePp: quality.edgeReal,
      quality: {
        score: quality.score,
        tier: quality.tier,
        shadowStakeUnits: quality.stakeUnits,
        warnings: [...quality.warnings],
        confirms: [...quality.confirms],
        reasoning: quality.reasoning,
      },
    };
  });

  return {
    schemaVersion: "wnba-evaluation-emission.v1",
    evaluationId: randomId(),
    evaluatedAt: new Date().toISOString(),
    gameDate,
    homeTeam,
    awayTeam,
    gameId: null,
    source: "WNBA_PREDICTOR_UI",
    captureVersion: "s6e-ui.v1",
    model: {
      homeInput: cloneRecord(probabilityCapture.homeInput) as unknown as Record<string, unknown>,
      awayInput: cloneRecord(probabilityCapture.awayInput) as unknown as Record<string, unknown>,
      marketImpliedHomeProbability: probabilityCapture.marketImpliedHomeProbability,
      homeProbability: probabilityCapture.homeProbability,
      awayProbability: 1 - probabilityCapture.homeProbability,
      estimatedTotal: totalCapture.estimatedTotal,
    },
    markets,
    bestPlay: bestPlay ? {
      market: mapMarket(bestPlay.market),
      recommendation: bestPlay.recommendation,
      signal: bestPlay.signal,
      confidencePct: bestPlay.confidence,
      edgeLabel: bestPlay.edgeLabel,
    } : {
      market: null,
      recommendation: null,
      signal: null,
      confidencePct: null,
      edgeLabel: null,
    },
    visibleMarket: {
      homeMoneyline: visibleMarket.homeMoneyline as number,
      awayMoneyline: visibleMarket.awayMoneyline as number,
      spreadLine: visibleMarket.spreadLine as number,
      homeSpreadOdds: visibleMarket.homeSpreadOdds as number,
      awaySpreadOdds: visibleMarket.awaySpreadOdds as number,
      totalLine: visibleMarket.totalLine as number,
      overOdds: visibleMarket.overOdds as number,
      underOdds: visibleMarket.underOdds as number,
    },
  };
}

export function captureWnbaModelProbability(args: {
  home: WNBATeamStats;
  away: WNBATeamStats;
  marketImpliedHomeProbability?: number;
  homeProbability: number;
}): void {
  if (!browserAvailable()) return;
  pending = {
    probability: {
      capturedAtMs: Date.now(),
      homeInput: cloneRecord(args.home),
      awayInput: cloneRecord(args.away),
      marketImpliedHomeProbability: Number.isFinite(args.marketImpliedHomeProbability)
        ? args.marketImpliedHomeProbability as number
        : null,
      homeProbability: args.homeProbability,
    },
    total: null,
    qualities: [],
  };
}

export function captureWnbaModelTotal(args: { estimatedTotal: number }): void {
  if (!browserAvailable() || !pending.probability) return;
  pending.total = { capturedAtMs: Date.now(), estimatedTotal: args.estimatedTotal };
}

export function captureWnbaPickQuality(quality: WNBAPickQuality): void {
  if (!browserAvailable() || !pending.probability) return;
  pending.qualities = pending.qualities.filter((row) => row.market !== quality.market);
  pending.qualities.push(cloneRecord(quality));
}

export function completeWnbaEvaluationCapture(plays: WNBABestPlay[], bestPlay: WNBABestPlay | null): void {
  if (!browserAvailable()) return;
  const snapshot = pending;
  pending = { probability: null, total: null, qualities: [] };
  if (!snapshot.probability || !snapshot.total || snapshot.qualities.length !== 3) return;
  const now = Date.now();
  if (now - snapshot.probability.capturedAtMs > CAPTURE_WINDOW_MS || now - snapshot.total.capturedAtMs > CAPTURE_WINDOW_MS) return;
  try {
    const envelope = buildWnbaEvaluationEnvelope(snapshot.probability, snapshot.total, snapshot.qualities, plays, bestPlay);
    if (envelope) enqueue(envelope);
  } catch {
    // Capture is observational and may never affect the predictor output.
  }
}

export async function flushWnbaEvaluationOutbox(): Promise<void> {
  if (!browserAvailable() || flushing || authBlocked) return;
  const rows = readOutbox();
  if (!rows.length) return;
  flushing = true;
  try {
    const remaining = [...rows];
    while (remaining.length) {
      const envelope = remaining[0];
      try {
        await fetchJson("/api/wnba/predictor-shadow/v1/evaluations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(envelope),
        });
        remaining.shift();
        writeOutbox(remaining);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) authBlocked = true;
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

function installListeners(): void {
  if (!browserAvailable() || listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener("courtedge:auth-ready", () => {
    authBlocked = false;
    void flushWnbaEvaluationOutbox();
  });
  window.addEventListener("online", () => {
    authBlocked = false;
    void flushWnbaEvaluationOutbox();
  });
}

installListeners();


import type { Express, Request, Response } from "express";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  assessFullModularLiveOperationalParity,
  MLB_FULL_MODULAR_DECISION_LEAD_MINUTES,
  type FullModularLiveOperationalAssessment,
} from "./mlb-full-modular-live-operational-bridge";
import {
  scoreMlbFullModularFrozenLiveSlate,
  type MlbFullModularStrengthTier,
} from "./mlb-full-modular-frozen-live-scorer-v1";
import { scoreMlbPpHorizonFrozenLiveSlate } from "./mlb-pp-horizon-frozen-live-scorer-v1";
import { MlbFullModularBullpenLiveMaterializer } from "./mlb-full-modular-bullpen-live-materializer";
import { MlbFullModularTeamStrengthLiveMaterializer } from "./mlb-full-modular-team-strength-live-materializer";
import { buildMlbP1DailySlate, type MlbP1DailySlate, type MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { MlbV68ProspectiveStateLiveAdapter } from "./mlb-v68-prospective-state-live-adapter";
import {
  MLB_UNIFIED_ELITE_PROSPECTIVE_FIRST_DATE,
  MlbUnifiedEliteProspectiveCustodyStore,
  buildMlbUnifiedEliteProspectiveGameSnapshot,
  type MlbUnifiedEliteProspectiveCustodyStatus,
} from "./mlb-unified-elite-prospective-custody-v1";

export const MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_SERVICE_VERSION =
  "mlb-unified-elite-prospective-capture-service-v1" as const;
export const MLB_UNIFIED_ELITE_PROSPECTIVE_STATUS_ROUTE =
  "/api/mlb/unified-elite/prospective-status" as const;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 5_000;

interface CaptureDependencies {
  buildSlate?: typeof buildMlbP1DailySlate;
  full13Materializer?: Pick<MlbC4CertifiedMaterializer, "materializeFull13PregameInput">;
  stateAdapter?: Pick<MlbV68ProspectiveStateLiveAdapter, "buildFullModularEvidence">;
  bullpenMaterializer?: Pick<MlbFullModularBullpenLiveMaterializer, "materializeGame">;
  teamStrengthMaterializer?: Pick<MlbFullModularTeamStrengthLiveMaterializer, "materializeDate">;
  assessOperational?: typeof assessFullModularLiveOperationalParity;
  scoreFullModular?: typeof scoreMlbFullModularFrozenLiveSlate;
  scorePpHorizon?: typeof scoreMlbPpHorizonFrozenLiveSlate;
  custody?: MlbUnifiedEliteProspectiveCustodyStore;
  now?: () => Date;
}

export interface MlbUnifiedEliteProspectiveCaptureAudit {
  schemaVersion: typeof MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_SERVICE_VERSION;
  officialDate: string;
  ranAtUtc: string;
  finalReadyGames: number;
  alreadyCapturedGames: number;
  newlyCapturedGames: number;
  tooLateUncapturedGames: readonly number[];
  failures: readonly string[];
  dateMaturityEligible: boolean;
  dateCaptureComplete: boolean;
  datePartialReason: string | null;
  custody: MlbUnifiedEliteProspectiveCustodyStatus;
  safety: {
    outcomesRead: false;
    sportsbookPricesRead: false;
    performanceMetricsRead: false;
    stakeCalculated: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function floridaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function targetIdentity(game: MlbP1SlateGame): {
  homeTeamId: number;
  awayTeamId: number;
  startTime: string;
  decisionDeadlineUtc: string;
} {
  const homeTeamId = positiveInt(game.homeTeam.id);
  const awayTeamId = positiveInt(game.awayTeam.id);
  const startTime = game.startTime;
  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId || !startTime || !Number.isFinite(Date.parse(startTime))) {
    throw new Error(`LOWER_TIER_PROSPECTIVE_TARGET_IDENTITY_INCOMPLETE:${game.gamePk}`);
  }
  const deadline = new Date(Date.parse(startTime) - MLB_FULL_MODULAR_DECISION_LEAD_MINUTES * 60_000).toISOString();
  return { homeTeamId, awayTeamId, startTime, decisionDeadlineUtc: deadline };
}

function isCancelled(game: MlbP1SlateGame): boolean {
  return game.state === "POSTPONED" || game.state === "CANCELLED" || game.state === "SUSPENDED";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noPlayReason(assessment: FullModularLiveOperationalAssessment): string {
  return assessment.status === "NO_PLAY" ? assessment.reason : "UNKNOWN";
}

export class MlbUnifiedEliteProspectiveCaptureService {
  readonly version = MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_SERVICE_VERSION;
  private readonly buildSlate: typeof buildMlbP1DailySlate;
  private readonly full13Materializer: Pick<MlbC4CertifiedMaterializer, "materializeFull13PregameInput">;
  private readonly stateAdapter: Pick<MlbV68ProspectiveStateLiveAdapter, "buildFullModularEvidence">;
  private readonly bullpenMaterializer: Pick<MlbFullModularBullpenLiveMaterializer, "materializeGame">;
  private readonly teamStrengthMaterializer: Pick<MlbFullModularTeamStrengthLiveMaterializer, "materializeDate">;
  private readonly assessOperational: typeof assessFullModularLiveOperationalParity;
  private readonly scoreFullModular: typeof scoreMlbFullModularFrozenLiveSlate;
  private readonly scorePpHorizon: typeof scoreMlbPpHorizonFrozenLiveSlate;
  private readonly custody: MlbUnifiedEliteProspectiveCustodyStore;
  private readonly ownsCustody: boolean;
  private readonly now: () => Date;
  private lastAudit: MlbUnifiedEliteProspectiveCaptureAudit | null = null;
  private lastError: string | null = null;

  constructor(deps: CaptureDependencies = {}) {
    this.buildSlate = deps.buildSlate ?? buildMlbP1DailySlate;
    this.full13Materializer = deps.full13Materializer ?? new MlbC4CertifiedMaterializer();
    this.stateAdapter = deps.stateAdapter ?? new MlbV68ProspectiveStateLiveAdapter();
    this.bullpenMaterializer = deps.bullpenMaterializer ?? new MlbFullModularBullpenLiveMaterializer();
    this.teamStrengthMaterializer = deps.teamStrengthMaterializer ?? new MlbFullModularTeamStrengthLiveMaterializer();
    this.assessOperational = deps.assessOperational ?? assessFullModularLiveOperationalParity;
    this.scoreFullModular = deps.scoreFullModular ?? scoreMlbFullModularFrozenLiveSlate;
    this.scorePpHorizon = deps.scorePpHorizon ?? scoreMlbPpHorizonFrozenLiveSlate;
    this.custody = deps.custody ?? new MlbUnifiedEliteProspectiveCustodyStore();
    this.ownsCustody = !deps.custody;
    this.now = deps.now ?? (() => new Date());
  }

  close(): void {
    if (this.ownsCustody) this.custody.close();
  }

  getCustody(): MlbUnifiedEliteProspectiveCustodyStore {
    return this.custody;
  }

  status(): {
    enabled: boolean;
    lastAudit: MlbUnifiedEliteProspectiveCaptureAudit | null;
    lastError: string | null;
    custody: MlbUnifiedEliteProspectiveCustodyStatus;
  } {
    return {
      enabled: prospectiveCaptureEnabled(),
      lastAudit: this.lastAudit,
      lastError: this.lastError,
      custody: this.custody.status(),
    };
  }

  async run(trigger = "scheduled"): Promise<MlbUnifiedEliteProspectiveCaptureAudit> {
    void trigger;
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_NOW_INVALID");
    }
    const officialDate = floridaDate(now);
    const slate = await this.buildSlate({ date: officialDate, now });
    return this.captureSlate({ officialDate, slate, now });
  }

  async captureSlate(input: {
    officialDate: string;
    slate: MlbP1DailySlate;
    now: Date;
  }): Promise<MlbUnifiedEliteProspectiveCaptureAudit> {
    const { officialDate, slate, now } = input;
    const ranAtUtc = now.toISOString();
    if (officialDate < MLB_UNIFIED_ELITE_PROSPECTIVE_FIRST_DATE) {
      throw new Error("MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_BEFORE_BOUNDARY");
    }

    const gameDeadlines = slate.games.flatMap((game) => {
      try {
        return [{ game, deadline: targetIdentity(game).decisionDeadlineUtc }];
      } catch {
        return [];
      }
    });
    const earliestDecisionDeadlineUtc = gameDeadlines.length
      ? [...gameDeadlines].sort((left, right) => Date.parse(left.deadline) - Date.parse(right.deadline))[0].deadline
      : null;
    this.custody.observeDate({ officialDate, observedAtUtc: ranAtUtc, earliestDecisionDeadlineUtc });

    const finalReady = slate.games.filter((game) =>
      game.officialDate === officialDate
      && game.analysisAllowed
      && game.analysisStage === "FINAL",
    );
    let alreadyCapturedGames = 0;
    let newlyCapturedGames = 0;
    const failures: string[] = [];
    const tooLateUncapturedGames: number[] = [];

    const captureable: Array<{
      game: MlbP1SlateGame;
      target: ReturnType<typeof targetIdentity>;
    }> = [];
    for (const game of finalReady) {
      const existing = this.custody.get(officialDate, game.gamePk);
      if (existing) {
        alreadyCapturedGames += 1;
        continue;
      }
      try {
        const target = targetIdentity(game);
        if (now.getTime() >= Date.parse(target.decisionDeadlineUtc)) {
          tooLateUncapturedGames.push(game.gamePk);
          continue;
        }
        captureable.push({ game, target });
      } catch (error) {
        failures.push(`${game.gamePk}:${message(error)}`);
      }
    }

    let strength: Awaited<ReturnType<typeof this.teamStrengthMaterializer.materializeDate>> | null = null;
    if (captureable.length > 0) {
      try {
        strength = await this.teamStrengthMaterializer.materializeDate(officialDate);
      } catch (error) {
        failures.push(`DATE_STRENGTH:${message(error)}`);
      }
    }

    if (strength) {
      for (const { game, target } of captureable) {
        try {
          const full13 = await this.full13Materializer.materializeFull13PregameInput(game);
          const [state, bullpen] = await Promise.all([
            this.stateAdapter.buildFullModularEvidence(officialDate, full13),
            this.bullpenMaterializer.materializeGame({
              officialDate,
              homeTeamId: target.homeTeamId,
              awayTeamId: target.awayTeamId,
            }),
          ]);
          const observedAt = this.now();
          if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
            throw new Error("LOWER_TIER_PROSPECTIVE_CURRENT_TIME_INVALID");
          }
          const assessment = this.assessOperational({
            observedAtUtc: observedAt.toISOString(),
            scheduledFirstPitchUtc: target.startTime,
            full13,
            v39: state.v39,
            pitchQualityHistory: state.pitchQualityHistory,
            bullpen: {
              homeHistory: bullpen.homeHistory,
              awayHistory: bullpen.awayHistory,
            },
          });
          if (assessment.status !== "READY") {
            if (assessment.reason === "DECISION_TIMESTAMP_MISSING_OR_LATE") {
              tooLateUncapturedGames.push(game.gamePk);
              continue;
            }
            throw new Error(`LOWER_TIER_PROSPECTIVE_BRIDGE_${noPlayReason(assessment)}`);
          }
          const frozenGame = Object.freeze({
            assessment,
            homeStrengthTier: (strength.tiers[target.homeTeamId] ?? "UNSTABLE") as MlbFullModularStrengthTier,
            awayStrengthTier: (strength.tiers[target.awayTeamId] ?? "UNSTABLE") as MlbFullModularStrengthTier,
          });
          const fullScore = this.scoreFullModular({ officialDate, games: [frozenGame] });
          const ppScore = this.scorePpHorizon({ officialDate, games: [frozenGame] });
          const snapshot = buildMlbUnifiedEliteProspectiveGameSnapshot({
            officialDate,
            gamePk: game.gamePk,
            capturedAtUtc: assessment.observedAtUtc,
            decisionDeadlineUtc: assessment.decisionDeadlineUtc,
            homeStrengthTier: frozenGame.homeStrengthTier,
            awayStrengthTier: frozenGame.awayStrengthTier,
            fullModularCandidates: fullScore.candidates,
            ppHorizonCandidates: ppScore.candidates,
          });
          const stored = this.custody.putFirstCanonical(snapshot);
          if (stored.inserted) newlyCapturedGames += 1;
          else alreadyCapturedGames += 1;
        } catch (error) {
          failures.push(`${game.gamePk}:${message(error)}`);
        }
      }
    }

    const snapshotPks = new Set(this.custody.listDate(officialDate).map((snapshot) => snapshot.gamePk));
    const pastDeadlineUncaptured = gameDeadlines
      .filter(({ game, deadline }) =>
        !isCancelled(game)
        && Date.parse(deadline) <= now.getTime()
        && !snapshotPks.has(game.gamePk))
      .map(({ game }) => game.gamePk);
    for (const gamePk of [...tooLateUncapturedGames, ...pastDeadlineUncaptured]) {
      if (!tooLateUncapturedGames.includes(gamePk)) tooLateUncapturedGames.push(gamePk);
    }

    if (tooLateUncapturedGames.length > 0) {
      this.custody.markDatePartial(officialDate, `MISSED_T5_GAME_PKS:${[...new Set(tooLateUncapturedGames)].sort((a, b) => a - b).join(",")}`);
    }
    if (failures.length > 0) {
      this.custody.markDatePartial(officialDate, `CAPTURE_SOURCE_FAILURE:${failures[0]}`);
    }

    const allDeadlinesPassed = gameDeadlines.length > 0
      && gameDeadlines.every(({ deadline }) => Date.parse(deadline) <= now.getTime());
    const allRequiredCaptured = gameDeadlines
      .filter(({ game }) => !isCancelled(game))
      .every(({ game }) => snapshotPks.has(game.gamePk));
    if (allDeadlinesPassed && allRequiredCaptured && failures.length === 0 && tooLateUncapturedGames.length === 0) {
      this.custody.markDateComplete(officialDate);
    }

    const dateState = this.custody.getDateState(officialDate)!;
    const audit: MlbUnifiedEliteProspectiveCaptureAudit = Object.freeze({
      schemaVersion: MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_SERVICE_VERSION,
      officialDate,
      ranAtUtc,
      finalReadyGames: finalReady.length,
      alreadyCapturedGames,
      newlyCapturedGames,
      tooLateUncapturedGames: Object.freeze([...new Set(tooLateUncapturedGames)].sort((a, b) => a - b)),
      failures: Object.freeze(failures),
      dateMaturityEligible: dateState.maturityEligible,
      dateCaptureComplete: dateState.captureComplete,
      datePartialReason: dateState.partialReason,
      custody: this.custody.status(),
      safety: Object.freeze({
        outcomesRead: false as const,
        sportsbookPricesRead: false as const,
        performanceMetricsRead: false as const,
        stakeCalculated: false as const,
        automaticBetPlacement: false as const,
        realFinancialExposure: 0 as const,
      }),
    });
    this.lastAudit = audit;
    this.lastError = failures.length ? failures.join(" | ") : null;
    return audit;
  }
}

function positiveMs(raw: unknown, fallback: number, minimum: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

export function prospectiveCaptureEnabled(): boolean {
  if (process.env.MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_ENABLED === "true") return true;
  if (process.env.MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_ENABLED === "false") return false;
  return Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
}

let singleton: {
  service: MlbUnifiedEliteProspectiveCaptureService;
  stop: () => void;
} | null = null;

export function startMlbUnifiedEliteProspectiveCaptureWorker(
  options: CaptureDependencies & { intervalMs?: number; initialDelayMs?: number } = {},
): { service: MlbUnifiedEliteProspectiveCaptureService; stop: () => void } {
  if (singleton) return singleton;
  const service = new MlbUnifiedEliteProspectiveCaptureService(options);
  const intervalMs = positiveMs(
    options.intervalMs ?? process.env.MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    60_000,
  );
  const initialDelayMs = positiveMs(
    options.initialDelayMs ?? process.env.MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_INITIAL_DELAY_MS,
    DEFAULT_INITIAL_DELAY_MS,
    0,
  );
  let initial: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  let running = false;
  const execute = async () => {
    if (running) return;
    running = true;
    try {
      await service.run("scheduled");
    } catch (error) {
      console.error("[mlb-lower-tier-prospective] capture cycle failed closed", error);
    } finally {
      running = false;
    }
  };
  if (prospectiveCaptureEnabled()) {
    initial = setTimeout(() => {
      void execute();
      interval = setInterval(() => void execute(), intervalMs);
      interval.unref();
    }, initialDelayMs);
    initial.unref();
  }
  singleton = {
    service,
    stop: () => {
      if (initial) clearTimeout(initial);
      if (interval) clearInterval(interval);
      service.close();
      singleton = null;
    },
  };
  return singleton;
}

export function registerMlbUnifiedEliteProspectiveStatusRoute(
  app: Express,
  service: MlbUnifiedEliteProspectiveCaptureService,
): void {
  app.get(MLB_UNIFIED_ELITE_PROSPECTIVE_STATUS_ROUTE, (_req: Request, res: Response) => {
    return res.status(200).json({
      schemaVersion: MLB_UNIFIED_ELITE_PROSPECTIVE_CAPTURE_SERVICE_VERSION,
      status: service.status(),
      policy: {
        shadowCaptureOnly: true,
        lowerTierRecommendationVisible: false,
        outcomeEmbargoActive: true,
        performanceMetricsReadable: false,
        sportsbookPricesRead: false,
        stakeCalculated: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    });
  });
}

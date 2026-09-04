import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  classifyMlbFrozenAPlusAndF5,
  type MlbFrozenAPlusClassifierResult,
  type MlbFrozenClassifierFeatureSnapshot,
} from "./mlb-frozen-a-plus-classifier";
import { MlbFrozenMatchupCertifiedMaterializer } from "./mlb-frozen-matchup-certified-materializer";
import {
  assessMlbFrozenResearchRoutes,
  type MlbFrozenRouteAssessmentInput,
} from "./mlb-frozen-research-route-assessor";
import type { MlbFrozenResearchRouteAssessment } from "./mlb-frozen-research-route-ledger";
import {
  getBullpenStatus,
  type BullpenRuntime,
  type BullpenStatus,
} from "./mlb-bullpen";
import type { MlbIntrinsicBullpenByGame } from "./mlb-intrinsic-edge";
import {
  evaluatePitcher,
  getStatcastQualityCertifiedSnapshot,
  type PitcherQuality,
  type PitcherQualitySignal,
  type StatcastQualityCertifiedSnapshot,
} from "./mlb-statcast-quality";
import {
  getDisciplineSpeedCertifiedSnapshot,
  type DisciplineSpeedCertifiedSnapshot,
} from "./mlb-discipline-speed";
import {
  getTeamSosCertifiedSnapshot,
  type TeamSosCertifiedSnapshot,
} from "./mlb-sos";
import type { MlbShortlistEvidenceByGame } from "./mlb-shortlist";
import type {
  MlbUnifiedV16LiveEvidenceProvider,
  MlbUnifiedV16LiveEvidenceProviders,
} from "./mlb-unified-v16-live-input-assembler";
import { MlbV15BullpenD1Materializer } from "./mlb-v15-bullpen-d1-materializer";

export const MLB_UNIFIED_V16_LIVE_PROVIDERS_SCHEMA =
  "courtedge-p0-mlb-unified-v16-live-providers.v2" as const;

interface ShortlistProviderDependencies {
  getSnapshot?: (runtime: { now?: () => Date }) => Promise<StatcastQualityCertifiedSnapshot>;
  evaluateStarter?: (pitcher: PitcherQuality | undefined) => PitcherQualitySignal | null;
  getDisciplineSpeedSnapshot?: typeof getDisciplineSpeedCertifiedSnapshot;
  getTeamSosSnapshot?: typeof getTeamSosCertifiedSnapshot;
}

interface BullpenProviderDependencies {
  getStatus?: (
    teamId: number,
    teamName: string,
    runtime?: BullpenRuntime,
  ) => Promise<BullpenStatus>;
}

interface FrozenRouteProviderDependencies {
  full13Materializer?: Pick<MlbC4CertifiedMaterializer, "assessFull13Game">;
  matchupMaterializer?: Pick<MlbFrozenMatchupCertifiedMaterializer, "assessGame">;
  bullpenD1Materializer?: Pick<MlbV15BullpenD1Materializer, "assessGame">;
  classify?: (features: MlbFrozenClassifierFeatureSnapshot) => MlbFrozenAPlusClassifierResult;
  assessRoutes?: (input: MlbFrozenRouteAssessmentInput) => MlbFrozenResearchRouteAssessment;
}

type ShortlistPayload = NonNullable<MlbShortlistEvidenceByGame[number]>;

type ShortlistComponentPayload = {
  sourceStatus: string;
  provenance?: { status?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "UNKNOWN");
}

function unavailablePayload(component: string, error: unknown): ShortlistComponentPayload {
  return Object.freeze({
    sourceStatus: "UNAVAILABLE",
    provenance: Object.freeze({ status: "UNAVAILABLE" }),
    component,
    error: errorMessage(error),
  });
}

function isCertifiedPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as ShortlistComponentPayload;
  return row.sourceStatus === "CERTIFIED" && row.provenance?.status === "CERTIFIED";
}

function compositeSosPayload(home: TeamSosCertifiedSnapshot, away: TeamSosCertifiedSnapshot): ShortlistComponentPayload {
  if (
    home.sourceStatus !== "CERTIFIED"
    || home.provenance.status !== "CERTIFIED"
    || away.sourceStatus !== "CERTIFIED"
    || away.provenance.status !== "CERTIFIED"
  ) {
    throw new Error("SOS_CERTIFIED_PROVENANCE_REQUIRED");
  }

  const generatedAtMs = Math.min(Date.parse(home.generatedAt), Date.parse(away.generatedAt));
  const generatedAt = Number.isFinite(generatedAtMs)
    ? new Date(generatedAtMs).toISOString()
    : home.generatedAt;

  return Object.freeze({
    sourceStatus: "CERTIFIED",
    generatedAt,
    provenance: Object.freeze({
      status: "CERTIFIED",
      home: home.provenance,
      away: away.provenance,
    }),
    home: home.teamSos,
    away: away.teamSos,
  });
}

/**
 * Build the common price-independent whole-slate evidence matrix used by the
 * preprice shortlist. These components are additive evidence, not hard gates:
 * one source may be unavailable while the other certified sources continue to
 * compete. The command blocks only when the entire analysis-eligible slate has
 * zero certified core evidence because that represents an infrastructure outage,
 * not a legitimate sporting no-signal state.
 */
export function createMlbUnifiedV16CertifiedShortlistProvider(
  deps: ShortlistProviderDependencies = {},
): MlbUnifiedV16LiveEvidenceProvider<MlbShortlistEvidenceByGame> {
  const getSnapshot = deps.getSnapshot ?? getStatcastQualityCertifiedSnapshot;
  const evaluateStarter = deps.evaluateStarter ?? evaluatePitcher;
  const getDisciplineSpeedSnapshot = deps.getDisciplineSpeedSnapshot ?? getDisciplineSpeedCertifiedSnapshot;
  const getTeamSosSnapshot = deps.getTeamSosSnapshot ?? getTeamSosCertifiedSnapshot;

  return async (context) => {
    if (context.analysisEligibleGamePks.length === 0) return { value: {} };
    const gameByPk = new Map(context.slate.games.map((game) => [game.gamePk, game]));
    const missingIdentityPks = context.analysisEligibleGamePks.filter((gamePk) => {
      const game = gameByPk.get(gamePk);
      return !game?.homePitcher.id
        || !game?.awayPitcher.id
        || !game?.homeTeam.id
        || !game?.awayTeam.id;
    });
    if (missingIdentityPks.length > 0) {
      return {
        blockers: [{
          code: "SHORTLIST_EVIDENCE_UNAVAILABLE",
          gamePks: missingIdentityPks,
          message: "Official team and probable-pitcher identities are required for whole-slate certified evidence.",
        }],
      };
    }

    let statcastSnapshot: StatcastQualityCertifiedSnapshot | null = null;
    let statcastFailure: unknown = null;
    try {
      const candidate = await getSnapshot({ now: () => context.now });
      if (candidate.sourceStatus !== "CERTIFIED" || candidate.provenance.status !== "CERTIFIED") {
        throw new Error("STATCAST_CERTIFIED_PROVENANCE_REQUIRED");
      }
      statcastSnapshot = candidate;
    } catch (error) {
      statcastFailure = error;
    }

    const evidence: Record<number, ShortlistPayload> = {};
    for (const gamePk of context.analysisEligibleGamePks) {
      const game = gameByPk.get(gamePk)!;
      evidence[gamePk] = {
        statcastQuality: statcastSnapshot
          ? {
              sourceStatus: statcastSnapshot.sourceStatus,
              generatedAt: statcastSnapshot.generatedAt,
              provenance: statcastSnapshot.provenance,
              homeSP: evaluateStarter(statcastSnapshot.pitcherMap[game.homePitcher.id!]),
              awaySP: evaluateStarter(statcastSnapshot.pitcherMap[game.awayPitcher.id!]),
            }
          : unavailablePayload("STATCAST_QUALITY", statcastFailure ?? "STATCAST_UNAVAILABLE"),
      };
    }

    // Discipline/Speed uses the exact official nine-man identities when P1 has them.
    // Before lineups are FINAL the arrays are empty, so pitcher discipline can contribute
    // provisionally without inventing batter-speed evidence. Bootstrap one call first so
    // the shared Savant sprint-speed cache is warm before parallelizing the rest.
    const loadDisciplineForGame = async (gamePk: number): Promise<void> => {
      const game = gameByPk.get(gamePk)!;
      try {
        const snapshot: DisciplineSpeedCertifiedSnapshot = await getDisciplineSpeedSnapshot({
          homePitcherId: game.homePitcher.id!,
          homePitcherName: game.homePitcher.name ?? "Home Starter",
          awayPitcherId: game.awayPitcher.id!,
          awayPitcherName: game.awayPitcher.name ?? "Away Starter",
          homeBatterIds: [...(game.homeLineupIds ?? [])],
          awayBatterIds: [...(game.awayLineupIds ?? [])],
          runtime: { now: () => context.now },
        });
        if (snapshot.sourceStatus !== "CERTIFIED" || snapshot.provenance.status !== "CERTIFIED") {
          throw new Error("DISCIPLINE_SPEED_CERTIFIED_PROVENANCE_REQUIRED");
        }
        evidence[gamePk].disciplineSpeed = snapshot;
      } catch (error) {
        evidence[gamePk].disciplineSpeed = unavailablePayload("DISCIPLINE_SPEED", error);
      }
    };

    const [firstGamePk, ...remainingGamePks] = context.analysisEligibleGamePks;
    if (firstGamePk !== undefined) await loadDisciplineForGame(firstGamePk);
    await Promise.all(remainingGamePks.map(loadDisciplineForGame));

    // SOS is memoized per unique team within this command so doubleheaders do not
    // duplicate work. The underlying certified SOS cache then protects repeated V16
    // invocations during its one-hour evidence window.
    const sosByTeamId = new Map<number, Promise<TeamSosCertifiedSnapshot>>();
    const loadTeamSos = (teamId: number, teamName: string): Promise<TeamSosCertifiedSnapshot> => {
      const existing = sosByTeamId.get(teamId);
      if (existing) return existing;
      const created = getTeamSosSnapshot(teamId, teamName, { now: () => context.now });
      sosByTeamId.set(teamId, created);
      return created;
    };

    await Promise.all(context.analysisEligibleGamePks.map(async (gamePk) => {
      const game = gameByPk.get(gamePk)!;
      try {
        const [home, away] = await Promise.all([
          loadTeamSos(game.homeTeam.id!, game.homeTeam.name),
          loadTeamSos(game.awayTeam.id!, game.awayTeam.name),
        ]);
        evidence[gamePk].sos = compositeSosPayload(home, away);
      } catch (error) {
        evidence[gamePk].sos = unavailablePayload("SOS", error);
      }
    }));

    const hasAnyCertifiedCoreEvidence = Object.values(evidence).some((row) =>
      isCertifiedPayload(row.statcastQuality)
      || isCertifiedPayload(row.disciplineSpeed)
      || isCertifiedPayload(row.sos),
    );

    if (!hasAnyCertifiedCoreEvidence) {
      return {
        blockers: [{
          code: "SHORTLIST_EVIDENCE_UNAVAILABLE",
          gamePks: context.analysisEligibleGamePks,
          message: "Whole-slate core evidence is unavailable across Statcast, Discipline/Speed, and SOS. This is treated as an infrastructure block, not sporting NO PLAY.",
        }],
      };
    }

    return { value: Object.freeze(evidence) };
  };
}

export function createMlbUnifiedV16CertifiedBullpenProvider(
  deps: BullpenProviderDependencies = {},
): MlbUnifiedV16LiveEvidenceProvider<MlbIntrinsicBullpenByGame> {
  const getStatus = deps.getStatus ?? getBullpenStatus;

  return async (context) => {
    if (context.analysisEligibleGamePks.length === 0) return { value: {} };
    const gameByPk = new Map(context.slate.games.map((game) => [game.gamePk, game]));
    const evidence: Record<number, NonNullable<MlbIntrinsicBullpenByGame[number]>> = {};
    const failures: Array<{ gamePk: number; message: string }> = [];

    await Promise.all(context.analysisEligibleGamePks.map(async (gamePk) => {
      const game = gameByPk.get(gamePk);
      if (!game) {
        failures.push({ gamePk, message: "slate entry missing" });
        return;
      }
      try {
        const runtime: BullpenRuntime = { now: () => context.now };
        const [home, away] = await Promise.all([
          getStatus(game.homeTeam.id, game.homeTeam.name, runtime),
          getStatus(game.awayTeam.id, game.awayTeam.name, runtime),
        ]);
        if (
          home.sourceStatus !== "CERTIFIED"
          || home.provenance?.status !== "CERTIFIED"
          || away.sourceStatus !== "CERTIFIED"
          || away.provenance?.status !== "CERTIFIED"
        ) {
          throw new Error("BULLPEN_CERTIFIED_PROVENANCE_REQUIRED");
        }
        evidence[gamePk] = Object.freeze({ home, away });
      } catch (error) {
        failures.push({
          gamePk,
          message: error instanceof Error ? error.message : "materialization failed",
        });
      }
    }));

    if (failures.length > 0) {
      failures.sort((a, b) => a.gamePk - b.gamePk);
      return {
        blockers: [{
          code: "BULLPEN_EVIDENCE_UNAVAILABLE",
          gamePks: failures.map((failure) => failure.gamePk),
          message: `Certified official-MLB bullpen materialization failed closed: ${failures.map((failure) => `${failure.gamePk}:${failure.message}`).join(" | ")}`,
        }],
      };
    }

    return { value: evidence };
  };
}

export function createMlbUnifiedV16CertifiedC4Provider(
  materializer: Pick<MlbC4CertifiedMaterializer, "assessGame"> = new MlbC4CertifiedMaterializer(),
): MlbUnifiedV16LiveEvidenceProvider<Readonly<Record<number, C4LiveFeatureAssessment | undefined>>> {
  return async (context) => {
    if (context.finalEligibleGamePks.length === 0) return { value: {} };
    const gameByPk = new Map(context.slate.games.map((game) => [game.gamePk, game]));
    const evidence: Record<number, C4LiveFeatureAssessment> = {};
    const failures: Array<{ gamePk: number; message: string }> = [];
    await Promise.all(context.finalEligibleGamePks.map(async (gamePk) => {
      const game = gameByPk.get(gamePk);
      if (!game) {
        failures.push({ gamePk, message: "slate entry missing" });
        return;
      }
      try {
        evidence[gamePk] = await materializer.assessGame(game);
      } catch (error) {
        failures.push({ gamePk, message: error instanceof Error ? error.message : "materialization failed" });
      }
    }));
    if (failures.length > 0) {
      failures.sort((a, b) => a.gamePk - b.gamePk);
      return {
        blockers: [{
          code: "C4_LIVE_INPUT_UNAVAILABLE",
          gamePks: failures.map((failure) => failure.gamePk),
          message: `Certified official-MLB C4 materialization failed closed: ${failures.map((failure) => `${failure.gamePk}:${failure.message}`).join(" | ")}`,
        }],
      };
    }
    return { value: evidence };
  };
}

export function createMlbUnifiedV16CertifiedFrozenRouteProvider(
  deps: FrozenRouteProviderDependencies = {},
): MlbUnifiedV16LiveEvidenceProvider<Readonly<Record<number, MlbFrozenResearchRouteAssessment | undefined>>> {
  const full13Materializer = deps.full13Materializer ?? new MlbC4CertifiedMaterializer();
  const matchupMaterializer = deps.matchupMaterializer ?? new MlbFrozenMatchupCertifiedMaterializer();
  const bullpenD1Materializer = deps.bullpenD1Materializer ?? new MlbV15BullpenD1Materializer();
  const classify = deps.classify ?? classifyMlbFrozenAPlusAndF5;
  const assessRoutes = deps.assessRoutes ?? assessMlbFrozenResearchRoutes;

  return async (context) => {
    if (context.finalEligibleGamePks.length === 0) return { value: {} };
    const gameByPk = new Map(context.slate.games.map((game) => [game.gamePk, game]));
    const evidence: Record<number, MlbFrozenResearchRouteAssessment> = {};
    const failures: Array<{ gamePk: number; message: string }> = [];

    await Promise.all(context.finalEligibleGamePks.map(async (gamePk) => {
      const game = gameByPk.get(gamePk);
      if (!game) {
        failures.push({ gamePk, message: "slate entry missing" });
        return;
      }
      try {
        const [full13, matchup, bullpenD1] = await Promise.all([
          full13Materializer.assessFull13Game(game),
          matchupMaterializer.assessGame(game),
          bullpenD1Materializer.assessGame({
            gamePk: game.gamePk,
            officialDate: game.officialDate,
            homeTeamId: game.homeTeam.id,
            awayTeamId: game.awayTeam.id,
            now: context.now,
          }),
        ]);
        if (matchup.sourceStatus !== "CERTIFIED" || matchup.provenance.targetOutcomeUsed || matchup.provenance.sportsbookPriceUsed) {
          throw new Error("FROZEN_ROUTE_MATCHUP_CERTIFIED_PROVENANCE_REQUIRED");
        }
        if (
          bullpenD1.provenance.status !== "CERTIFIED_PROSPECTIVE_OPERATIONAL"
          || bullpenD1.provenance.targetGameOutcomeUsed
          || bullpenD1.provenance.sameDateDataUsed
          || bullpenD1.provenance.futureGameDataUsed
          || bullpenD1.provenance.thresholdSearchUsed
        ) {
          throw new Error("FROZEN_ROUTE_BULLPEN_D1_CERTIFIED_PROVENANCE_REQUIRED");
        }

        const classification = classify(full13.featureVector as MlbFrozenClassifierFeatureSnapshot);
        evidence[gamePk] = assessRoutes({
          gamePk: game.gamePk,
          gameDate: game.officialDate,
          scheduledStartTime: game.startTime,
          evaluatedAt: context.now.toISOString(),
          finalInputs: true,
          classifiers: {
            premiumA: classification.premiumA,
            aPlus: classification.aPlus,
            f5Consensus: classification.f5Consensus,
            slg: {
              eligible: matchup.featureAssessment.slg.eligible,
              adv: matchup.featureAssessment.slg.adv,
            },
            pitchmix: {
              eligible: matchup.featureAssessment.pitchmix.eligible,
              contactAdv: matchup.featureAssessment.pitchmix.contactAdv,
              whiffAdv: matchup.featureAssessment.pitchmix.whiffAdv,
              tbpaAdv: matchup.featureAssessment.pitchmix.tbpaAdv,
              hrpaAdv: matchup.featureAssessment.pitchmix.hrpaAdv,
            },
            bullpenD1Eligible: bullpenD1.eligible,
            bullpenPitches1dAdv: bullpenD1.bullpenPitches1dAdv,
          },
        });
      } catch (error) {
        failures.push({
          gamePk,
          message: error instanceof Error ? error.message : "materialization failed",
        });
      }
    }));

    if (failures.length > 0) {
      failures.sort((a, b) => a.gamePk - b.gamePk);
      return {
        blockers: [{
          code: "FROZEN_ROUTE_ASSESSMENT_UNAVAILABLE",
          gamePks: failures.map((failure) => failure.gamePk),
          message: `Certified frozen-route materialization failed closed: ${failures.map((failure) => `${failure.gamePk}:${failure.message}`).join(" | ")}`,
        }],
      };
    }

    return { value: Object.freeze(evidence) };
  };
}

export function createMlbUnifiedV16DefaultLiveEvidenceProviders(): MlbUnifiedV16LiveEvidenceProviders {
  const sharedClassifierMaterializer = new MlbC4CertifiedMaterializer();
  return Object.freeze({
    shortlistEvidence: createMlbUnifiedV16CertifiedShortlistProvider(),
    bullpenEvidence: createMlbUnifiedV16CertifiedBullpenProvider(),
    frozenRouteAssessments: createMlbUnifiedV16CertifiedFrozenRouteProvider({
      full13Materializer: sharedClassifierMaterializer,
    }),
    c4Assessments: createMlbUnifiedV16CertifiedC4Provider(sharedClassifierMaterializer),
  });
}
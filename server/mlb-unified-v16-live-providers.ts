import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  evaluatePitcher,
  getStatcastQualityCertifiedSnapshot,
  type PitcherQuality,
  type PitcherQualitySignal,
  type StatcastQualityCertifiedSnapshot,
} from "./mlb-statcast-quality";
import type { MlbShortlistEvidenceByGame } from "./mlb-shortlist";
import type {
  MlbUnifiedV16LiveEvidenceProvider,
  MlbUnifiedV16LiveEvidenceProviders,
} from "./mlb-unified-v16-live-input-assembler";

export const MLB_UNIFIED_V16_LIVE_PROVIDERS_SCHEMA =
  "courtedge-p0-mlb-unified-v16-live-providers.v1" as const;

interface StatcastProviderDependencies {
  getSnapshot?: (runtime: { now?: () => Date }) => Promise<StatcastQualityCertifiedSnapshot>;
  evaluateStarter?: (pitcher: PitcherQuality | undefined) => PitcherQualitySignal | null;
}

export function createMlbUnifiedV16CertifiedShortlistProvider(
  deps: StatcastProviderDependencies = {},
): MlbUnifiedV16LiveEvidenceProvider<MlbShortlistEvidenceByGame> {
  const getSnapshot = deps.getSnapshot ?? getStatcastQualityCertifiedSnapshot;
  const evaluateStarter = deps.evaluateStarter ?? evaluatePitcher;

  return async (context) => {
    if (context.analysisEligibleGamePks.length === 0) return { value: {} };
    const gameByPk = new Map(context.slate.games.map((game) => [game.gamePk, game]));
    const missingPitcherPks = context.analysisEligibleGamePks.filter((gamePk) => {
      const game = gameByPk.get(gamePk);
      return !game?.homePitcher.id || !game?.awayPitcher.id;
    });
    if (missingPitcherPks.length > 0) {
      return { blockers: [{ code: "SHORTLIST_EVIDENCE_UNAVAILABLE", gamePks: missingPitcherPks, message: "Official probable-pitcher identity is incomplete for certified Statcast shortlist evidence." }] };
    }

    let snapshot: StatcastQualityCertifiedSnapshot;
    try {
      snapshot = await getSnapshot({ now: () => context.now });
    } catch {
      return { blockers: [{ code: "SHORTLIST_EVIDENCE_UNAVAILABLE", gamePks: context.analysisEligibleGamePks, message: "The certified Baseball Savant Statcast snapshot is unavailable." }] };
    }
    if (snapshot.sourceStatus !== "CERTIFIED" || snapshot.provenance.status !== "CERTIFIED") {
      return { blockers: [{ code: "SHORTLIST_EVIDENCE_UNAVAILABLE", gamePks: context.analysisEligibleGamePks, message: "The Statcast snapshot did not satisfy certified provenance requirements." }] };
    }

    const evidence: Record<number, NonNullable<MlbShortlistEvidenceByGame[number]>> = {};
    for (const gamePk of context.analysisEligibleGamePks) {
      const game = gameByPk.get(gamePk)!;
      evidence[gamePk] = {
        statcastQuality: {
          sourceStatus: snapshot.sourceStatus,
          generatedAt: snapshot.generatedAt,
          provenance: snapshot.provenance,
          homeSP: evaluateStarter(snapshot.pitcherMap[game.homePitcher.id!]),
          awaySP: evaluateStarter(snapshot.pitcherMap[game.awayPitcher.id!]),
        },
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

export function createMlbUnifiedV16DefaultLiveEvidenceProviders(): MlbUnifiedV16LiveEvidenceProviders {
  return Object.freeze({
    shortlistEvidence: createMlbUnifiedV16CertifiedShortlistProvider(),
    c4Assessments: createMlbUnifiedV16CertifiedC4Provider(),
  });
}

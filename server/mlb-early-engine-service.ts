import { computeMlbEre } from "./mlb-ere.js";
import { computeEarlyMarkets } from "./mlb-early-markets.js";
import { computeF5Unified, type PitcherRecentForm, type UmpireData } from "./mlb-f5-unified.js";
import { computeMatchupSignal } from "./mlb-matchup-signal.js";
import { computeUncertainty } from "./mlb-uncertainty.js";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";

export const MLB_EARLY_ENGINE_SERVICE_SCHEMA = "mlb-early-engine-service.v1" as const;

export interface MlbEarlyEngineTeamInput {
  teamId: number;
  teamName?: string;
  gamePk?: number;
  opposingPitcherId?: number;
  opposingPitcherHand?: "R" | "L";
  venue?: string;
  tempF?: number;
  windMph?: number;
  windDirOut?: boolean;
}

export interface MlbEarlyEngineLinesInput {
  f5OverLine?: number;
  f5OverOdds?: number;
  f5UnderOdds?: number;
  f5HomeMlOdds?: number;
  f5AwayMlOdds?: number;
  nrfiOdds?: number;
  yrfiOdds?: number;
}

export interface MlbEarlyEngineRequest {
  home: MlbEarlyEngineTeamInput;
  away: MlbEarlyEngineTeamInput;
  lines?: MlbEarlyEngineLinesInput;
  gameDate?: string;
  disableMatchup?: boolean;
  homePitcherForm?: PitcherRecentForm;
  awayPitcherForm?: PitcherRecentForm;
  umpire?: UmpireData;
}

/**
 * Canonical Early/ERE computation used by both the single-game HTTP route and
 * whole-slate producer. Sporting formulas remain in their existing modules;
 * this service only owns the orchestration that previously lived in the route.
 */
export async function computeMlbEarlyEngine(request: MlbEarlyEngineRequest) {
  const { home, away, lines } = request;
  if (!home?.teamId || !away?.teamId) throw new Error("home y away requieren teamId");

  const sharedGamePk = home.gamePk || away.gamePk;
  const analysisDateIso = await resolveMlbAnalysisDate(request.gameDate, sharedGamePk);
  const currentSeason = Number(analysisDateIso.slice(0, 4));
  const disableMatchup = request.disableMatchup === true;

  const [homeEre, awayEre, matchupSignal] = await Promise.all([
    computeMlbEre({
      teamId: home.teamId,
      teamName: home.teamName || "",
      gamePk: home.gamePk,
      opposingPitcherId: home.opposingPitcherId,
      opposingPitcherHand: home.opposingPitcherHand,
      venue: home.venue,
      tempF: home.tempF,
      windMph: home.windMph,
      windDirOut: home.windDirOut,
      gameDate: analysisDateIso,
    }),
    computeMlbEre({
      teamId: away.teamId,
      teamName: away.teamName || "",
      gamePk: away.gamePk,
      opposingPitcherId: away.opposingPitcherId,
      opposingPitcherHand: away.opposingPitcherHand,
      venue: away.venue,
      tempF: away.tempF,
      windMph: away.windMph,
      windDirOut: away.windDirOut,
      gameDate: analysisDateIso,
    }),
    sharedGamePk && !disableMatchup
      ? computeMatchupSignal(sharedGamePk, currentSeason).catch(() => null)
      : Promise.resolve(null),
  ]);

  // Existing optional F5 PREMIUM boost overlay. These signals do not change
  // filters or base probabilities; preserving them here prevents route/slate drift.
  const homeProbPid = away.opposingPitcherId;
  const awayProbPid = home.opposingPitcherId;
  let boostSignalsInput:
    | { home: Array<{ type: any; label: string }>; away: Array<{ type: any; label: string }> }
    | undefined;

  try {
    const [{ getPitcherRecentCombined }, { analyzePitcherVsTeamMatchup }, { getTeamSos }, { getPitcherQualityMap }] = await Promise.all([
      import("./mlb-pitcher-recent"),
      import("./mlb-pitcher-vs-team"),
      import("./mlb-sos"),
      import("./mlb-statcast-quality"),
    ]);
    const [recent, pvt, sosHome, sosAway, qualityMap] = await Promise.all([
      (homeProbPid || awayProbPid)
        ? getPitcherRecentCombined(homeProbPid ?? null, "?", awayProbPid ?? null, "?", analysisDateIso).catch(() => null)
        : Promise.resolve(null),
      (homeProbPid && awayProbPid)
        ? analyzePitcherVsTeamMatchup(
            home.teamId,
            home.teamName || "",
            homeProbPid,
            "?",
            away.teamId,
            away.teamName || "",
            awayProbPid,
            "?",
          ).catch(() => null)
        : Promise.resolve(null),
      getTeamSos(home.teamId, home.teamName || "").catch(() => null),
      getTeamSos(away.teamId, away.teamName || "").catch(() => null),
      getPitcherQualityMap().catch(() => ({} as Record<number, any>)),
    ]);

    const buildBoosts = (pickSide: "HOME" | "AWAY"): Array<{ type: any; label: string }> => {
      const boosts: Array<{ type: any; label: string }> = [];
      const rivalRecent = pickSide === "HOME" ? recent?.away : recent?.home;
      const rivalPid = pickSide === "HOME" ? awayProbPid : homeProbPid;
      const rivalPvt = pickSide === "HOME" ? pvt?.awayVsHome : pvt?.homeVsAway;
      const sosPick = pickSide === "HOME" ? sosHome : sosAway;
      const rivalQual = rivalPid ? qualityMap[rivalPid] : null;

      if (rivalRecent?.trend === "IMPLOSION") {
        boosts.push({ type: "IMPLOSION", label: `Rival IMPLOSION (ERA ${rivalRecent.recentEra?.toFixed(2)})` });
      }
      if (rivalRecent?.recencyEraDelta && rivalRecent.recencyEraDelta >= 0.3) {
        boosts.push({ type: "ERA_DECLINE", label: `Rival ERA +${rivalRecent.recencyEraDelta.toFixed(2)} recent` });
      }
      if (rivalQual?.xera && rivalQual.xera >= 5) {
        boosts.push({ type: "QUALITY_BAD", label: `Rival xERA=${rivalQual.xera.toFixed(2)} elite malo` });
      }
      if (rivalPvt && rivalPvt.significantSample && rivalPvt.era !== null && rivalPvt.era >= 5) {
        boosts.push({ type: "H2H_STRUGGLE", label: `Rival ERA H2H=${rivalPvt.era.toFixed(2)} (${rivalPvt.totalStarts} starts)` });
      }
      if (sosPick?.tier === "INFLATED") {
        boosts.push({ type: "SOS_INFLATED", label: "Ofensiva reprimida (SOS INFLATED)" });
      }
      return boosts;
    };

    boostSignalsInput = {
      home: buildBoosts("HOME"),
      away: buildBoosts("AWAY"),
    };
  } catch {
    boostSignalsInput = undefined;
  }

  const markets = computeEarlyMarkets({
    homeEre,
    awayEre,
    f5OverLine: lines?.f5OverLine,
    f5OverOddsAmerican: lines?.f5OverOdds,
    f5UnderOddsAmerican: lines?.f5UnderOdds,
    f5HomeMlOddsAmerican: lines?.f5HomeMlOdds,
    f5AwayMlOddsAmerican: lines?.f5AwayMlOdds,
    nrfiOddsAmerican: lines?.nrfiOdds,
    yrfiOddsAmerican: lines?.yrfiOdds,
    matchupSignal: matchupSignal ?? undefined,
    boostSignals: boostSignalsInput,
  });

  const f5Unified = computeF5Unified({
    homeEre,
    awayEre,
    homePitcherForm: request.homePitcherForm,
    awayPitcherForm: request.awayPitcherForm,
    umpire: request.umpire,
    matchupSignal: matchupSignal ? {
      homeLineupAvgXwoba: matchupSignal.homeLineupAvgXwoba,
      awayLineupAvgXwoba: matchupSignal.awayLineupAvgXwoba,
      dataConfidence: matchupSignal.dataConfidence,
    } : undefined,
  });

  const uncertainty = await computeUncertainty(
    home.teamId,
    away.teamId,
    homeEre,
    awayEre,
    matchupSignal,
  ).catch(() => null);

  return {
    schemaVersion: MLB_EARLY_ENGINE_SERVICE_SCHEMA,
    analysisDate: analysisDateIso,
    homeEre,
    awayEre,
    markets,
    f5Unified,
    matchupSignal: matchupSignal ?? null,
    matchupDisabled: disableMatchup,
    uncertainty: uncertainty ?? null,
  };
}

export type MlbEarlyEngineOutput = Awaited<ReturnType<typeof computeMlbEarlyEngine>>;

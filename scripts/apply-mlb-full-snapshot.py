from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


# Frontend API type carries the immutable scientific snapshot alongside editable history.
replace_once(
    "frontend/client/src/lib/picks-api.ts",
    '// Cliente canónico de picks. Todas las escrituras usan /api/picks/v2.\nimport { fetchJson } from "./queryClient";',
    '// Cliente canónico de picks. Todas las escrituras usan /api/picks/v2.\nimport { fetchJson } from "./queryClient";\nimport type { MlbScientificSnapshot } from "./mlb-scientific-snapshot";',
)
replace_once(
    "frontend/client/src/lib/picks-api.ts",
    "  clvPercent?: number;\n}",
    "  clvPercent?: number;\n  scientificSnapshot?: MlbScientificSnapshot;\n}",
)

# App context preserves the snapshot while the editable Picks V2 record is reloaded or saved.
replace_once(
    "frontend/client/src/lib/context.tsx",
    "  clvPercent?: number;\n}",
    '  clvPercent?: number;\n  scientificSnapshot?: SavedPick["scientificSnapshot"];\n}',
)
replace_once(
    "frontend/client/src/lib/context.tsx",
    "    clvPercent: record.clvPercent,\n  };",
    "    clvPercent: record.clvPercent,\n    scientificSnapshot: record.scientificSnapshot,\n  };",
)
replace_once(
    "frontend/client/src/lib/context.tsx",
    "    clvPercent: pick.clvPercent,\n  };",
    "    clvPercent: pick.clvPercent,\n    scientificSnapshot: pick.scientificSnapshot,\n  };",
)

# Predictor emits a whitelisted, redacted, bounded snapshot through the same save action.
replace_once(
    "frontend/client/src/pages/mlb-predictor.tsx",
    'import { MLBUmpireCard, MLBAdvancedCard, EliteBanner, SharpSignalsCard, sharpBadgeFor, MLBContextualCard, type SharpDirection } from "@/components/elite-factors";',
    'import { MLBUmpireCard, MLBAdvancedCard, EliteBanner, SharpSignalsCard, sharpBadgeFor, MLBContextualCard, type SharpDirection } from "@/components/elite-factors";\nimport { americanImpliedProbability, createMlbScientificSnapshot, isoDateTimeOrUndefined, mapMlbLedgerMarket, noVigSideProbability, parseMlbMarketLine, type MlbSourceStatus } from "@/lib/mlb-scientific-snapshot";',
)

old_save = '''  // Save MLB pick
  const savePick = (market: string, pick: string, odds: number, modelProb: number) => {
    const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
    const kelly = Math.max(0, (b * (modelProb/100) - (1 - modelProb/100)) / b) * 0.25 * 1000;
    dispatch({
      type: "ADD_MLB_PICK",
      payload: {
        date: new Date().toISOString().split("T")[0],
        sport: "MLB",
        team: homeTeam || "Local",
        opponent: awayTeam || "Visitante",
        market, pick, odds, modelProb,
        stake: Math.round(kelly * 100) / 100,
        result: "P",
      },
    });
    toast({ title: "Pick MLB guardado en historial" });
  };
'''

new_save = '''  // Save MLB pick + one canonical scientific snapshot.
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
    const implied = americanImpliedProbability(odds);
    const noVig = noVigSideProbability(odds, oppositeOdds);
    const edgePp = implied == null ? undefined : resolvedModelProb - implied * 100;
    const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
    const fallbackKelly = Math.max(0, (b * (resolvedModelProb / 100) - (1 - resolvedModelProb / 100)) / b) * 0.25 * 100;
    const operationalStake = Math.min(1, Math.max(0, pq?.stakeUnits ?? fallbackKelly));
    const capturedAt = new Date().toISOString();
    const selectedGame = mlbGames.find((game) => String(game.gameId) === selectedGameId) as any;
    const commenceTime = isoDateTimeOrUndefined(selectedGame?.commenceTime || selectedGame?.gameTime || selectedGame?.gameDate);
    const injuryStatus = (status: MLBInjuryFeedStatus): MlbSourceStatus => status === "VERIFIED" ? "VERIFIED"
      : status === "PARTIAL" ? "PARTIAL"
        : status === "SOURCE_UNAVAILABLE" ? "MISSING" : "UNKNOWN";
    const completeFactorFeeds = [lineupMatchup, archetypeMatchup, bullpenStatus, parkPitcher, pitcherVsTeam, windPark, catcherFraming, rookiePitcher, pitcherForm, teamFatigue, pitcherRecent, statcastMatchup, statcastQuality, sos, discSpeed]
      .filter(Boolean).length;
    const stage = Boolean(gamePkForTesi && selectedGameId && homeInjuryFeed.status === "VERIFIED" && awayInjuryFeed.status === "VERIFIED")
      ? "FINAL" as const : "PROVISIONAL" as const;
    const warnings = [
      ...(pq?.warnings || []),
      ...(stage === "PROVISIONAL" ? ["Snapshot provisional: faltan identificador oficial del juego o verificación completa de lesiones."] : []),
    ];

    const scientificSnapshot = createMlbScientificSnapshot({
      model: {
        name: "CourtEdge MLB",
        version: "predictor-full-snapshot-v1",
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
            fetchedAt: homeInjuryFeed.fetchedAt || capturedAt,
            sample: homeInjuryFeed.count,
            metadata: { autoApplyAllowed: homeInjuryFeed.autoApplyAllowed, stale: homeInjuryFeed.stale || false },
          },
          {
            name: "BALLDONTLIE injuries away",
            status: injuryStatus(awayInjuryFeed.status),
            fetchedAt: awayInjuryFeed.fetchedAt || capturedAt,
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
'''
replace_once("frontend/client/src/pages/mlb-predictor.tsx", old_save, new_save)

# Backend accepts the snapshot, maps it once, and compensates the editable history if the immutable append fails.
replace_once(
    "server/picks-v2.ts",
    'import { getMlbLedgerStore } from "./mlb-ledger";',
    'import { getMlbLedgerStore } from "./mlb-ledger";\nimport { buildMlbLedgerPredictionFromPick, mlbScientificSnapshotSchema } from "./mlb-scientific-snapshot";',
)
replace_once(
    "server/picks-v2.ts",
    "  clvPercent: z.number().finite().optional(),\n}).strict();",
    "  clvPercent: z.number().finite().optional(),\n  scientificSnapshot: mlbScientificSnapshotSchema.optional(),\n}).strict();",
)
replace_once(
    "server/picks-v2.ts",
    ".omit({ id: true, ts: true, sport: true, homeTeam: true, awayTeam: true, pickType: true, pickSide: true, confidence: true })",
    ".omit({ id: true, ts: true, sport: true, homeTeam: true, awayTeam: true, pickType: true, pickSide: true, confidence: true, scientificSnapshot: true })",
)

start = '''function mirrorMlbPickToScientificLedger(pick: SavedPickV2): void {
'''
end = '''}

export function registerPicksV2Routes(app: Express): void {
'''
path = ROOT / "server/picks-v2.ts"
text = path.read_text(encoding="utf-8")
left = text.find(start)
right = text.find(end, left)
if left < 0 or right < 0:
    raise RuntimeError("Could not locate mirrorMlbPickToScientificLedger block")
replacement = '''function mirrorMlbPickToScientificLedger(pick: SavedPickV2): void {
  if (pick.sport !== "mlb") return;
  getMlbLedgerStore().appendPrediction(buildMlbLedgerPredictionFromPick(pick));
}

export function registerPicksV2Routes(app: Express): void {
'''
path.write_text(text[:left] + replacement + text[right + len(end):], encoding="utf-8")

old_post = '''    const picks = loadPicks();
    const existingIndex = picks.findIndex((item) => item.id === pick.id);
    if (existingIndex >= 0) picks[existingIndex] = { ...picks[existingIndex], ...pick };
    else picks.push(pick);
    savePicks(picks);

    try {
      mirrorMlbPickToScientificLedger(pick);
    } catch (error) {
      // The editable user history remains available even if scientific mirroring fails.
      // The ledger error is visible in logs and can be repaired with an explicit backfill.
      console.error(`[mlb-ledger] mirror failed for canonical pick ${pick.id}`, error);
    }

    res.status(existingIndex >= 0 ? 200 : 201).json({ success: true, data: pick });
'''
new_post = '''    const originalPicks = loadPicks();
    const picks = originalPicks.map((item) => ({ ...item }));
    const existingIndex = picks.findIndex((item) => item.id === pick.id);
    if (existingIndex >= 0) picks[existingIndex] = { ...picks[existingIndex], ...pick };
    else picks.push(pick);

    savePicks(picks);
    try {
      mirrorMlbPickToScientificLedger(pick);
    } catch (error: any) {
      if (pick.scientificSnapshot) {
        // A full snapshot is one canonical scientific event. Compensate the editable
        // history write rather than silently leaving it disconnected from the ledger.
        savePicks(originalPicks);
        console.error(`[mlb-ledger] canonical snapshot failed for pick ${pick.id}`, error);
        res.status(error?.status || 500).json({
          success: false,
          error: error?.message || "Scientific MLB snapshot could not be recorded",
        });
        return;
      }
      // Legacy records remain best-effort provisional mirrors.
      console.error(`[mlb-ledger] provisional mirror failed for canonical pick ${pick.id}`, error);
    }

    res.status(existingIndex >= 0 ? 200 : 201).json({
      success: true,
      data: pick,
      ledger: pick.sport === "mlb" ? {
        mode: pick.scientificSnapshot ? "FULL_SNAPSHOT" : "PROVISIONAL_MIRROR",
        clientRequestId: `picks-v2:${pick.id}`,
      } : undefined,
    });
'''
replace_once("server/picks-v2.ts", old_post, new_post)

# Add new validator and tests to the permanent Phase 1 gate.
replace_once(
    "package.json",
    '"test:mlb-ledger": "tsx --test server/mlb-ledger.test.ts server/mlb-settlement-worker.test.ts"',
    '"test:mlb-ledger": "tsx --test server/mlb-ledger.test.ts server/mlb-settlement-worker.test.ts server/mlb-scientific-snapshot.test.ts"',
)
replace_once(
    "tsconfig.mlb-ledger.json",
    '    "server/mlb-settlement-worker.test.ts"\n',
    '    "server/mlb-settlement-worker.test.ts",\n    "server/mlb-scientific-snapshot.ts",\n    "server/mlb-scientific-snapshot.test.ts",\n    "server/picks-v2.ts"\n',
)

print("MLB full scientific snapshot integration patch applied successfully")

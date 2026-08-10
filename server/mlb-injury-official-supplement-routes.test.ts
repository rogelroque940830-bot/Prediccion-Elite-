import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  MLB_INJURY_IDENTITY_DIAGNOSTIC_QUERY,
  MLB_OFFICIAL_INJURY_SUPPLEMENT_SCHEMA,
  registerMlbOfficialInjurySupplementMiddleware,
  supplementMlbAllOfficialInjuryEvidence,
} from "./mlb-injury-official-supplement-routes";
import { MLB_INJURY_IDENTITY_DIAGNOSTIC_SCHEMA } from "./mlb-injury-official-supplement";
import type { MlbOfficialInjurySnapshot } from "./mlb-injury-shadow";

function officialSnapshot(ids: number[]): MlbOfficialInjurySnapshot {
  return {
    status: "VERIFIED",
    source: "MLB_STATS",
    fetchedAt: "2026-08-09T16:00:00.000Z",
    errors: [],
    rosterByPlayerId: Object.fromEntries(ids.map((id, index) => [id, {
      playerId: id,
      name: `Official Player ${id}`,
      statusCode: index % 2 ? "D10" : "D15",
      statusDescription: index % 2 ? "10-Day Injured List" : "15-Day Injured List",
      position: index % 2 ? "OF" : "P",
    }])),
    latestTransactionByPlayerId: Object.fromEntries(ids.map((id) => [id, {
      effectiveDate: "2026-08-07",
      typeDesc: "Placed on Injured List",
    }])),
  };
}

function partialMeta(overrides: Record<string, unknown> = {}) {
  return {
    source: "BALLDONTLIE",
    validationSource: "MLB_STATS",
    status: "PARTIAL",
    fetchedAt: "2026-08-09T16:00:00.000Z",
    stale: false,
    sourceErrors: [],
    officialValidationStatus: "VERIFIED",
    officialFetchedAt: "2026-08-09T16:00:00.000Z",
    count: 1,
    rejectedCount: 0,
    autoApplyAllowed: true,
    phaseB: {
      enabled: true,
      mode: "AUTO_CONSERVATIVE",
      coverage: "PARTIAL",
      eligiblePlayerIds: [201],
      eligiblePlayerNames: ["Detected Reliever"],
      withheldCandidateNames: [],
      candidateCount: 1,
      scale: 0.35,
      maxAbsRuns: 0.35,
      requiresBullpenReconciliation: true,
      reason: "existing phase B",
    },
    shadowSummary: {
      total: 1,
      applyCandidates: 1,
      alreadyReflected: 0,
      ignored: 0,
      conflicts: 0,
      pending: 0,
      highConfidence: 1,
      officialOnly: 2,
      mode: "SHADOW",
    },
    ...overrides,
  };
}

function payload(meta = partialMeta()) {
  return {
    games: [{
      gameId: 9001,
      homeTeam: { id: 10, name: "Home" },
      awayTeam: { id: 20, name: "Away" },
      homeInjuries: [{
        playerId: 201,
        name: "Detected Reliever",
        position: "RP",
        status: "Out",
        isPitcher: true,
        source: "BDL",
        shadow: {
          decision: "APPLY_CANDIDATE",
          confidence: "HIGH",
          impact: "MEDIUM",
          reasonCode: "OFFICIAL_IL_HIGH_LEVERAGE_RELIEVER",
          reason: "existing detector path",
          shadowOnly: true,
        },
      }],
      awayInjuries: [],
      homeInjuryData: meta,
      awayInjuryData: {
        ...partialMeta({ status: "VERIFIED", rejectedCount: 0 }),
        shadowSummary: { ...partialMeta().shadowSummary, officialOnly: 0 },
        phaseB: { ...partialMeta().phaseB, coverage: "FULL" },
      },
    }],
  };
}

test("eligible official-only gap becomes VERIFIED with evidence-only supplements and unchanged Phase B", async () => {
  const body = payload();
  const beforePhaseB = JSON.stringify(body.games[0].homeInjuryData.phaseB);
  let calls = 0;
  await supplementMlbAllOfficialInjuryEvidence(body, "2026-08-09", async (teamId) => {
    calls += 1;
    assert.equal(teamId, 10);
    return officialSnapshot([201, 301, 302]);
  });

  const game = body.games[0];
  const meta = game.homeInjuryData as any;
  assert.equal(calls, 1);
  assert.equal(meta.status, "VERIFIED");
  assert.equal(meta.officialSupplementedCount, 2);
  assert.equal(meta.unresolvedOfficialOnlyCount, 0);
  assert.equal(meta.coverageReconciled, true);
  assert.equal(meta.coverageMode, "BDL_PLUS_MLB_OFFICIAL_SUPPLEMENT");
  assert.equal(meta.supplementSchemaVersion, MLB_OFFICIAL_INJURY_SUPPLEMENT_SCHEMA);
  assert.equal(meta.supplementEvidenceOnly, true);
  assert.equal(meta.count, 3);
  assert.equal(JSON.stringify(meta.phaseB), beforePhaseB);
  assert.equal(meta.autoApplyAllowed, true);
  assert.deepEqual(meta.phaseB.eligiblePlayerNames, ["Detected Reliever"]);
  assert.equal(game.homeInjuries.length, 3);
  const supplements = game.homeInjuries.filter((player: any) => player.source === "MLB_STATS_OFFICIAL_SUPPLEMENT");
  assert.deepEqual(supplements.map((player: any) => player.playerId), [301, 302]);
  assert.ok(supplements.every((player: any) => player.shadow.decision === "PENDING"));
  assert.ok(supplements.every((player: any) => player.shadow.impact === "NONE"));
  assert.ok(supplements.every((player: any) => !meta.phaseB.eligiblePlayerNames.includes(player.name)));
});

test("rejected external identity remains PARTIAL and official snapshot is not requested", async () => {
  const body = payload(partialMeta({ rejectedCount: 1 }));
  let calls = 0;
  await supplementMlbAllOfficialInjuryEvidence(body, "2026-08-09", async () => {
    calls += 1;
    return officialSnapshot([201, 301, 302]);
  });

  assert.equal(calls, 0);
  assert.equal(body.games[0].homeInjuryData.status, "PARTIAL");
  assert.equal(body.games[0].homeInjuries.length, 1);
});

test("unknown detector or validator source remains fail-closed", async () => {
  for (const meta of [
    partialMeta({ source: "OTHER_PROVIDER" }),
    partialMeta({ validationSource: "OTHER_VALIDATOR" }),
  ]) {
    const body = payload(meta);
    let calls = 0;
    await supplementMlbAllOfficialInjuryEvidence(body, "2026-08-09", async () => {
      calls += 1;
      return officialSnapshot([201, 301, 302]);
    });
    assert.equal(calls, 0);
    assert.equal(body.games[0].homeInjuryData.status, "PARTIAL");
    assert.equal(body.games[0].homeInjuries.length, 1);
  }
});

test("blocked or unhealthy Phase B source remains PARTIAL", async () => {
  const meta = partialMeta({
    phaseB: { ...partialMeta().phaseB, coverage: "BLOCKED" },
  });
  const body = payload(meta);
  let calls = 0;
  await supplementMlbAllOfficialInjuryEvidence(body, "2026-08-09", async () => {
    calls += 1;
    return officialSnapshot([201, 301, 302]);
  });

  assert.equal(calls, 0);
  assert.equal(body.games[0].homeInjuryData.status, "PARTIAL");
});

test("official-only count mismatch fails closed and preserves original response", async () => {
  const body = payload();
  await supplementMlbAllOfficialInjuryEvidence(body, "2026-08-09", async () =>
    officialSnapshot([201, 301])
  );

  const meta = body.games[0].homeInjuryData as any;
  assert.equal(meta.status, "PARTIAL");
  assert.equal(meta.officialSupplementedCount, undefined);
  assert.equal(body.games[0].homeInjuries.length, 1);
});

test("official source error fails closed", async () => {
  const body = payload();
  await supplementMlbAllOfficialInjuryEvidence(body, "2026-08-09", async () => {
    throw new Error("official unavailable");
  });

  assert.equal(body.games[0].homeInjuryData.status, "PARTIAL");
  assert.equal(body.games[0].homeInjuries.length, 1);
});

test("invalid date never attempts supplementation", async () => {
  const body = payload();
  let calls = 0;
  await supplementMlbAllOfficialInjuryEvidence(body, "not-a-date", async () => {
    calls += 1;
    return officialSnapshot([201, 301, 302]);
  });
  assert.equal(calls, 0);
  assert.equal(body.games[0].homeInjuryData.status, "PARTIAL");
});

test("Express middleware asynchronously decorates one downstream JSON response exactly once", async () => {
  const app = express();
  let officialCalls = 0;
  let downstreamCalls = 0;
  registerMlbOfficialInjurySupplementMiddleware(app, async (teamId, date) => {
    officialCalls += 1;
    assert.equal(teamId, 10);
    assert.equal(date, "2026-08-09");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return officialSnapshot([201, 301, 302]);
  });
  app.get("/api/mlb/all", (_req, res) => {
    downstreamCalls += 1;
    return res.json(payload());
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/mlb/all?date=2026-08-09`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(downstreamCalls, 1);
    assert.equal(officialCalls, 1);
    assert.equal(body.games[0].homeInjuryData.status, "VERIFIED");
    assert.equal(body.games[0].homeInjuryData.officialSupplementedCount, 2);
    assert.equal(body.games[0].homeInjuries.length, 3);
    assert.equal(body.researchInjuryIdentityDiagnostic, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("aggregate diagnostic is opt-in on existing MLB all route and returns no identity material", async () => {
  const app = express();
  let diagnosticCalls = 0;
  registerMlbOfficialInjurySupplementMiddleware(
    app,
    async () => officialSnapshot([201, 301, 302]),
    async (input) => {
      diagnosticCalls += 1;
      assert.equal(input.asOfDate, "2026-08-09");
      assert.equal(input.season, "2026");
      assert.equal(input.bdlKey, "secret-test");
      return {
        schemaVersion: MLB_INJURY_IDENTITY_DIAGNOSTIC_SCHEMA,
        asOfDate: input.asOfDate,
        season: input.season,
        privacy: {
          aggregateOnly: true,
          playerNamesReturned: false,
          playerIdsReturned: false,
          credentialReturned: false,
        },
        source: {
          bdlPages: 1,
          bdlTotalRecords: 40,
          activeMappedBeforeDedupe: 30,
          activeMappedAfterDedupe: 28,
          teamsWithActiveRecords: 17,
        },
        strictResolver: {
          resolved: 10,
          rejected: 18,
          rejectionReasons: {
            MISSING_NAME: 0,
            SEARCH_TRANSPORT_FAILURE: 0,
            SEARCH_EMPTY: 2,
            EXACT_NAME_NOT_FOUND: 1,
            EXACT_NAME_NO_CURRENT_TEAM: 7,
            EXACT_NAME_WRONG_CURRENT_TEAM: 8,
            STATS_ENRICHMENT_FAILURE: 0,
          },
        },
        officialAuthority: {
          rejectedEvaluated: 18,
          uniqueRosterExactName: 10,
          uniqueRosterIlExactName: 8,
          uniqueRosterNonIlExactName: 2,
          uniqueTransactionExactNameOnly: 3,
          ambiguousOfficialExactName: 1,
          noOfficialExactName: 4,
          authorityUnavailable: 0,
          safelyResolvableIdentityTotal: 13,
          remainingUnresolved: 5,
        },
      };
    },
    () => "secret-test",
  );
  app.get("/api/mlb/all", (_req, res) => res.json(payload()));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/mlb/all?date=2026-08-09&researchInjuryIdentityDiagnostic=${MLB_INJURY_IDENTITY_DIAGNOSTIC_QUERY}`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = await response.json() as any;
    assert.equal(diagnosticCalls, 1);
    assert.equal(body.researchInjuryIdentityDiagnostic.strictResolver.rejected, 18);
    assert.equal(body.researchInjuryIdentityDiagnostic.officialAuthority.safelyResolvableIdentityTotal, 13);
    const diagnosticJson = JSON.stringify(body.researchInjuryIdentityDiagnostic);
    assert.equal(diagnosticJson.includes("secret-test"), false);
    assert.equal(diagnosticJson.includes('"playerId":'), false);
    assert.equal(diagnosticJson.includes('"playerName":'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  MLB_INJURY_IDENTITY_DIAGNOSTIC_QUERY,
  MLB_OFFICIAL_INJURY_SUPPLEMENT_SCHEMA,
  MLB_REJECTED_IDENTITY_RECONCILIATION_SCHEMA,
  buildMlbRejectedIdentityReconciliationReport,
  registerMlbOfficialInjurySupplementMiddleware,
  supplementMlbAllOfficialInjuryEvidence,
  type MlbRejectedIdentityReconciliationReport,
} from "./mlb-injury-official-supplement-routes";
import {
  MLB_INJURY_IDENTITY_DIAGNOSTIC_SCHEMA,
  MLB_REJECTED_IDENTITY_RECONCILIATION_MODE,
  MLB_REJECTED_IDENTITY_RECONCILIATION_REASON,
} from "./mlb-injury-official-supplement";
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

function namedOfficialSnapshot(entries: Array<{
  id: number;
  name: string;
  statusCode?: string;
  statusDescription?: string;
  position?: string;
}>, transactionOnly: Array<{ id: number; name: string }> = []): MlbOfficialInjurySnapshot {
  return {
    status: "VERIFIED",
    source: "MLB_STATS",
    fetchedAt: "2026-08-10T16:00:00.000Z",
    errors: [],
    rosterByPlayerId: Object.fromEntries(entries.map((entry) => [entry.id, {
      playerId: entry.id,
      name: entry.name,
      statusCode: entry.statusCode ?? "D10",
      statusDescription: entry.statusDescription ?? "10-Day Injured List",
      position: entry.position ?? "OF",
    }])),
    latestTransactionByPlayerId: Object.fromEntries(transactionOnly.map((entry) => [entry.id, {
      effectiveDate: "2026-08-09",
      typeDesc: "Placed on Injured List",
      description: `${entry.name} placed on injured list`,
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

function reconciliationReport(teamId: number, expectedRejectedCount: number, reconciled = expectedRejectedCount): MlbRejectedIdentityReconciliationReport {
  const unresolved = Math.max(0, expectedRejectedCount - reconciled);
  return {
    schemaVersion: MLB_REJECTED_IDENTITY_RECONCILIATION_SCHEMA,
    asOfDate: "2026-08-09",
    privacy: {
      aggregateOnly: true,
      playerNamesReturned: false,
      playerIdsReturned: false,
      credentialReturned: false,
    },
    byTeam: {
      [teamId]: {
        expectedRejectedCount,
        observedMissingCount: expectedRejectedCount,
        exactWrongCurrentTeamCount: reconciled,
        officialIlReconciledCount: reconciled,
        unresolvedRejectedCount: unresolved,
        countParity: true,
        sourceHealthy: true,
        eligible: expectedRejectedCount > 0 && unresolved === 0,
      },
    },
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

test("fully reconciled raw rejects can close coverage only as evidence while raw count and Phase B remain unchanged", async () => {
  const body = payload(partialMeta({ rejectedCount: 2 }));
  const beforePhaseB = JSON.stringify(body.games[0].homeInjuryData.phaseB);
  await supplementMlbAllOfficialInjuryEvidence(
    body,
    "2026-08-09",
    async () => officialSnapshot([201, 301, 302]),
    reconciliationReport(10, 2),
  );

  const game = body.games[0];
  const meta = game.homeInjuryData as any;
  assert.equal(meta.status, "VERIFIED");
  assert.equal(meta.rejectedCount, 2);
  assert.equal(meta.rejectedIdentityReconciledCount, 2);
  assert.equal(meta.unresolvedRejectedIdentityCount, 0);
  assert.equal(meta.rejectedIdentityReconciliationMode, MLB_REJECTED_IDENTITY_RECONCILIATION_MODE);
  assert.equal(meta.rejectedIdentityReconciliationReason, MLB_REJECTED_IDENTITY_RECONCILIATION_REASON);
  assert.equal(meta.rejectedIdentityReconciliationEvidenceOnly, true);
  assert.equal(meta.officialSupplementedCount, 2);
  assert.equal(meta.supplementEvidenceOnly, true);
  assert.equal(JSON.stringify(meta.phaseB), beforePhaseB);
  assert.deepEqual(meta.phaseB.eligiblePlayerNames, ["Detected Reliever"]);
  assert.equal(game.homeInjuries.length, 3);
});

test("rejected external identity without a validated reconciliation report remains PARTIAL and official snapshot is not requested", async () => {
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

test("partially reconciled rejected identities remain PARTIAL", async () => {
  const body = payload(partialMeta({ rejectedCount: 2 }));
  let calls = 0;
  await supplementMlbAllOfficialInjuryEvidence(
    body,
    "2026-08-09",
    async () => {
      calls += 1;
      return officialSnapshot([201, 301, 302]);
    },
    reconciliationReport(10, 2, 1),
  );
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bdlInjury(id: number, name: string) {
  const [first_name, ...rest] = name.split(" ");
  return {
    status: "10-day IL",
    player: {
      id,
      first_name,
      last_name: rest.join(" "),
      full_name: name,
      position: "OF",
      team: { abbreviation: "NYY" },
    },
  };
}

test("reconciliation builder proves exact missing-count parity, wrong currentTeam, and unique official IL authority", async () => {
  const snapshot = namedOfficialSnapshot([
    { id: 501, name: "Rejected One", statusCode: "D10" },
    { id: 502, name: "Rejected Two", statusCode: "D60", statusDescription: "60-Day Injured List" },
  ]);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.balldontlie.io/mlb/v1/player_injuries")) {
      assert.equal((init?.headers as Record<string, string>)?.Authorization, "secret-test");
      return jsonResponse({
        data: [
          bdlInjury(1, "Detected Reliever"),
          bdlInjury(2, "Rejected One"),
          bdlInjury(3, "Rejected Two"),
        ],
        meta: { next_cursor: null },
      });
    }
    if (url.includes("/people/search?")) {
      const name = new URL(url).searchParams.get("names");
      if (name === "Rejected One") {
        return jsonResponse({ people: [{ id: 601, fullName: "Rejected One", currentTeam: { id: 111 } }] });
      }
      if (name === "Rejected Two") {
        return jsonResponse({ people: [{ id: 602, fullName: "Rejected Two", currentTeam: { id: 121 } }] });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;

  const report = await buildMlbRejectedIdentityReconciliationReport({
    asOfDate: "2026-08-10",
    season: "2026",
    bdlKey: "secret-test",
    targets: [{ teamId: 147, expectedRejectedCount: 2, existingDetectedNames: ["Detected Reliever"] }],
    fetchOfficialSnapshot: async (teamId) => {
      assert.equal(teamId, 147);
      return snapshot;
    },
    fetchImpl,
  });

  const team = report.byTeam[147];
  assert.equal(team.expectedRejectedCount, 2);
  assert.equal(team.observedMissingCount, 2);
  assert.equal(team.countParity, true);
  assert.equal(team.sourceHealthy, true);
  assert.equal(team.exactWrongCurrentTeamCount, 2);
  assert.equal(team.officialIlReconciledCount, 2);
  assert.equal(team.unresolvedRejectedCount, 0);
  assert.equal(team.eligible, true);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("Detected Reliever"), false);
  assert.equal(serialized.includes("Rejected One"), false);
  assert.equal(serialized.includes("Rejected Two"), false);
  assert.equal(serialized.includes("secret-test"), false);
});

test("same-team people/search result cannot be relabeled as wrong-current-team rescue", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.balldontlie.io")) {
      return jsonResponse({ data: [bdlInjury(2, "Rejected One")], meta: { next_cursor: null } });
    }
    if (url.includes("/people/search?")) {
      return jsonResponse({ people: [{ id: 601, fullName: "Rejected One", currentTeam: { id: 147 } }] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  const report = await buildMlbRejectedIdentityReconciliationReport({
    asOfDate: "2026-08-10",
    season: "2026",
    bdlKey: "secret-test",
    targets: [{ teamId: 147, expectedRejectedCount: 1, existingDetectedNames: [] }],
    fetchOfficialSnapshot: async () => namedOfficialSnapshot([{ id: 501, name: "Rejected One" }]),
    fetchImpl,
  });
  assert.equal(report.byTeam[147].exactWrongCurrentTeamCount, 0);
  assert.equal(report.byTeam[147].officialIlReconciledCount, 0);
  assert.equal(report.byTeam[147].unresolvedRejectedCount, 1);
  assert.equal(report.byTeam[147].eligible, false);
});

test("transaction-only or active-roster authority cannot rescue a rejected identity", async () => {
  for (const official of [
    namedOfficialSnapshot([], [{ id: 501, name: "Rejected One" }]),
    namedOfficialSnapshot([{ id: 501, name: "Rejected One", statusCode: "A", statusDescription: "Active" }]),
  ]) {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.balldontlie.io")) {
        return jsonResponse({ data: [bdlInjury(2, "Rejected One")], meta: { next_cursor: null } });
      }
      if (url.includes("/people/search?")) {
        return jsonResponse({ people: [{ id: 601, fullName: "Rejected One", currentTeam: { id: 111 } }] });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;
    const report = await buildMlbRejectedIdentityReconciliationReport({
      asOfDate: "2026-08-10",
      season: "2026",
      bdlKey: "secret-test",
      targets: [{ teamId: 147, expectedRejectedCount: 1, existingDetectedNames: [] }],
      fetchOfficialSnapshot: async () => official,
      fetchImpl,
    });
    assert.equal(report.byTeam[147].exactWrongCurrentTeamCount, 1);
    assert.equal(report.byTeam[147].officialIlReconciledCount, 0);
    assert.equal(report.byTeam[147].eligible, false);
  }
});

test("missing-count mismatch fails closed before official authority is used", async () => {
  let officialCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.balldontlie.io")) {
      return jsonResponse({ data: [bdlInjury(2, "Rejected One")], meta: { next_cursor: null } });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  const report = await buildMlbRejectedIdentityReconciliationReport({
    asOfDate: "2026-08-10",
    season: "2026",
    bdlKey: "secret-test",
    targets: [{ teamId: 147, expectedRejectedCount: 2, existingDetectedNames: [] }],
    fetchOfficialSnapshot: async () => {
      officialCalls += 1;
      return namedOfficialSnapshot([{ id: 501, name: "Rejected One" }]);
    },
    fetchImpl,
  });
  assert.equal(officialCalls, 0);
  assert.equal(report.byTeam[147].countParity, false);
  assert.equal(report.byTeam[147].observedMissingCount, 1);
  assert.equal(report.byTeam[147].unresolvedRejectedCount, 2);
  assert.equal(report.byTeam[147].eligible, false);
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

test("middleware builds rejected-identity reconciliation once per cached evidence key and preserves raw reject audit", async () => {
  const app = express();
  let officialCalls = 0;
  let reconciliationCalls = 0;
  registerMlbOfficialInjurySupplementMiddleware(
    app,
    async () => {
      officialCalls += 1;
      return officialSnapshot([201, 301, 302]);
    },
    async () => { throw new Error("diagnostic should not run"); },
    () => "secret-test",
    async (input) => {
      reconciliationCalls += 1;
      assert.equal(input.asOfDate, "2026-08-09");
      assert.equal(input.season, "2026");
      assert.equal(input.bdlKey, "secret-test");
      assert.equal(input.targets.length, 1);
      assert.equal(input.targets[0].teamId, 10);
      assert.equal(input.targets[0].expectedRejectedCount, 2);
      assert.deepEqual(input.targets[0].existingDetectedNames, ["detectedreliever"]);
      return reconciliationReport(10, 2);
    },
  );
  app.get("/api/mlb/all", (_req, res) => res.json(payload(partialMeta({ rejectedCount: 2 }))));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/mlb/all?date=2026-08-09`);
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.games[0].homeInjuryData.status, "VERIFIED");
      assert.equal(body.games[0].homeInjuryData.rejectedCount, 2);
      assert.equal(body.games[0].homeInjuryData.rejectedIdentityReconciledCount, 2);
      assert.equal(body.games[0].homeInjuryData.unresolvedRejectedIdentityCount, 0);
      assert.equal(body.games[0].homeInjuryData.rejectedIdentityReconciliationEvidenceOnly, true);
    }
    assert.equal(reconciliationCalls, 1);
    assert.equal(officialCalls, 1);
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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbSelectiveOddsSqliteCoordinator } from "./mlb-selective-odds-sqlite-coordinator";

function tempDb(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-odds-coordinator-"));
  return { dir, file: path.join(dir, "coordinator.sqlite") };
}

function completedResult(runId: string): any {
  return {
    schemaVersion: "courtedge-p0-mlb-selective-odds-acquisition.v6",
    generatedAt: "2026-08-13T18:00:00.000Z",
    runId,
    date: "2026-08-13",
    sourceMarketDiscoverySchemaVersion: "test",
    status: "NO_PAID_WORK",
    stopReason: null,
    games: [],
    budget: null,
    providerCalls: { zeroCostEventsProbe: 0, paidEventOdds: 0, eventMarkets: 0, sportOdds: 0 },
    summary: {
      discoveryGames: 0,
      paidLookupEligibleGames: 0,
      fetchedGames: 0,
      cacheOnlyGames: 0,
      unresolvedEventGames: 0,
      heldGames: 0,
      blockedGames: 0,
      requestedPaidMarketKeys: 0,
      reusedFreshMarketKeys: 0,
      usableMarketQuotes: 0,
    },
    policy: {},
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

test("run journal is durable across coordinator instances and replays completed results", async () => {
  const { dir, file } = tempDb();
  const a = new MlbSelectiveOddsSqliteCoordinator({ filename: file });
  const b = new MlbSelectiveOddsSqliteCoordinator({ filename: file });
  try {
    const policy = { nowMs: 1_000, expiresAtMs: 100_000, maxRunEntries: 10 };
    const admitted = await a.beginRun("acct", "run-1", "fp-1", policy);
    assert.equal(admitted.status, "ADMITTED");

    const seenBySecond = await b.beginRun("acct", "run-1", "fp-1", policy);
    assert.equal(seenBySecond.status, "IN_PROGRESS");

    const completed = {
      state: "COMPLETED" as const,
      fingerprint: "fp-1",
      expiresAtMs: 100_000,
      result: completedResult("run-1"),
    };
    await a.completeRun("acct", "run-1", "fp-1", completed as any);

    const replay = await b.beginRun("acct", "run-1", "fp-1", policy);
    assert.equal(replay.status, "COMPLETED");
    if (replay.status === "COMPLETED") assert.equal(replay.record.result.runId, "run-1");
  } finally {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run journal refuses admission when unexpired capacity is exhausted", async () => {
  const { dir, file } = tempDb();
  const coordinator = new MlbSelectiveOddsSqliteCoordinator({ filename: file });
  try {
    const first = await coordinator.beginRun("acct", "run-1", "fp-1", {
      nowMs: 1_000,
      expiresAtMs: 100_000,
      maxRunEntries: 1,
    });
    assert.equal(first.status, "ADMITTED");
    const second = await coordinator.beginRun("acct", "run-2", "fp-2", {
      nowMs: 1_001,
      expiresAtMs: 100_001,
      maxRunEntries: 1,
    });
    assert.equal(second.status, "CAPACITY_EXHAUSTED");
  } finally {
    coordinator.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("expired run journal entries are pruned before capacity admission", async () => {
  const { dir, file } = tempDb();
  const coordinator = new MlbSelectiveOddsSqliteCoordinator({ filename: file });
  try {
    assert.equal((await coordinator.beginRun("acct", "expired", "fp-old", {
      nowMs: 1_000,
      expiresAtMs: 2_000,
      maxRunEntries: 1,
    })).status, "ADMITTED");

    assert.equal((await coordinator.beginRun("acct", "fresh", "fp-new", {
      nowMs: 3_000,
      expiresAtMs: 10_000,
      maxRunEntries: 1,
    })).status, "ADMITTED");
  } finally {
    coordinator.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("event cache persists across instances and pruning keeps newest bounded entries", async () => {
  const { dir, file } = tempDb();
  const a = new MlbSelectiveOddsSqliteCoordinator({ filename: file });
  const b = new MlbSelectiveOddsSqliteCoordinator({ filename: file });
  try {
    await a.putEventCache("acct", "evt-1", {
      eventId: "evt-1",
      providerEvent: { id: "evt-1", bookmakers: [] },
      marketFetchedAtMs: { h2h: 1_000 },
      updatedAtMs: 1_000,
    });
    const persisted = await b.getEventCache("acct", "evt-1");
    assert.equal(persisted?.providerEvent.id, "evt-1");
    assert.equal(persisted?.marketFetchedAtMs.h2h, 1_000);

    await a.putEventCache("acct", "evt-2", {
      eventId: "evt-2",
      providerEvent: { id: "evt-2" },
      marketFetchedAtMs: { h2h: 2_000 },
      updatedAtMs: 2_000,
    });
    await a.putEventCache("acct", "evt-3", {
      eventId: "evt-3",
      providerEvent: { id: "evt-3" },
      marketFetchedAtMs: { h2h: 3_000 },
      updatedAtMs: 3_000,
    });
    await b.pruneEventCache("acct", { nowMs: 3_500, eventCacheTtlMs: 10_000, maxEventEntries: 2 });
    assert.equal(await a.getEventCache("acct", "evt-1"), null);
    assert.equal((await a.getEventCache("acct", "evt-2"))?.eventId, "evt-2");
    assert.equal((await a.getEventCache("acct", "evt-3"))?.eventId, "evt-3");
  } finally {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runExclusive serializes two coordinator instances sharing one SQLite file", async () => {
  const { dir, file } = tempDb();
  const a = new MlbSelectiveOddsSqliteCoordinator({ filename: file, lockPollMs: 5, lockWaitMs: 2_000 });
  const b = new MlbSelectiveOddsSqliteCoordinator({ filename: file, lockPollMs: 5, lockWaitMs: 2_000 });
  const order: string[] = [];
  try {
    const first = a.runExclusive("acct", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push("a-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = b.runExclusive("acct", async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  } finally {
    a.close();
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

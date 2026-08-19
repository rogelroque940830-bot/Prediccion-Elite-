import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { MlbV68ProspectiveStateLiveAdapter } from "../server/mlb-v68-prospective-state-live-adapter";

const DATE = "2026-08-19";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
  }
  throw new Error(`UNSUPPORTED_CANONICAL_VALUE:${typeof value}`);
}

function signedState() {
  const unsigned = {
    schemaVersion: "courtedge-p0-step12v68-prospective-state.v1",
    targetOfficialDate: DATE,
    chronology: {
      historyStrictlyBeforeTargetDate: true,
      wholeOfficialDatePriorStateOnly: true,
      sameDateOutcomesUsed: false,
      latestHistoricalOfficialDate: "2026-08-18",
    },
    c4: { teams: {} },
    v39: {
      pitchers: {},
      league: { starts: 1, bf: 1, outs: 1, pitches: 1, k: 1, bb: 0, er: 0, recent: [] },
      opponents: {},
      previousCompleteLineup: {},
    },
    v62: {
      pitchers: {},
      leagueByPitchType: {},
      lookbackDays: 365,
      pitchGamesInWindow: 123,
    },
    policy: {
      researchOnly: true,
      containsTargetOutcomes: false,
      containsMarketPrices: false,
      productionChanged: false,
      betEliteAllowed: false,
      realFinancialExposure: 0,
    },
  };
  const stateDigest = createHash("sha256").update(canonical(unsigned), "utf8").digest("hex");
  return { ...unsigned, stateDigest };
}

function githubPayload(state: unknown) {
  const text = JSON.stringify(state, null, 2) + "\n";
  return {
    encoding: "base64",
    content: Buffer.from(text, "utf8").toString("base64"),
  };
}

function adapterFor(state: unknown) {
  return new MlbV68ProspectiveStateLiveAdapter({
    fetchImpl: async () => new Response(JSON.stringify(githubPayload(state)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
}

{
  const state = signedState();
  const loaded = await adapterFor(state).loadState(DATE);
  assert.equal(loaded.stateDigest, state.stateDigest);
}

{
  const state = signedState();
  const tampered = {
    ...state,
    v62: {
      ...state.v62,
      pitchGamesInWindow: state.v62.pitchGamesInWindow + 1,
    },
  };
  await assert.rejects(
    () => adapterFor(tampered).loadState(DATE),
    /V68_LIVE_STATE_DIGEST_MISMATCH/,
  );
}

console.log("MLB_V68_PROSPECTIVE_STATE_LIVE_ADAPTER_V1_TESTS_PASSED");
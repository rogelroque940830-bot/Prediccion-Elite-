import assert from "node:assert/strict";
import test from "node:test";
import { MlbUnifiedEliteProspectiveCustodyStore } from "../server/mlb-unified-elite-prospective-custody-v1";
import { MlbUnifiedEliteProspectiveCaptureService } from "../server/mlb-unified-elite-prospective-capture-service-v1";
import type { MlbP1DailySlate, MlbP1SlateGame } from "../server/mlb-p1-daily-slate";

const DATE = "2026-08-20";
const NOW = new Date("2026-08-20T12:00:00.000Z");

function game(overrides: Partial<MlbP1SlateGame> = {}): MlbP1SlateGame {
  return {
    gamePk: 910001,
    startTime: "2026-08-20T23:00:00.000Z",
    officialDate: DATE,
    venue: "Test Park",
    state: "SCHEDULED",
    detailedState: "Scheduled",
    homeTeam: { id: 1, name: "Home" },
    awayTeam: { id: 2, name: "Away" },
    homePitcher: { id: 101, name: "Home SP", hand: "R", confirmed: true },
    awayPitcher: { id: 102, name: "Away SP", hand: "L", confirmed: true },
    lineupState: "NOT_POSTED",
    homeLineupCount: 0,
    awayLineupCount: 0,
    readiness: "PROVISIONAL_WAITING_FOR_LINEUPS",
    analysisStage: "PROVISIONAL",
    analysisAllowed: true,
    blockers: [],
    source: { name: "MLB_STATS_API", fetchedAt: NOW.toISOString(), quality: "AUTHORITATIVE" },
    ...overrides,
  };
}

function slate(games: MlbP1SlateGame[]): MlbP1DailySlate {
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: DATE,
    generatedAt: NOW.toISOString(),
    games,
    summary: {
      total: games.length,
      ready: 0,
      provisional: games.length,
      waitingForPitchers: 0,
      startedOrClosed: 0,
      dataInsufficient: 0,
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

test("empty successful slate is retryable and does not freeze date eligibility", async () => {
  const custody = new MlbUnifiedEliteProspectiveCustodyStore({ filename: ":memory:" });
  const service = new MlbUnifiedEliteProspectiveCaptureService({ custody, now: () => NOW });
  try {
    await assert.rejects(
      service.captureSlate({ officialDate: DATE, slate: slate([]), now: NOW }),
      /SLATE_EMPTY_RETRY/,
    );
    assert.equal(custody.getDateState(DATE), null);
  } finally {
    service.close();
    custody.close();
  }
});

test("one malformed scheduled game is retryable and cannot be omitted from completeness", async () => {
  const custody = new MlbUnifiedEliteProspectiveCustodyStore({ filename: ":memory:" });
  const service = new MlbUnifiedEliteProspectiveCaptureService({ custody, now: () => NOW });
  const malformed = game({ gamePk: 910002, startTime: null });
  try {
    await assert.rejects(
      service.captureSlate({ officialDate: DATE, slate: slate([game(), malformed]), now: NOW }),
      /SCHEDULE_IDENTITY_RETRY:910002/,
    );
    assert.equal(custody.getDateState(DATE), null);
  } finally {
    service.close();
    custody.close();
  }
});

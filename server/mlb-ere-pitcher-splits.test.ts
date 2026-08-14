import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseMlbPitcherInningSplits,
  eraFromOuts,
  inningsDecimalFromOuts,
  mlbIpToOuts,
  outsToMlbIpNumber,
} from "./mlb-ere-pitcher-splits.js";

function row(code: string, teamId: number | null, ip: string, er: number, extra: Record<string, number> = {}) {
  return {
    split: { code },
    team: teamId ? { id: teamId } : undefined,
    stat: {
      inningsPitched: ip,
      earnedRuns: er,
      runs: extra.runs ?? er,
      hits: extra.hits ?? 0,
      baseOnBalls: extra.bb ?? 0,
      strikeOuts: extra.k ?? 0,
      homeRuns: extra.hr ?? 0,
      gamesPlayed: extra.gp ?? 0,
    },
  };
}

test("MLB innings notation converts to outs instead of decimal innings", () => {
  assert.equal(mlbIpToOuts("8.1"), 25);
  assert.equal(mlbIpToOuts("5.2"), 17);
  assert.equal(mlbIpToOuts("10.0"), 30);
  assert.equal(mlbIpToOuts("4.3"), 0);
  assert.equal(outsToMlbIpNumber(25), 8.1);
  assert.equal(inningsDecimalFromOuts(25), 25 / 3);
});

test("Clay Holmes team switch: valid Mets + Cubs i01 data cannot be overwritten by trailing 0-IP aggregate", () => {
  const collapsed = collapseMlbPitcherInningSplits([
    row("i01", 121, "9.0", 2, { hits: 3, bb: 5, k: 7, gp: 9 }),
    row("i01", 112, "1.0", 1, { hits: 1, bb: 0, k: 0, hr: 1, gp: 1 }),
    row("i01", null, "0.0", 0, { hits: 4, bb: 5, k: 7, hr: 1, gp: 10 }),
  ]);

  assert.deepEqual(collapsed.i01.sourceTeamIds, [112, 121]);
  assert.equal(collapsed.i01.provenance, "TEAM_ROWS");
  assert.equal(collapsed.i01.sourceRowCount, 2);
  assert.equal(collapsed.i01.outs, 30);
  assert.equal(collapsed.i01.inningsPitched, 10);
  assert.equal(collapsed.i01.earnedRuns, 3);
  assert.equal(collapsed.i01.hits, 4);
  assert.equal(collapsed.i01.baseOnBalls, 5);
  assert.equal(collapsed.i01.gamesPlayed, 10);
  assert.equal(eraFromOuts(collapsed.i01.earnedRuns, collapsed.i01.outs), 2.7);
});

test("8.1 MLB innings produces the correct 1.08 ERA rather than parseFloat 1.11", () => {
  const collapsed = collapseMlbPitcherInningSplits([
    row("i05", 121, "8.1", 1, { gp: 9 }),
  ]);
  assert.equal(collapsed.i05.outs, 25);
  assert.equal(eraFromOuts(collapsed.i05.earnedRuns, collapsed.i05.outs), 1.08);
});

test("no-team positive-IP row is a deterministic fallback when team-scoped custody is absent", () => {
  const collapsed = collapseMlbPitcherInningSplits([
    row("i02", null, "7.2", 2, { gp: 8 }),
    row("i02", null, "0.0", 0, { gp: 8 }),
  ]);
  assert.equal(collapsed.i02.provenance, "AGGREGATE_FALLBACK");
  assert.equal(collapsed.i02.outs, 23);
  assert.equal(collapsed.i02.earnedRuns, 2);
});

test("zero-out inning remains zero coverage and cannot manufacture an ERA", () => {
  const collapsed = collapseMlbPitcherInningSplits([
    row("i08", null, "0.0", 0, { gp: 2 }),
  ]);
  assert.equal(collapsed.i08.outs, 0);
  assert.equal(eraFromOuts(collapsed.i08.earnedRuns, collapsed.i08.outs), null);
});

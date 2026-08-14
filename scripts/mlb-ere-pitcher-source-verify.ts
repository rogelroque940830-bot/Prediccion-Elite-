import assert from "node:assert/strict";

import {
  collapseMlbPitcherInningSplits,
  eraFromOuts,
} from "../server/mlb-ere-pitcher-splits.js";

const pitcherId = Number(process.env.PITCHER_ID || 605280);
const season = Number(process.env.SEASON || 2026);
const codes = ["i01", "i02", "i03", "i04", "i05", "i06", "i07", "i08", "i09"];
const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&season=${season}&group=pitching&sitCodes=${codes.join(",")}`;

const response = await fetch(url, {
  headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge-Source-Verify/1.0)" },
});
assert.equal(response.ok, true, `official MLB split request failed: ${response.status}`);
const payload: any = await response.json();
const rows = payload?.stats?.[0]?.splits ?? [];
assert.ok(rows.length > 0, "official MLB split source returned no rows");

const collapsed = collapseMlbPitcherInningSplits(rows);
for (const code of ["i01", "i02", "i03", "i04", "i05"]) {
  assert.ok(collapsed[code], `${code} missing after authoritative collapse`);
  assert.ok(collapsed[code].outs > 0, `${code} has no real recorded outs after collapse`);
}

// Clay Holmes moved from the Mets (121) to the Cubs (112) in 2026. The source
// currently exposes team-scoped rows plus a no-team aggregate row. The product
// parser must keep additive team custody and must never let the trailing 0-IP
// aggregate erase the real innings.
assert.equal(collapsed.i01.provenance, "TEAM_ROWS");
assert.ok(collapsed.i01.sourceTeamIds.includes(121), "Mets custody missing from Clay Holmes i01");
assert.ok(collapsed.i01.sourceTeamIds.includes(112), "Cubs custody missing from Clay Holmes i01");
assert.ok(collapsed.i01.outs >= 30, `Clay Holmes i01 unexpectedly below 10 IP: ${collapsed.i01.outs} outs`);
assert.ok(collapsed.i05.outs >= 25, `Clay Holmes i05 unexpectedly below 8 1/3 IP: ${collapsed.i05.outs} outs`);

const f5Outs = ["i01", "i02", "i03", "i04", "i05"].reduce(
  (sum, code) => sum + collapsed[code].outs,
  0,
);
assert.ok(f5Outs >= 75, `Clay Holmes F5 source coverage unexpectedly small: ${f5Outs} outs`);

const i01Era = eraFromOuts(collapsed.i01.earnedRuns, collapsed.i01.outs);
assert.notEqual(i01Era, null);
assert.ok((i01Era ?? 0) > 0, `Clay Holmes i01 incorrectly collapsed to a synthetic 0.00 ERA`);

console.log(JSON.stringify({
  schema: "courtedge-mlb-ere-pitcher-source-verify.v1",
  pitcherId,
  season,
  i01: collapsed.i01,
  i05: collapsed.i05,
  f5Outs,
  i01Era,
  verified: true,
}, null, 2));

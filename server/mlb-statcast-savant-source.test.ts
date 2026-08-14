import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSavantPitchArsenalUrl } from "./mlb-statcast-savant-source";

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test("official Savant batter DIRECT URL is inclusive without changing engine evidence thresholds", () => {
  const url = buildSavantPitchArsenalUrl({ role: "batter", year: 2026, coverage: "INCLUSIVE" });
  const search = params(url);

  assert.equal(search.get("type"), "batter");
  assert.equal(search.get("year"), "2026");
  assert.equal(search.get("min"), "1");
  assert.equal(search.get("minPitches"), "1");
  assert.equal(search.get("pitchType"), "");
  assert.equal(search.get("team"), "");
  assert.equal(search.get("csv"), "true");
  assert.equal(search.has("min_pa"), false);
  assert.equal(search.has("min_pitches"), false);
  assert.equal(search.has("pitch_type"), false);
});

test("Qualified proxy and pitcher URLs preserve the Qualified Savant source", () => {
  for (const role of ["batter", "pitcher"] as const) {
    const search = params(buildSavantPitchArsenalUrl({ role, year: 2026, coverage: "QUALIFIED" }));
    assert.equal(search.get("type"), role);
    assert.equal(search.get("min"), "1");
    assert.equal(search.get("minPitches"), "q");
    assert.equal(search.get("pitchType"), "");
  }
});

test("invalid Savant season fails closed", () => {
  assert.throws(
    () => buildSavantPitchArsenalUrl({ role: "batter", year: 0, coverage: "INCLUSIVE" }),
    /SAVANT_PITCH_ARSENAL_YEAR_INVALID/,
  );
});

test("engine isolates inclusive DIRECT acquisition from Qualified TEAM_PROXY acquisition", () => {
  const source = readFileSync(new URL("./mlb-statcast-matchup.ts", import.meta.url), "utf8");

  assert.match(source, /loadBatterArsenalFromSavant\(year, "DIRECT_INCLUSIVE"\)/);
  assert.match(source, /loadBatterArsenalFromSavant\(year, "QUALIFIED_PROXY"\)/);
  assert.match(source, /const data = await loadQualifiedBatterArsenal\(year\);/);
  assert.match(source, /role: "pitcher", year, coverage: "QUALIFIED"/);

  // The source repair must not lower the existing internal evidence rules.
  assert.match(source, /return \{ minPitches: 30, minTeamPa: 50 \}/);
  assert.match(source, /directMatches >= arsenal\.pitches\.length \* 0\.6/);

  // The frozen combined run-delta weights remain untouched.
  assert.match(source, /expectedTeamRunsDelta \?\? 0\) \* 0\.50/);
  assert.match(source, /homeBullpenAvg \* 0\.25/);
  assert.match(source, /awayBullpenAvg \* 0\.25/);

  assert.doesNotMatch(source, /pitch_type=ALL&min_pa=q&min_pitches=q/);
});

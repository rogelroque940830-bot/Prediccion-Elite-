import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPitcherVsTeamCacheKey,
  isMeaningfulPitcherName,
} from "./mlb-pitcher-vs-team";

test("pitcher display names reject symbolic and provisional placeholders", () => {
  assert.equal(isMeaningfulPitcherName("?"), false);
  assert.equal(isMeaningfulPitcherName(" — "), false);
  assert.equal(isMeaningfulPitcherName("Pitcher por confirmar"), false);
  assert.equal(isMeaningfulPitcherName("Pitcher local por confirmar"), false);
  assert.equal(isMeaningfulPitcherName("George Kirby"), true);
  assert.equal(isMeaningfulPitcherName("Kumar Rocker"), true);
});

test("pitcher-vs-team cache identity changes when the real name replaces a placeholder", () => {
  const provisional = buildPitcherVsTeamCacheKey(669923, "?", 140, "Texas Rangers");
  const finalName = buildPitcherVsTeamCacheKey(669923, "George Kirby", 140, "Texas Rangers");
  assert.notEqual(provisional, finalName);
});

test("pitcher-vs-team cache identity ignores harmless case and spacing differences", () => {
  const a = buildPitcherVsTeamCacheKey(677958, "Kumar Rocker", 136, "Seattle Mariners");
  const b = buildPitcherVsTeamCacheKey(677958, "  kumar   rocker ", 136, " seattle mariners ");
  assert.equal(a, b);
});

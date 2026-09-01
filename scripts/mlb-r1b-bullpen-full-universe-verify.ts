#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERIFY_SCHEMA = "courtedge-mlb-r1b-bullpen-full-universe-verification.v1";
const PACK_SCHEMA = "courtedge-mlb-r1b-bullpen-family-pack-row.v1";
const WITNESS_SCHEMA = "courtedge-mlb-r1b-bullpen-full-universe-witness.v1";
const MANIFEST_SCHEMA = "courtedge-mlb-r1b-bullpen-full-universe-season-manifest.v1";
const CONTRACT_SCHEMA = "courtedge-mlb-r1b-bullpen-full-universe-contract.v1";
const SOURCE_VERSION = "courtedge-mlb-r1b-bullpen-full-universe.v1";
const SEASONS = ["2022", "2023", "2024", "2025", "2026_YTD"] as const;
const ALLOWED = new Set([0, 0.15, 0.3, 0.5, 0.7]);

type Identity = { officialDate: string; gamePk: number; side: "HOME"|"AWAY"; market: "FG_ML"|"F5_ML"; horizon: "FULL_GAME"|"EARLY_WINDOW" };

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`BULLPEN_VERIFY_ARG_MISSING:${name}`);
  return process.argv[i + 1];
}
function readJson(file: string): any { return JSON.parse(fs.readFileSync(file, "utf8")); }
function readJsonl(file: string): any[] {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`BULLPEN_VERIFY_BAD_JSONL:${file}:${i + 1}`); }
  });
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
function canonical(value: any): string { return JSON.stringify(stable(value)); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function id(row: any): string { return `${row.officialDate}|${row.gamePk}|${row.side}|${row.market}|${row.horizon}`; }
function gameKey(row: any): string { return `${row.officialDate}|${row.gamePk}`; }
function findUnique(root: string, basename: string): string {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === basename) hits.push(p);
    }
  };
  walk(root);
  if (hits.length !== 1) throw new Error(`BULLPEN_VERIFY_FILE_CARDINALITY:${basename}:${hits.length}`);
  return hits[0];
}
function v16Identities(file: string): Identity[] {
  return readJsonl(file).map((r) => ({ officialDate: String(r.officialDate), gamePk: Number(r.gamePk), side: r.side, market: r.market, horizon: r.horizon }));
}
function assertSetEqual(expected: string[], actual: string[], label: string): void {
  const e = new Set(expected), a = new Set(actual);
  if (e.size !== expected.length || a.size !== actual.length) throw new Error(`BULLPEN_VERIFY_DUPLICATE_IDENTITY:${label}`);
  const missing = [...e].filter((x) => !a.has(x));
  const extra = [...a].filter((x) => !e.has(x));
  if (missing.length || extra.length) throw new Error(`BULLPEN_VERIFY_IDENTITY_MISMATCH:${label}:missing=${missing.length}:extra=${extra.length}`);
}
function fingerprintAdjustment(fp: any): number {
  if (!fp || typeof fp !== "object") throw new Error("BULLPEN_VERIFY_FINGERPRINT_MISSING");
  if (fp.bullpenCompromised === true) return 0.7;
  const closerAvailable = fp.closerAvailable === true;
  const setupAvailable = Number(fp.setupAvailable);
  if (!Number.isInteger(setupAvailable) || setupAvailable < 0) throw new Error("BULLPEN_VERIFY_SETUP_AVAILABLE_INVALID");
  if (!closerAvailable && setupAvailable <= 1) return 0.5;
  if (!closerAvailable) return 0.3;
  if (fp.closer?.availability === "RIESGO") return 0.15;
  return 0;
}
function forbiddenKeyCounts(value: any): { outcome: number; price: number } {
  let outcome = 0, price = 0;
  const visit = (v: any) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    for (const [k, x] of Object.entries(v)) {
      const key = k.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (/(outcome|result|winner|settlement|homewin|finalscore|targetlabel|targetoutcome)/.test(key)) outcome += 1;
      if (/(odds|price|moneylineprice|sportsbook)/.test(key)) price += 1;
      visit(x);
    }
  };
  visit(value);
  return { outcome, price };
}

function verifySide(side: any, pack: any, counters: any): void {
  const dateFp = side?.dateFingerprint ?? null;
  const t5Fp = side?.t5Fingerprint ?? null;
  const parity = dateFp != null && t5Fp != null && canonical(dateFp) === canonical(t5Fp);
  if (side?.eligible === true) {
    counters.eligibleFullGameRows += 1;
    if (!parity) throw new Error("BULLPEN_VERIFY_ELIGIBLE_WITHOUT_FINGERPRINT_PARITY");
    if (side.reason !== null) throw new Error("BULLPEN_VERIFY_ELIGIBLE_WITH_REASON");
    const independent = fingerprintAdjustment(dateFp);
    if (!ALLOWED.has(independent) || dateFp.runsAdjustment !== independent || t5Fp.runsAdjustment !== independent || side.runsAdjustment !== independent) {
      throw new Error(`BULLPEN_VERIFY_RUNS_ADJUSTMENT_DRIFT:${independent}:${side.runsAdjustment}`);
    }
    if (pack.feature?.eligible !== true || pack.feature?.values?.runsAdjustment !== independent || pack.feature?.missingnessReason !== null) {
      throw new Error("BULLPEN_VERIFY_PACK_ELIGIBLE_DRIFT");
    }
    counters.recomputedEligibleRows += 1;
  } else {
    counters.missingFullGameRows += 1;
    if (!side?.reason || typeof side.reason !== "string") throw new Error("BULLPEN_VERIFY_MISSINGNESS_NOT_EXPLICIT");
    if (side.runsAdjustment !== null) throw new Error("BULLPEN_VERIFY_MISSINGNESS_CONVERTED_TO_VALUE");
    if (pack.feature?.eligible !== false || pack.feature?.values !== null || pack.feature?.missingnessReason !== side.reason) {
      throw new Error("BULLPEN_VERIFY_PACK_MISSINGNESS_DRIFT");
    }
    if (side.reason === "ROSTER_MEMBERSHIP_OR_ORDER_DECISION_AMBIGUOUS" && parity) {
      throw new Error("BULLPEN_VERIFY_AMBIGUITY_WITH_EQUAL_FINGERPRINTS");
    }
    counters.missingnessReasons[side.reason] = (counters.missingnessReasons[side.reason] ?? 0) + 1;
  }
}

function main(): void {
  const artifactRoot = arg("artifact-root");
  const v16Root = arg("v16-root");
  const contractFile = arg("contract");
  const out = arg("out");
  const contract = readJson(contractFile);
  if (contract.schemaVersion !== CONTRACT_SCHEMA || contract.family !== "BULLPEN_FULL_GAME") throw new Error("BULLPEN_VERIFY_CONTRACT_INVALID");
  if (contract.certificationGate?.promotionOnlyAfterIndependentVerification !== true) throw new Error("BULLPEN_VERIFY_GATE_NOT_FROZEN");
  const v16Combined = readJson(path.join(v16Root, "combined-manifest.json"));
  if (v16Combined.combinedRowsetSha256 !== contract.universe.combinedV16RowsetSha256) throw new Error("BULLPEN_VERIFY_V16_AUTHORITY_DIGEST_DRIFT");

  const counters: any = {
    totalRows: 0, fullGameRows: 0, earlyWindowRows: 0, eligibleFullGameRows: 0, missingFullGameRows: 0,
    recomputedEligibleRows: 0, duplicateIdentityCount: 0, forbiddenOutcomeFieldCount: 0, forbiddenPriceFieldCount: 0,
    missingnessReasons: {}, fingerprintMismatchEligibleRows: 0,
  };
  const seasonReports: any[] = [];
  const combinedPackParts: Buffer[] = [];
  const combinedWitnessParts: Buffer[] = [];
  const allGameKeys = new Set<string>();

  for (const season of SEASONS) {
    const packFile = findUnique(artifactRoot, `bullpen-${season}.jsonl`);
    const witnessFile = findUnique(artifactRoot, `bullpen-witness-${season}.jsonl`);
    const manifestFile = findUnique(artifactRoot, `bullpen-manifest-${season}.json`);
    const v16File = path.join(v16Root, `v16-baseline-${season}.jsonl`);
    const packBytes = fs.readFileSync(packFile);
    const witnessBytes = fs.readFileSync(witnessFile);
    const manifest = readJson(manifestFile);
    if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.status !== "FULL_UNIVERSE_MATERIALIZED_PENDING_INDEPENDENT_VERIFICATION" || manifest.family !== "BULLPEN_FULL_GAME" || manifest.season !== season) {
      throw new Error(`BULLPEN_VERIFY_MANIFEST_INVALID:${season}`);
    }
    if (sha256(packBytes) !== manifest.packSha256 || sha256(witnessBytes) !== manifest.witnessSha256) throw new Error(`BULLPEN_VERIFY_MANIFEST_DIGEST_DRIFT:${season}`);
    combinedPackParts.push(packBytes); combinedWitnessParts.push(witnessBytes);

    const packRows = readJsonl(packFile);
    const witnessRows = readJsonl(witnessFile);
    const expected = v16Identities(v16File);
    assertSetEqual(expected.map(id), packRows.map(id), season);
    const expectedGameKeys = [...new Set(expected.map(gameKey))];
    assertSetEqual(expectedGameKeys, witnessRows.map(gameKey), `${season}:witness`);
    for (const key of expectedGameKeys) allGameKeys.add(`${season}|${key}`);

    const packById = new Map(packRows.map((r) => [id(r), r]));
    const witnessByGame = new Map(witnessRows.map((r) => [gameKey(r), r]));
    for (const row of packRows) {
      if (row.schemaVersion !== PACK_SCHEMA || row.feature?.sourceVersion !== SOURCE_VERSION || row.feature?.inputStage !== "PREGAME_T5") throw new Error(`BULLPEN_VERIFY_PACK_SCHEMA_DRIFT:${season}`);
      const forbidden = forbiddenKeyCounts(row); counters.forbiddenOutcomeFieldCount += forbidden.outcome; counters.forbiddenPriceFieldCount += forbidden.price;
      if (row.horizon === "EARLY_WINDOW") {
        counters.earlyWindowRows += 1;
        if (row.feature?.eligible !== false || row.feature?.values !== null || row.feature?.missingnessReason !== "NOT_APPLICABLE_EARLY_HORIZON") throw new Error(`BULLPEN_VERIFY_EARLY_WINDOW_DRIFT:${id(row)}`);
      } else if (row.horizon === "FULL_GAME") counters.fullGameRows += 1;
      else throw new Error(`BULLPEN_VERIFY_HORIZON_DRIFT:${id(row)}`);
    }
    for (const w of witnessRows) {
      if (w.schemaVersion !== WITNESS_SCHEMA) throw new Error(`BULLPEN_VERIFY_WITNESS_SCHEMA_DRIFT:${season}`);
      const forbidden = forbiddenKeyCounts(w); counters.forbiddenOutcomeFieldCount += forbidden.outcome; counters.forbiddenPriceFieldCount += forbidden.price;
      for (const sideName of ["HOME", "AWAY"] as const) {
        const side = sideName === "HOME" ? w.home : w.away;
        const pack = packById.get(`${w.officialDate}|${w.gamePk}|${sideName}|FG_ML|FULL_GAME`);
        if (!pack) throw new Error(`BULLPEN_VERIFY_FULL_GAME_PACK_MISSING:${season}:${w.gamePk}:${sideName}`);
        verifySide(side, pack, counters);
      }
    }
    counters.totalRows += packRows.length;
    if (manifest.rowCount !== packRows.length || manifest.gameCount !== witnessRows.length || manifest.fullGameRows !== packRows.filter((r) => r.horizon === "FULL_GAME").length || manifest.earlyWindowRows !== packRows.filter((r) => r.horizon === "EARLY_WINDOW").length) {
      throw new Error(`BULLPEN_VERIFY_MANIFEST_ACCOUNTING_DRIFT:${season}`);
    }
    seasonReports.push({
      season, rows: packRows.length, games: witnessRows.length, packSha256: sha256(packBytes), witnessSha256: sha256(witnessBytes),
      eligibleFullGameRows: manifest.eligibleFullGameRows, missingFullGameRows: manifest.missingFullGameRows, missingnessReasonCounts: manifest.missingnessReasonCounts,
    });
  }

  if (counters.totalRows !== Number(contract.universe.expectedRows)) throw new Error(`BULLPEN_VERIFY_TOTAL_ROWS:${counters.totalRows}`);
  if (allGameKeys.size !== Number(contract.universe.expectedGames)) throw new Error(`BULLPEN_VERIFY_TOTAL_GAMES:${allGameKeys.size}`);
  if (counters.fullGameRows !== 22008 || counters.earlyWindowRows !== 22008) throw new Error(`BULLPEN_VERIFY_HORIZON_COUNTS:${counters.fullGameRows}:${counters.earlyWindowRows}`);
  if (counters.forbiddenOutcomeFieldCount !== 0 || counters.forbiddenPriceFieldCount !== 0) throw new Error(`BULLPEN_VERIFY_FORBIDDEN_FIELDS:${counters.forbiddenOutcomeFieldCount}:${counters.forbiddenPriceFieldCount}`);

  const verification = {
    schemaVersion: VERIFY_SCHEMA,
    status: "FULL_UNIVERSE_INDEPENDENT_VERIFICATION_COMPLETE",
    family: "BULLPEN_FULL_GAME",
    promotionEligible: true,
    authority: {
      v16CombinedRowsetSha256: v16Combined.combinedRowsetSha256,
      expectedRows: contract.universe.expectedRows,
      expectedGames: contract.universe.expectedGames,
    },
    verification: counters,
    seasons: seasonReports,
    combinedPackSha256: sha256(Buffer.concat(combinedPackParts)),
    combinedWitnessSha256: sha256(Buffer.concat(combinedWitnessParts)),
    policy: {
      researchOnly: true,
      targetOutcomeFieldsRead: false,
      marketPricesRead: false,
      modelRefit: false,
      newWeightsCreated: false,
      productionChanged: false,
      r1b2Authorized: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(verification, null, 2) + "\n");
  console.log(JSON.stringify({ promotionEligible: verification.promotionEligible, rows: counters.totalRows, games: allGameKeys.size, fullGameRows: counters.fullGameRows, earlyWindowRows: counters.earlyWindowRows, eligibleFullGameRows: counters.eligibleFullGameRows, missingFullGameRows: counters.missingFullGameRows, recomputedEligibleRows: counters.recomputedEligibleRows, combinedPackSha256: verification.combinedPackSha256 }, null, 2));
}

main();

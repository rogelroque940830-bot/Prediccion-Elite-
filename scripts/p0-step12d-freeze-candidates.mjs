import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const EXPECTED_PILOT_GIT_BLOB_SHA = "3988b0214284b7338be8aeb8102c57d98f88d7a1";
const EXPECTED_PILOT_SCHEMA = "courtedge-p0-step12-pocket-pilot.v1";
const MANIFEST_SCHEMA = "courtedge-p0-step12d-frozen-candidates.v1";
const ALLOWED_HORIZONS = new Set(["FULL_GAME", "FIRST_5"]);

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const input = arg("--input") ?? "evidence/p0-step12/2025-pocket-pilot.json";
const output = arg("--out") ?? "artifacts/p0-step12d/frozen-candidates.json";
const pilotText = await fs.readFile(input, "utf8");
const pilot = JSON.parse(pilotText);

if (pilot.schemaVersion !== EXPECTED_PILOT_SCHEMA) throw new Error("STEP12D_PILOT_SCHEMA_INVALID");
if (pilot.evidenceStatus !== "PILOT_RESEARCH_ONLY_NOT_BET_ELITE") throw new Error("STEP12D_PILOT_STATUS_INVALID");
if (pilot.policy?.historicalPricesUsed || pilot.policy?.historicalEvClaimProduced || pilot.policy?.holdoutThresholdTuningAllowed
  || pilot.policy?.automaticBestRulePromotion || pilot.policy?.livePickFiltersChanged || pilot.policy?.betEliteProduced) {
  throw new Error("STEP12D_PILOT_RESEARCH_BOUNDARY_VIOLATION");
}
if (!Array.isArray(pilot.targets) || pilot.targets.length !== 2) throw new Error("STEP12D_TARGET_FAMILY_INVALID");

const candidates = [];
for (const target of pilot.targets) {
  if (!ALLOWED_HORIZONS.has(target.horizon)) throw new Error(`STEP12D_HORIZON_INVALID:${target.horizon}`);
  if (target.topK !== 10 || !Array.isArray(target.rules) || target.rules.length !== 10) {
    throw new Error(`STEP12D_FROZEN_TOPK_INVALID:${target.horizon}`);
  }
  for (const rule of target.rules) {
    if (!/^[a-f0-9]{16}$/i.test(String(rule.ruleKey ?? ""))) throw new Error("STEP12D_RULE_KEY_INVALID");
    if (!(rule.side === "HOME" || rule.side === "AWAY")) throw new Error("STEP12D_SIDE_INVALID");
    if (!Array.isArray(rule.atoms) || rule.atoms.length < 1 || rule.atoms.length > 3) throw new Error("STEP12D_ATOMS_INVALID");
    for (const atom of rule.atoms) {
      if (typeof atom.feature !== "string" || !(atom.operator === "GTE" || atom.operator === "LTE") || !Number.isFinite(atom.threshold)) {
        throw new Error(`STEP12D_ATOM_INVALID:${rule.ruleKey}`);
      }
    }
    candidates.push({
      ruleKey: rule.ruleKey,
      horizon: target.horizon,
      side: rule.side,
      atoms: rule.atoms.map((atom) => ({
        feature: atom.feature,
        operator: atom.operator,
        threshold: atom.threshold,
        quantile: atom.quantile,
      })),
      frozen2025Discovery: rule.discovery,
      frozen2025DiscoveryWilsonLower95: rule.discoveryWilsonLower95,
      frozen2025Holdout: rule.holdout,
      frozen2025HoldoutOneSidedPValueVsBaseline: rule.holdoutOneSidedPValueVsBaseline,
      frozen2025HoldoutBonferroniPValueTopK: rule.holdoutBonferroniPValueTopK,
    });
  }
}
if (candidates.length !== 20 || new Set(candidates.map((candidate) => candidate.ruleKey)).size !== 20) {
  throw new Error("STEP12D_FROZEN_FAMILY_MUST_CONTAIN_20_UNIQUE_RULES");
}

const familyDigest = sha256(canonical(candidates.map(({ ruleKey, horizon, side, atoms }) => ({ ruleKey, horizon, side, atoms }))));
const manifest = {
  schemaVersion: MANIFEST_SCHEMA,
  frozenAtStep: "12D_BEFORE_EXTERNAL_COHORT_EVALUATION",
  sourcePilot: {
    path: input,
    expectedGitBlobSha: EXPECTED_PILOT_GIT_BLOB_SHA,
    schemaVersion: pilot.schemaVersion,
    evidenceStatus: pilot.evidenceStatus,
    discoveryEndDate: pilot.split?.discoveryEndDate ?? null,
    datasetSha256: pilot.source?.datasetSha256 ?? null,
    starterHistorySha256: pilot.source?.starterHistorySha256 ?? null,
    lineupHistorySha256: pilot.source?.lineupHistorySha256 ?? null,
  },
  frozenFamily: {
    candidateCount: candidates.length,
    horizons: ["FULL_GAME", "FIRST_5"],
    candidatesPerHorizon: 10,
    globalMultiplicityFamilySize: 20,
    familyDigest,
    candidates,
  },
  policy: {
    externalThresholdTuningAllowed: false,
    candidateAdditionAllowed: false,
    candidateRemovalAllowed: false,
    atomMutationAllowed: false,
    sideMutationAllowed: false,
    horizonMutationAllowed: false,
    validationFamilyMutationAllowed: false,
    historicalPricesUsed: false,
    historicalEvClaimAllowed: false,
    livePickFiltersChanged: false,
    step11cCapturePopulationChanged: false,
    betEliteLabelProduced: false,
    automaticBetPlacement: false,
  },
};

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, output, candidateCount: 20, familyDigest, expectedPilotGitBlobSha: EXPECTED_PILOT_GIT_BLOB_SHA }, null, 2));

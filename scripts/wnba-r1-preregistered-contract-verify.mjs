import fs from "node:fs";
import { execFileSync } from "node:child_process";

const CONTRACT_PATH = "research/wnba/WNBA_R1_HISTORICAL_FOUNDATION_CONTRACT.json";
const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));

function fail(message) {
  console.error(`[WNBA-R1] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function gitBlobSha(path) {
  return execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim();
}

assert(contract.schemaVersion === "wnba-r1-historical-foundation-contract.v1", "unexpected schemaVersion");
assert(contract.phase === "WNBA-R1", "phase must remain WNBA-R1");
assert(contract.status === "PREREGISTERED_INPUT_AUDIT_ONLY", "R1 must begin with outcomes closed");
assert(contract.scientificScope?.market === "FULL_GAME_MONEYLINE", "R1 primary market must remain full-game moneyline");
assert(contract.scientificScope?.target === "GAME_WINNER", "R1 target must remain game winner");
assert(contract.scientificScope?.spreadIncluded === false, "spread must remain outside R1");
assert(contract.scientificScope?.totalIncluded === false, "total must remain outside R1");

const primary = contract.frozenPrimaryCandidate;
assert(primary?.id === "SPORTS_ONLY_V1", "SPORTS_ONLY_V1 must remain the preregistered primary candidate");
assert(primary?.role === "PRIMARY_CROSS_SPORT_CANDIDATE", "primary candidate role changed");
assert(primary?.marketInputsAllowed === false, "primary cross-sport candidate may not use market inputs");
assert(primary?.fixedMechanics?.logitHardCap === 2.0, "logit hard cap changed");

const control = contract.frozenDeployedControl;
assert(control?.id === "CURRENT_65_35_V1", "deployed control identity changed");
assert(control?.sportsWeight === 0.65 && control?.marketWeight === 0.35, "deployed 65/35 control weights changed");
assert(control?.eligibleForGlobalRanker === false, "market-informed control must stay blocked from global ranker in R1");

assert(contract.historicalReplay?.minimumSeasonsForR1Evaluation === 5, "five-season R1 requirement changed");
assert(contract.historicalReplay?.minimumEligibleGamesTotal === 500, "minimum total eligible games changed");
assert(contract.historicalReplay?.minimumEligibleGamesPerSeason === 80, "minimum per-season eligible games changed");
assert(contract.historicalReplay?.sameRowsRequiredForPrimaryAndControlComparison === true, "paired-row comparison requirement changed");

assert(contract.missingDataPolicy?.futureBackfillAllowed === false, "future backfill must remain forbidden");
assert(contract.missingDataPolicy?.silentZeroImputationAllowed === false, "silent zero imputation must remain forbidden");
assert(contract.missingDataPolicy?.injuryDefaultZeroAllowed === false, "missing injury state may not silently become zero");
assert(contract.leakageControls?.sameGameOutcomeAsFeature === false, "same-game outcome leakage guard changed");
assert(contract.leakageControls?.postTipData === false, "post-tip data guard changed");
assert(contract.leakageControls?.postResultCandidateSwitching === false, "post-result candidate switching guard changed");
assert(contract.leakageControls?.postResultGateWeakening === false, "post-result gate weakening guard changed");

assert(contract.evaluationProtocol?.firstStage === "INPUT_AVAILABILITY_AND_TIMESTAMP_AUDIT_WITH_OUTCOMES_CLOSED", "outcomes must remain closed during input audit");
assert(contract.decisionPolicy?.primaryCandidateCannotBeReplacedByControlBecauseOfObservedResults === true, "primary candidate freeze changed");
assert(contract.decisionPolicy?.automaticPromotion === false, "automatic promotion must remain disabled");
assert(contract.decisionPolicy?.automaticBetPlacement === false, "automatic betting must remain disabled");
assert(contract.decisionPolicy?.realFinancialExposure === 0, "real financial exposure must remain zero");

for (const source of [contract.sourceCustody?.modelSource, contract.sourceCustody?.runtimeSource]) {
  assert(source?.path && source?.gitBlobSha, "source custody path/blob SHA missing");
  assert(fs.existsSync(source.path), `frozen source missing: ${source.path}`);
  const actual = gitBlobSha(source.path);
  assert(actual === source.gitBlobSha, `source custody mismatch for ${source.path}: expected ${source.gitBlobSha}, got ${actual}`);
}

console.log("[WNBA-R1] PASS: preregistration, source custody, leakage guards, candidate identity, and outcome embargo are frozen.");

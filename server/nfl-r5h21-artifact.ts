import { createHash } from "node:crypto";
import type { FrozenLogitSpec } from "./nfl-frozen-logit";

export const NFL_R5H21_ARTIFACT_SCHEMA = "courtedge-nfl-r5h21-late-down-runtime.v1" as const;
export const NFL_R5H21_ARTIFACT_DIGEST = "d49f01cc32e0b5cb828933d2a03ca5128280d0a0f0cd033cd947acd12d8e2a6e" as const;
export const NFL_R5H21_END_2025_STATE_DIGEST = "5ab0bce7f5d25566e66151c3de6e2bfe580a069070314a4651bed85471a6a96a" as const;
export const NFL_R5H21_FROZEN_2026_THRESHOLD = 0.8335487495672039 as const;

export type NflR5H21LateDownTeamState = {
  team: string;
  offLateDownConversion: number | null;
  defLateDownConversionAllowed: number | null;
};

export type NflR5H21Artifact = {
  schemaVersion: typeof NFL_R5H21_ARTIFACT_SCHEMA;
  sport: "NFL";
  stage: "R5H21_2026_LATE_DOWN_RUNTIME_EXPORT";
  family: "LATE_DOWN_CONVERSION";
  targetSeason: 2026;
  trainedThroughSeason: 2025;
  productionPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING";
  targetSeasonRankingOrCapUsed: false;
  referenceDirectionSource: string;
  features: string[];
  model: FrozenLogitSpec;
  supportScore: string;
  selectionRule: string;
  thresholdConfig: { threshold: number; quantile: number; gate: boolean; validationSeasons: number[]; [key: string]: unknown };
  end2025State: {
    schemaVersion: "courtedge-nfl-r5h21-late-down-state.v1";
    currentSeason: 2025;
    trainedThroughSeason: 2025;
    processedCompletedGames: number;
    lastAppliedGameId: string | null;
    ewmaAlpha: number;
    seasonDecay: number;
    teamState: NflR5H21LateDownTeamState[];
    semanticDigest: string;
  };
  safety: {
    automaticBetPlacement: false;
    automaticProductionPromotion: false;
    future2026FeatureRankingUsed: false;
    historicalAccuracyExposedAsGameProbability: false;
    marketDataUsedAsFeatures: false;
    postKickoffEvidenceAllowed: false;
    sameGameOutcomeAllowed: false;
    target2026OutcomesUsed: false;
  };
  sourceCustody: Record<string, string | number>;
  researchPr: 663;
  semanticDigest: string;
};

const EMBEDDED_ARTIFACT = {"end2025State":{"currentSeason":2025,"ewmaAlpha":0.22,"lastAppliedGameId":"2025_18_WAS_PHI","processedCompletedGames":3663,"schemaVersion":"courtedge-nfl-r5h21-late-down-state.v1","seasonDecay":0.75,"semanticDigest":"5ab0bce7f5d25566e66151c3de6e2bfe580a069070314a4651bed85471a6a96a","teamState":[{"defLateDownConversionAllowed":0.5458147971542406,"offLateDownConversion":0.40106666043653916,"team":"ARI"},{"defLateDownConversionAllowed":0.4395074346988324,"offLateDownConversion":0.359476206732814,"team":"ATL"},{"defLateDownConversionAllowed":0.41363652372710646,"offLateDownConversion":0.4767620477705587,"team":"BAL"},{"defLateDownConversionAllowed":0.43465337119016584,"offLateDownConversion":0.48484946293169606,"team":"BUF"},{"defLateDownConversionAllowed":0.5270689174823279,"offLateDownConversion":0.37276867049919954,"team":"CAR"},{"defLateDownConversionAllowed":0.4849012957858706,"offLateDownConversion":0.43440484749288033,"team":"CHI"},{"defLateDownConversionAllowed":0.39587075253935106,"offLateDownConversion":0.5373835752891489,"team":"CIN"},{"defLateDownConversionAllowed":0.3606838097904357,"offLateDownConversion":0.3634717089791007,"team":"CLE"},{"defLateDownConversionAllowed":0.44801823026961585,"offLateDownConversion":0.42584999949578733,"team":"DAL"},{"defLateDownConversionAllowed":0.4107525037547722,"offLateDownConversion":0.44099056308249485,"team":"DEN"},{"defLateDownConversionAllowed":0.4023713307590422,"offLateDownConversion":0.42689321773420286,"team":"DET"},{"defLateDownConversionAllowed":0.4229148599559024,"offLateDownConversion":0.43151833119370614,"team":"GB"},{"defLateDownConversionAllowed":0.42411839941352714,"offLateDownConversion":0.3804118081390413,"team":"HOU"},{"defLateDownConversionAllowed":0.4259834884106861,"offLateDownConversion":0.4368055102952646,"team":"IND"},{"defLateDownConversionAllowed":0.3732772959451106,"offLateDownConversion":0.47194494173683554,"team":"JAX"},{"defLateDownConversionAllowed":0.4273327176208064,"offLateDownConversion":0.3315579269494863,"team":"KC"},{"defLateDownConversionAllowed":0.38898084103066544,"offLateDownConversion":0.4636485692389967,"team":"LA"},{"defLateDownConversionAllowed":0.33615080504589245,"offLateDownConversion":0.4591417520872624,"team":"LAC"},{"defLateDownConversionAllowed":0.4592855714083155,"offLateDownConversion":0.32794461361419985,"team":"LV"},{"defLateDownConversionAllowed":0.44047098235176085,"offLateDownConversion":0.3161810545978013,"team":"MIA"},{"defLateDownConversionAllowed":0.34240696549204985,"offLateDownConversion":0.364762293196628,"team":"MIN"},{"defLateDownConversionAllowed":0.4110809650622875,"offLateDownConversion":0.4640853729711138,"team":"NE"},{"defLateDownConversionAllowed":0.347243777097034,"offLateDownConversion":0.4247071367673936,"team":"NO"},{"defLateDownConversionAllowed":0.4151393953280165,"offLateDownConversion":0.4275339889656009,"team":"NYG"},{"defLateDownConversionAllowed":0.4654138972268682,"offLateDownConversion":0.34367131827604375,"team":"NYJ"},{"defLateDownConversionAllowed":null,"offLateDownConversion":null,"team":"OAK"},{"defLateDownConversionAllowed":0.4235509631680589,"offLateDownConversion":0.39474335424789325,"team":"PHI"},{"defLateDownConversionAllowed":0.42222876611310034,"offLateDownConversion":0.43983912521353563,"team":"PIT"},{"defLateDownConversionAllowed":null,"offLateDownConversion":null,"team":"SD"},{"defLateDownConversionAllowed":0.29543544593803756,"offLateDownConversion":0.4380928065671833,"team":"SEA"},{"defLateDownConversionAllowed":0.43962601747041485,"offLateDownConversion":0.515032412534911,"team":"SF"},{"defLateDownConversionAllowed":null,"offLateDownConversion":null,"team":"STL"},{"defLateDownConversionAllowed":0.387867356319929,"offLateDownConversion":0.4760403834432071,"team":"TB"},{"defLateDownConversionAllowed":0.4105155779807139,"offLateDownConversion":0.36781018198999904,"team":"TEN"},{"defLateDownConversionAllowed":0.4490524030781701,"offLateDownConversion":0.38216002010196237,"team":"WAS"}],"trainedThroughSeason":2025},"family":"LATE_DOWN_CONVERSION","features":["home_off_late_down_conversion","home_def_late_down_conversion_allowed","away_off_late_down_conversion","away_def_late_down_conversion_allowed"],"model":{"features":["home_off_late_down_conversion","home_def_late_down_conversion_allowed","away_off_late_down_conversion","away_def_late_down_conversion_allowed"],"imputer":{"statistics":[0.3813724130068885,0.3863079584200005,0.38509176417557955,0.38381514517020643],"strategy":"median"},"kind":"STANDARDIZED_LOGISTIC_REGRESSION","logistic":{"C":3.0,"classes":[0,1],"coef":[0.36272903303826104,-0.17995576609667646,-0.34313903182906325,0.13220771848882829],"intercept":0.2181509030542526},"scaler":{"mean":[0.3841381154096248,0.3855320088924384,0.38566101378700274,0.38338899769749096],"scale":[0.06254697761159231,0.058473746599680534,0.06196161943558722,0.05951712389285767]}},"productionPolicy":"THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING","referenceDirectionSource":"R5B2_HICONF_SWITCH_FROZEN_2026_REFERENCE_PROBABILITY","researchPr":663,"safety":{"automaticBetPlacement":false,"automaticProductionPromotion":false,"future2026FeatureRankingUsed":false,"historicalAccuracyExposedAsGameProbability":false,"marketDataUsedAsFeatures":false,"postKickoffEvidenceAllowed":false,"sameGameOutcomeAllowed":false,"target2026OutcomesUsed":false},"schemaVersion":"courtedge-nfl-r5h21-late-down-runtime.v1","selectionRule":"NON_CORE_AND_FINITE_SUPPORT_AND_SUPPORT_GT_0_AND_SUPPORT_GTE_FROZEN_THRESHOLD","semanticDigest":"d49f01cc32e0b5cb828933d2a03ca5128280d0a0f0cd033cd947acd12d8e2a6e","sourceCustody":{"h15PredictionsSha256":"c0d7fcbf89e98617502a2163db1fec712bd890cb94c903f0023236cf69e10eb9","h15SupplementSha256":"e62613e36e936c1efdd46b0f5a918b61074eb8c0bfdd84c5319da8e01a802a9d","h20ReplaySemanticDigest":"d2873a557ed391b7bffaa6d12fb49ead7cc4554538554bdaa5bdf8248a06c5c5","hybridDatasetSha256":"45b6513984d897f22a79a46377cb2ec8080e6f854c7bd00ff265cbb0908ae278","r5h18ArtifactId":9543740255,"r5h18CombinedGames":211,"r5h18CombinedLosses":40,"r5h18CombinedWins":171,"r5h18ThresholdOnlyGames":53,"r5h18ThresholdOnlyLosses":7,"r5h18ThresholdOnlyWins":46},"sport":"NFL","stage":"R5H21_2026_LATE_DOWN_RUNTIME_EXPORT","supportScore":"sign(ref_p-0.5) * logit(late_down_probability)","targetSeason":2026,"targetSeasonRankingOrCapUsed":false,"thresholdConfig":{"deltaVsMatched":0.11486486486486491,"family":"LATE_DOWN_CONVERSION","gate":true,"matchedAccuracy":0.75,"matchedGames":28,"quantile":0.9,"selectedAccuracy":0.8648648648648649,"selectedGames":37,"selectedWilson95Lower":0.7202227252929444,"threshold":0.8335487495672039,"validationSeasons":[2024,2025],"worstValidationSeasonAccuracy":0.8076923076923077},"trainedThroughSeason":2025} as NflR5H21Artifact;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function semanticDigest(value: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

let cached: NflR5H21Artifact | null = null;

/** Certified, prior-only 2026 LATE_DOWN_CONVERSION runtime contract exported by R5H21. */
export function getNflR5H21Artifact(): NflR5H21Artifact {
  if (cached) return cached;
  const artifact = EMBEDDED_ARTIFACT;
  if (artifact.schemaVersion !== NFL_R5H21_ARTIFACT_SCHEMA || artifact.semanticDigest !== NFL_R5H21_ARTIFACT_DIGEST) {
    throw new Error("NFL R5H21 artifact identity mismatch");
  }
  const { semanticDigest: declared, ...payload } = artifact;
  const actual = semanticDigest(payload);
  if (actual !== declared || actual !== NFL_R5H21_ARTIFACT_DIGEST) {
    throw new Error(`NFL R5H21 artifact semantic digest mismatch: recomputed=${actual} expected=${NFL_R5H21_ARTIFACT_DIGEST}`);
  }
  if (artifact.targetSeason !== 2026 || artifact.trainedThroughSeason !== 2025) throw new Error("NFL R5H21 season custody mismatch");
  if (artifact.productionPolicy !== "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING" || artifact.targetSeasonRankingOrCapUsed !== false) {
    throw new Error("NFL R5H21 prospective policy mismatch");
  }
  if (!artifact.thresholdConfig.gate || artifact.thresholdConfig.threshold !== NFL_R5H21_FROZEN_2026_THRESHOLD) {
    throw new Error("NFL R5H21 frozen threshold custody mismatch");
  }
  if (artifact.end2025State.semanticDigest !== NFL_R5H21_END_2025_STATE_DIGEST || artifact.end2025State.processedCompletedGames !== 3663) {
    throw new Error("NFL R5H21 end-2025 state custody mismatch");
  }
  if (artifact.safety.marketDataUsedAsFeatures || artifact.safety.sameGameOutcomeAllowed || artifact.safety.postKickoffEvidenceAllowed || artifact.safety.target2026OutcomesUsed) {
    throw new Error("NFL R5H21 safety boundary mismatch");
  }
  cached = artifact;
  return artifact;
}

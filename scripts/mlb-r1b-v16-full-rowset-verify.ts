import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { C4_LIVE_FEATURE_BUILDER_VERSION, type C4LiveFeatureAssessment } from "../server/mlb-c4-live-feature-builder";
import { adaptCertifiedFinalC4ToR1bV16Baseline, MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA } from "../server/mlb-r1b-v16-final-baseline-adapter";
import { MLB_V16_RUNTIME_MODEL_LOCK } from "../server/mlb-pure-settlement-scorer";

const SEASONS = ["2022", "2023", "2024", "2025", "2026_YTD"] as const;
const COMBINED_SCHEMA = "courtedge-mlb-r1b-v16-baseline-combined-manifest.v1";
const TOLERANCE = 1e-15;
type Json = Record<string, any>;
function arg(name:string,fallback?:string):string{const i=process.argv.indexOf(`--${name}`);if(i>=0&&process.argv[i+1])return process.argv[i+1];if(fallback!==undefined)return fallback;throw new Error(`MLB_R1B_V16_VERIFY_ARG_MISSING:${name}`);}
function sha(value:string|Buffer):string{return createHash("sha256").update(value).digest("hex");}
function fileSha(path:string):string{return sha(readFileSync(path));}
function load(path:string):Json{return JSON.parse(readFileSync(path,"utf8"));}
function jsonl(path:string):Json[]{const t=readFileSync(path,"utf8").trim();return t? t.split("\n").map(line=>JSON.parse(line)):[];}
function key(r:any):string{return `${r.officialDate}|${r.gamePk}|${r.side}|${r.market}|${r.horizon}`;}
function close(a:number,b:number):boolean{return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=TOLERANCE;}

async function main():Promise<void>{
  const root=arg("root","research/mlb-r1b-v16-baseline-historical");
  const out=arg("out",join(root,"combined-manifest.json"));
  const seasonSummaries:any[]=[]; const combinedKeys=new Set<string>(); let totalRows=0,totalEligible=0,totalFrozen=0,totalSourceUniverse=0,totalC4Excluded=0,totalSourceExcluded=0; let parityChecked=0;
  const combinedHash=createHash("sha256");
  for(const season of SEASONS){
    const manifestPath=join(root,`manifest-${season}.json`), coveragePath=join(root,`coverage-${season}.json`), featurePath=join(root,`c4-features-${season}.jsonl`), rowsetPath=join(root,`v16-baseline-${season}.jsonl`), priorPath=join(root,`prior-history-${season}.jsonl`);
    const manifest=load(manifestPath),coverage=load(coveragePath);
    if(manifest.status!=="MATERIALIZED_AND_DIGEST_PINNED")throw new Error(`MLB_R1B_V16_VERIFY_MANIFEST_STATUS:${season}`);
    const actual={prior:fileSha(priorPath),features:fileSha(featurePath),rowset:fileSha(rowsetPath),coverage:fileSha(coveragePath)};
    if(actual.prior!==manifest.files.priorHistory.sha256||actual.features!==manifest.files.c4Features.sha256||actual.rowset!==manifest.files.v16Baseline.sha256||actual.coverage!==manifest.files.coverage.sha256)throw new Error(`MLB_R1B_V16_VERIFY_DIGEST_MISMATCH:${season}`);
    if(manifest.locks.c4BuilderVersion!==C4_LIVE_FEATURE_BUILDER_VERSION||manifest.locks.v16AdapterSchema!==MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA||manifest.locks.v16ModelVersion!==MLB_V16_RUNTIME_MODEL_LOCK.modelVersion||manifest.locks.v16ManifestSha256!==MLB_V16_RUNTIME_MODEL_LOCK.manifestSha256)throw new Error(`MLB_R1B_V16_VERIFY_MODEL_LOCK_MISMATCH:${season}`);
    const features=jsonl(featurePath), rows=jsonl(rowsetPath); if(rows.length!==features.length*4)throw new Error(`MLB_R1B_V16_VERIFY_ROW_COUNT:${season}`);
    const byKey=new Map(rows.map(r=>[key(r),r])); if(byKey.size!==rows.length)throw new Error(`MLB_R1B_V16_VERIFY_DUPLICATE:${season}`);
    for(const f of features){
      const c4:C4LiveFeatureAssessment={builderVersion:C4_LIVE_FEATURE_BUILDER_VERSION,priceIndependent:true,sameDateHistoryAllowed:false,seasonResetHistory:true,featureVector:f.featureVector,diagnostics:f.diagnostics};
      const expected=adaptCertifiedFinalC4ToR1bV16Baseline({officialDate:String(f.officialDate),gamePk:Number(f.gamePk),generatedAt:String(f.generatedAt),inputStage:"FINAL",c4});
      for(const e of expected){const r=byKey.get(key(e));if(!r||r.stage!=="FINAL"||!close(Number(r.probability),e.probability)||!close(Number(r.pushProbability),e.pushProbability))throw new Error(`MLB_R1B_V16_VERIFY_SCORER_PARITY:${season}:${key(e)}`);parityChecked++;}
    }
    const raw=readFileSync(rowsetPath); combinedHash.update(`${season}\n`); combinedHash.update(raw);
    for(const r of rows){const k=key(r);if(combinedKeys.has(k))throw new Error(`MLB_R1B_V16_VERIFY_CROSS_SEASON_DUPLICATE:${k}`);combinedKeys.add(k);}
    const rowText=raw.toString("utf8"); if(/"(?:odds|price|sportsbook|winner|targetOutcome|homeRuns|awayRuns)"\s*:/.test(rowText))throw new Error(`MLB_R1B_V16_VERIFY_FORBIDDEN_ROW_FIELD:${season}`);
    totalRows+=rows.length; totalEligible+=features.length; totalFrozen+=Number(coverage.sourceUniverse.frozenT5EligibleCount); totalSourceUniverse+=Number(coverage.sourceUniverse.unionGameCount); totalC4Excluded+=Number(coverage.currentC4.structurallyIneligibleGameCount); totalSourceExcluded+=Number(coverage.sourceUniverse.sourceExcludedCount);
    seasonSummaries.push({season,rowsetSha256:actual.rowset,featureSha256:actual.features,priorHistorySha256:actual.prior,coverageSha256:actual.coverage,sourceUniverseGameCount:coverage.sourceUniverse.unionGameCount,frozenT5EligibleGameCount:coverage.sourceUniverse.frozenT5EligibleCount,c4EligibleGameCount:coverage.currentC4.eligibleGameCount,c4IneligibleGameCount:coverage.currentC4.structurallyIneligibleGameCount,rowCount:rows.length,dateRange:coverage.rowset.dateRange});
  }
  const combined={schemaVersion:COMBINED_SCHEMA,status:"FULL_UNIVERSE_PARITY_CERTIFIED_EVIDENCE",family:"V16_BASELINE",canonicalShardOrder:[...SEASONS],combinedRowsetSha256:combinedHash.digest("hex"),tolerance:TOLERANCE,fullUniverseScorerParity:{checkedRows:parityChecked,failedRows:0,allRowsRecomputedThroughLockedAdapter:true},coverage:{sourceUniverseGameCount:totalSourceUniverse,frozenT5EligibleGameCount:totalFrozen,sourceExcludedGameCount:totalSourceExcluded,c4EligibleGameCount:totalEligible,c4StructurallyIneligibleGameCount:totalC4Excluded,rowCount:totalRows,duplicateCount:0,explicitMissingnessPreserved:true,noPostHocHistoryShrink:true},locks:{c4BuilderVersion:C4_LIVE_FEATURE_BUILDER_VERSION,v16AdapterSchema:MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA,v16ModelVersion:MLB_V16_RUNTIME_MODEL_LOCK.modelVersion,v16ManifestSha256:MLB_V16_RUNTIME_MODEL_LOCK.manifestSha256},seasons:seasonSummaries,policy:{researchOnly:true,targetIdentityFromFrozenT5Only:true,strictlyPriorOfficialDateHistory:true,sameDateHistoryAllowed:false,targetOutcomeUsedAsFeature:false,historicalPriorResultsReadForTeamForm:true,marketPricesRead:false,modelRefit:false,newWeightsCreated:false,thresholdSearch:false,productionChanged:false,v16Changed:false,v68Changed:false,v80Changed:false,automaticBetPlacement:false,realFinancialExposure:0}};
  writeFileSync(out,`${JSON.stringify(combined,null,2)}\n`,"utf8"); console.log(JSON.stringify(combined,null,2));
}
main().catch(e=>{console.error(e instanceof Error?e.stack??e.message:String(e));process.exitCode=1;});

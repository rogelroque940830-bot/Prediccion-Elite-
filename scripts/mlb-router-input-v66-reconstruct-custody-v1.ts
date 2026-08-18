#!/usr/bin/env tsx
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  V66_QUALITY_FEATURE_NAMES,
  buildHorizonExposureFeatures,
  buildQualityHorizonInteractions,
  buildV66BullpenFeatures,
  type BullpenProfile,
} from "../server/mlb-full-modular-mechanistic-feature-builder";

type Row = Record<string, unknown>;
const EXPECTED_ROWS=11407;
const EXPECTED_BY_SEASON:Record<string,number>={"2022":2398,"2023":2399,"2024":2406,"2025":2423,"2026_YTD":1781};
const TOL=1e-12;

function args(){const a=process.argv.slice(2);const g=(n:string)=>{const i=a.indexOf(n);if(i<0||i+1>=a.length)throw new Error(`MISSING:${n}`);return a[i+1];};return {input:g("--input"),output:g("--output"),report:g("--report")};}
function finite(v:unknown):v is number{return typeof v==="number"&&Number.isFinite(v);}
function nullable(r:Row,k:string){return finite(r[k])?r[k] as number:null;}
function required(r:Row,k:string){const v=r[k];if(!finite(v))throw new Error(`MISSING_REQUIRED:${k}`);return v;}
function profile(r:Row,side:"home"|"away"):BullpenProfile{return {
  bullpen_pitches_1d:required(r,`${side}_bullpen_pitches_1d`),
  bullpen_pitches_3d:required(r,`${side}_bullpen_pitches_3d`),
  bullpen_core3_pitches_2d:required(r,`${side}_bullpen_core3_pitches_2d`),
  bullpen_b2b_arms:required(r,`${side}_bullpen_b2b_arms`),
  priorGames30d:required(r,`${side}_bullpen_prior_games_30d`),
  relieverPool:required(r,`${side}_bullpen_reliever_pool_30d`),
};}
function sha256(b:Buffer|string){return "sha256:"+createHash("sha256").update(b).digest("hex");}

function main(){const a=args();const raw=readFileSync(a.input);const sourceRawSha=sha256(raw);if(sourceRawSha!=="sha256:1d7a7f35226186b0043606db3762c0e612ea90d6bca71fb4f1616a0dc493add2")throw new Error(`SOURCE_SHA_DRIFT:${sourceRawSha}`);
  const rows:Row[]=gunzipSync(raw).toString("utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));if(rows.length!==EXPECTED_ROWS)throw new Error(`ROWS:${rows.length}`);
  const seasons:Record<string,number>={},ids=new Set<string>(),fields=new Set<string>();let comparisons=0,maxDiff=0,numeric=0,missing=0;const examples:any[]=[];
  const cmp=(id:string,k:string,e:unknown,v:unknown)=>{comparisons++;const a0=finite(e)?e:null,b0=finite(v)?v:null;if(a0===null||b0===null){if(a0!==b0){missing++;if(examples.length<20)examples.push({id,k,expected:a0,actual:b0,kind:"MISSINGNESS"});}return;}const d=Math.abs(a0-b0);maxDiff=Math.max(maxDiff,d);if(d>TOL){numeric++;if(examples.length<20)examples.push({id,k,expected:a0,actual:b0,diff:d,kind:"NUMERIC"});}};
  const outRows:Row[]=[];
  for(const original of rows){const r={...original};const season=String(r.season),date=String(r.officialDate),gamePk=Number(r.gamePk),id=`${season}|${date}|${gamePk}`;if(ids.has(id))throw new Error(`DUP:${id}`);ids.add(id);seasons[season]=(seasons[season]||0)+1;
    const exposure=buildHorizonExposureFeatures(nullable(r,"home_expected_starter_outs"),nullable(r,"away_expected_starter_outs"));
    const derived:Record<string,number|null>={};for(const [k,v] of Object.entries(exposure)){if(k==="home_expected_starter_outs"||k==="away_expected_starter_outs")continue;derived[k]=v;}
    const quality=Object.fromEntries(V66_QUALITY_FEATURE_NAMES.map(k=>[k,nullable(r,k)])) as Record<(typeof V66_QUALITY_FEATURE_NAMES)[number],number|null>;
    Object.assign(derived,buildQualityHorizonInteractions(quality,exposure));
    Object.assign(derived,buildV66BullpenFeatures({homeProfile:profile(r,"home"),awayProfile:profile(r,"away"),exposure}));
    for(const [k,v] of Object.entries(derived)){fields.add(k);cmp(id,k,original[k],v);r[k]=v;}
    outRows.push(r);
  }
  if(JSON.stringify(seasons)!==JSON.stringify(EXPECTED_BY_SEASON))throw new Error(`SEASONS:${JSON.stringify(seasons)}`);if(fields.size!==68)throw new Error(`DERIVED_FIELDS:${fields.size}`);if(numeric+missing!==0)throw new Error(`DERIVED_MISMATCH:${numeric+missing}`);if(maxDiff>TOL)throw new Error(`MAX_DIFF:${maxDiff}`);
  const text=outRows.map(r=>JSON.stringify(r)).join("\n")+"\n";const gz=gzipSync(Buffer.from(text,"utf8"),{level:9});mkdirSync(dirname(a.output),{recursive:true});writeFileSync(a.output,gz);
  const report={schemaVersion:"courtedge-mlb-router-input-v66-reconstructed-custody.v1",classification:"V66_RUNTIME_DERIVED_CUSTODY_RECONSTRUCTION_PASS",sourceRawSha256:sourceRawSha,outputGzipSha256:sha256(gz),outputJsonlSha256:sha256(text),rows:rows.length,rowsBySeason:seasons,uniqueIdentityRows:ids.size,derivedFeatureCount:fields.size,derivedFeatures:[...fields].sort(),comparisons,maximumAbsoluteDifference:maxDiff,numericMismatches:numeric,missingnessMismatches:missing,totalMismatches:numeric+missing,tolerance:TOL,baseV39ExpectedOutsAuthority:"V39_STEP12V3_SOURCE_TO_V66_PARITY_PASS",baseV62QualityAuthority:"V62_RAW_SOURCE_TO_V66_PARITY_PASS",derivedAuthority:"V66_DERIVED_RUNTIME_PARITY_PASS",targetOutcomeAdded:false,sameDateOutcomeAdded:false,productionChanged:false,realFinancialExposure:0};mkdirSync(dirname(a.report),{recursive:true});writeFileSync(a.report,JSON.stringify(report,null,2)+"\n");console.log("MLB_ROUTER_INPUT_V66_RECONSTRUCTED_CUSTODY_REPORT_BEGIN");console.log(JSON.stringify(report));console.log("MLB_ROUTER_INPUT_V66_RECONSTRUCTED_CUSTODY_REPORT_END");}
main();

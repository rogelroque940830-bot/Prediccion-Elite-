#!/usr/bin/env tsx
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

type Totals = {
  pitches:number; strikes:number; swings:number; whiffs:number;
  velocityN:number; velocitySum:number; spinN:number; spinSum:number;
  battedBallN:number; hardHitN:number;
};
type TypeMap = Map<string, Totals>;
type PitcherMap = Map<number, TypeMap>;
type CustodyRow = Record<string, unknown>;

const RECOGNIZED = new Set(["FF","FT","SI","FC","SL","ST","SV","CU","KC","CS","CH","FS","FO","SC","KN","EP"]);
const DAY_MS=86_400_000;
const TOL=1e-12;
const QUALITY_FIELDS=[
  ["starter_velocity_adv","velocity"],
  ["starter_spin_adv","spin"],
  ["starter_swing_miss_adv","whiff"],
  ["starter_in_zone_adv","strike"],
  ["starter_weak_contact_adv","hard"],
] as const;

function day(s:string){const x=Date.parse(`${s}T00:00:00Z`);if(!Number.isFinite(x))throw new Error(`BAD_DATE:${s}`);return Math.floor(x/DAY_MS);}
function empty():Totals{return {pitches:0,strikes:0,swings:0,whiffs:0,velocityN:0,velocitySum:0,spinN:0,spinSum:0,battedBallN:0,hardHitN:0};}
function cloneTotals(x:Totals):Totals{return {...x};}
function add(a:Totals,b:Totals,sign=1){for(const k of Object.keys(a) as (keyof Totals)[])a[k]+=sign*Number(b[k]||0);}
function getType(m:TypeMap,pt:string){let z=m.get(pt);if(!z){z=empty();m.set(pt,z);}return z;}
function getPitcher(m:PitcherMap,pid:number){let z=m.get(pid);if(!z){z=new Map();m.set(pid,z);}return z;}
function mean(t:number,n:number){return n>0?t/n:null;}
function rate(n:number,d:number){return d>0?n/d:null;}
function sm(t:number,n:number,a:number,w:number){return (t+w*a)/(n+w);}
function sr(n:number,d:number,a:number,w:number){return (n+w*a)/(d+w);}

function quality(starterId:number,pitchers:PitcherMap,league:TypeMap){
  const sp=pitchers.get(starterId);
  if(!(starterId>0)||!sp)return null;
  let total=0;for(const r of sp.values())total+=r.pitches;
  if(total<1)return null;
  const q={velocity:0,spin:0,whiff:0,strike:0,hard:0};
  for(const [pt,r] of sp){
    if(!(r.pitches>0))continue;
    const lg=league.get(pt);if(!lg||!(lg.pitches>0))continue;
    const u=r.pitches/total;
    const lv=mean(lg.velocitySum,lg.velocityN),ls=mean(lg.spinSum,lg.spinN),lw=rate(lg.whiffs,lg.swings),lst=rate(lg.strikes,lg.pitches),lh=rate(lg.hardHitN,lg.battedBallN);
    if(lv!==null)q.velocity+=u*(sm(r.velocitySum,r.velocityN,lv,100)-lv);
    if(ls!==null)q.spin+=u*(sm(r.spinSum,r.spinN,ls,100)-ls);
    if(lw!==null)q.whiff+=u*(sr(r.whiffs,r.swings,lw,50)-lw);
    if(lst!==null)q.strike+=u*(sr(r.strikes,r.pitches,lst,100)-lst);
    if(lh!==null)q.hard+=u*(lh-sr(r.hardHitN,r.battedBallN,lh,30));
  }
  return {...q,starterPriorRecognizedPitches:total};
}

function parseArgs(){const a=process.argv.slice(2);const g=(n:string)=>{const i=a.indexOf(n);if(i<0||i+1>=a.length)throw new Error(`MISSING:${n}`);return a[i+1];};return {pitch:g("--pitch-root"),hands:g("--hands-root"),custody:g("--custody"),out:g("--out")};}
function loadJson(p:string){return JSON.parse(readFileSync(p,"utf8"));}
function findFile(root:string,name:string){
  const stack=[root];while(stack.length){const d=stack.pop()!;for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name);if(e.isDirectory())stack.push(p);else if(e.name===name)return p;}}
  throw new Error(`FILE_NOT_FOUND:${name}`);
}

function main(){
  const args=parseArgs();
  const seasons=["2022","2023","2024","2025","2026_YTD"];
  const packs=["2021",...seasons].map(s=>loadJson(findFile(args.pitch,`pitch-quality-${s}.json`)));
  for(const p of packs)if(p.schemaVersion!=="courtedge-p0-step12v62-pitch-quality-pbp.v1")throw new Error(`PACK_SCHEMA:${p.season}`);

  const handsBySeason=new Map<string,Map<number,any>>();
  for(const s of seasons){
    const p=loadJson(findFile(args.hands,`pregame-hands-${s}.json`));
    handsBySeason.set(s,new Map((p.snapshots||[]).map((x:any)=>[Number(x.gamePk),x])));
  }

  const rows:CustodyRow[]=gunzipSync(readFileSync(args.custody)).toString("utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  if(rows.length!==11407)throw new Error(`ROW_COUNT:${rows.length}`);
  const rowsByDate=new Map<string,CustodyRow[]>();
  for(const r of rows){const d=String(r.officialDate);const z=rowsByDate.get(d)||[];z.push(r);rowsByDate.set(d,z);}

  type DateEvent={d:number,date:string,pitchers:PitcherMap,league:TypeMap};
  const eventMap=new Map<string,DateEvent>();
  for(const pack of packs){for(const g of pack.games||[]){
    const date=String(g.officialDate);let ev=eventMap.get(date);if(!ev){ev={d:day(date),date,pitchers:new Map(),league:new Map()};eventMap.set(date,ev);}
    for(const raw of g.pitcherPitchTypeTotals||[]){
      const pt=String(raw.pitchType);if(!RECOGNIZED.has(pt))continue;const pid=Number(raw.pitcherId);if(!(pid>0))continue;
      const src:Totals={pitches:Number(raw.pitches||0),strikes:Number(raw.strikes||0),swings:Number(raw.swings||0),whiffs:Number(raw.whiffs||0),velocityN:Number(raw.velocityN||0),velocitySum:Number(raw.velocitySum||0),spinN:Number(raw.spinN||0),spinSum:Number(raw.spinSum||0),battedBallN:Number(raw.battedBallN||0),hardHitN:Number(raw.hardHitN||0)};
      add(getType(getPitcher(ev.pitchers,pid),pt),src);add(getType(ev.league,pt),src);
    }
  }}

  const dates=[...new Set([...eventMap.keys(),...rowsByDate.keys()])].sort();
  const rollingPitchers:PitcherMap=new Map(),rollingLeague:TypeMap=new Map();
  const queue:DateEvent[]=[];
  let qidx=0,comparisons=0,numericMismatch=0,missingMismatch=0,maxDiff=0,starterUsable=0,qualityAvailable=0;const examples:any[]=[];const bySeason:any={};
  const removeEvent=(ev:DateEvent)=>{for(const [pid,tm] of ev.pitchers){const dest=rollingPitchers.get(pid);if(!dest)continue;for(const [pt,src] of tm){const z=dest.get(pt);if(z)add(z,src,-1);}}for(const [pt,src] of ev.league){const z=rollingLeague.get(pt);if(z)add(z,src,-1);}};
  const addEvent=(ev:DateEvent)=>{for(const [pid,tm] of ev.pitchers)for(const [pt,src] of tm)add(getType(getPitcher(rollingPitchers,pid),pt),src);for(const [pt,src] of ev.league)add(getType(rollingLeague,pt),src);queue.push(ev);};
  const cmp=(identity:string,field:string,expected:unknown,actual:number|null)=>{comparisons++;const e=typeof expected==="number"&&Number.isFinite(expected)?expected:null;if(e===null||actual===null){if(e!==actual){missingMismatch++;if(examples.length<20)examples.push({identity,field,expected:e,actual,kind:"MISSINGNESS"});}return;}const diff=Math.abs(e-actual);if(diff>maxDiff)maxDiff=diff;if(diff>TOL){numericMismatch++;if(examples.length<20)examples.push({identity,field,expected:e,actual,diff,kind:"NUMERIC"});}};

  for(const date of dates){const td=day(date),cutoff=td-365;while(qidx<queue.length&&queue[qidx].d<cutoff){removeEvent(queue[qidx]);qidx++;}
    for(const r of rowsByDate.get(date)||[]){const season=String(r.season);bySeason[season]??={rows:0,starterUsable:0,qualityAvailable:0,comparisons:0};bySeason[season].rows++;
      const h=handsBySeason.get(season)?.get(Number(r.gamePk));const usable=h?.usable===true;let homeQ:any=null,awayQ:any=null;
      if(usable){starterUsable++;bySeason[season].starterUsable++;homeQ=quality(Number(h.homePitcherId||0),rollingPitchers,rollingLeague);awayQ=quality(Number(h.awayPitcherId||0),rollingPitchers,rollingLeague);}
      if(homeQ&&awayQ){qualityAvailable++;bySeason[season].qualityAvailable++;}
      const identity=`${season}|${date}|${r.gamePk}`;
      for(const [field,key] of QUALITY_FIELDS){const actual=homeQ&&awayQ?Number(homeQ[key])-Number(awayQ[key]):null;cmp(identity,field,r[field],actual);bySeason[season].comparisons++;}
    }
    const ev=eventMap.get(date);if(ev)addEvent(ev);
  }
  const total=numericMismatch+missingMismatch;
  const report={schemaVersion:"courtedge-mlb-router-input-v62-source-parity.v1",classification:total===0?"V62_RAW_SOURCE_TO_V66_PARITY_PASS":"V62_RAW_SOURCE_TO_V66_PARITY_FAIL",authority:{pitchQualityWorkflowRunId:31925270654,starterCustodyWorkflowRunId:31919873754,v66WorkflowRunId:31962659793,v66PregameCustodyRawSha256:"sha256:1d7a7f35226186b0043606db3762c0e612ea90d6bca71fb4f1616a0dc493add2"},rows:rows.length,starterIdentityUsableRows:starterUsable,qualityAvailableRows:qualityAvailable,qualityFields:QUALITY_FIELDS.map(x=>x[0]),comparisons,tolerance:TOL,maximumAbsoluteDifference:maxDiff,numericMismatches:numericMismatch,missingnessMismatches:missingMismatch,totalMismatches:total,bySeason,mismatchExamples:examples,rollingLookbackDays:365,sameDateStateUpdateAfterScoring:true,targetGameOutcomeUsed:false,productionChanged:false,realFinancialExposure:0};
  mkdirSync(dirname(args.out),{recursive:true});writeFileSync(args.out,JSON.stringify(report,null,2)+"\n");console.log("MLB_ROUTER_INPUT_V62_SOURCE_PARITY_REPORT_BEGIN");console.log(JSON.stringify(report));console.log("MLB_ROUTER_INPUT_V62_SOURCE_PARITY_REPORT_END");if(total!==0)throw new Error(`V62_SOURCE_PARITY_FAILED:${total}`);
}
main();

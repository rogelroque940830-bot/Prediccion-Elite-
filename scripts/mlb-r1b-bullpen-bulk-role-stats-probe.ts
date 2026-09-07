#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-bullpen-bulk-role-stats-probe.v1";
const MLB = "https://statsapi.mlb.com/api/v1";

type Args = { season: string; lineupHistory: string; out: string };
type Frozen = { gamePk:number; officialDate:string; requestedTimecode:string; homeTeamId:number; awayTeamId:number; complete?:boolean; availability?:string };

type RoleFields = {
  gamesStarted:number;
  gamesPlayed:number;
  inningsPitched:number;
  saves:number;
  holds:number;
};

function parseArgs():Args {
  const m=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2){
    const k=process.argv[i],v=process.argv[i+1];
    if(!k?.startsWith("--")||!v) throw new Error(`BULLPEN_BULK_BAD_ARG:${k}`);
    m.set(k.slice(2),v);
  }
  const season=m.get("season"),lineupHistory=m.get("lineup-history"),out=m.get("out");
  if(!season||!lineupHistory||!out) throw new Error("BULLPEN_BULK_REQUIRED_ARGS_MISSING");
  return {season,lineupHistory,out};
}
function readJson(file:string){return JSON.parse(fs.readFileSync(file,"utf8"));}
function choose(doc:any,season:string):Frozen{
  const year=season==="2026_YTD"?"2026":season;
  const floor=`${year}-06-15`;
  const rows:Frozen[]=Array.isArray(doc?.snapshots)?doc.snapshots:[];
  const x=rows.filter(r=>r.complete===true&&r.availability==="COMPLETE"&&String(r.officialDate)>=floor)
    .sort((a,b)=>String(a.officialDate).localeCompare(String(b.officialDate))||Number(a.gamePk)-Number(b.gamePk))[0];
  if(!x) throw new Error(`BULLPEN_BULK_NO_SAMPLE:${season}`);
  return x;
}
function shiftDate(d:string,n:number){const x=new Date(`${d}T12:00:00Z`);x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);}
async function json(url:string){const r=await fetch(url,{headers:{Accept:"application/json","User-Agent":"CourtEdge-R1B-Bullpen-Bulk-Probe/1.0"},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`BULLPEN_BULK_HTTP_${r.status}:${url}`);return r.json();}
function ip(v:unknown){const [w,o]=String(v??"0").split(".");return (parseInt(w||"0",10)||0)+(parseInt(o||"0",10)||0)/3;}
function n(v:unknown){const x=Number(v);return Number.isFinite(x)?x:0;}
function role(s:any):RoleFields|null{if(!s)return null;return {gamesStarted:Math.trunc(n(s.gamesStarted)),gamesPlayed:Math.trunc(n(s.gamesPlayed)),inningsPitched:Math.round(ip(s.inningsPitched)*1e6)/1e6,saves:Math.trunc(n(s.saves)),holds:Math.trunc(n(s.holds))};}
function firstStat(p:any){return p?.stats?.[0]?.splits?.[0]?.stat??null;}
function refLine(p:any){return firstStat(p);}
function splitPlayerId(s:any){const v=Number(s?.player?.id??s?.person?.id);return Number.isInteger(v)&&v>0?v:null;}
function rosterPitchers(p:any):number[]{return (Array.isArray(p?.roster)?p.roster:[]).filter((r:any)=>String(r?.position?.code)==="1").map((r:any)=>Number(r?.person?.id)).filter((x:number)=>Number.isInteger(x)&&x>0).sort((a:number,b:number)=>a-b);}
function mapStatsSplits(payload:any):Map<number,RoleFields>{const m=new Map<number,RoleFields>();for(const block of Array.isArray(payload?.stats)?payload.stats:[]){for(const s of Array.isArray(block?.splits)?block.splits:[]){const id=splitPlayerId(s),r=role(s?.stat);if(id&&r)m.set(id,r);}}return m;}
function mapPeople(payload:any):Map<number,RoleFields>{const m=new Map<number,RoleFields>();for(const p of Array.isArray(payload?.people)?payload.people:[]){const id=Number(p?.id),r=role(firstStat(p));if(Number.isInteger(id)&&id>0&&r)m.set(id,r);}return m;}
function compare(ids:number[],refs:Map<number,RoleFields|null>,candidate:Map<number,RoleFields>){const referenceIds=ids.filter(id=>refs.get(id)!=null);const missing=referenceIds.filter(id=>!candidate.has(id));const mismatched=referenceIds.filter(id=>candidate.has(id)&&JSON.stringify(candidate.get(id))!==JSON.stringify(refs.get(id)));return {rosterPitchers:ids.length,referenceStatLines:referenceIds.length,candidateStatLines:[...candidate.keys()].filter(id=>ids.includes(id)).length,missing,mismatched,exact:missing.length===0&&mismatched.length===0};}
async function side(teamId:number,targetDate:string){
  const prior=shiftDate(targetDate,-1),start=`${targetDate.slice(0,4)}-03-01`;
  const roster=await json(`${MLB}/teams/${teamId}/roster?rosterType=Active&date=${targetDate}`);
  const ids=rosterPitchers(roster);if(!ids.length)throw new Error(`BULLPEN_BULK_EMPTY_ROSTER:${teamId}`);
  const refPairs=await Promise.all(ids.map(async id=>{const p=await json(`${MLB}/people/${id}/stats?stats=byDateRange&group=pitching&startDate=${start}&endDate=${prior}`);return [id,role(refLine(p))] as const;}));
  const refs=new Map<number,RoleFields|null>(refPairs);
  const aUrl=`${MLB}/stats?stats=byDateRange&group=pitching&teamId=${teamId}&startDate=${start}&endDate=${prior}&playerPool=ALL&limit=1000`;
  let aPayload:any=null,aError:string|null=null;try{aPayload=await json(aUrl);}catch(e){aError=e instanceof Error?e.message:String(e);}
  const hydrate=`stats(group=[pitching],type=[byDateRange],startDate=${start},endDate=${prior})`;
  const bUrl=`${MLB}/people?personIds=${ids.join(",")}&hydrate=${encodeURIComponent(hydrate)}`;
  let bPayload:any=null,bError:string|null=null;try{bPayload=await json(bUrl);}catch(e){bError=e instanceof Error?e.message:String(e);}
  const a=compare(ids,refs,aPayload?mapStatsSplits(aPayload):new Map());
  const b=compare(ids,refs,bPayload?mapPeople(bPayload):new Map());
  return {teamId,targetDate,priorDate:prior,rosterPitcherIds:ids,referenceNoStatLineIds:ids.filter(id=>refs.get(id)==null),candidates:{teamStatsByDateRange:{urlShape:"/stats?stats=byDateRange&group=pitching&teamId=...&playerPool=ALL",transportError:aError,...a},peopleHydratedByDateRange:{urlShape:"/people?personIds=...&hydrate=stats(...byDateRange...)",transportError:bError,...b}}};
}
async function main(){const a=parseArgs();const snap=choose(readJson(a.lineupHistory),a.season);const home=await side(Number(snap.homeTeamId),snap.officialDate);const away=await side(Number(snap.awayTeamId),snap.officialDate);const candidates=["teamStatsByDateRange","peopleHydratedByDateRange"] as const;const accepted=candidates.filter(k=>(home.candidates as any)[k].exact&&(away.candidates as any)[k].exact);const report={schemaVersion:SCHEMA,season:a.season,classification:accepted.length?"BULK_ROLE_STATS_ROUTE_EXACT_ON_SAMPLE":"NO_BULK_ROLE_STATS_ROUTE_EXACT_ON_SAMPLE",sample:{gamePk:snap.gamePk,officialDate:snap.officialDate,homeTeamId:snap.homeTeamId,awayTeamId:snap.awayTeamId},home,away,acceptedRoutes:accepted,findings:{perPitcherByDateRangeReference:true,fullRoleFieldParityRequired:true,sampleOnlyNotFullUniverseCertification:true,noTargetOutcomeRead:true,marketPricesRead:false},policy:{researchOnly:true,targetOutcomeFieldsAllowed:false,marketPricesAllowed:false,modelRefitAllowed:false,newWeightsAllowed:false,productionChangeAllowed:false,r1b2AuthorizationChanged:false,favorableResultRequiredForWorkflowSuccess:false}};fs.mkdirSync(path.dirname(a.out),{recursive:true});fs.writeFileSync(a.out,JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify({season:a.season,classification:report.classification,acceptedRoutes:accepted,home:{teamStats:home.candidates.teamStatsByDateRange,people:home.candidates.peopleHydratedByDateRange},away:{teamStats:away.candidates.teamStatsByDateRange,people:away.candidates.peopleHydratedByDateRange}},null,2));}
main().catch(e=>{console.error(e instanceof Error?e.stack??e.message:String(e));process.exitCode=1;});

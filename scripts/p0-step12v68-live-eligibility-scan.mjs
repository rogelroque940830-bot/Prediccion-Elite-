import fs from 'node:fs/promises';
import path from 'node:path';
import { buildMlbP1DailySlate } from '../server/mlb-p1-daily-slate.ts';

const SCHEMA='courtedge-p0-step12v68-live-eligibility-scan.v1';
const FIRST_ELIGIBLE='2026-08-17';
const DEFAULT_MAX_MINUTES=75;

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
function positiveInt(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function easternDate(now=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get=t=>parts.find(p=>p.type===t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''));}
function asIso(v){const ms=Date.parse(String(v||''));return Number.isFinite(ms)?new Date(ms).toISOString():null;}
async function loadJson(p){return JSON.parse(await fs.readFile(p,'utf8'));}
async function saveJson(p,v){await fs.mkdir(path.dirname(p)||'.',{recursive:true});await fs.writeFile(p,`${JSON.stringify(v,null,2)}\n`,'utf8');}

const nowArg=arg('--now');
const now=nowArg?new Date(nowArg):new Date();
if(!Number.isFinite(now.getTime()))throw new Error('V68_LIVE_SCAN_INVALID_NOW');
const date=arg('--date')||easternDate(now);
if(!validDate(date))throw new Error(`V68_LIVE_SCAN_INVALID_DATE:${date}`);
const out=arg('--out');
if(!out)throw new Error('V68_LIVE_SCAN_OUT_REQUIRED');
const maxMinutes=Number(arg('--max-minutes-before-start')??DEFAULT_MAX_MINUTES);
if(!Number.isFinite(maxMinutes)||maxMinutes<=0||maxMinutes>180)throw new Error('V68_LIVE_SCAN_WINDOW_INVALID');

let slate;
const slatePath=arg('--slate-json');
if(slatePath){
  slate=await loadJson(slatePath);
}else{
  slate=await buildMlbP1DailySlate({date,now});
}
if(!slate||!Array.isArray(slate.games))throw new Error('V68_LIVE_SCAN_SLATE_INVALID');

const rows=[];
const skipped=[];
for(const g of slate.games){
  const gp=positiveInt(g.gamePk);
  const start=asIso(g.startTime);
  const officialDate=String(g.officialDate||'');
  const reasons=[];
  if(!gp)reasons.push('GAME_PK_INVALID');
  if(!validDate(officialDate))reasons.push('OFFICIAL_DATE_INVALID');
  if(officialDate<FIRST_ELIGIBLE)reasons.push('PRE_FREEZE_DATE');
  if(!start)reasons.push('START_TIME_INVALID');
  const startMs=start?Date.parse(start):NaN;
  const minutesToStart=Number.isFinite(startMs)?(startMs-now.getTime())/60000:null;
  if(minutesToStart===null||minutesToStart<=0)reasons.push('NOT_STRICTLY_PREGAME');
  if(minutesToStart!==null&&minutesToStart>maxMinutes)reasons.push('OUTSIDE_CAPTURE_WINDOW');
  if(g.state==='IN_PROGRESS'||g.state==='FINAL'||g.state==='POSTPONED'||g.state==='CANCELLED'||g.state==='SUSPENDED')reasons.push(`STATE_${g.state}`);
  if(g.readiness!=='READY_TO_ANALYZE')reasons.push(`READINESS_${g.readiness||'UNKNOWN'}`);
  if(g.lineupState!=='CONFIRMED'||Number(g.homeLineupCount)<9||Number(g.awayLineupCount)<9)reasons.push('LINEUP_NOT_CONFIRMED_9X9');
  if(!g.homePitcher?.confirmed||!positiveInt(g.homePitcher?.id)||!g.awayPitcher?.confirmed||!positiveInt(g.awayPitcher?.id))reasons.push('PROBABLE_STARTERS_NOT_CONFIRMED');
  if(g.source?.quality!=='AUTHORITATIVE')reasons.push('SOURCE_NOT_AUTHORITATIVE');
  if(reasons.length){skipped.push({gamePk:gp,officialDate,startTime:start,minutesToStart,reasons});continue;}
  rows.push({
    gamePk:gp,
    officialDate,
    homeTeamId:positiveInt(g.homeTeam?.id),
    awayTeamId:positiveInt(g.awayTeam?.id),
    homePitcherId:positiveInt(g.homePitcher?.id),
    awayPitcherId:positiveInt(g.awayPitcher?.id),
    startTime:start,
    observedAt:now.toISOString(),
    minutesToStart,
    lineupState:'CONFIRMED',
    homeLineupCount:Number(g.homeLineupCount),
    awayLineupCount:Number(g.awayLineupCount),
    readiness:'READY_TO_ANALYZE',
    sourceQuality:'AUTHORITATIVE',
    exactPregameLineupSemantics:true,
    exactPregameProbableStarterSemantics:true,
    wholeOfficialDatePriorStateOnly:true,
    containsOutcome:false,
    containsMarketPrice:false,
  });
}
rows.sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime)||a.gamePk-b.gamePk);
const payload={
  schemaVersion:SCHEMA,
  scientificStatus:'LIVE_PREGAME_ELIGIBILITY_ONLY_NOT_YET_CANONICAL_V68_CAPTURE',
  generatedAt:now.toISOString(),date,firstEligibleOfficialDate:FIRST_ELIGIBLE,maxMinutesBeforeStart:maxMinutes,
  rows,skipped,
  summary:{slateGames:slate.games.length,eligibleNow:rows.length,skipped:skipped.length},
  policy:{researchOnly:true,outcomesRead:false,pricesRead:false,canonicalV68ProbabilitiesCaptured:false,productionV16Changed:false,rankingChanged:false,stakeChanged:false,betEliteAllowed:false,automaticBetPlacementAllowed:false,realFinancialExposure:0},
};
await saveJson(out,payload);
console.log(JSON.stringify(payload.summary,null,2));

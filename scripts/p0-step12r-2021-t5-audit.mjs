import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fetchMlbHistoricalPregameLineups } from '../server/mlb-market-pregame-lineup-history.ts';
import { fetchMlbHistoricalStartingPitcherHistory } from '../server/mlb-market-starting-pitcher-history.ts';

const REQUEST_TIMEOUT_MS=20_000;
const MAX_ATTEMPTS=3;

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
function positive(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function sha256(v){return crypto.createHash('sha256').update(v).digest('hex');}
function isoInstant(v){const t=String(v??'').trim();if(!t)return null;const ms=Date.parse(t);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
function isoDate(v){const t=String(v??'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(t)?t:null;}
function obsolete(g){const coded=String(g?.status?.codedGameState??'').trim().toUpperCase();const detailed=String(g?.status?.detailedState??'').trim();return coded==='D'||/^(Postponed|Canceled|Cancelled|Suspended)$/i.test(detailed);}
function candidate(g,d){return{gamePk:Number(g?.gamePk),officialDate:String(g?.officialDate??d?.date??'').slice(0,10),scheduledStart:isoInstant(g?.gameDate),homeTeamId:Number(g?.teams?.home?.team?.id),awayTeamId:Number(g?.teams?.away?.team?.id),codedGameState:String(g?.status?.codedGameState??'').trim(),detailedState:String(g?.status?.detailedState??'').trim(),resumeDate:isoInstant(g?.resumeDate),resumeGameDate:isoDate(g?.resumeGameDate),resumedFrom:isoInstant(g?.resumedFrom),resumedFromDate:isoDate(g?.resumedFromDate)};}
function exactSuspendedPair(rows){
  if(rows.length!==2)return false;
  const originals=rows.filter(x=>x.resumeDate!=null&&x.resumedFrom==null);
  const resumed=rows.filter(x=>x.resumedFrom!=null&&x.resumeDate==null);
  if(originals.length!==1||resumed.length!==1)return false;
  const o=originals[0],c=resumed[0];
  return o.homeTeamId===c.homeTeamId&&o.awayTeamId===c.awayTeamId
    &&o.officialDate===c.officialDate
    &&o.resumeDate===c.scheduledStart
    &&c.resumedFrom===o.scheduledStart
    &&o.resumeGameDate!=null&&c.resumedFromDate!=null
    &&c.resumedFromDate===o.officialDate
    &&o.codedGameState.toUpperCase()==='F'&&c.codedGameState.toUpperCase()==='F';
}

export function normalizeStep12r2021Schedule(payload){
  const groups=new Map();
  for(const d of Array.isArray(payload?.dates)?payload.dates:[]){for(const g of Array.isArray(d?.games)?d.games:[]){const pk=positive(g?.gamePk);if(!pk)continue;const xs=groups.get(pk)??[];xs.push({raw:g,dateEntry:d,c:candidate(g,d)});groups.set(pk,xs);}}
  const normalized=new Set();
  for(const [pk,xs] of groups){
    if(xs.length<3)continue;
    const nonObsolete=xs.filter(x=>!obsolete(x.raw));
    const obsoleteRows=xs.filter(x=>obsolete(x.raw));
    if(obsoleteRows.length>0&&exactSuspendedPair(nonObsolete.map(x=>x.c)))normalized.add(pk);
  }
  if(!normalized.size)return{payload,normalizedGamePks:[],removedRows:0};
  let removed=0;
  const dates=(Array.isArray(payload?.dates)?payload.dates:[]).map(d=>({...d,games:(Array.isArray(d?.games)?d.games:[]).filter(g=>{const pk=positive(g?.gamePk);if(pk&&normalized.has(pk)&&obsolete(g)){removed+=1;return false;}return true;})}));
  return{payload:{...payload,dates},normalizedGamePks:[...normalized].sort((a,b)=>a-b),removedRows:removed};
}

function selfTest(){
  const team={home:{team:{id:144}},away:{team:{id:135}}};
  const p={dates:[
    {date:'2021-07-19',games:[{gamePk:633224,gameType:'R',gameDate:'2021-07-19T23:20:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'D',detailedState:'Postponed'}}]},
    {date:'2021-07-21',games:[{gamePk:633224,gameType:'R',gameDate:'2021-07-21T21:20:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'F',detailedState:'Final'},resumeDate:'2021-09-25T00:10:00Z',resumeGameDate:'2021-09-24'}]},
    {date:'2021-09-24',games:[{gamePk:633224,gameType:'R',gameDate:'2021-09-25T00:10:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'F',detailedState:'Final'},resumedFrom:'2021-07-21T21:20:00Z',resumedFromDate:'2021-07-21'}]}
  ]};
  const ok=normalizeStep12r2021Schedule(p);assert.deepEqual(ok.normalizedGamePks,[633224]);assert.equal(ok.removedRows,1);assert.equal(ok.payload.dates.flatMap(d=>d.games).length,2);
  const bad=structuredClone(p);bad.dates[2].games[0].resumedFrom='2021-07-21T22:20:00Z';const no=normalizeStep12r2021Schedule(bad);assert.deepEqual(no.normalizedGamePks,[]);assert.equal(no.removedRows,0);assert.equal(no.payload.dates.flatMap(d=>d.games).length,3);
  console.log('STEP12R_2021_SCHEDULE_NORMALIZER_SELF_TEST_OK');
}

async function sleep(ms){if(ms>0)await new Promise(r=>setTimeout(r,ms));}
async function fetchJson(url){let last;for(let a=1;a<=MAX_ATTEMPTS;a++){try{const r=await fetch(url,{headers:{'User-Agent':'CourtEdge-Step12R/1.0',Accept:'application/json'},signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});if(r.ok)return r.json();last=new Error(`HTTP_${r.status}`);if(r.status<500&&r.status!==429)throw last;}catch(e){last=e;if(a===MAX_ATTEMPTS)throw e;}await sleep(250*2**(a-1));}throw last;}
async function mapConcurrency(values,n,fn){const out=new Array(values.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=values.length)return;out[i]=await fn(values[i],i);}}await Promise.all(Array.from({length:Math.min(n,Math.max(1,values.length))},worker));return out;}
function pregame(payload){const coded=String(payload?.gameData?.status?.codedGameState??'').toUpperCase();const detailed=String(payload?.gameData?.status?.detailedState??'');if(['I','F','O'].includes(coded))return false;if(/^(In Progress|Final|Game Over|Completed Early)$/i.test(detailed))return false;return true;}

if(process.argv.includes('--self-test')){selfTest();process.exit(0);}

const start=arg('--start'),end=arg('--end'),outRoot=arg('--out')??'artifacts/p0-step12r/2021-preflight',concurrency=Number(arg('--concurrency')??6);
if(!/^\d{4}-\d{2}-\d{2}$/.test(start??'')||!/^\d{4}-\d{2}-\d{2}$/.test(end??''))throw new Error('STEP12R_DATE_REQUIRED');
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new Error('STEP12R_CONCURRENCY_INVALID');
await fs.mkdir(outRoot,{recursive:true});
const normalization={normalizedGamePks:new Set(),removedRows:0,scheduleResponses:0};
const normalizingFetch=async(input,init)=>{
  const r=await fetch(input,init);const url=String(input);
  if(!r.ok||!url.includes('/v1/schedule?'))return r;
  const body=await r.json();const n=normalizeStep12r2021Schedule(body);normalization.scheduleResponses+=1;normalization.removedRows+=n.removedRows;for(const pk of n.normalizedGamePks)normalization.normalizedGamePks.add(pk);
  return new Response(JSON.stringify(n.payload),{status:r.status,statusText:r.statusText,headers:r.headers});
};
const lineups=await fetchMlbHistoricalPregameLineups({startDate:start,endDate:end,cutoffSecondsBeforeScheduledStart:300,concurrency,fetchImpl:normalizingFetch});
if(lineups.failures.length)throw new Error(`STEP12R_LINEUP_SOURCE_FAILURES:${lineups.failures.length}`);
const finals=await fetchMlbHistoricalStartingPitcherHistory({startDate:start,endDate:end,concurrency});
if(finals.failures.length)throw new Error(`STEP12R_FINAL_STARTER_SOURCE_FAILURES:${finals.failures.length}`);
const finalMap=new Map(finals.games.map(g=>[Number(g.gamePk),g]));
const rows=await mapConcurrency(lineups.snapshots,concurrency,async s=>{const url=`https://statsapi.mlb.com/api/v1.1/game/${s.gamePk}/feed/live?timecode=${encodeURIComponent(s.requestedTimecode)}`;const p=await fetchJson(url);const payloadGamePk=positive(p?.gamePk);const homeTeamId=positive(p?.gameData?.teams?.home?.id),awayTeamId=positive(p?.gameData?.teams?.away?.id);const sourceTime=String(p?.metaData?.timeStamp??'').trim();const homeProbable=positive(p?.gameData?.probablePitchers?.home?.id),awayProbable=positive(p?.gameData?.probablePitchers?.away?.id);const fg=finalMap.get(Number(s.gamePk));const identityOk=payloadGamePk===Number(s.gamePk)&&homeTeamId===Number(s.homeTeamId)&&awayTeamId===Number(s.awayTeamId);const sourceHistorical=/^\d{8}_\d{6}$/.test(sourceTime)&&sourceTime<=s.requestedTimecode;const validPregame=identityOk&&sourceHistorical&&pregame(p);return{gamePk:Number(s.gamePk),officialDate:s.officialDate,cutoffAt:s.cutoffAt,requestedTimecode:s.requestedTimecode,sourceMetadataTimecode:sourceTime||null,lineupComplete:Boolean(s.complete),identityOk,sourceHistorical,pregame:validPregame,homeProbablePitcherId:homeProbable,awayProbablePitcherId:awayProbable,probableBothKnown:validPregame&&homeProbable!=null&&awayProbable!=null,finalHomeStarterId:fg?Number(fg.homeStarter.pitcherId):null,finalAwayStarterId:fg?Number(fg.awayStarter.pitcherId):null,homeMatchesFinal:homeProbable!=null&&fg?homeProbable===Number(fg.homeStarter.pitcherId):null,awayMatchesFinal:awayProbable!=null&&fg?awayProbable===Number(fg.awayStarter.pitcherId):null};});
const validRows=rows.filter(r=>r.identityOk&&r.sourceHistorical&&r.pregame),both=validRows.filter(r=>r.probableBothKnown),mismatched=both.filter(r=>!r.homeMatchesFinal||!r.awayMatchesFinal),lineupAndStarter=both.filter(r=>r.lineupComplete);
const normalizedGamePks=[...normalization.normalizedGamePks].sort((a,b)=>a-b);
const report={schemaVersion:'courtedge-p0-step12h-t5-starter-identity-audit.v1',evidenceStatus:'DIAGNOSTIC_ONLY_NO_PROMOTION',range:{startDate:start,endDate:end},cutoffSecondsBeforeScheduledStart:300,counts:{snapshots:rows.length,validPregameSnapshots:validRows.length,bothProbablePitchersKnown:both.length,bothProbableCoveragePct:validRows.length?100*both.length/validRows.length:0,completeLineupAndBothProbables:lineupAndStarter.length,completeLineupAndBothProbablesPct:validRows.length?100*lineupAndStarter.length/validRows.length:0,probableVsFinalMismatchGames:mismatched.length,probableVsFinalMismatchPctOfKnown:both.length?100*mismatched.length/both.length:0},mismatches:mismatched,rows,step12rScheduleNormalization:{scope:'RESEARCH_ONLY_2021_PREFLIGHT',policy:'REMOVE_ONLY_EXPLICITLY_OBSOLETE_ROWS_WHEN_REMAINING_ROWS_FORM_EXACT_SUSPENDED_ORIGINAL_RESUMED_PAIR',normalizedGamePks,removedRows:normalization.removedRows,scheduleResponses:normalization.scheduleResponses,ambiguousFallbackAllowed:false},interpretation:{boxscoreStarterMaySubstituteFutureIdentity:true,t5ProbableIdentityIsRequiredForPregameStarterFeatures:true,thresholdRetuningAllowed:false,canProduceBetElite:false,canChangeLiveFilters:false},digests:{rowsSha256:sha256(JSON.stringify(rows)),lineupHistoryDigest:lineups.lineupHistoryDigest,finalStarterHistoryDigest:finals.starterHistoryDigest}};
await fs.writeFile(path.join(outRoot,'t5-starter-identity-audit.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({ok:true,range:report.range,counts:report.counts,step12rScheduleNormalization:report.step12rScheduleNormalization,researchOnly:true},null,2));

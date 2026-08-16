import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchMlbHistoricalPregameLineups } from '../server/mlb-market-pregame-lineup-history.ts';
import { fetchMlbHistoricalStartingPitcherHistory } from '../server/mlb-market-starting-pitcher-history.ts';

const REQUEST_TIMEOUT_MS=20_000;
const MAX_ATTEMPTS=3;

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
function positive(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function sha256(v){return crypto.createHash('sha256').update(v).digest('hex');}
async function sleep(ms){if(ms>0)await new Promise(r=>setTimeout(r,ms));}
async function fetchJson(url){let last;for(let a=1;a<=MAX_ATTEMPTS;a++){try{const r=await fetch(url,{headers:{'User-Agent':'CourtEdge-Step12H/1.0',Accept:'application/json'},signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});if(r.ok)return r.json();last=new Error(`HTTP_${r.status}`);if(r.status<500&&r.status!==429)throw last;}catch(e){last=e;if(a===MAX_ATTEMPTS)throw e;}await sleep(250*2**(a-1));}throw last;}
async function mapConcurrency(values,n,fn){const out=new Array(values.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=values.length)return;out[i]=await fn(values[i],i);}}await Promise.all(Array.from({length:Math.min(n,Math.max(1,values.length))},worker));return out;}
function pregame(payload){const coded=String(payload?.gameData?.status?.codedGameState??'').toUpperCase();const detailed=String(payload?.gameData?.status?.detailedState??'');if(['I','F','O'].includes(coded))return false;if(/^(In Progress|Final|Game Over|Completed Early)$/i.test(detailed))return false;return true;}

const start=arg('--start'); const end=arg('--end'); const outRoot=arg('--out')??'artifacts/p0-step12h'; const concurrency=Number(arg('--concurrency')??6);
if(!/^\d{4}-\d{2}-\d{2}$/.test(start??'')||!/^\d{4}-\d{2}-\d{2}$/.test(end??''))throw new Error('STEP12H_DATE_REQUIRED');
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new Error('STEP12H_CONCURRENCY_INVALID');
await fs.mkdir(outRoot,{recursive:true});

const lineups=await fetchMlbHistoricalPregameLineups({startDate:start,endDate:end,cutoffSecondsBeforeScheduledStart:300,concurrency});
if(lineups.failures.length)throw new Error(`STEP12H_LINEUP_SOURCE_FAILURES:${lineups.failures.length}`);
const finals=await fetchMlbHistoricalStartingPitcherHistory({startDate:start,endDate:end,concurrency});
if(finals.failures.length)throw new Error(`STEP12H_FINAL_STARTER_SOURCE_FAILURES:${finals.failures.length}`);
const finalMap=new Map(finals.games.map(g=>[Number(g.gamePk),g]));

const rows=await mapConcurrency(lineups.snapshots,concurrency,async s=>{
  const url=`https://statsapi.mlb.com/api/v1.1/game/${s.gamePk}/feed/live?timecode=${encodeURIComponent(s.requestedTimecode)}`;
  const p=await fetchJson(url);
  const payloadGamePk=positive(p?.gamePk);
  const homeTeamId=positive(p?.gameData?.teams?.home?.id); const awayTeamId=positive(p?.gameData?.teams?.away?.id);
  const sourceTime=String(p?.metaData?.timeStamp??'').trim();
  const homeProbable=positive(p?.gameData?.probablePitchers?.home?.id); const awayProbable=positive(p?.gameData?.probablePitchers?.away?.id);
  const fg=finalMap.get(Number(s.gamePk));
  const identityOk=payloadGamePk===Number(s.gamePk)&&homeTeamId===Number(s.homeTeamId)&&awayTeamId===Number(s.awayTeamId);
  const sourceHistorical=/^\d{8}_\d{6}$/.test(sourceTime)&&sourceTime<=s.requestedTimecode;
  const validPregame=identityOk&&sourceHistorical&&pregame(p);
  return {gamePk:Number(s.gamePk),officialDate:s.officialDate,cutoffAt:s.cutoffAt,requestedTimecode:s.requestedTimecode,sourceMetadataTimecode:sourceTime||null,
    lineupComplete:Boolean(s.complete),identityOk,sourceHistorical,pregame:validPregame,
    homeProbablePitcherId:homeProbable,awayProbablePitcherId:awayProbable,
    probableBothKnown:validPregame&&homeProbable!=null&&awayProbable!=null,
    finalHomeStarterId:fg?Number(fg.homeStarter.pitcherId):null,finalAwayStarterId:fg?Number(fg.awayStarter.pitcherId):null,
    homeMatchesFinal:homeProbable!=null&&fg?homeProbable===Number(fg.homeStarter.pitcherId):null,
    awayMatchesFinal:awayProbable!=null&&fg?awayProbable===Number(fg.awayStarter.pitcherId):null};
});

const validRows=rows.filter(r=>r.identityOk&&r.sourceHistorical&&r.pregame);
const both=validRows.filter(r=>r.probableBothKnown);
const mismatched=both.filter(r=>!r.homeMatchesFinal||!r.awayMatchesFinal);
const lineupAndStarter=both.filter(r=>r.lineupComplete);
const report={schemaVersion:'courtedge-p0-step12h-t5-starter-identity-audit.v1',evidenceStatus:'DIAGNOSTIC_ONLY_NO_PROMOTION',range:{startDate:start,endDate:end},cutoffSecondsBeforeScheduledStart:300,
  counts:{snapshots:rows.length,validPregameSnapshots:validRows.length,bothProbablePitchersKnown:both.length,bothProbableCoveragePct:validRows.length?100*both.length/validRows.length:0,
    completeLineupAndBothProbables:lineupAndStarter.length,completeLineupAndBothProbablesPct:validRows.length?100*lineupAndStarter.length/validRows.length:0,
    probableVsFinalMismatchGames:mismatched.length,probableVsFinalMismatchPctOfKnown:both.length?100*mismatched.length/both.length:0},
  mismatches:mismatched,rows,
  interpretation:{boxscoreStarterMaySubstituteFutureIdentity:true,t5ProbableIdentityIsRequiredForPregameStarterFeatures:true,thresholdRetuningAllowed:false,canProduceBetElite:false,canChangeLiveFilters:false},
  digests:{rowsSha256:sha256(JSON.stringify(rows)),lineupHistoryDigest:lineups.lineupHistoryDigest,finalStarterHistoryDigest:finals.starterHistoryDigest}};
await fs.writeFile(path.join(outRoot,'t5-starter-identity-audit.json'),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify({ok:true,range:report.range,counts:report.counts,researchOnly:true},null,2));

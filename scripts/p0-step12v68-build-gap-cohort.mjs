import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchMlbHistoricalOfficialGames } from '../server/mlb-market-historical-source.ts';
import { buildMlbHistoricalDataset } from '../server/mlb-market-historical-dataset.ts';
import { fetchMlbHistoricalStartingPitcherHistory } from '../server/mlb-market-starting-pitcher-history.ts';
import { fetchMlbHistoricalPregameLineups } from '../server/mlb-market-pregame-lineup-history.ts';

const CUTOFF_SECONDS=300;
const REQUEST_TIMEOUT_MS=20_000;
const MAX_ATTEMPTS=3;
const COHORT_SCHEMA='courtedge-p0-step12v68-gap-cohort.v1';
const AUDIT_SCHEMA='courtedge-p0-step12h-t5-starter-identity-audit.v1';
function arg(n){const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:null;}
function positive(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function sha256(v){return crypto.createHash('sha256').update(v).digest('hex');}
function pks(v){return[...new Set(v.map(Number).filter(x=>Number.isInteger(x)&&x>0))].sort((a,b)=>a-b);}
async function writeJson(f,v){const t=`${JSON.stringify(v,null,2)}\n`;await fs.writeFile(f,t,'utf8');return{file:path.basename(f),sha256:sha256(t),bytes:Buffer.byteLength(t)};}
async function sleep(ms){if(ms>0)await new Promise(r=>setTimeout(r,ms));}
async function fetchJson(url){let last;for(let a=1;a<=MAX_ATTEMPTS;a++){try{const r=await fetch(url,{headers:{'User-Agent':'CourtEdge-V68-Gap/1.0',Accept:'application/json'},signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});if(r.ok)return r.json();last=new Error(`HTTP_${r.status}`);if(r.status<500&&r.status!==429)throw last;}catch(e){last=e;if(a===MAX_ATTEMPTS)throw e;}await sleep(250*2**(a-1));}throw last;}
async function mapConcurrency(values,n,fn){const out=new Array(values.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=values.length)return;out[i]=await fn(values[i],i);}}await Promise.all(Array.from({length:Math.min(n,Math.max(1,values.length))},worker));return out;}
function pregame(payload){const coded=String(payload?.gameData?.status?.codedGameState??'').toUpperCase();const detailed=String(payload?.gameData?.status?.detailedState??'');if(['I','F','O'].includes(coded))return false;if(/^(In Progress|Final|Game Over|Completed Early)$/i.test(detailed))return false;return true;}

const startDate=arg('--start'),endDate=arg('--end'),outRoot=arg('--out');const concurrency=Number(arg('--concurrency')??4);
if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate??'')||!/^\d{4}-\d{2}-\d{2}$/.test(endDate??'')||!outRoot)throw new Error('V68_GAP_REQUIRED_ARGUMENT_MISSING');
if(startDate<'2026-08-11')throw new Error('V68_GAP_PRE_FROZEN_BASE_RANGE_FORBIDDEN');
if(endDate<startDate)throw new Error('V68_GAP_RANGE_INVALID');
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new Error('V68_GAP_CONCURRENCY_INVALID');
await fs.mkdir(outRoot,{recursive:true});const generatedAt=new Date().toISOString();

const official=await fetchMlbHistoricalOfficialGames({startDate,endDate,concurrency});
if(official.failures.length)throw new Error(`V68_GAP_OFFICIAL_INCOMPLETE:${official.failures.length}`);
const officialArtifact=await writeJson(path.join(outRoot,'official-acquisition.json'),official);
const dataset=buildMlbHistoricalDataset(official.games,{generatedAt});
if(dataset.regularSeasonFinalGames!==official.officialFinalGames)throw new Error('V68_GAP_DATASET_COUNT_MISMATCH');
const datasetArtifact=await writeJson(path.join(outRoot,'dataset.json'),dataset);
const starter=await fetchMlbHistoricalStartingPitcherHistory({startDate,endDate,concurrency});
if(starter.failures.length||starter.gamesWithBothStarters!==dataset.regularSeasonFinalGames)throw new Error('V68_GAP_STARTER_INCOMPLETE');
const starterArtifact=await writeJson(path.join(outRoot,'starting-pitcher-history.json'),starter);
const lineupSource=await fetchMlbHistoricalPregameLineups({startDate,endDate,cutoffSecondsBeforeScheduledStart:CUTOFF_SECONDS,concurrency});
if(lineupSource.failures.length)throw new Error(`V68_GAP_LINEUP_INCOMPLETE:${lineupSource.failures.length}`);
if(lineupSource.sourceVersion!=='statsapi.mlb.com-v1.1-timecode-pregame-lineup.v4')throw new Error(`V68_GAP_LINEUP_SOURCE_DRIFT:${lineupSource.sourceVersion}`);
const lineupSourceArtifact=await writeJson(path.join(outRoot,'pregame-lineup-history-source.json'),lineupSource);
const officialPks=pks(official.games.map(g=>g.gamePk)),starterPks=pks(starter.games.map(g=>g.gamePk));
if(JSON.stringify(officialPks)!==JSON.stringify(starterPks))throw new Error('V68_GAP_STARTER_IDENTITY_MISMATCH');
const byPk=new Map();for(const s of lineupSource.snapshots){if(byPk.has(Number(s.gamePk)))throw new Error(`V68_GAP_DUPLICATE_LINEUP:${s.gamePk}`);byPk.set(Number(s.gamePk),s);}
const missing=officialPks.filter(x=>!byPk.has(x));if(missing.length)throw new Error(`V68_GAP_LINEUP_MISSING:${missing.length}`);
const cohortSnapshots=officialPks.map(x=>byPk.get(x));
const lineup={schemaVersion:'courtedge-p0-step12m-cohort-pregame-lineups.v1',sourceVersion:lineupSource.sourceVersion,generatedAt,startDate,endDate,cutoffSecondsBeforeScheduledStart:CUTOFF_SECONDS,cohortDefinition:'OFFICIAL_FINAL_GAME_PK_INTERSECTION',officialFinalGames:officialPks.length,snapshotsFetched:cohortSnapshots.length,completeLineupGames:cohortSnapshots.filter(s=>s.complete).length,completeLineupCoveragePct:officialPks.length?100*cohortSnapshots.filter(s=>s.complete).length/officialPks.length:0,snapshots:cohortSnapshots,researchOnly:true};
const lineupArtifact=await writeJson(path.join(outRoot,'pregame-lineup-history.json'),lineup);

const finalMap=new Map(starter.games.map(g=>[Number(g.gamePk),g]));
const auditRows=await mapConcurrency(cohortSnapshots,concurrency,async s=>{
  const url=`https://statsapi.mlb.com/api/v1.1/game/${s.gamePk}/feed/live?timecode=${encodeURIComponent(s.requestedTimecode)}`;const p=await fetchJson(url);
  const payloadGamePk=positive(p?.gamePk);const homeTeamId=positive(p?.gameData?.teams?.home?.id),awayTeamId=positive(p?.gameData?.teams?.away?.id);const sourceTime=String(p?.metaData?.timeStamp??'').trim();const homeProbable=positive(p?.gameData?.probablePitchers?.home?.id),awayProbable=positive(p?.gameData?.probablePitchers?.away?.id);const fg=finalMap.get(Number(s.gamePk));
  const identityOk=payloadGamePk===Number(s.gamePk)&&homeTeamId===Number(s.homeTeamId)&&awayTeamId===Number(s.awayTeamId);const sourceHistorical=/^\d{8}_\d{6}$/.test(sourceTime)&&sourceTime<=s.requestedTimecode;const validPregame=identityOk&&sourceHistorical&&pregame(p);
  return{gamePk:Number(s.gamePk),officialDate:s.officialDate,cutoffAt:s.cutoffAt,requestedTimecode:s.requestedTimecode,sourceMetadataTimecode:sourceTime||null,lineupComplete:Boolean(s.complete),identityOk,sourceHistorical,pregame:validPregame,homeProbablePitcherId:homeProbable,awayProbablePitcherId:awayProbable,probableBothKnown:validPregame&&homeProbable!=null&&awayProbable!=null,finalHomeStarterId:fg?Number(fg.homeStarter.pitcherId):null,finalAwayStarterId:fg?Number(fg.awayStarter.pitcherId):null,homeMatchesFinal:homeProbable!=null&&fg?homeProbable===Number(fg.homeStarter.pitcherId):null,awayMatchesFinal:awayProbable!=null&&fg?awayProbable===Number(fg.awayStarter.pitcherId):null};
});
const validRows=auditRows.filter(r=>r.identityOk&&r.sourceHistorical&&r.pregame);const both=validRows.filter(r=>r.probableBothKnown);const mismatched=both.filter(r=>!r.homeMatchesFinal||!r.awayMatchesFinal);const canonical=auditRows.filter(r=>r.identityOk&&r.sourceHistorical&&r.pregame&&r.lineupComplete);
const audit={schemaVersion:AUDIT_SCHEMA,evidenceStatus:'V68_PROSPECTIVE_HISTORY_ADAPTER_ONLY',range:{startDate,endDate},cutoffSecondsBeforeScheduledStart:CUTOFF_SECONDS,counts:{snapshots:auditRows.length,validPregameSnapshots:validRows.length,bothProbablePitchersKnown:both.length,completeLineupAndBothProbables:both.filter(r=>r.lineupComplete).length,probableVsFinalMismatchGames:mismatched.length,canonicalT5EquivalentGames:canonical.length},mismatches:mismatched,rows:auditRows,interpretation:{canonicalT5EquivalentDefinition:'IDENTITY_OK_AND_SOURCE_HISTORICAL_AND_PREGAME_AND_LINEUP_COMPLETE',boxscoreStarterMaySubstituteFutureIdentity:true,currentMetadataFallbackAllowed:false},digests:{rowsSha256:sha256(JSON.stringify(auditRows)),lineupHistoryDigest:lineupSource.lineupHistoryDigest,finalStarterHistoryDigest:starter.starterHistoryDigest}};
const auditArtifact=await writeJson(path.join(outRoot,'t5-starter-identity-audit.json'),audit);
const manifest={schemaVersion:COHORT_SCHEMA,generatedAt,range:{startDate,endDate},officialFinalGames:officialPks.length,canonicalT5EquivalentGames:canonical.length,canonicalGamePks:canonical.map(r=>r.gamePk).sort((a,b)=>a-b),artifacts:[officialArtifact,datasetArtifact,starterArtifact,lineupSourceArtifact,lineupArtifact,auditArtifact],policy:{researchOnly:true,currentMetadataFallbackAllowed:false,sameDateHistoryAllowed:false,outcomesUsedForFuturePregameFeaturesOnlyAfterOfficialDate:false,marketPricesUsed:false,productionChanged:false,betEliteAllowed:false,realFinancialExposure:0}};
await writeJson(path.join(outRoot,'v68-gap-cohort-manifest.json'),manifest);
console.log(JSON.stringify({ok:true,range:manifest.range,officialFinalGames:manifest.officialFinalGames,canonicalT5EquivalentGames:manifest.canonicalT5EquivalentGames,researchOnly:true},null,2));

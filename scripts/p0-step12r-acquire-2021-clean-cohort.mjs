import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fetchMlbHistoricalOfficialGames } from '../server/mlb-market-historical-source.ts';
import { buildMlbHistoricalDataset } from '../server/mlb-market-historical-dataset.ts';
import { fetchMlbHistoricalStartingPitcherHistory } from '../server/mlb-market-starting-pitcher-history.ts';
import { fetchMlbHistoricalPregameLineups } from '../server/mlb-market-pregame-lineup-history.ts';

const CUTOFF_SECONDS = 300;
const SCHEMA = 'courtedge-p0-step12r-2021-clean-cohort.v1';
const LINEUP_SCHEMA = 'courtedge-p0-step12r-2021-pregame-lineups.v1';
const NORMALIZATION_POLICY = 'REMOVE_ONLY_EXPLICITLY_OBSOLETE_ROWS_WHEN_REMAINING_ROWS_FORM_EXACT_SUSPENDED_ORIGINAL_RESUMED_PAIR';
const FROZEN_START = '2021-03-01';
const FROZEN_END = '2021-10-04';
const FROZEN_ROLE = 'EXTERNAL_INVALIDATOR_REPLICATION_2021_FROZEN';

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
function positive(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function sha256(v){return crypto.createHash('sha256').update(v).digest('hex');}
async function writeJson(file,value){const text=`${JSON.stringify(value,null,2)}\n`;await fs.writeFile(file,text,'utf8');return{file:path.basename(file),sha256:sha256(text),bytes:Buffer.byteLength(text)};}
function pks(values){return[...new Set(values.map(Number).filter(x=>Number.isInteger(x)&&x>0))].sort((a,b)=>a-b);}
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
function normalizeSchedule(payload){
  const groups=new Map();
  for(const d of Array.isArray(payload?.dates)?payload.dates:[]){
    for(const g of Array.isArray(d?.games)?d.games:[]){
      const pk=positive(g?.gamePk);if(!pk)continue;
      const xs=groups.get(pk)??[];xs.push({raw:g,c:candidate(g,d)});groups.set(pk,xs);
    }
  }
  const normalized=new Set();
  for(const [pk,xs] of groups){
    if(xs.length<3)continue;
    const nonObsolete=xs.filter(x=>!obsolete(x.raw));
    const obsoleteRows=xs.filter(x=>obsolete(x.raw));
    if(obsoleteRows.length>0&&exactSuspendedPair(nonObsolete.map(x=>x.c)))normalized.add(pk);
  }
  if(!normalized.size)return{payload,normalizedGamePks:[],removedRows:0};
  let removed=0;
  const dates=(Array.isArray(payload?.dates)?payload.dates:[]).map(d=>({...d,games:(Array.isArray(d?.games)?d.games:[]).filter(g=>{
    const pk=positive(g?.gamePk);
    if(pk&&normalized.has(pk)&&obsolete(g)){removed+=1;return false;}
    return true;
  })}));
  return{payload:{...payload,dates},normalizedGamePks:[...normalized].sort((a,b)=>a-b),removedRows:removed};
}
function selfTest(){
  const team={home:{team:{id:144}},away:{team:{id:135}}};
  const payload={dates:[
    {date:'2021-07-19',games:[{gamePk:633224,gameType:'R',gameDate:'2021-07-19T23:20:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'D',detailedState:'Postponed'}}]},
    {date:'2021-07-21',games:[{gamePk:633224,gameType:'R',gameDate:'2021-07-21T21:20:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'F',detailedState:'Final'},resumeDate:'2021-09-25T00:10:00Z',resumeGameDate:'2021-09-24'}]},
    {date:'2021-09-24',games:[{gamePk:633224,gameType:'R',gameDate:'2021-09-25T00:10:00Z',officialDate:'2021-07-21',teams:team,status:{codedGameState:'F',detailedState:'Final'},resumedFrom:'2021-07-21T21:20:00Z',resumedFromDate:'2021-07-21'}]}
  ]};
  const ok=normalizeSchedule(payload);assert.deepEqual(ok.normalizedGamePks,[633224]);assert.equal(ok.removedRows,1);
  const bad=structuredClone(payload);bad.dates[2].games[0].resumedFrom='2021-07-21T22:20:00Z';const no=normalizeSchedule(bad);assert.deepEqual(no.normalizedGamePks,[]);assert.equal(no.removedRows,0);
  console.log('STEP12R_2021_COHORT_NORMALIZER_SELF_TEST_OK');
}

if(process.argv.includes('--self-test')){selfTest();process.exit(0);}

const startDate=arg('--start'),endDate=arg('--end'),outputRoot=arg('--out'),role=arg('--role');
const concurrency=Number(arg('--concurrency')??6);
if(startDate!==FROZEN_START||endDate!==FROZEN_END)throw new Error('STEP12R_2021_FROZEN_RANGE_MISMATCH');
if(role!==FROZEN_ROLE)throw new Error('STEP12R_2021_ROLE_MISMATCH');
if(!outputRoot)throw new Error('STEP12R_2021_OUTPUT_REQUIRED');
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new Error('STEP12R_2021_INVALID_CONCURRENCY');
await fs.mkdir(outputRoot,{recursive:true});
const generatedAt=new Date().toISOString();
const normalization={normalizedGamePks:new Set(),removedRows:0,scheduleResponses:0};
const normalizingFetch=async(input,init)=>{
  const response=await fetch(input,init);const url=String(input);
  if(!response.ok||!url.includes('/v1/schedule?'))return response;
  const body=await response.json();const normalized=normalizeSchedule(body);
  normalization.scheduleResponses+=1;normalization.removedRows+=normalized.removedRows;
  for(const pk of normalized.normalizedGamePks)normalization.normalizedGamePks.add(pk);
  return new Response(JSON.stringify(normalized.payload),{status:response.status,statusText:response.statusText,headers:response.headers});
};

const official=await fetchMlbHistoricalOfficialGames({startDate,endDate,concurrency});
if(official.failures.length)throw new Error(`STEP12R_2021_OFFICIAL_INCOMPLETE:${official.failures.length}`);
const officialArtifact=await writeJson(path.join(outputRoot,'official-acquisition.json'),official);
const dataset=buildMlbHistoricalDataset(official.games,{generatedAt});
if(dataset.regularSeasonFinalGames!==official.officialFinalGames)throw new Error('STEP12R_2021_DATASET_COUNT_MISMATCH');
const datasetArtifact=await writeJson(path.join(outputRoot,'dataset.json'),dataset);
const starter=await fetchMlbHistoricalStartingPitcherHistory({startDate,endDate,concurrency});
if(starter.failures.length||starter.gamesWithBothStarters!==dataset.regularSeasonFinalGames)throw new Error('STEP12R_2021_STARTER_INCOMPLETE');
const starterArtifact=await writeJson(path.join(outputRoot,'starting-pitcher-history.json'),starter);
const lineupSource=await fetchMlbHistoricalPregameLineups({startDate,endDate,cutoffSecondsBeforeScheduledStart:CUTOFF_SECONDS,concurrency,fetchImpl:normalizingFetch});
if(lineupSource.failures.length)throw new Error(`STEP12R_2021_LINEUP_INCOMPLETE:${lineupSource.failures.length}`);
const normalizedGamePks=[...normalization.normalizedGamePks].sort((a,b)=>a-b);
if(JSON.stringify(normalizedGamePks)!==JSON.stringify([633224]))throw new Error(`STEP12R_2021_UNEXPECTED_NORMALIZED_GAMES:${JSON.stringify(normalizedGamePks)}`);
if(normalization.removedRows!==1)throw new Error(`STEP12R_2021_UNEXPECTED_REMOVED_ROWS:${normalization.removedRows}`);
const lineupSourceArtifact=await writeJson(path.join(outputRoot,'pregame-lineup-history-source.json'),lineupSource);
const officialPks=pks(official.games.map(g=>g.gamePk)),starterPks=pks(starter.games.map(g=>g.gamePk));
if(JSON.stringify(officialPks)!==JSON.stringify(starterPks))throw new Error('STEP12R_2021_STARTER_IDENTITY_MISMATCH');
const officialSet=new Set(officialPks),byPk=new Map();
for(const snapshot of lineupSource.snapshots){if(byPk.has(snapshot.gamePk))throw new Error(`STEP12R_2021_DUPLICATE_LINEUP:${snapshot.gamePk}`);byPk.set(snapshot.gamePk,snapshot);}
const missing=officialPks.filter(pk=>!byPk.has(pk));if(missing.length)throw new Error(`STEP12R_2021_LINEUP_MISSING:${missing.length}`);
const cohortSnapshots=officialPks.map(pk=>byPk.get(pk));const excluded=lineupSource.snapshots.filter(s=>!officialSet.has(s.gamePk));
const complete=pks(cohortSnapshots.filter(s=>s.complete).map(s=>s.gamePk));
const lineup={schemaVersion:LINEUP_SCHEMA,sourceVersion:lineupSource.sourceVersion,generatedAt,startDate,endDate,cutoffSecondsBeforeScheduledStart:CUTOFF_SECONDS,cohortDefinition:'OFFICIAL_FINAL_GAME_PK_INTERSECTION_AFTER_SCOPED_2021_SCHEDULE_NORMALIZATION',officialFinalGames:officialPks.length,snapshotsFetched:cohortSnapshots.length,completeLineupGames:complete.length,completeLineupCoveragePct:100*complete.length/officialPks.length,snapshots:cohortSnapshots,upstreamSchedule:{scheduleGames:lineupSource.scheduleGames,snapshotsFetched:lineupSource.snapshotsFetched,excludedNonCohortSnapshots:excluded.length},step12rScheduleNormalization:{scope:'RESEARCH_ONLY_2021_EXTERNAL_REPLICATION',policy:NORMALIZATION_POLICY,normalizedGamePks,removedRows:normalization.removedRows,scheduleResponses:normalization.scheduleResponses,ambiguousFallbackAllowed:false},researchOnly:true};
const lineupArtifact=await writeJson(path.join(outputRoot,'pregame-lineup-history.json'),lineup);
const lineupPks=pks(cohortSnapshots.map(s=>s.gamePk));if(JSON.stringify(officialPks)!==JSON.stringify(lineupPks))throw new Error('STEP12R_2021_LINEUP_IDENTITY_MISMATCH');
const manifest={schemaVersion:SCHEMA,generatedAt,temporalRole:role,frozenRange:{startDate,endDate},cohort:{regularSeasonFinalGames:dataset.regularSeasonFinalGames,starterGames:starter.gamesWithBothStarters,lineupSnapshotsFetched:cohortSnapshots.length,completeLineupGames:complete.length,completeLineupCoveragePct:lineup.completeLineupCoveragePct,excludedNonCohortLineupScheduleSnapshots:excluded.length,officialGamePksDigest:sha256(JSON.stringify(officialPks)),starterGamePksDigest:sha256(JSON.stringify(starterPks)),lineupGamePksDigest:sha256(JSON.stringify(lineupPks))},step12rScheduleNormalization:lineup.step12rScheduleNormalization,provenance:{outcomeSourceVersion:official.sourceVersion,outcomeDigest:dataset.outcomeDigest,starterSource:starter.source,starterHistoryDigest:starter.starterHistoryDigest,lineupSourceVersion:lineupSource.sourceVersion,lineupHistoryDigest:lineupSource.lineupHistoryDigest},artifacts:[officialArtifact,datasetArtifact,starterArtifact,lineupSourceArtifact,lineupArtifact],policy:{reservedSeason:2021,thresholdRetuningAllowed:false,newInvalidatorSearchAllowed:false,historicalPricesUsed:false,historicalEvClaimAllowed:false,liveFilterChangeAllowed:false,betEliteAllowed:false,prospective11cValidationStillRequired:true}};
await writeJson(path.join(outputRoot,'cohort-manifest.json'),manifest);
console.log(JSON.stringify({ok:true,role,games:dataset.regularSeasonFinalGames,completeLineupCoveragePct:lineup.completeLineupCoveragePct,step12rScheduleNormalization:manifest.step12rScheduleNormalization,researchOnly:true},null,2));

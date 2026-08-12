import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalStartingPitcherHistory } from "../server/mlb-market-starting-pitcher-history.ts";
import { fetchMlbHistoricalPregameLineups } from "../server/mlb-market-pregame-lineup-history.ts";

const CUTOFF_SECONDS=300;
const SCHEMA="courtedge-p0-step12m-clean-replication-cohort.v1";
const LINEUP_SCHEMA="courtedge-p0-step12m-cohort-pregame-lineups.v1";
function arg(n){const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:null}
function sha256(v){return crypto.createHash('sha256').update(v).digest('hex')}
async function writeJson(f,v){const t=`${JSON.stringify(v,null,2)}\n`;await fs.writeFile(f,t,'utf8');return{file:path.basename(f),sha256:sha256(t),bytes:Buffer.byteLength(t)}}
function pks(v){return[...new Set(v.map(Number).filter(x=>Number.isInteger(x)&&x>0))].sort((a,b)=>a-b)}
const startDate=arg('--start'), endDate=arg('--end'), outputRoot=arg('--out'), role=arg('--role');
const concurrency=Number(arg('--concurrency')??6);
if(!startDate||!endDate||!outputRoot||!role)throw new Error('STEP12M_REQUIRED_ARGUMENT_MISSING');
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw new Error('STEP12M_INVALID_CONCURRENCY');
await fs.mkdir(outputRoot,{recursive:true}); const generatedAt=new Date().toISOString();
const official=await fetchMlbHistoricalOfficialGames({startDate,endDate,concurrency});
if(official.failures.length)throw new Error(`STEP12M_OFFICIAL_INCOMPLETE:${official.failures.length}`);
const officialArtifact=await writeJson(path.join(outputRoot,'official-acquisition.json'),official);
const dataset=buildMlbHistoricalDataset(official.games,{generatedAt});
if(dataset.regularSeasonFinalGames!==official.officialFinalGames)throw new Error('STEP12M_DATASET_COUNT_MISMATCH');
const datasetArtifact=await writeJson(path.join(outputRoot,'dataset.json'),dataset);
const starter=await fetchMlbHistoricalStartingPitcherHistory({startDate,endDate,concurrency});
if(starter.failures.length||starter.gamesWithBothStarters!==dataset.regularSeasonFinalGames)throw new Error('STEP12M_STARTER_INCOMPLETE');
const starterArtifact=await writeJson(path.join(outputRoot,'starting-pitcher-history.json'),starter);
const lineupSource=await fetchMlbHistoricalPregameLineups({startDate,endDate,cutoffSecondsBeforeScheduledStart:CUTOFF_SECONDS,concurrency});
if(lineupSource.failures.length)throw new Error(`STEP12M_LINEUP_INCOMPLETE:${lineupSource.failures.length}`);
const lineupSourceArtifact=await writeJson(path.join(outputRoot,'pregame-lineup-history-source.json'),lineupSource);
const officialPks=pks(official.games.map(g=>g.gamePk)), starterPks=pks(starter.games.map(g=>g.gamePk));
if(JSON.stringify(officialPks)!==JSON.stringify(starterPks))throw new Error('STEP12M_STARTER_IDENTITY_MISMATCH');
const officialSet=new Set(officialPks), byPk=new Map();
for(const s of lineupSource.snapshots){if(byPk.has(s.gamePk))throw new Error(`STEP12M_DUPLICATE_LINEUP:${s.gamePk}`);byPk.set(s.gamePk,s)}
const missing=officialPks.filter(x=>!byPk.has(x)); if(missing.length)throw new Error(`STEP12M_LINEUP_MISSING:${missing.length}`);
const cohortSnapshots=officialPks.map(x=>byPk.get(x)); const excluded=lineupSource.snapshots.filter(s=>!officialSet.has(s.gamePk));
const complete=pks(cohortSnapshots.filter(s=>s.complete).map(s=>s.gamePk));
const lineup={schemaVersion:LINEUP_SCHEMA,sourceVersion:lineupSource.sourceVersion,generatedAt,startDate,endDate,cutoffSecondsBeforeScheduledStart:CUTOFF_SECONDS,cohortDefinition:'OFFICIAL_FINAL_GAME_PK_INTERSECTION',officialFinalGames:officialPks.length,snapshotsFetched:cohortSnapshots.length,completeLineupGames:complete.length,completeLineupCoveragePct:100*complete.length/officialPks.length,snapshots:cohortSnapshots,upstreamSchedule:{scheduleGames:lineupSource.scheduleGames,snapshotsFetched:lineupSource.snapshotsFetched,excludedNonCohortSnapshots:excluded.length},researchOnly:true};
const lineupArtifact=await writeJson(path.join(outputRoot,'pregame-lineup-history.json'),lineup);
const lineupPks=pks(cohortSnapshots.map(s=>s.gamePk)); if(JSON.stringify(officialPks)!==JSON.stringify(lineupPks))throw new Error('STEP12M_LINEUP_IDENTITY_MISMATCH');
const manifest={schemaVersion:SCHEMA,generatedAt,temporalRole:role,frozenRange:{startDate,endDate},cohort:{regularSeasonFinalGames:dataset.regularSeasonFinalGames,starterGames:starter.gamesWithBothStarters,lineupSnapshotsFetched:cohortSnapshots.length,completeLineupGames:complete.length,completeLineupCoveragePct:lineup.completeLineupCoveragePct,excludedNonCohortLineupScheduleSnapshots:excluded.length,officialGamePksDigest:sha256(JSON.stringify(officialPks)),starterGamePksDigest:sha256(JSON.stringify(starterPks)),lineupGamePksDigest:sha256(JSON.stringify(lineupPks))},provenance:{outcomeSourceVersion:official.sourceVersion,outcomeDigest:dataset.outcomeDigest,starterSource:starter.source,starterHistoryDigest:starter.starterHistoryDigest,lineupSourceVersion:lineupSource.sourceVersion,lineupHistoryDigest:lineupSource.lineupHistoryDigest},artifacts:[officialArtifact,datasetArtifact,starterArtifact,lineupSourceArtifact,lineupArtifact],policy:{thresholdSearchAllowed:false,candidateSearchAllowed:false,historicalPricesUsed:false,historicalEvClaimAllowed:false,livePickFiltersChanged:false,step11cCapturePopulationChanged:false,betEliteLabelProduced:false,automaticBetPlacement:false}};
await writeJson(path.join(outputRoot,'cohort-manifest.json'),manifest);
console.log(JSON.stringify({ok:true,role,games:dataset.regularSeasonFinalGames,completeLineupCoveragePct:lineup.completeLineupCoveragePct,researchOnly:true},null,2));
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fetchMlbHistoricalPregameLineups } from '../server/mlb-market-pregame-lineup-history.ts';

const TARGET='2026-08-16';
const CUTOFF=300;
const API='https://statsapi.mlb.com/api/v1.1/game';
const TIMEOUT=20_000;
const ATTEMPTS=3;

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
function positive(v){const n=Number(v);return Number.isInteger(n)&&n>0?n:null;}
function sha256(v){return crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');}
async function sleep(ms){if(ms>0)await new Promise(r=>setTimeout(r,ms));}
async function fetchJson(url){let last=null;for(let i=0;i<ATTEMPTS;i++){try{const r=await fetch(url,{headers:{'User-Agent':'CourtEdge-V76-Retrospective/1.0',Accept:'application/json'},signal:AbortSignal.timeout(TIMEOUT)});if(r.ok)return await r.json();last=new Error(`HTTP_${r.status}`);if(r.status<500&&![408,425,429].includes(r.status))throw last;}catch(e){last=e;if(i+1===ATTEMPTS)throw e;}await sleep(300*(2**i));}throw last;}
function pregame(payload){const s=payload?.gameData?.status??{};const coded=String(s.codedGameState??'').toUpperCase();const detailed=String(s.detailedState??'');const abstract=String(s.abstractGameState??'');if(['I','F','O'].includes(coded))return false;if(/^(In Progress|Final|Game Over|Completed Early)$/i.test(detailed))return false;return ['S','P'].includes(coded)||/^(Scheduled|Pre-Game|Warmup|Delayed Start)$/i.test(detailed)||abstract==='Preview';}

const outPath=arg('--out');
if(!outPath)throw new Error('V76_TARGET_OUT_REQUIRED');
const lineups=await fetchMlbHistoricalPregameLineups({startDate:TARGET,endDate:TARGET,cutoffSecondsBeforeScheduledStart:CUTOFF,concurrency:4});
if(lineups.failures.length)throw new Error(`V76_TARGET_LINEUP_SOURCE_FAILURES:${lineups.failures.length}`);
const rows=[];const exclusions=[];
for(const s of lineups.snapshots){
  const url=`${API}/${s.gamePk}/feed/live?timecode=${encodeURIComponent(s.requestedTimecode)}`;
  const p=await fetchJson(url);
  const sourceTime=String(p?.metaData?.timeStamp??'').trim();
  const homeId=positive(p?.gameData?.teams?.home?.id),awayId=positive(p?.gameData?.teams?.away?.id);
  const hp=positive(p?.gameData?.probablePitchers?.home?.id),ap=positive(p?.gameData?.probablePitchers?.away?.id);
  const identityOk=positive(p?.gamePk)===Number(s.gamePk)&&homeId===Number(s.homeTeamId)&&awayId===Number(s.awayTeamId);
  const historical=/^\d{8}_\d{6}$/.test(sourceTime)&&sourceTime<=s.requestedTimecode;
  const pg=pregame(p);
  if(!identityOk||!historical||!pg||!hp||!ap){
    exclusions.push({gamePk:Number(s.gamePk),officialDate:s.officialDate,scheduledStart:s.scheduledStart,identityOk,sourceHistorical:historical,pregame:pg,bothProbablePitchersKnown:Boolean(hp&&ap),reason:!identityOk?'IDENTITY_CONFLICT':!historical?'TIMECODE_NOT_HISTORICAL':!pg?'NOT_PREGAME_AT_T_MINUS_5':'BOTH_PROBABLE_PITCHERS_NOT_KNOWN_AT_T_MINUS_5'});
    continue;
  }
  rows.push({
    gamePk:Number(s.gamePk),officialDate:s.officialDate,scheduledStart:s.scheduledStart,cutoffAt:s.cutoffAt,requestedTimecode:s.requestedTimecode,sourceMetadataTimecode:sourceTime,
    homeTeamId:homeId,awayTeamId:awayId,
    homeTeam:String(p?.gameData?.teams?.home?.name??homeId),awayTeam:String(p?.gameData?.teams?.away?.name??awayId),
    homeProbablePitcherId:hp,awayProbablePitcherId:ap,
    homeProbablePitcher:String(p?.gameData?.probablePitchers?.home?.fullName??hp),awayProbablePitcher:String(p?.gameData?.probablePitchers?.away?.fullName??ap),
    ready:true,
    evidenceDigest:sha256({gamePk:s.gamePk,requestedTimecode:s.requestedTimecode,sourceTime,homeId,awayId,hp,ap})
  });
}
rows.sort((a,b)=>a.scheduledStart.localeCompare(b.scheduledStart)||a.gamePk-b.gamePk);
const out={
  schemaVersion:'courtedge-p0-step12v76-aug16-t5-target-snapshot.v1',
  classification:'V76_AUG16_ARCHIVED_T5_TARGET_IDENTITIES_OUTCOME_FIELDS_NOT_SERIALIZED',
  targetOfficialDate:TARGET,
  cutoffSecondsBeforeScheduledStart:CUTOFF,
  sourceVersion:lineups.sourceVersion,
  sourceProvenanceDigest:lineups.sourceProvenanceDigest,
  scheduleGames:lineups.scheduleGames,
  readyGames:rows.length,
  rows,exclusions,
  policy:{retrospectivePseudoPregame:true,currentMetadataFallbackUsed:false,finalStarterIdentityRead:false,targetRunScoresParsedByThisScript:false,targetRunScoresSerialized:false,sportsbookLinesRead:false,sportsbookPricesRead:false,researchOnly:true,realFinancialExposure:0}
};
await fs.mkdir(new URL('.',`file://${process.cwd()}/${outPath}`).pathname,{recursive:true}).catch(()=>{});
await fs.writeFile(outPath,JSON.stringify(out,null,2)+'\n','utf8');
console.log(JSON.stringify({classification:out.classification,scheduleGames:out.scheduleGames,readyGames:out.readyGames,excluded:out.exclusions.length,games:rows.map(r=>`${r.awayTeam} @ ${r.homeTeam}`)},null,2));

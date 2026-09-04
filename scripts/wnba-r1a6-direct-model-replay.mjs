#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CONTRACT='research/wnba/WNBA_R1A6_OUTCOME_BLIND_MODEL_REPLAY_CONTRACT.json';
const INPUT='wnba-r1a5-neutral-availability-candidate-rowset.jsonl';
const MODEL='frontend/client/src/lib/wnba-model.ts';
const OUT='wnba-r1a6-sports-only-probability-rowset.jsonl';
const EVIDENCE='wnba-r1a6-model-replay-evidence.json';
const EXECUTION_MODULE=process.env.WNBA_MODEL_MODULE || MODEL;
const EXECUTION_LABEL=process.env.WNBA_MODEL_EXECUTION || 'DIRECT_TYPESCRIPT_IMPORT_NODE22';
const specialIds=new Set(['401341447','401353913','401455978','401430112','401558893','401507376','401620458','401677672','401781604','401736430']);

function sha256(buf){return crypto.createHash('sha256').update(buf).digest('hex');}
function gitBlobSha(buf){
  const prefix=Buffer.from(`blob ${buf.length}\0`,'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([prefix,buf])).digest('hex');
}
function stable(value){
  if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function sideInput(side){
  return {
    netRtg:Number(side.netRtg),
    offRtg:Number(side.offRtg),
    defRtg:Number(side.defRtg),
    pace:Number(side.pace),
    daysRest:Number(side.daysRest),
    winRate:Number(side.winRate),
    isB2B:Boolean(side.isB2B),
    streak:Number(side.streak),
    injuryAdj:Number(side.injuryAdj),
    recentNetRtg:Number(side.recentNetRtg),
    recentOffRtg:Number(side.recentOffRtg),
    recentDefRtg:Number(side.recentDefRtg),
    recentWinRate:Number(side.recentWinPct),
    gamesPlayed:Number(side.gamesPlayed),
    oppAvgNetRtg:Number(side.sos?.oppAvgNetRtg),
    b2bWasRoad:Boolean(side.b2bWasRoad),
    gamesLast7Days:Number(side.gamesLast7),
    travelMiles:Number(side.travelMiles),
  };
}

const contract=JSON.parse(fs.readFileSync(CONTRACT,'utf8'));
const inputBytes=fs.readFileSync(INPUT);
const inputSha=sha256(inputBytes);
const inputRows=inputBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const expectedInputSha=contract.frozen_candidate_input.expected_sha256;
const expectedRows=Number(contract.frozen_candidate_input.expected_rows);
const inputOk=inputSha===expectedInputSha && inputRows.length===expectedRows;

const modelBytes=fs.readFileSync(MODEL);
const modelBlob=gitBlobSha(modelBytes);
const expectedModelBlob=contract.frozen_model.git_blob_sha;
const modelOk=modelBlob===expectedModelBlob;
if(!inputOk || !modelOk){
  const ev={name:'WNBA_R1A6_PREMODEL_CUSTODY_FAILURE',decision:'MODEL_REPLAY_NOT_CERTIFIED',candidate_input_sha256:inputSha,expected_candidate_input_sha256:expectedInputSha,candidate_input_rows:inputRows.length,expected_rows:expectedRows,model_blob_sha:modelBlob,expected_model_blob_sha:expectedModelBlob,r1b_outcome_opening_authorized:false};
  fs.writeFileSync(EVIDENCE,JSON.stringify(ev,null,2)+'\n');
  process.exit(2);
}

if(!fs.existsSync(EXECUTION_MODULE)) throw new Error(`Execution module unavailable: ${EXECUTION_MODULE}`);
const executionBytes=fs.readFileSync(EXECUTION_MODULE);
const executionModuleSha=sha256(executionBytes);
const moduleUrl=pathToFileURL(path.resolve(EXECUTION_MODULE)).href;
const mod=await import(moduleUrl);
if(typeof mod.predictWNBA!=='function') throw new Error('predictWNBA export unavailable');

const out=[];
let finite=0,inside=0,selectedGeHalf=0,duplicates=0,markets=0,outcomes=0,special=0;
const seen=new Set();
const originalLog=console.log;
console.log=()=>{};
try{
  for(const row of inputRows){
    const gid=String(row.gameId);
    if(seen.has(gid)) duplicates+=1;
    seen.add(gid);
    if(specialIds.has(gid)) special+=1;
    if(Boolean(row.marketAttached)) markets+=1;
    if(Boolean(row.targetOutcomeAttached)) outcomes+=1;
    const home=sideInput(row.home), away=sideInput(row.away);
    // CRITICAL: third market argument intentionally omitted by frozen contract.
    const hp=mod.predictWNBA(home,away);
    const ap=1-hp;
    const okFinite=Number.isFinite(hp)&&Number.isFinite(ap);
    if(okFinite) finite+=1;
    if(okFinite && hp>0 && hp<1 && ap>0 && ap<1) inside+=1;
    const selectedHome=hp>=0.5;
    const psel=selectedHome?hp:ap;
    if(Number.isFinite(psel)&&psel>=0.5&&psel<1) selectedGeHalf+=1;
    out.push({
      schemaVersion:1,
      candidate:contract.candidate,
      gameId:gid,
      season:Number(row.season),
      targetDate:String(row.targetDate),
      homeTeamId:String(row.homeTeamId),
      awayTeamId:String(row.awayTeamId),
      homeProbability:hp,
      awayProbability:ap,
      selectedSide:selectedHome?'HOME':'AWAY',
      selectedTeamId:String(selectedHome?row.homeTeamId:row.awayTeamId),
      p_win_selected_side:psel,
      marketAttached:false,
      targetOutcomeAttached:false,
      modelBlobSha:modelBlob,
    });
  }
}finally{console.log=originalLog;}

const canonical=Buffer.from(out.map(stable).join('\n')+'\n','utf8');
fs.writeFileSync(OUT,canonical);
const outSha=sha256(canonical);
const minHome=Math.min(...out.map(r=>r.homeProbability));
const maxHome=Math.max(...out.map(r=>r.homeProbability));
const minSelected=Math.min(...out.map(r=>r.p_win_selected_side));
const maxSelected=Math.max(...out.map(r=>r.p_win_selected_side));
const gates={candidate_input_sha256_matches:inputSha===expectedInputSha,candidate_input_rows:inputRows.length,model_blob_sha_matches:modelOk,probability_rows:out.length,finite_probability_rows:finite,probabilities_between_0_and_1:inside,selected_probability_ge_0_5:selectedGeHalf,duplicate_game_ids:duplicates,market_attached_rows:markets,outcome_attached_rows:outcomes,special_event_rows:special};
const passed=inputSha===expectedInputSha&&inputRows.length===expectedRows&&modelOk&&out.length===expectedRows&&finite===expectedRows&&inside===expectedRows&&selectedGeHalf===expectedRows&&duplicates===0&&markets===0&&outcomes===0&&special===0;
const evidence={
  name:'WNBA_R1A6_DIRECT_MODEL_REPLAY_EVIDENCE_V1',
  decision:passed?'FROZEN_OUTCOME_BLIND_SPORTS_ONLY_PROBABILITY_ROWSET':'MODEL_REPLAY_NOT_CERTIFIED',
  candidate:contract.candidate,
  target_outcomes_opened:false,
  market_argument_passed:false,
  market_data_consumed:false,
  calibration_fit:false,
  threshold_tuning:false,
  r1b_outcome_opening_authorized:false,
  input_custody:{sha256:inputSha,expected_sha256:expectedInputSha,rows:inputRows.length,match:inputSha===expectedInputSha},
  model_custody:{path:MODEL,git_blob_sha:modelBlob,expected_git_blob_sha:expectedModelBlob,match:modelOk,execution:EXECUTION_LABEL,execution_module:EXECUTION_MODULE,execution_module_sha256:executionModuleSha},
  gates,
  probability_summary:{home_min:minHome,home_max:maxHome,selected_min:minSelected,selected_max:maxSelected},
  probability_rowset:{rows:out.length,bytes:canonical.length,sha256:outSha},
  closure:{r1a6:passed?'PASS':'FAIL',probability_rowset_frozen:passed,target_outcomes_may_be_evaluated:false,r1b_remains_closed:true,next_gate:passed?'R1A7_PROBABILITY_ROWSET_CUSTODY_AND_R1A_CLOSURE':'R1A6_REPAIR'}
};
fs.writeFileSync(EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(!passed) process.exit(2);

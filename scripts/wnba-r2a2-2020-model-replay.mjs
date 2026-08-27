#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CONTRACT='research/wnba/WNBA_R2A2_2020_MODEL_PROBABILITY_FREEZE_CONTRACT.json';
const INPUT='wnba-r2a-2020-seed-candidate-rowset.jsonl';
const MODEL='frontend/client/src/lib/wnba-model.ts';
const OUT='wnba-r2a2-2020-probability-rowset.jsonl';
const EVIDENCE='wnba-r2a2-2020-model-replay-evidence.json';
const EXECUTION_MODULE=process.env.WNBA_MODEL_MODULE;
function sha256(b){return crypto.createHash('sha256').update(b).digest('hex');}
function gitBlobSha(b){return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`),b])).digest('hex');}
function stable(v){if(Array.isArray(v))return '['+v.map(stable).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';return JSON.stringify(v);}
function sideInput(s){return {netRtg:Number(s.netRtg),offRtg:Number(s.offRtg),defRtg:Number(s.defRtg),pace:Number(s.pace),daysRest:Number(s.daysRest),winRate:Number(s.winRate),isB2B:Boolean(s.isB2B),streak:Number(s.streak),injuryAdj:Number(s.injuryAdj),recentNetRtg:Number(s.recentNetRtg),recentOffRtg:Number(s.recentOffRtg),recentDefRtg:Number(s.recentDefRtg),recentWinRate:Number(s.recentWinPct),gamesPlayed:Number(s.gamesPlayed),oppAvgNetRtg:Number(s.sos?.oppAvgNetRtg),b2bWasRoad:Boolean(s.b2bWasRoad),gamesLast7Days:Number(s.gamesLast7),travelMiles:Number(s.travelMiles)};}
const c=JSON.parse(fs.readFileSync(CONTRACT,'utf8'));
const ib=fs.readFileSync(INPUT), rows=ib.toString().split(/\r?\n/).filter(Boolean).map(JSON.parse), isha=sha256(ib);
const mb=fs.readFileSync(MODEL), mblob=gitBlobSha(mb);
if(isha!==c.frozen_candidate_input.sha256||rows.length!==c.frozen_candidate_input.rows||mblob!==c.frozen_model.git_blob_sha)throw new Error('R2A2_CUSTODY_MISMATCH');
if(!EXECUTION_MODULE||!fs.existsSync(EXECUTION_MODULE))throw new Error('R2A2_EXECUTION_MODULE_MISSING');
const mod=await import(pathToFileURL(path.resolve(EXECUTION_MODULE)).href);
if(typeof mod.predictWNBA!=='function')throw new Error('predictWNBA unavailable');
const out=[];let finite=0,inside=0,selok=0,dup=0,market=0,outcome=0;const seen=new Set();const old=console.log;console.log=()=>{};
try{for(const r of rows){const gid=String(r.gameId);if(seen.has(gid))dup++;seen.add(gid);market+=Number(Boolean(r.marketAttached));outcome+=Number(Boolean(r.targetOutcomeAttached));const hp=mod.predictWNBA(sideInput(r.home),sideInput(r.away));const ap=1-hp;const ok=Number.isFinite(hp)&&Number.isFinite(ap);if(ok)finite++;if(ok&&hp>0&&hp<1&&ap>0&&ap<1)inside++;const sh=hp>=0.5,ps=sh?hp:ap;if(Number.isFinite(ps)&&ps>=0.5&&ps<1)selok++;out.push({schemaVersion:1,candidate:c.candidate,gameId:gid,season:2020,targetDate:String(r.targetDate),homeTeamId:String(r.homeTeamId),awayTeamId:String(r.awayTeamId),homeProbability:hp,awayProbability:ap,selectedSide:sh?'HOME':'AWAY',selectedTeamId:String(sh?r.homeTeamId:r.awayTeamId),p_win_selected_side:ps,marketAttached:false,targetOutcomeAttached:false,modelBlobSha:mblob});}}finally{console.log=old;}
const canonical=Buffer.from(out.map(stable).join('\n')+'\n');fs.writeFileSync(OUT,canonical);const osha=sha256(canonical);
const passed=rows.length===126&&finite===126&&inside===126&&selok===126&&dup===0&&market===0&&outcome===0;
const ev={name:'WNBA_R2A2_2020_DIRECT_MODEL_REPLAY_EVIDENCE_V1',decision:passed?'R2A2_2020_PROBABILITY_ROWSET_FROZEN_LABEL_OPENING_MAY_PROCEED':'R2A2_NOT_CERTIFIED',candidate:c.candidate,seedSeason:2020,seedRole:'TRAINING_ONLY_NEVER_TARGET_FOLD',inputCustody:{rows:rows.length,sha256:isha,match:true},modelCustody:{gitBlobSha:mblob,match:true,marketArgumentPassed:false},gates:{probabilityRows:out.length,finiteProbabilityRows:finite,strictlyInsideProbabilityRows:inside,selectedProbabilityAtLeastHalf:selok,duplicateGameIds:dup,marketAttachedRows:market,targetOutcomeAttachedRows:outcome},summary:{homeMin:Math.min(...out.map(x=>x.homeProbability)),homeMax:Math.max(...out.map(x=>x.homeProbability)),selectedMin:Math.min(...out.map(x=>x.p_win_selected_side)),selectedMax:Math.max(...out.map(x=>x.p_win_selected_side))},probabilityRowset:{rows:out.length,bytes:canonical.length,sha256:osha},chronology:{labelsOpenedBeforeThisFreeze:false,calibrationFitPerformed:false,thresholdTuningPerformed:false},closure:{r2a2:passed?'PASS':'FAIL',2020SeedProbabilityFrozen:passed,2020LabelsMayNowBeOpened:passed,nextGate:passed?'R2B_2020_LABEL_LINKAGE_AND_FIVE_FOLD_PLATT':'R2A2_REPAIR'},productionChangeAuthorized:false,globalRankerPromotionAuthorized:false};
fs.writeFileSync(EVIDENCE,JSON.stringify(ev,null,2)+'\n');console.log(JSON.stringify(ev,null,2));if(!passed)process.exit(2);

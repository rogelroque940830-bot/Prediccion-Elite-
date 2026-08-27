#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CONTRACT='research/wnba/WNBA_R1B3_FAILURE_CLOSURE_AND_PLATT_FEASIBILITY.json';
const INPUT='wnba-r1b2-scored-rowset.jsonl';
const ENGINE=process.env.WNBA_PLATT_ENGINE_MODULE || '/tmp/cross-sport-calibration.mjs';
const OUT='wnba-r1b3-platt-oos-rowset.jsonl';
const EVIDENCE='wnba-r1b3-platt-feasibility-evidence.json';

function sha256(buf){return crypto.createHash('sha256').update(buf).digest('hex');}
function stable(value){
  if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function close(a,b,tol=1e-12){
  if(a===null||b===null) return a===b;
  return Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tol;
}

const contract=JSON.parse(fs.readFileSync(CONTRACT,'utf8'));
const bytes=fs.readFileSync(INPUT);
const actualSha=sha256(bytes);
const expectedSha=contract.scored_rowset.sha256;
const rows=bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
if(actualSha!==expectedSha || rows.length!==contract.scored_rowset.rows){
  throw new Error(`R1B2 scored custody mismatch sha=${actualSha} rows=${rows.length}`);
}

const mod=await import(pathToFileURL(ENGINE).href);
for(const fn of ['fitPlattCalibrator','applyPlatt','calibrationMetrics','walkForwardPlatt']){
  if(typeof mod[fn]!=='function') throw new Error(`missing engine export ${fn}`);
}

const family=contract.feasibility_input.signal_family;
const policyDigest=`sha256:${contract.scored_rowset.sha256}`;
const sourceDigest=`sha256:${contract.scored_rowset.sha256}`;
const calibrationRows=rows.map(r=>({
  schemaVersion:'courtedge-cross-sport-calibration.v1',
  sport:'WNBA',
  candidateId:String(r.gameId),
  gameId:String(r.gameId),
  eventDate:String(r.targetDate),
  season:Number(r.season),
  signalFamily:family,
  rawSignal:Number(r.p_win_selected_side),
  outcome:Number(r.selectedSideOutcome),
  temporalCustody:{
    mode:'LEAKAGE_SAFE_OOS_REPLAY',
    capturedAt:null,
    pregameCutoffAt:null,
    replayProtocolDigest:`sha256:${contract.scored_rowset.sha256}`,
    trainingThroughSeason:Number(r.season)-1,
  },
  candidatePolicyDigest:policyDigest,
  sourceArtifactDigest:sourceDigest,
  // Deliberately FALSE. This is mathematical feasibility only, never a certified cross-sport observation.
  sportEliteGatePassed:false,
  safety:{
    pregameOnly:true,
    sameGameOutcomeUsedAtDecisionTime:false,
    targetSeasonRankingOrCapUsed:false,
    historicalAccuracyUsedAsGameProbability:false,
  },
}));

const engineFolds=mod.walkForwardPlatt(calibrationRows,family);
const expectedTargets=contract.rolling_origin.available_target_folds;
const actualTargets=engineFolds.map(f=>f.targetSeason);
if(JSON.stringify(actualTargets)!==JSON.stringify(expectedTargets)){
  throw new Error(`unexpected target folds ${JSON.stringify(actualTargets)}`);
}

const oos=[];
const foldEvidence=[];
let engineParity=true;
for(const targetSeason of actualTargets){
  const train=calibrationRows.filter(r=>r.season<targetSeason);
  const test=calibrationRows.filter(r=>r.season===targetSeason);
  const calibrator=mod.fitPlattCalibrator(train,family);
  const rawPs=test.map(r=>r.rawSignal);
  const ys=test.map(r=>r.outcome);
  const calibratedPs=test.map(r=>mod.applyPlatt(calibrator,r.rawSignal));
  const raw=mod.calibrationMetrics(rawPs,ys);
  const calibrated=mod.calibrationMetrics(calibratedPs,ys);
  const wf=engineFolds.find(f=>f.targetSeason===targetSeason);
  const foldParity=wf &&
    wf.trainingObservations===calibrator.trainingObservations &&
    JSON.stringify(wf.trainingSeasons)===JSON.stringify(calibrator.trainingSeasons) &&
    wf.testObservations===test.length &&
    close(wf.raw.brier,raw.brier)&&close(wf.raw.logLoss,raw.logLoss)&&close(wf.raw.ece10,raw.ece10)&&
    close(wf.calibrated.brier,calibrated.brier)&&close(wf.calibrated.logLoss,calibrated.logLoss)&&close(wf.calibrated.ece10,calibrated.ece10);
  engineParity=engineParity&&Boolean(foldParity);
  foldEvidence.push({
    targetSeason,
    trainingSeasons:calibrator.trainingSeasons,
    trainingObservations:calibrator.trainingObservations,
    testObservations:test.length,
    platt:{intercept:calibrator.intercept,slope:calibrator.slope},
    raw,
    calibrated,
    exactWalkForwardFunctionParity:Boolean(foldParity),
  });
  for(let i=0;i<test.length;i++){
    oos.push({
      schemaVersion:1,
      candidate:contract.candidate,
      signalFamily:family,
      gameId:test[i].gameId,
      season:test[i].season,
      eventDate:test[i].eventDate,
      rawSignal:test[i].rawSignal,
      calibratedProbability:calibratedPs[i],
      outcome:test[i].outcome,
      sportEliteGatePassed:false,
      certificationEligible:false,
      trainingSeasons:calibrator.trainingSeasons,
      trainingObservations:calibrator.trainingObservations,
      plattIntercept:calibrator.intercept,
      plattSlope:calibrator.slope,
    });
  }
}

const pooledRaw=mod.calibrationMetrics(oos.map(r=>r.rawSignal),oos.map(r=>r.outcome));
const pooledCalibrated=mod.calibrationMetrics(oos.map(r=>r.calibratedProbability),oos.map(r=>r.outcome));
const promising =
  pooledCalibrated.brier!==null && pooledRaw.brier!==null && pooledCalibrated.brier < pooledRaw.brier &&
  pooledCalibrated.logLoss!==null && pooledRaw.logLoss!==null && pooledCalibrated.logLoss < pooledRaw.logLoss &&
  pooledCalibrated.ece10!==null && pooledRaw.ece10!==null && pooledCalibrated.ece10 <= pooledRaw.ece10;

const outBytes=Buffer.from(oos.map(stable).join('\n')+'\n','utf8');
fs.writeFileSync(OUT,outBytes);
const evidence={
  name:'WNBA_R1B3_PLATT_FEASIBILITY_EVIDENCE_V1',
  decision:promising?'PLATT_FEASIBILITY_PROMISING_NOT_CERTIFIED':'PLATT_FEASIBILITY_NOT_PROMISING_STOP_PATH',
  candidate:contract.candidate,
  candidateRawProbabilityStatus:'FAILED_FROZEN_NO_RETUNE',
  engine:{
    sourcePullRequest:contract.preexisting_cross_sport_protocol.pull_request,
    sourceGitBlobSha:contract.preexisting_cross_sport_protocol.engine_git_blob_sha,
    method:contract.preexisting_cross_sport_protocol.method,
    exactWalkForwardFunctionParityAllFolds:engineParity,
  },
  inputCustody:{rows:rows.length,sha256:actualSha,expectedSha256:expectedSha,match:actualSha===expectedSha},
  sportEliteGatePassed:false,
  crossSportObservationCertified:false,
  certificationEligible:false,
  targetFolds:actualTargets,
  targetFoldCount:actualTargets.length,
  minimumTargetSeasonsRequired:contract.preexisting_cross_sport_protocol.minimum_target_seasons_when_applicable,
  fiveTargetSeasonRequirementMet:actualTargets.length>=contract.preexisting_cross_sport_protocol.minimum_target_seasons_when_applicable,
  folds:foldEvidence,
  pooledOos2022To2025:{raw:pooledRaw,calibrated:pooledCalibrated},
  preregisteredPromisingCriterionMet:promising,
  calibratedOosRowset:{rows:oos.length,bytes:outBytes.length,sha256:sha256(outBytes)},
  coefficientRetunePerformed:false,
  thresholdSearchPerformed:false,
  eliteGateDiscoveryPerformed:false,
  targetSeasonRankingOrCapUsed:false,
  globalRankerPromotionAuthorized:false,
  productionChangeAuthorized:false,
  nextGate:promising?contract.next_if_promising:contract.next_if_not_promising,
};
fs.writeFileSync(EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(!engineParity) process.exit(2);

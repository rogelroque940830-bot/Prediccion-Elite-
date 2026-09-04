#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SCIENCE='research/wnba/WNBA_R2B_FIVE_FOLD_PLATT_CERTIFICATION_CONTRACT.json';
const FREEZE='research/wnba/WNBA_R2B2_FIVE_FOLD_EXECUTION_FREEZE.json';
const SEED='wnba-r2b1-2020-labeled-seed.jsonl';
const TARGET='wnba-r1b2-scored-rowset.jsonl';
const ENGINE=process.env.WNBA_PLATT_ENGINE_MODULE || '/tmp/cross-sport-calibration.mjs';
const OUT='wnba-r2b2-five-fold-platt-oos-rowset.jsonl';
const EVIDENCE='wnba-r2b2-five-fold-platt-certification-evidence.json';

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
function binary(value,label){
  const n=Number(value);
  if(n!==0&&n!==1) throw new Error(`${label} must be binary`);
  return n;
}
function calZ(ps,ys){
  let num=0,den=0;
  for(let i=0;i<ps.length;i++){const p=Number(ps[i]),y=binary(ys[i],'outcome');num+=y-p;den+=p*(1-p);}
  return den>0?Math.abs(num)/Math.sqrt(den):Infinity;
}
function bias(ps,ys){return ps.reduce((s,p)=>s+Number(p),0)/ps.length-ys.reduce((s,y)=>s+binary(y,'outcome'),0)/ys.length;}
function meanBinary(values){return values.reduce((s,v)=>s+binary(v,'binary'),0)/values.length;}

const science=JSON.parse(fs.readFileSync(SCIENCE,'utf8'));
const freeze=JSON.parse(fs.readFileSync(FREEZE,'utf8'));
const seedBytes=fs.readFileSync(SEED);
const targetBytes=fs.readFileSync(TARGET);
const seedSha=sha256(seedBytes),targetSha=sha256(targetBytes);
const seedRows=seedBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const targetRows=targetBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);

if(seedSha!==freeze.r2b1_seed_label_custody.sha256||seedRows.length!==freeze.r2b1_seed_label_custody.rows||seedBytes.length!==freeze.r2b1_seed_label_custody.bytes) throw new Error(`R2B2 seed custody mismatch sha=${seedSha} rows=${seedRows.length} bytes=${seedBytes.length}`);
if(targetSha!==science.frozen_target_signal.scored_rowset_sha256||targetRows.length!==science.frozen_target_signal.rows) throw new Error(`R2B2 target custody mismatch sha=${targetSha} rows=${targetRows.length}`);
if(!fs.existsSync(ENGINE)) throw new Error('R2B2 Platt engine module missing');
const mod=await import(pathToFileURL(ENGINE).href);
for(const fn of ['fitPlattCalibrator','applyPlatt','calibrationMetrics','walkForwardPlatt']) if(typeof mod[fn]!=='function') throw new Error(`missing engine export ${fn}`);

const expectedTargets=science.folds.map(f=>Number(f.target));
const expectedTraining=new Map(science.folds.map(f=>[Number(f.target),f.training.map(Number)]));
const signalFamily=science.calibration_candidate;
const allGameIds=new Set();
let duplicateGameIds=0;

function normalized(row,isSeed){
  const season=Number(row.season);
  const gameId=String(row.gameId);
  if(allGameIds.has(gameId)) duplicateGameIds+=1;
  allGameIds.add(gameId);
  const selectedOutcome=isSeed ? (String(row.selectedTeamId)===String(row.winnerTeamId)?1:0) : binary(row.selectedSideOutcome,'selectedSideOutcome');
  const homeOutcome=binary(row.homeOutcome,'homeOutcome');
  const rawSignal=Number(row.p_win_selected_side);
  if(!Number.isFinite(rawSignal)||rawSignal<=0||rawSignal>=1) throw new Error(`invalid rawSignal game=${gameId}`);
  if(row.selectedSide!=='HOME'&&row.selectedSide!=='AWAY') throw new Error(`invalid selectedSide game=${gameId}`);
  return {
    source:isSeed?'R2B1_2020_SEED':'R1B2_2021_2025_TARGET',
    gameId,season,eventDate:String(row.targetDate),rawSignal,outcome:selectedOutcome,homeOutcome,
    selectedSide:String(row.selectedSide),selectedTeamId:String(row.selectedTeamId),homeTeamId:String(row.homeTeamId),awayTeamId:String(row.awayTeamId),
  };
}
const normalizedRows=[...seedRows.map(r=>normalized(r,true)),...targetRows.map(r=>normalized(r,false))];
if(duplicateGameIds!==0) throw new Error(`duplicate game ids across R2B2 inputs: ${duplicateGameIds}`);
if(normalizedRows.some(r=>r.season===2020&&r.source!=='R2B1_2020_SEED')) throw new Error('unexpected target source row in 2020');
if(normalizedRows.some(r=>r.season>=2021&&r.source!=='R1B2_2021_2025_TARGET')) throw new Error('unexpected seed source row in target seasons');

const calibrationRows=normalizedRows.map(r=>({
  schemaVersion:'courtedge-cross-sport-calibration.v1',sport:'WNBA',candidateId:r.gameId,gameId:r.gameId,eventDate:r.eventDate,season:r.season,
  signalFamily,rawSignal:r.rawSignal,outcome:r.outcome,
  temporalCustody:{mode:'LEAKAGE_SAFE_OOS_REPLAY',capturedAt:null,pregameCutoffAt:null,replayProtocolDigest:`sha256:${r.source==='R2B1_2020_SEED'?seedSha:targetSha}`,trainingThroughSeason:r.season-1},
  candidatePolicyDigest:`sha256:${targetSha}`,sourceArtifactDigest:`sha256:${r.source==='R2B1_2020_SEED'?seedSha:targetSha}`,
  sportEliteGatePassed:false,
  safety:{pregameOnly:true,sameGameOutcomeUsedAtDecisionTime:false,targetSeasonRankingOrCapUsed:false,historicalAccuracyUsedAsGameProbability:false},
}));

const engineFolds=mod.walkForwardPlatt(calibrationRows,signalFamily);
const actualTargets=engineFolds.map(f=>Number(f.targetSeason));
const targetFoldsExact=JSON.stringify(actualTargets)===JSON.stringify(expectedTargets);
if(!targetFoldsExact) throw new Error(`unexpected target folds ${JSON.stringify(actualTargets)} expected ${JSON.stringify(expectedTargets)}`);

let engineParity=true;
const foldEvidence=[];
const oos=[];
for(const targetSeason of expectedTargets){
  const trainObs=calibrationRows.filter(r=>r.season<targetSeason);
  const testObs=calibrationRows.filter(r=>r.season===targetSeason);
  const testNorm=normalizedRows.filter(r=>r.season===targetSeason);
  const expectedTrain=expectedTraining.get(targetSeason);
  const calibrator=mod.fitPlattCalibrator(trainObs,signalFamily);
  if(JSON.stringify(calibrator.trainingSeasons)!==JSON.stringify(expectedTrain)) throw new Error(`training season mismatch target=${targetSeason}`);
  const rawPs=testObs.map(r=>r.rawSignal),ys=testObs.map(r=>r.outcome),calPs=testObs.map(r=>mod.applyPlatt(calibrator,r.rawSignal));
  const raw=mod.calibrationMetrics(rawPs,ys),calibrated=mod.calibrationMetrics(calPs,ys);
  const wf=engineFolds.find(f=>Number(f.targetSeason)===targetSeason);
  const parity=Boolean(wf)&&wf.trainingObservations===calibrator.trainingObservations&&JSON.stringify(wf.trainingSeasons)===JSON.stringify(calibrator.trainingSeasons)&&wf.testObservations===testObs.length&&close(wf.raw.brier,raw.brier)&&close(wf.raw.logLoss,raw.logLoss)&&close(wf.raw.ece10,raw.ece10)&&close(wf.calibrated.brier,calibrated.brier)&&close(wf.calibrated.logLoss,calibrated.logLoss)&&close(wf.calibrated.ece10,calibrated.ece10);
  engineParity=engineParity&&parity;

  const priorNorm=normalizedRows.filter(r=>r.season<targetSeason);
  const qHome=meanBinary(priorNorm.map(r=>r.homeOutcome));
  const baselinePs=testNorm.map(r=>r.selectedSide==='HOME'?qHome:1-qHome);
  const baseline=mod.calibrationMetrics(baselinePs,ys);
  const foldBias=bias(calPs,ys),foldZ=calZ(calPs,ys);
  foldEvidence.push({
    targetSeason,trainingSeasons:calibrator.trainingSeasons,trainingObservations:calibrator.trainingObservations,testObservations:testObs.length,
    platt:{intercept:calibrator.intercept,slope:calibrator.slope},selectedSideAccuracy:meanBinary(ys),
    raw,calibrated,calibratedCalibrationInTheLargeAbsZ:foldZ,calibratedMeanPredictedMinusObserved:foldBias,
    walkForwardClimatology:{homeProbability:qHome,selectedSideMetrics:baseline},exactWalkForwardFunctionParity:parity,
  });
  for(let i=0;i<testObs.length;i++) oos.push({
    schemaVersion:1,candidate:science.candidate,calibrationCandidate:science.calibration_candidate,gameId:testObs[i].gameId,season:targetSeason,eventDate:testObs[i].eventDate,
    selectedSide:testNorm[i].selectedSide,selectedTeamId:testNorm[i].selectedTeamId,rawSignal:rawPs[i],calibratedProbability:calPs[i],outcome:ys[i],
    walkForwardClimatologySelectedProbability:baselinePs[i],trainingSeasons:calibrator.trainingSeasons,trainingObservations:calibrator.trainingObservations,
    plattIntercept:calibrator.intercept,plattSlope:calibrator.slope,sportEliteGatePassed:false,certificationScope:'PROBABILITY_FOUNDATION_ONLY_NOT_SPORT_ELITE',
  });
}

const targetRowCount=oos.length;
const pooledYs=oos.map(r=>r.outcome),pooledRawPs=oos.map(r=>r.rawSignal),pooledCalPs=oos.map(r=>r.calibratedProbability),pooledBaselinePs=oos.map(r=>r.walkForwardClimatologySelectedProbability);
const pooledRaw=mod.calibrationMetrics(pooledRawPs,pooledYs);
const pooledCal=mod.calibrationMetrics(pooledCalPs,pooledYs);
const pooledBaseline=mod.calibrationMetrics(pooledBaselinePs,pooledYs);
const pooledZ=calZ(pooledCalPs,pooledYs),pooledBias=bias(pooledCalPs,pooledYs);
const limits=science.absolute_probability_gates_on_pooled_oos_2021_2025;
const gates={
  calibration_in_the_large_abs_z:{value:pooledZ,limit_max:Number(limits.calibration_in_the_large_abs_z_max),pass:pooledZ<=Number(limits.calibration_in_the_large_abs_z_max)},
  ece10:{value:pooledCal.ece10,limit_max:Number(limits.ece10_max),pass:pooledCal.ece10!==null&&pooledCal.ece10<=Number(limits.ece10_max)},
  abs_mean_predicted_minus_observed:{value:Math.abs(pooledBias),signed_value:pooledBias,limit_max:Number(limits.abs_mean_predicted_minus_observed_max),pass:Math.abs(pooledBias)<=Number(limits.abs_mean_predicted_minus_observed_max)},
  brier_vs_walk_forward_climatology:{model:pooledCal.brier,baseline:pooledBaseline.brier,pass:pooledCal.brier!==null&&pooledBaseline.brier!==null&&pooledCal.brier<pooledBaseline.brier},
  log_loss_vs_walk_forward_climatology:{model:pooledCal.logLoss,baseline:pooledBaseline.logLoss,pass:pooledCal.logLoss!==null&&pooledBaseline.logLoss!==null&&pooledCal.logLoss<pooledBaseline.logLoss},
};
const fiveProbabilityGatesPass=Object.values(gates).every(g=>g.pass===true);
const exactFiveFoldGate=targetFoldsExact&&actualTargets.length===Number(science.target_fold_count_required)&&engineParity;
const rowCustodyGate=targetRowCount===Number(science.target_rows_required)&&seedRows.length===freeze.r2b1_seed_label_custody.rows&&seedBytes.length===freeze.r2b1_seed_label_custody.bytes&&targetRows.length===science.frozen_target_signal.rows&&duplicateGameIds===0;
const researchQualified=fiveProbabilityGatesPass&&exactFiveFoldGate&&rowCustodyGate;
const outBytes=Buffer.from(oos.map(stable).join('\n')+'\n','utf8');
fs.writeFileSync(OUT,outBytes);
const decision=researchQualified?science.decision.if_all_five_gates_pass_and_five_folds_exact:science.decision.otherwise;
const evidence={
  name:'WNBA_R2B2_FIVE_FOLD_PLATT_CERTIFICATION_EVIDENCE_V1',decision,candidate:science.candidate,calibrationCandidate:science.calibration_candidate,
  scientificContract:{path:SCIENCE,gitBlobSha:freeze.scientific_contract_git_blob_sha,status:science.status},
  inputCustody:{seed2020:{rows:seedRows.length,bytes:seedBytes.length,expectedBytes:freeze.r2b1_seed_label_custody.bytes,sha256:seedSha,expectedSha256:freeze.r2b1_seed_label_custody.sha256,match:seedSha===freeze.r2b1_seed_label_custody.sha256&&seedBytes.length===freeze.r2b1_seed_label_custody.bytes,role:'TRAINING_ONLY_NEVER_TARGET_FOLD'},target2021To2025:{rows:targetRows.length,sha256:targetSha,expectedSha256:science.frozen_target_signal.scored_rowset_sha256,match:targetSha===science.frozen_target_signal.scored_rowset_sha256},duplicateGameIds},
  engine:{sourcePullRequest:science.calibration_engine.source_pull_request,gitBlobSha:science.calibration_engine.git_blob_sha,method:science.calibration_engine.method,split:science.calibration_engine.split,exactWalkForwardFunctionParityAllFolds:engineParity},
  targetFolds:actualTargets,targetFoldCount:actualTargets.length,targetFoldCountRequired:science.target_fold_count_required,fiveTargetSeasonRequirementMet:actualTargets.length===science.target_fold_count_required,
  folds:foldEvidence,
  pooledOos2021To2025:{observations:targetRowCount,selectedSideAccuracy:meanBinary(pooledYs),raw:pooledRaw,calibrated:pooledCal,walkForwardClimatology:pooledBaseline,calibratedCalibrationInTheLargeAbsZ:pooledZ,calibratedMeanPredictedMinusObserved:pooledBias},
  frozenGates:gates,allFiveProbabilityGatesPass:fiveProbabilityGatesPass,exactFiveFoldGatePass:exactFiveFoldGate,rowCustodyGatePass:rowCustodyGate,researchProbabilityFoundationQualified:researchQualified,
  calibratedOosRowset:{rows:oos.length,bytes:outBytes.length,sha256:sha256(outBytes)},
  chronology:{scientificThresholdsFrozenBefore2020OutcomeOpening:true,r2b1SeedLabelShaFrozenBeforeR2B2:true,seed2020UsedAsTargetFold:false,targetSeasonsUsedToTrainTheirOwnCalibrator:false,targetSeasonOutcomesUsedToSetOwnClimatologyBaseline:false},
  rowsDroppedAfterOutcomes:0,coefficientRetunePerformed:false,featureSearchPerformed:false,thresholdSearchPerformed:false,candidateSwitchPerformed:false,plattMethodChanged:false,optimizerChanged:false,gateWeakeningPerformed:false,targetSeasonRankingOrCapUsed:false,marketDataConsumed:false,historicalHitRateUsedAsGameProbability:false,
  sportEliteGatePassed:false,exactProductionSportsOnlyV1Rehabilitated:false,globalRankerPromotionAuthorized:false,productionChangeAuthorized:false,automaticBettingAuthorized:false,realFinancialExposure:0,
  nextGate:researchQualified?'R2C_FREEZE_CALIBRATED_WNBA_PROBABILITY_FOUNDATION_THEN_SEPARATE_SPORT_ELITE_SELECTION_POLICY_RESEARCH':'STOP_CALIBRATION_PATH_NO_POST_RESULT_RETUNE',
};
fs.writeFileSync(EVIDENCE,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(!engineParity||!rowCustodyGate) process.exit(2);

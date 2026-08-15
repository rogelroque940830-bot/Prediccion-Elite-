#!/usr/bin/env python3
import argparse
import importlib.util
import json
import math
import os

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA='courtedge-p0-step12v38-pitcher-hits-allowed-no-retune-robustness.v1'

def load(path):
    with open(path,encoding='utf-8') as f:return json.load(f)
def dump(path,payload):
    os.makedirs(os.path.dirname(path) or '.',exist_ok=True)
    with open(path,'w',encoding='utf-8') as f:json.dump(payload,f,indent=2,sort_keys=True);f.write('\n')
def load_v37(path):
    spec=importlib.util.spec_from_file_location('courtedge_v37_pitcher_hits_allowed',path)
    if spec is None or spec.loader is None:raise SystemExit('V38_V37_MODULE_LOAD_FAILED')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def assert_close(label,actual,expected,tol):
    if not math.isfinite(float(actual)) or not math.isfinite(float(expected)):raise SystemExit(f'V38_PARITY_NONFINITE:{label}:{actual}:{expected}')
    if abs(float(actual)-float(expected))>tol:raise SystemExit(f'V38_V37_PARITY_MISMATCH:{label}:{actual}:{expected}:tol={tol}')
def poisson_deviance_per_row(y,mu):
    y=np.asarray(y,float);mu=np.maximum(np.asarray(mu,float),1e-12);out=np.empty_like(mu);zero=y<=0
    out[zero]=2.0*mu[zero];pos=~zero;out[pos]=2.0*(y[pos]*np.log(y[pos]/mu[pos])-(y[pos]-mu[pos]));return out
def bootstrap_date_means(frame,metric_arrays,replicates,seed,confidence):
    names=list(metric_arrays);work=frame[['officialDate']].copy().reset_index(drop=True)
    for name,values in metric_arrays.items():work[name]=np.asarray(values,float)
    daily=work.groupby('officialDate',sort=True)[names].mean()
    if len(daily)<2:raise SystemExit('V38_BOOTSTRAP_TOO_FEW_DATES')
    values=daily.to_numpy(float);point=np.mean(values,axis=0);rng=np.random.default_rng(seed);n=len(values);boot=np.empty((replicates,len(names)),float);cursor=0
    while cursor<replicates:
        count=min(500,replicates-cursor);idx=rng.integers(0,n,size=(count,n));boot[cursor:cursor+count]=np.mean(values[idx],axis=1);cursor+=count
    alpha=1.0-confidence;lo=np.percentile(boot,100.0*alpha/2.0,axis=0);hi=np.percentile(boot,100.0*(1.0-alpha/2.0),axis=0)
    metrics={name:{'equalDayPointEstimate':float(point[i]),'ciLower':float(lo[i]),'ciUpper':float(hi[i])} for i,name in enumerate(names)}
    return {'clusterUnit':'OFFICIAL_DATE','uniqueDates':int(n),'replicates':int(replicates),'randomSeed':int(seed),'confidenceLevel':float(confidence),'aggregationWithinCluster':'MEAN_PER_PITCHER_START_LOSS_IMPROVEMENT_WITHIN_DATE','aggregationAcrossClusters':'EQUAL_WEIGHT_MEAN_ACROSS_OFFICIAL_DATES','metrics':metrics}

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--contract',required=True);p.add_argument('--v37-contract',required=True);p.add_argument('--v37-script',required=True);p.add_argument('--v37-report',required=True);p.add_argument('--out',required=True);args=p.parse_args()
    contract=load(args.contract)
    if contract.get('schemaVersion')!='courtedge-p0-step12v38-pitcher-hits-allowed-no-retune-robustness-contract.v1':raise SystemExit('V38_CONTRACT_SCHEMA_INVALID')
    v37c=load(args.v37_contract);v37r=load(args.v37_report)
    if v37r.get('classification')!=contract['parentEvidence']['v37ClassificationRequired']:raise SystemExit('V38_V37_PARENT_CLASSIFICATION_INVALID')
    if not v37r.get('candidateRubricPassed'):raise SystemExit('V38_V37_PARENT_GATE_NOT_PASSED')
    v37=load_v37(args.v37_script)
    seasons=[v37c['dataBoundary']['modelFitSeason'],v37c['dataBoundary']['validationSeason'],*v37c['dataBoundary']['retrospectiveEvaluationSeasons']]
    records=[];custody={}
    for season in seasons:
        rows,c=v37.build(args.root,season,v37c);records.extend(rows);custody[season]=c
    frame=pd.DataFrame.from_records(records);features=tuple(v37c['features']['exactly']);train=frame[frame.season=='2022'].copy();validation=frame[frame.season=='2023'].copy();evaluation=frame[frame.season.isin(['2024','2025','2026_YTD'])].copy()
    if min(len(train),len(validation),len(evaluation))<=0:raise SystemExit('V38_EMPTY_PARTITION')
    imputer=SimpleImputer(strategy='median');scaler=StandardScaler();Xtrain=scaler.fit_transform(imputer.fit_transform(train[list(features)]));ytrain=train['hitsAllowed'].to_numpy(float);cfg=v37c['model'];model=PoissonRegressor(alpha=float(cfg['poissonAlpha']),max_iter=int(cfg['maxIter']));model.fit(Xtrain,ytrain);train_mu=np.maximum(model.predict(Xtrain),1e-9);disp=v37.nb2(ytrain,train_mu);train_mean=float(np.mean(ytrain));lines=[float(x) for x in cfg['fixedHalfRunLines']];line_probs={line:float(np.mean(ytrain>line)) for line in lines}
    vm=v37.evaluate(validation,features,imputer,scaler,model,disp,train_mean,line_probs,lines);em=v37.evaluate(evaluation,features,imputer,scaler,model,disp,train_mean,line_probs,lines)
    tol=float(contract['replayParity']['absoluteTolerance'])
    for metric in contract['replayParity']['requiredMetrics']:
        assert_close(f'validation2023.{metric}',vm[metric],v37r['validation2023'][metric],tol);assert_close(f'evaluation2024_2026Ytd.{metric}',em[metric],v37r['evaluation2024_2026Ytd'][metric],tol)
    season_metrics={};season_checks={}
    for season in contract['seasonStabilityGate']['partitions']:
        m=v37.evaluate(frame[frame.season==season].copy(),features,imputer,scaler,model,disp,train_mean,line_probs,lines);season_metrics[season]=m;season_checks[season]={'modelDevianceBeatsConstant':m['modelVsConstantDevianceImprovement']>0.0,'modelDevianceBeatsPitcherOnly':m['modelVsPitcherOnlyDevianceImprovement']>0.0,'modelAverageBrierBeatsConstant':m['modelVsConstantAverageBrierImprovement']>0.0,'modelAverageBrierBeatsPitcherOnly':m['modelVsPitcherOnlyAverageBrierImprovement']>0.0,'modelAbsoluteMeanBiasNoWorseThanConstant':m['modelAbsoluteMeanCalibrationBias']<=m['constantAbsoluteMeanCalibrationBias'],'modelAbsoluteMeanBiasNoWorseThanPitcherOnly':m['modelAbsoluteMeanCalibrationBias']<=m['pitcherOnlyAbsoluteMeanCalibrationBias']}
    ef=evaluation.reset_index(drop=True);Xe=scaler.transform(imputer.transform(ef[list(features)]));model_mu=np.maximum(model.predict(Xe),1e-9);y=ef['hitsAllowed'].to_numpy(float);const_mu=np.full(len(ef),train_mean,float);pitch_mu=ef['pitcherOnlyMuRaw'].to_numpy(float);pitch_mu=np.where(np.isfinite(pitch_mu)&(pitch_mu>0),pitch_mu,train_mean)
    model_dev=poisson_deviance_per_row(y,model_mu);const_dev=poisson_deviance_per_row(y,const_mu);pitch_dev=poisson_deviance_per_row(y,pitch_mu);cb=[];pb=[]
    for line in lines:
        obs=(y>line).astype(float);mp=np.asarray([v37.overp(mu,disp,line) for mu in model_mu]);pp=np.asarray([v37.overp(mu,disp,line) for mu in pitch_mu]);cp=float(line_probs[line]);ml=(mp-obs)**2;cb.append((cp-obs)**2-ml);pb.append((pp-obs)**2-ml)
    arrays={'devianceVsConstant':const_dev-model_dev,'devianceVsPitcherOnly':pitch_dev-model_dev,'averageBrierVsConstant':np.mean(np.vstack(cb),axis=0),'averageBrierVsPitcherOnly':np.mean(np.vstack(pb),axis=0)};bcfg=contract['dateClusterBootstrapGate'];boot=bootstrap_date_means(ef,arrays,int(bcfg['replicates']),int(bcfg['randomSeed']),float(bcfg['confidenceLevel']));boot_checks={name:v['ciLower']>0.0 for name,v in boot['metrics'].items()}
    season_pass=all(all(x.values()) for x in season_checks.values());boot_pass=all(boot_checks.values());passed=season_pass and boot_pass;classification=contract['classification']['pass'] if passed else contract['classification']['fail']
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'robustnessGatePassed':passed,'parent':{'v37Classification':v37r['classification'],'v37CandidateRubricPassed':v37r['candidateRubricPassed'],'v37WorkflowRunId':contract['parentEvidence']['v37WorkflowRunId'],'v37ArtifactId':contract['parentEvidence']['v37ArtifactId']},'modelBoundary':{'unchangedV37ImplementationReplayed':True,'replayParityTolerance':tol,'replayParityPassed':True,'refitWithAdditionalSeasonsUsed':False,'recalibrationUsed':False,'coefficientChangeUsed':False,'featureChangeUsed':False,'imputationChangeUsed':False,'scalingChangeUsed':False,'dispersionChangeUsed':False,'lineSetChangeUsed':False,'baselineFormulaChangeUsed':False,'thresholdSearchUsed':False},'data':{'scoredRows':int(len(frame)),'custodyBySeason':custody,'featureCount':len(features),'features':list(features)},'seasonMetrics':season_metrics,'seasonStabilityChecks':season_checks,'seasonStabilityGatePassed':season_pass,'dateClusterBootstrap':boot,'bootstrapChecks':boot_checks,'bootstrapGatePassed':boot_pass,'marketBoundary':{'providerMarketKey':'pitcher_hits_allowed','repositoryRegistryFamily':'PITCHER_PROP','historicalPitcherHitsAllowedPricesUsed':False,'positiveEvEstablished':False,'hardRockFloridaPerEventAvailabilityEstablished':False,'prospectivePriceCaptureEngineeringAuthorized':bool(passed),'productionPromotionAuthorized':False},'policy':{'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'thresholdSearchUsed':False,'subsetMiningUsed':False,'postResultRuleChangeUsed':False,'productionMarketRegistryChanged':False,'liveLookupAuthorizationChanged':False,'liveMarketDiscoveryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}}
    dump(args.out,report);print(json.dumps({'classification':classification,'robustnessGatePassed':passed,'seasonStabilityGatePassed':season_pass,'seasonStabilityChecks':season_checks,'seasonMetrics':season_metrics,'bootstrapGatePassed':boot_pass,'dateClusterBootstrap':boot,'bootstrapChecks':boot_checks},indent=2))
if __name__=='__main__':main()

#!/usr/bin/env python3
import argparse,importlib.util,json,math,os
import numpy as np,pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.preprocessing import StandardScaler
REPORT_SCHEMA='courtedge-p0-step12v40-pitcher-outs-no-retune-robustness.v1'
def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,x):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(x,f,indent=2,sort_keys=True);f.write('\n')
def load_v39(path):
    spec=importlib.util.spec_from_file_location('courtedge_v39_pitcher_outs',path)
    if spec is None or spec.loader is None:raise SystemExit('V40_V39_MODULE_LOAD_FAILED')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def assert_close(label,a,b,tol):
    if not math.isfinite(float(a)) or not math.isfinite(float(b)):raise SystemExit(f'V40_PARITY_NONFINITE:{label}:{a}:{b}')
    if abs(float(a)-float(b))>tol:raise SystemExit(f'V40_V39_PARITY_MISMATCH:{label}:{a}:{b}:tol={tol}')
def poisson_dev_rows(y,mu):
    y=np.asarray(y,float);mu=np.maximum(np.asarray(mu,float),1e-12);o=np.empty_like(mu);z=y<=0;o[z]=2*mu[z];p=~z;o[p]=2*(y[p]*np.log(y[p]/mu[p])-(y[p]-mu[p]));return o
def bootstrap(frame,arrays,reps,seed,confidence):
    names=list(arrays);w=frame[['officialDate']].copy().reset_index(drop=True)
    for n,v in arrays.items():w[n]=np.asarray(v,float)
    daily=w.groupby('officialDate',sort=True)[names].mean();vals=daily.to_numpy(float)
    if len(vals)<2:raise SystemExit('V40_BOOTSTRAP_TOO_FEW_DATES')
    point=np.mean(vals,axis=0);rng=np.random.default_rng(seed);n=len(vals);boot=np.empty((reps,len(names)));cur=0
    while cur<reps:
        c=min(500,reps-cur);idx=rng.integers(0,n,size=(c,n));boot[cur:cur+c]=np.mean(vals[idx],axis=1);cur+=c
    a=1-confidence;lo=np.percentile(boot,100*a/2,axis=0);hi=np.percentile(boot,100*(1-a/2),axis=0)
    return {'clusterUnit':'OFFICIAL_DATE','uniqueDates':int(n),'replicates':int(reps),'randomSeed':int(seed),'confidenceLevel':float(confidence),'aggregationWithinCluster':'MEAN_PER_PITCHER_START_LOSS_IMPROVEMENT_WITHIN_DATE','aggregationAcrossClusters':'EQUAL_WEIGHT_MEAN_ACROSS_OFFICIAL_DATES','metrics':{name:{'equalDayPointEstimate':float(point[i]),'ciLower':float(lo[i]),'ciUpper':float(hi[i])} for i,name in enumerate(names)}}
def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--contract',required=True);p.add_argument('--v39-contract',required=True);p.add_argument('--v39-script',required=True);p.add_argument('--v39-report',required=True);p.add_argument('--out',required=True);a=p.parse_args();c=load(a.contract)
    if c.get('schemaVersion')!='courtedge-p0-step12v40-pitcher-outs-no-retune-robustness-contract.v1':raise SystemExit('V40_CONTRACT_SCHEMA_INVALID')
    v39c=load(a.v39_contract);v39r=load(a.v39_report)
    if v39r.get('classification')!=c['parentEvidence']['v39ClassificationRequired']:raise SystemExit('V40_V39_PARENT_CLASSIFICATION_INVALID')
    if not v39r.get('candidateRubricPassed'):raise SystemExit('V40_V39_PARENT_GATE_NOT_PASSED')
    v39=load_v39(a.v39_script);records=[];cust={}
    for s in [v39c['dataBoundary']['modelFitSeason'],v39c['dataBoundary']['validationSeason'],*v39c['dataBoundary']['retrospectiveEvaluationSeasons']]:
        r,k=v39.build(a.root,s,v39c);records+=r;cust[s]=k
    df=pd.DataFrame(records);features=tuple(v39c['features']['exactly']);tr=df[df.season=='2022'].copy();va=df[df.season=='2023'].copy();ev=df[df.season.isin(['2024','2025','2026_YTD'])].copy();imp=SimpleImputer(strategy='median');sc=StandardScaler();Xt=sc.fit_transform(imp.fit_transform(tr[list(features)]));ytr=tr.outsRecorded.to_numpy(float);cfg=v39c['model'];model=PoissonRegressor(alpha=float(cfg['poissonAlpha']),max_iter=int(cfg['maxIter']));model.fit(Xt,ytr);tmu=np.maximum(model.predict(Xt),1e-9);disp=v39.nb2(ytr,tmu);tm=float(np.mean(ytr));lines=[float(x) for x in cfg['fixedHalfOutLines']];lp={x:float(np.mean(ytr>x)) for x in lines};vm=v39.evaluate(va,features,imp,sc,model,disp,tm,lp,lines);em=v39.evaluate(ev,features,imp,sc,model,disp,tm,lp,lines)
    tol=float(c['replayParity']['absoluteTolerance'])
    for metric in c['replayParity']['requiredMetrics']:
        assert_close('validation2023.'+metric,vm[metric],v39r['validation2023'][metric],tol);assert_close('evaluation2024_2026Ytd.'+metric,em[metric],v39r['evaluation2024_2026Ytd'][metric],tol)
    sm={};checks={}
    for s in c['seasonStabilityGate']['partitions']:
        m=v39.evaluate(df[df.season==s].copy(),features,imp,sc,model,disp,tm,lp,lines);sm[s]=m;checks[s]={'modelDevianceBeatsConstant':m['modelVsConstantDevianceImprovement']>0,'modelDevianceBeatsPitcherOnly':m['modelVsPitcherOnlyDevianceImprovement']>0,'modelAverageBrierBeatsConstant':m['modelVsConstantAverageBrierImprovement']>0,'modelAverageBrierBeatsPitcherOnly':m['modelVsPitcherOnlyAverageBrierImprovement']>0,'modelAbsoluteMeanBiasNoWorseThanConstant':m['modelAbsoluteMeanCalibrationBias']<=m['constantAbsoluteMeanCalibrationBias'],'modelAbsoluteMeanBiasNoWorseThanPitcherOnly':m['modelAbsoluteMeanCalibrationBias']<=m['pitcherOnlyAbsoluteMeanCalibrationBias']}
    ef=ev.reset_index(drop=True);Xe=sc.transform(imp.transform(ef[list(features)]));mmu=np.maximum(model.predict(Xe),1e-9);y=ef.outsRecorded.to_numpy(float);cmu=np.full(len(ef),tm,float);pmu=ef.pitcherOnlyMuRaw.to_numpy(float);pmu=np.where(np.isfinite(pmu)&(pmu>0),pmu,tm);md=poisson_dev_rows(y,mmu);cd=poisson_dev_rows(y,cmu);pitch_dev=poisson_dev_rows(y,pmu);cb=[];pb=[]
    for line in lines:
        obs=(y>line).astype(float);mp=np.array([v39.overp(x,disp,line) for x in mmu]);pp=np.array([v39.overp(x,disp,line) for x in pmu]);cp=float(lp[line]);ml=(mp-obs)**2;cb.append((cp-obs)**2-ml);pb.append((pp-obs)**2-ml)
    arrays={'devianceVsConstant':cd-md,'devianceVsPitcherOnly':pitch_dev-md,'averageBrierVsConstant':np.mean(np.vstack(cb),axis=0),'averageBrierVsPitcherOnly':np.mean(np.vstack(pb),axis=0)};bc=c['dateClusterBootstrapGate'];bt=bootstrap(ef,arrays,int(bc['replicates']),int(bc['randomSeed']),float(bc['confidenceLevel']));bchecks={n:v['ciLower']>0 for n,v in bt['metrics'].items()};spass=all(all(x.values()) for x in checks.values());bpass=all(bchecks.values());passed=spass and bpass;clas=c['classification']['pass'] if passed else c['classification']['fail'];report={'schemaVersion':REPORT_SCHEMA,'classification':clas,'robustnessGatePassed':passed,'parent':{'v39Classification':v39r['classification'],'v39CandidateRubricPassed':v39r['candidateRubricPassed'],'v39WorkflowRunId':c['parentEvidence']['v39WorkflowRunId'],'v39ArtifactId':c['parentEvidence']['v39ArtifactId']},'modelBoundary':{'unchangedV39ImplementationReplayed':True,'replayParityTolerance':tol,'replayParityPassed':True,'refitWithAdditionalSeasonsUsed':False,'recalibrationUsed':False,'coefficientChangeUsed':False,'featureChangeUsed':False,'imputationChangeUsed':False,'scalingChangeUsed':False,'dispersionChangeUsed':False,'lineSetChangeUsed':False,'baselineFormulaChangeUsed':False,'thresholdSearchUsed':False},'data':{'scoredRows':int(len(df)),'custodyBySeason':cust,'featureCount':len(features),'features':list(features)},'seasonMetrics':sm,'seasonStabilityChecks':checks,'seasonStabilityGatePassed':spass,'dateClusterBootstrap':bt,'bootstrapChecks':bchecks,'bootstrapGatePassed':bpass,'marketBoundary':{'providerMarketKey':'pitcher_outs','repositoryRegistryFamily':'PITCHER_PROP','historicalPitcherOutPricesUsed':False,'positiveEvEstablished':False,'hardRockFloridaPerEventAvailabilityEstablished':False,'prospectivePriceCaptureEngineeringAuthorized':bool(passed),'productionPromotionAuthorized':False},'policy':{'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'thresholdSearchUsed':False,'subsetMiningUsed':False,'postResultRuleChangeUsed':False,'productionMarketRegistryChanged':False,'liveLookupAuthorizationChanged':False,'liveMarketDiscoveryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}};dump(a.out,report);print(json.dumps({'classification':clas,'robustnessGatePassed':passed,'seasonStabilityGatePassed':spass,'seasonStabilityChecks':checks,'seasonMetrics':sm,'bootstrapGatePassed':bpass,'dateClusterBootstrap':bt,'bootstrapChecks':bchecks},indent=2))
if __name__=='__main__':main()

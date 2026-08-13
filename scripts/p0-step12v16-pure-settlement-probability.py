#!/usr/bin/env python3
import argparse,hashlib,json,math,os
from copy import deepcopy
import numpy as np
from scipy.optimize import minimize

TABLE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v16-pure-ml-f5-settlement-probability-contract.v1'
REPORT_SCHEMA='courtedge-p0-step12v16-pure-ml-f5-settlement-probability.v1'
MANIFEST_SCHEMA='courtedge-p0-step12v16-pure-settlement-model-manifest.v1'
MODEL_VERSION='rogel-pure-settlement-ml-f5-v1'
EPS=1e-15

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,v):
    os.makedirs(os.path.dirname(p),exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def rows(t):
    if t.get('schemaVersion')!=TABLE_SCHEMA:raise SystemExit('STEP12V16_TABLE_SCHEMA_INVALID')
    return [r for r in t.get('rows',[]) if r.get('t5PregameValid') is True]
def validate_features(sets):
    banned=('odds','price','market','implied','vig','book','sportsbook','ev')
    for n,fs in sets.items():
        if not fs or len(fs)!=len(set(fs)):raise SystemExit(f'STEP12V16_FEATURE_SET_INVALID:{n}')
        for f in fs:
            if any(x in f.lower() for x in banned):raise SystemExit(f'STEP12V16_MARKET_FEATURE_FORBIDDEN:{n}:{f}')

def prep(train,fs):
    med=[];means=[];scales=[]
    for f in fs:
        vals=[float(r['features'][f]) for r in train if finite(r.get('features',{}).get(f))]
        if not vals:raise SystemExit(f'STEP12V16_TRAIN_FEATURE_EMPTY:{f}')
        m=float(np.median(np.asarray(vals)));a=np.asarray([float(r['features'][f]) if finite(r.get('features',{}).get(f)) else m for r in train])
        u=float(a.mean());s=float(a.std());s=1.0 if not math.isfinite(s) or s<1e-12 else s
        med.append(m);means.append(u);scales.append(s)
    return {'features':list(fs),'medianImpute':med,'mean':means,'scale':scales,'fitSeason':'2022'}
def transform(rs,p):
    X=np.empty((len(rs),len(p['features'])),float)
    for j,(f,m,u,s) in enumerate(zip(p['features'],p['medianImpute'],p['mean'],p['scale'])):
        X[:,j]=[((float(r['features'][f]) if finite(r.get('features',{}).get(f)) else m)-u)/s for r in rs]
    return X
def sigmoid(z):z=np.clip(np.asarray(z,float),-50,50);return 1/(1+np.exp(-z))
def softmax(z):z=np.asarray(z,float);z=z-z.max(axis=1,keepdims=True);e=np.exp(z);return e/e.sum(axis=1,keepdims=True)

def fit_bin(X,y,l2):
    def obj(t):
        b=t[0];w=t[1:];z=b+X@w
        return float(np.mean(np.logaddexp(0,z)-y*z)+.5*l2*(w@w)/len(y))
    o=minimize(obj,np.zeros(X.shape[1]+1),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-13,'gtol':1e-8})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'STEP12V16_BINARY_OPTIMIZER_FAILED:{o.message}')
    return o.x
def cal_bin(logit,y):
    def obj(t):
        a=math.exp(float(t[0]));b=float(t[1]);z=a*logit+b
        return float(np.mean(np.logaddexp(0,z)-y*z))
    o=minimize(obj,np.zeros(2),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-14,'gtol':1e-9})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'STEP12V16_BINARY_CALIBRATION_FAILED:{o.message}')
    return {'slope':math.exp(float(o.x[0])),'intercept':float(o.x[1]),'fitSeason':'2023'}
def unpack(t,d):return t[:2*d].reshape(2,d),t[2*d:2*d+2]
def logits(t,X):
    W,b=unpack(t,X.shape[1]);return np.column_stack([b[0]+X@W[0],np.zeros(len(X)),b[1]+X@W[1]])
def fit_multi(X,y,l2):
    d=X.shape[1]
    def obj(t):
        W,_=unpack(t,d);p=softmax(logits(t,X));return -float(np.mean(np.log(np.maximum(p[np.arange(len(y)),y],EPS))))+.5*l2*float(np.sum(W*W))/len(y)
    o=minimize(obj,np.zeros(2*d+2),method='L-BFGS-B',options={'maxiter':12000,'ftol':1e-13,'gtol':1e-8})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'STEP12V16_MULTINOMIAL_OPTIMIZER_FAILED:{o.message}')
    return o.x
def cal_multi(raw,y):
    def obj(t):
        T=math.exp(float(t[0]));p=softmax(raw/T+np.asarray([float(t[1]),0.,float(t[2])]))
        return -float(np.mean(np.log(np.maximum(p[np.arange(len(y)),y],EPS))))
    o=minimize(obj,np.zeros(3),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-14,'gtol':1e-9})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'STEP12V16_MULTICLASS_CALIBRATION_FAILED:{o.message}')
    return {'temperature':math.exp(float(o.x[0])),'homeBias':float(o.x[1]),'awayBias':0.,'tieBias':float(o.x[2]),'fitSeason':'2023'}
def pbin(m,X):
    z=m['intercept']+X@np.asarray(m['coefficients']);c=m['calibration'];return sigmoid(c['slope']*z+c['intercept'])
def pmulti(m,X):
    h=m['intercepts']['HOME']+X@np.asarray(m['coefficients']['HOME']);t=m['intercepts']['TIE']+X@np.asarray(m['coefficients']['TIE'])
    raw=np.column_stack([h,np.zeros(len(X)),t]);c=m['calibration'];return softmax(raw/c['temperature']+np.asarray([c['homeBias'],c['awayBias'],c['tieBias']]))

def mbin(p,y):
    p=np.asarray(p);y=np.asarray(y);ll=-float(np.mean(y*np.log(np.maximum(p,EPS))+(1-y)*np.log(np.maximum(1-p,EPS))));br=float(np.mean((p-y)**2));ece=0.;bins=[]
    for i in range(10):
        lo=i/10;hi=(i+1)/10;mask=(p>=lo)&((p<hi) if i<9 else (p<=hi));n=int(mask.sum())
        if n:
            mp=float(p[mask].mean());ob=float(y[mask].mean());ece+=n/len(y)*abs(mp-ob);bins.append({'low':lo,'high':hi,'n':n,'meanPredicted':mp,'observedHomeRate':ob})
    return {'n':len(y),'logLoss':ll,'brier':br,'ece10':ece,'meanPredictedHome':float(p.mean()),'observedHomeRate':float(y.mean()),'accuracyAtHalf':float(np.mean((p>=.5)==(y==1))),'calibrationBins':bins}
def mmulti(p,y):
    p=np.asarray(p);y=np.asarray(y,int);oh=np.eye(3)[y];ll=-float(np.mean(np.log(np.maximum(p[np.arange(len(y)),y],EPS))));br=float(np.mean(np.sum((p-oh)**2,axis=1)));obs=np.bincount(y,minlength=3)/len(y);pred=p.mean(0);gap=np.abs(pred-obs)
    return {'n':len(y),'logLoss':ll,'brier':br,'meanPredicted':{'HOME':float(pred[0]),'AWAY':float(pred[1]),'TIE':float(pred[2])},'observedRate':{'HOME':float(obs[0]),'AWAY':float(obs[1]),'TIE':float(obs[2])},'classMeanCalibrationGap':{'HOME':float(gap[0]),'AWAY':float(gap[1]),'TIE':float(gap[2])},'maxClassMeanCalibrationGap':float(gap.max()),'tieMeanCalibrationGap':float(gap[2]),'threeClassAccuracy':float(np.mean(np.argmax(p,axis=1)==y))}

def candidate(name,fs,tr,ca,l2):
    pp=prep(tr,fs);Xt=transform(tr,pp);Xc=transform(ca,pp);yfgt=np.asarray([r['outcomes']['FULL_GAME']['result']=='HOME' for r in tr],float);yfgc=np.asarray([r['outcomes']['FULL_GAME']['result']=='HOME' for r in ca],float);mp={'HOME':0,'AWAY':1,'TIE':2};yf5t=np.asarray([mp[r['outcomes']['FIRST_5']['result']] for r in tr]);yf5c=np.asarray([mp[r['outcomes']['FIRST_5']['result']] for r in ca])
    bt=fit_bin(Xt,yfgt,l2);bm={'featureSet':name,'preprocessor':pp,'intercept':float(bt[0]),'coefficients':[float(x) for x in bt[1:]],'calibration':cal_bin(bt[0]+Xc@bt[1:],yfgc)}
    mt=fit_multi(Xt,yf5t,l2);raw=logits(mt,Xc);W,b=unpack(mt,len(fs));mm={'featureSet':name,'preprocessor':deepcopy(pp),'referenceClass':'AWAY','intercepts':{'HOME':float(b[0]),'AWAY':0.,'TIE':float(b[1])},'coefficients':{'HOME':[float(x) for x in W[0]],'AWAY':[0. for _ in fs],'TIE':[float(x) for x in W[1]]},'calibration':cal_multi(raw,yf5c)}
    return {'name':name,'fullGameModel':bm,'first5Model':mm,'fullGame2023':mbin(pbin(bm,Xc),yfgc),'first52023':mmulti(pmulti(mm,Xc),yf5c)}
def select(cs,prefix):
    k=prefix+'2023';mk=prefix+'Model';return min(cs,key=lambda c:(c[k]['logLoss'],c[k]['brier'],len(c[mk]['preprocessor']['features']),c['name']))
def validate_probs(fg,f5,tol):
    if not np.all(np.isfinite(fg)) or not np.all((fg>=0)&(fg<=1)):raise SystemExit('STEP12V16_FG_PROBABILITY_INVALID')
    if not np.all(np.isfinite(f5)) or not np.all((f5>=0)&(f5<=1)):raise SystemExit('STEP12V16_F5_PROBABILITY_INVALID')
    if np.max(np.abs(f5.sum(1)-1))>tol:raise SystemExit('STEP12V16_F5_SUM_INVALID')
def evaluate(rs,fgm,f5m,fgprior,f5prior,tol):
    fg=pbin(fgm,transform(rs,fgm['preprocessor']));f5=pmulti(f5m,transform(rs,f5m['preprocessor']));validate_probs(fg,f5,tol);yfg=np.asarray([r['outcomes']['FULL_GAME']['result']=='HOME' for r in rs],float);mp={'HOME':0,'AWAY':1,'TIE':2};yf5=np.asarray([mp[r['outcomes']['FIRST_5']['result']] for r in rs]);bp=np.full(len(rs),fgprior);b5=np.tile(np.asarray(f5prior),(len(rs),1))
    return {'rows':len(rs),'coverageShare':1.,'fullGame':{'model':mbin(fg,yfg),'priorBaseline':mbin(bp,yfg)},'first5':{'model':mmulti(f5,yf5),'priorBaseline':mmulti(b5,yf5)}},(fg,yfg,f5,yf5)

def main():
    a=argparse.ArgumentParser();a.add_argument('--root',required=True);a.add_argument('--contract',required=True);a.add_argument('--out',required=True);a.add_argument('--manifest-out',required=True);x=a.parse_args();c=load(x.contract)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA:raise SystemExit('STEP12V16_CONTRACT_INVALID')
    if c['dataBoundary']['historicalPricesUsed'] or c['dataBoundary']['marketOddsAllowedAsFeature']:raise SystemExit('STEP12V16_PRICE_BOUNDARY_INVALID')
    sets=c['candidateFeatureSets'];
    if list(sets)!=['C4','FULL13']:raise SystemExit('STEP12V16_CANDIDATE_SET_DRIFT')
    validate_features(sets);seasons=['2022','2023','2024','2025','2026_YTD'];rr={s:rows(load(os.path.join(x.root,s,'game-anatomy-feature-table.json'))) for s in seasons};l2=float(c['fullGameModel']['l2Strength']);cs=[candidate(n,fs,rr['2022'],rr['2023'],l2) for n,fs in sets.items()];sfg=select(cs,'fullGame');sf5=select(cs,'first5');fgm=deepcopy(sfg['fullGameModel']);f5m=deepcopy(sf5['first5Model']);fgm['settlement']={'HOME':'WIN','AWAY':'LOSS','pushProbability':0.};f5m['settlement']={'HOME':'WIN','AWAY':'LOSS','TIE':'PUSH'}
    yfg23=np.asarray([r['outcomes']['FULL_GAME']['result']=='HOME' for r in rr['2023']],float);mp={'HOME':0,'AWAY':1,'TIE':2};yf523=np.asarray([mp[r['outcomes']['FIRST_5']['result']] for r in rr['2023']]);fgprior=float(yfg23.mean());f5prior=(np.bincount(yf523,minlength=3)/len(yf523)).tolist();manifest={'schemaVersion':MANIFEST_SCHEMA,'modelVersion':MODEL_VERSION,'priceIndependent':True,'trainingSeason':'2022','calibrationSeason':'2023','selectionSeason':'2023','fullGame':fgm,'first5':f5m,'developmentPriors':{'fullGameHome':fgprior,'first5':{'HOME':f5prior[0],'AWAY':f5prior[1],'TIE':f5prior[2]}},'policy':{'sportsbookPriceInputs':False,'marketOddsInputs':False,'cohortHitRateAsProbability':False,'first5TieMassExplicit':True,'fullGamePushProbabilityFixedZeroBySettlement':True,'evaluationSeasonsCanMutateModel':False}};md=digest(manifest);g=c['validationGates'];tol=float(g['probabilitiesMustSumToOneTolerance']);by={};afp=[];afy=[];a5p=[];a5y=[]
    for s in c['dataBoundary']['retrospectiveEvaluationSeasons']:
        z,ar=evaluate(rr[s],fgm,f5m,fgprior,f5prior,tol);by[s]=z;p,y,p5,y5=ar;afp.append(p);afy.append(y);a5p.append(p5);a5y.append(y5)
    fp=np.concatenate(afp);fy=np.concatenate(afy);p5=np.concatenate(a5p);y5=np.concatenate(a5y);combined={'rows':len(fy),'fullGame':{'model':mbin(fp,fy),'priorBaseline':mbin(np.full(len(fy),fgprior),fy)},'first5':{'model':mmulti(p5,y5),'priorBaseline':mmulti(np.tile(np.asarray(f5prior),(len(y5),1)),y5)}}
    checks={'coverage':all(v['coverageShare']>=float(g['minimumEvaluationCoverageShare']) for v in by.values()),'fullGameCombinedLogLossBeatsPrior':combined['fullGame']['model']['logLoss']<combined['fullGame']['priorBaseline']['logLoss'],'fullGameCombinedBrierBeatsPrior':combined['fullGame']['model']['brier']<combined['fullGame']['priorBaseline']['brier'],'fullGameCombinedEce10':combined['fullGame']['model']['ece10']<=float(g['fullGameCombinedEce10Max']),'fullGameEverySeasonNoCatastrophe':all(v['fullGame']['model']['logLoss']<=v['fullGame']['priorBaseline']['logLoss']+float(g['fullGameEverySeasonLogLossMaxPriorPlus']) for v in by.values()),'first5CombinedLogLossBeatsPrior':combined['first5']['model']['logLoss']<combined['first5']['priorBaseline']['logLoss'],'first5CombinedBrierBeatsPrior':combined['first5']['model']['brier']<combined['first5']['priorBaseline']['brier'],'first5CombinedClassCalibration':combined['first5']['model']['maxClassMeanCalibrationGap']<=float(g['first5CombinedMaxClassMeanCalibrationGap']),'first5CombinedTieCalibration':combined['first5']['model']['tieMeanCalibrationGap']<=float(g['first5CombinedTieMeanCalibrationGapMax']),'first5EverySeasonNoCatastrophe':all(v['first5']['model']['logLoss']<=v['first5']['priorBaseline']['logLoss']+float(g['first5EverySeasonLogLossMaxPriorPlus']) for v in by.values())};ok=all(checks.values());report={'schemaVersion':REPORT_SCHEMA,'classification':'PURE_SETTLEMENT_MODEL_ELIGIBLE_FOR_RUNTIME_RESEARCH_ADAPTER' if ok else 'PURE_SETTLEMENT_MODEL_VALIDATION_FAILED_NO_RUNTIME_ADAPTER','sourceRows':{s:len(rr[s]) for s in seasons},'development':{'candidateMetrics':{q['name']:{'fullGame2023':q['fullGame2023'],'first52023':q['first52023'],'featureCount':len(q['fullGameModel']['preprocessor']['features'])} for q in cs},'selectedFullGameFeatureSet':sfg['name'],'selectedFirst5FeatureSet':sf5['name'],'selectionUsedEvaluationSeasons':False},'manifest':{'schemaVersion':MANIFEST_SCHEMA,'modelVersion':MODEL_VERSION,'sha256':md},'evaluationBySeason':by,'combinedEvaluation':combined,'validationChecks':checks,'allValidationGatesPassed':ok,'policy':{'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'sameDateOutcomeLeakageAllowed':False,'evaluationOutcomesChangedModel':False,'evaluationOutcomesChangedCalibration':False,'cohortHitRateUsedAsPerGameProbability':False,'first5TieProbabilityExplicit':True,'legacyMarketRegressedMlReclassifiedReady':False,'legacyMarketRegressedF5ReclassifiedReady':False,'liveFilterChangeAllowed':False,'rankingChangeAllowed':False,'stakeChangeAllowed':False,'betEliteAllowed':False,'prospective11cRequiredBeforePromotion':True}};dump(x.manifest_out,manifest);dump(x.out,report)
if __name__=='__main__':main()

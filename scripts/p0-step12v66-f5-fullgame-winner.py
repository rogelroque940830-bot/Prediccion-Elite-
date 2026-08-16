#!/usr/bin/env python3
import argparse,gzip,hashlib,json,math,os
from collections import defaultdict
import numpy as np
from scipy.optimize import minimize

EPS=1e-15
SEASONS=('2022','2023','2024','2025','2026_YTD')
EVAL=('2024','2025','2026_YTD')
CONTROL4=('lineup_exposure_rate_adv','starter_kbb_adv','combined_team_rs10','team_rd10_diff')
QUALITY=('starter_velocity_adv','starter_spin_adv','starter_swing_miss_adv','starter_in_zone_adv','starter_weak_contact_adv')
BP=('bullpen_pitches_1d','bullpen_pitches_3d','bullpen_core3_pitches_2d','bullpen_b2b_arms')
EXPECTED={'2022':2398,'2023':2399,'2024':2406,'2025':2423,'2026_YTD':1781}

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,v):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def load_custody(p):
    rr=[]
    op=gzip.open if str(p).endswith('.gz') else open
    with op(p,'rt',encoding='utf-8') as f:
        for line in f:
            if line.strip():rr.append(json.loads(line))
    return rr

def attach_outcomes(rr,root):
    by={}
    for s in SEASONS:
        t=load(os.path.join(root,s,'game-anatomy-feature-table.json'))
        xs=[r for r in t['rows'] if r.get('t5PregameValid') is True]
        if len(xs)!=EXPECTED[s]:raise SystemExit(f'V66_SCORE_CONTROL_ROWS_DRIFT:{s}:{len(xs)}')
        for r in xs:by[(s,int(r['gamePk']))]=r['outcomes']
    out=[]
    for r in rr:
        k=(r['season'],int(r['gamePk']))
        if k not in by:raise SystemExit(f'V66_SCORE_OUTCOME_MISSING:{k}')
        z=dict(r);z['_outcomes']=by[k];out.append(z)
    return out

def prep(train,fs):
    med=[];means=[];scales=[]
    for f in fs:
        vals=[float(r[f]) for r in train if finite(r.get(f))]
        if not vals:raise SystemExit(f'V66_SCORE_TRAIN_FEATURE_EMPTY:{f}')
        m=float(np.median(vals)); a=np.asarray([float(r[f]) if finite(r.get(f)) else m for r in train],float)
        u=float(a.mean()); s=float(a.std()); s=1.0 if (not math.isfinite(s) or s<1e-12) else s
        med.append(m);means.append(u);scales.append(s)
    return {'features':list(fs),'medianImpute':med,'mean':means,'scale':scales,'fitSeason':'2022'}
def transform(rs,p):
    X=np.empty((len(rs),len(p['features'])),float)
    for j,(f,m,u,s) in enumerate(zip(p['features'],p['medianImpute'],p['mean'],p['scale'])):
        X[:,j]=[((float(r[f]) if finite(r.get(f)) else m)-u)/s for r in rs]
    return X

def transform_manifest(rs,p):
    X=np.empty((len(rs),len(p['features'])),float)
    for j,(f,m,u,s) in enumerate(zip(p['features'],p['medianImpute'],p['mean'],p['scale'])):
        X[:,j]=[((float(r[f]) if finite(r.get(f)) else m)-u)/s for r in rs]
    return X

def sigmoid(z):z=np.clip(np.asarray(z,float),-50,50);return 1/(1+np.exp(-z))
def softmax(z):z=np.asarray(z,float);z=z-z.max(axis=1,keepdims=True);e=np.exp(z);return e/e.sum(axis=1,keepdims=True)

def fit_bin(X,y,l2=1.0):
    def obj(t):
        b=t[0];w=t[1:];z=b+X@w
        return float(np.mean(np.logaddexp(0,z)-y*z)+.5*l2*(w@w)/len(y))
    o=minimize(obj,np.zeros(X.shape[1]+1),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-13,'gtol':1e-8})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'V66_SCORE_BINARY_FIT_FAILED:{o.message}')
    return o.x
def cal_bin(logit,y):
    def obj(t):
        a=math.exp(float(t[0]));b=float(t[1]);z=a*logit+b
        return float(np.mean(np.logaddexp(0,z)-y*z))
    o=minimize(obj,np.zeros(2),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-14,'gtol':1e-9})
    if not o.success:raise SystemExit(f'V66_SCORE_BINARY_CAL_FAILED:{o.message}')
    return {'slope':math.exp(float(o.x[0])),'intercept':float(o.x[1]),'fitSeason':'2023'}
def unpack(t,d):return t[:2*d].reshape(2,d),t[2*d:2*d+2]
def logits(t,X):
    W,b=unpack(t,X.shape[1]);return np.column_stack([b[0]+X@W[0],np.zeros(len(X)),b[1]+X@W[1]])
def fit_multi(X,y,l2=1.0):
    d=X.shape[1]
    def obj(t):
        W,_=unpack(t,d);p=softmax(logits(t,X));return -float(np.mean(np.log(np.maximum(p[np.arange(len(y)),y],EPS))))+.5*l2*float(np.sum(W*W))/len(y)
    o=minimize(obj,np.zeros(2*d+2),method='L-BFGS-B',options={'maxiter':12000,'ftol':1e-13,'gtol':1e-8})
    if not o.success:raise SystemExit(f'V66_SCORE_MULTI_FIT_FAILED:{o.message}')
    return o.x
def cal_multi(raw,y):
    def obj(t):
        T=math.exp(float(t[0]));p=softmax(raw/T+np.asarray([float(t[1]),0.,float(t[2])]))
        return -float(np.mean(np.log(np.maximum(p[np.arange(len(y)),y],EPS))))
    o=minimize(obj,np.zeros(3),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-14,'gtol':1e-9})
    if not o.success:raise SystemExit(f'V66_SCORE_MULTI_CAL_FAILED:{o.message}')
    return {'temperature':math.exp(float(o.x[0])),'homeBias':float(o.x[1]),'awayBias':0.,'tieBias':float(o.x[2]),'fitSeason':'2023'}

def fit_candidate(rs,fs,target):
    tr=[r for r in rs if r['season']=='2022'];ca=[r for r in rs if r['season']=='2023']
    pp=prep(tr,fs);Xt=transform(tr,pp);Xc=transform(ca,pp)
    if target=='FG':
        yt=np.asarray([r['_outcomes']['FULL_GAME']['result']=='HOME' for r in tr],float)
        yc=np.asarray([r['_outcomes']['FULL_GAME']['result']=='HOME' for r in ca],float)
        t=fit_bin(Xt,yt); c=cal_bin(t[0]+Xc@t[1:],yc)
        return {'target':'FULL_GAME','features':list(fs),'preprocessor':pp,'intercept':float(t[0]),'coefficients':[float(x) for x in t[1:]],'calibration':c}
    mp={'HOME':0,'AWAY':1,'TIE':2}
    yt=np.asarray([mp[r['_outcomes']['FIRST_5']['result']] for r in tr],int);yc=np.asarray([mp[r['_outcomes']['FIRST_5']['result']] for r in ca],int)
    t=fit_multi(Xt,yt); raw=logits(t,Xc);W,b=unpack(t,len(fs));c=cal_multi(raw,yc)
    return {'target':'FIRST_5','features':list(fs),'preprocessor':pp,'referenceClass':'AWAY','intercepts':{'HOME':float(b[0]),'AWAY':0.,'TIE':float(b[1])},'coefficients':{'HOME':[float(x) for x in W[0]],'AWAY':[0. for _ in fs],'TIE':[float(x) for x in W[1]]},'calibration':c}

def pred_candidate(m,rs):
    X=transform(rs,m['preprocessor'])
    if m['target']=='FULL_GAME':
        z=m['intercept']+X@np.asarray(m['coefficients']);c=m['calibration'];return sigmoid(c['slope']*z+c['intercept'])
    h=m['intercepts']['HOME']+X@np.asarray(m['coefficients']['HOME']);t=m['intercepts']['TIE']+X@np.asarray(m['coefficients']['TIE']);raw=np.column_stack([h,np.zeros(len(X)),t]);c=m['calibration'];return softmax(raw/c['temperature']+np.asarray([c['homeBias'],c['awayBias'],c['tieBias']]))

def pred_v16(manifest,rs,target):
    if target=='FG':
        m=manifest['fullGame'];X=transform_manifest(rs,m['preprocessor']);z=m['intercept']+X@np.asarray(m['coefficients']);c=m['calibration'];return sigmoid(c['slope']*z+c['intercept'])
    m=manifest['first5'];X=transform_manifest(rs,m['preprocessor']);h=m['intercepts']['HOME']+X@np.asarray(m['coefficients']['HOME']);t=m['intercepts']['TIE']+X@np.asarray(m['coefficients']['TIE']);raw=np.column_stack([h,np.zeros(len(X)),t]);c=m['calibration'];return softmax(raw/c['temperature']+np.asarray([c['homeBias'],c['awayBias'],c['tieBias']]))

def y_for(rs,target):
    if target=='FG':return np.asarray([r['_outcomes']['FULL_GAME']['result']=='HOME' for r in rs],float)
    mp={'HOME':0,'AWAY':1,'TIE':2};return np.asarray([mp[r['_outcomes']['FIRST_5']['result']] for r in rs],int)

def metrics_bin(p,y):
    p=np.asarray(p);y=np.asarray(y);ll=-float(np.mean(y*np.log(np.maximum(p,EPS))+(1-y)*np.log(np.maximum(1-p,EPS))));br=float(np.mean((p-y)**2));ece=0.
    for i in range(10):
        lo=i/10;hi=(i+1)/10;m=(p>=lo)&((p<hi) if i<9 else (p<=hi));n=int(m.sum())
        if n:ece+=n/len(y)*abs(float(p[m].mean())-float(y[m].mean()))
    return {'n':len(y),'logLoss':ll,'brier':br,'ece10':float(ece),'absoluteMeanProbabilityGap':abs(float(p.mean())-float(y.mean())),'meanPredictedHome':float(p.mean()),'observedHomeRate':float(y.mean())}
def metrics_multi(p,y):
    p=np.asarray(p);y=np.asarray(y,int);oh=np.eye(3)[y];ll=-float(np.mean(np.log(np.maximum(p[np.arange(len(y)),y],EPS))));br=float(np.mean(np.sum((p-oh)**2,axis=1)));pred=p.mean(0);obs=np.bincount(y,minlength=3)/len(y);conf=p.max(1);correct=(p.argmax(1)==y).astype(float);ece=0.
    for i in range(10):
        lo=i/10;hi=(i+1)/10;m=(conf>=lo)&((conf<hi) if i<9 else (conf<=hi));n=int(m.sum())
        if n:ece+=n/len(y)*abs(float(conf[m].mean())-float(correct[m].mean()))
    return {'n':len(y),'logLoss':ll,'brier':br,'ece10':float(ece),'absoluteMeanProbabilityGap':float(np.mean(np.abs(pred-obs))),'meanPredicted':{'HOME':float(pred[0]),'AWAY':float(pred[1]),'TIE':float(pred[2])},'observedRate':{'HOME':float(obs[0]),'AWAY':float(obs[1]),'TIE':float(obs[2])}}
def metrics(p,y,target):return metrics_bin(p,y) if target=='FG' else metrics_multi(p,y)

def losses(p,y,target):
    if target=='FG':
        p=np.asarray(p);y=np.asarray(y,float);return -(y*np.log(np.maximum(p,EPS))+(1-y)*np.log(np.maximum(1-p,EPS))),(p-y)**2
    p=np.asarray(p);y=np.asarray(y,int);oh=np.eye(3)[y];return -np.log(np.maximum(p[np.arange(len(y)),y],EPS)),np.sum((p-oh)**2,axis=1)

def delta(control,cand):return {'logLossImprovement':control['logLoss']-cand['logLoss'],'brierImprovement':control['brier']-cand['brier']}

def bootstrap_dates(dates,cp,pp,y,target,resamples=5000,seed=20260816):
    cll,cbr=losses(cp,y,target);pll,pbr=losses(pp,y,target);dll=cll-pll;dbr=cbr-pbr
    groups=defaultdict(list)
    for i,d in enumerate(dates):groups[d].append(i)
    keys=sorted(groups);agg=[]
    for k in keys:
        idx=np.asarray(groups[k],int);agg.append((float(dll[idx].sum()),float(dbr[idx].sum()),len(idx)))
    rng=np.random.default_rng(seed);a=np.asarray(agg,float);vals=np.empty((resamples,2),float);K=len(keys)
    for b in range(resamples):
        pick=rng.integers(0,K,size=K);x=a[pick];n=x[:,2].sum();vals[b,0]=x[:,0].sum()/n;vals[b,1]=x[:,1].sum()/n
    return {'unit':'OFFICIAL_DATE_CLUSTER','distinctDates':K,'resamples':resamples,'seed':seed,'logLossImprovement':{'pointEstimate':float(dll.mean()),'ci95':[float(np.quantile(vals[:,0],.025)),float(np.quantile(vals[:,0],.975))]},'brierImprovement':{'pointEstimate':float(dbr.mean()),'ci95':[float(np.quantile(vals[:,1],.025)),float(np.quantile(vals[:,1],.975))]}}

def feature_sets(h):
    inter=[f'{q}_x_{h}_mean_starter_share' for q in QUALITY]
    bp=[f'{b}_adv_weighted_{h}' for b in BP]
    exp=f'{h}_exposure_adv'
    tag='F5' if h=='f5' else 'FG'
    return {
      'FORMAL_CONTROL':list(CONTROL4),
      'CONTROL_PLUS_STARTER_QUALITY5':list(CONTROL4)+list(QUALITY),
      f'CONTROL_PLUS_EXPOSURE_{tag}':list(CONTROL4)+[exp],
      f'CONTROL_PLUS_STARTER_QUALITY5_PLUS_EXPOSURE_{tag}_PLUS_QUALITY_X_EXPOSURE5':list(CONTROL4)+list(QUALITY)+[exp]+inter,
      'FULL_MECHANISTIC_PRIMARY':list(CONTROL4)+list(QUALITY)+[exp]+inter+bp,
    }

def evaluate_route(rr,manifest,target,horizon,passing,fail):
    fs=feature_sets(horizon);models={k:fit_candidate(rr,v,target) for k,v in fs.items() if k!='FORMAL_CONTROL'}
    seasons=('2023',)+EVAL
    out={'formalControl':'FROZEN_V16_F5_MODEL' if target=='F5' else 'FROZEN_V16_C4','primaryCandidate':'FULL_MECHANISTIC_PRIMARY','candidateFeatureSets':fs,'diagnosticAblations':{},'evaluationBySeason':{}}
    cache={}
    for s in seasons:
        rs=[r for r in rr if r['season']==s];y=y_for(rs,target);cp=pred_v16(manifest,rs,target);cache[s]=(rs,y,cp)
        z={'formalControl':metrics(cp,y,target),'candidates':{}}
        for name,m in models.items():z['candidates'][name]=metrics(pred_candidate(m,rs),y,target)
        out['evaluationBySeason'][s]=z
    rs=[]
    for s in EVAL:rs.extend(cache[s][0])
    y=y_for(rs,target);cp=pred_v16(manifest,rs,target);pp=pred_candidate(models['FULL_MECHANISTIC_PRIMARY'],rs)
    out['combinedEvaluation']={'formalControl':metrics(cp,y,target),'primaryCandidate':metrics(pp,y,target),'delta':delta(metrics(cp,y,target),metrics(pp,y,target))}
    out['validation2023Delta']=delta(out['evaluationBySeason']['2023']['formalControl'],out['evaluationBySeason']['2023']['candidates']['FULL_MECHANISTIC_PRIMARY'])
    out['diagnosticAblations']={name:{'validation2023Delta':delta(out['evaluationBySeason']['2023']['formalControl'],out['evaluationBySeason']['2023']['candidates'][name]),'combinedDelta':None} for name in models}
    for name,m in models.items():
        ppn=pred_candidate(m,rs);out['diagnosticAblations'][name]['combinedDelta']=delta(out['combinedEvaluation']['formalControl'],metrics(ppn,y,target))
    dates=[r['officialDate'] for r in rs];out['pairedBootstrap']=bootstrap_dates(dates,cp,pp,y,target)
    season_d={}
    for s in EVAL:
        m0=out['evaluationBySeason'][s]['formalControl'];m1=out['evaluationBySeason'][s]['candidates']['FULL_MECHANISTIC_PRIMARY'];season_d[s]=delta(m0,m1)
    out['seasonDeltas']=season_d
    r23=out['validation2023Delta'];rc=out['combinedEvaluation']['delta'];b=out['pairedBootstrap'];ece=out['combinedEvaluation']['primaryCandidate']['ece10']
    checks={
      'validation2023ImprovesBoth':r23['logLossImprovement']>0 and r23['brierImprovement']>0,
      'combinedImprovesBoth':rc['logLossImprovement']>0 and rc['brierImprovement']>0,
      'bootstrapLogLossLowerBoundPositive':b['logLossImprovement']['ci95'][0]>0,
      'bootstrapBrierLowerBoundPositive':b['brierImprovement']['ci95'][0]>0,
      'atLeastTwoOfThreeSeasonsImproveBoth':sum(d['logLossImprovement']>0 and d['brierImprovement']>0 for d in season_d.values())>=2,
      'noEvaluationSeasonWorseOnBoth':all(not(d['logLossImprovement']<0 and d['brierImprovement']<0) for d in season_d.values()),
      'combinedEce10Within002':ece<=0.02,
    }
    out['promotionChecks']=checks;out['passed']=all(checks.values());out['classification']=passing if out['passed'] else fail;out['models']=models
    return out

def main():
    a=argparse.ArgumentParser();a.add_argument('--custody',required=True);a.add_argument('--control-root',required=True);a.add_argument('--v16-manifest',required=True);a.add_argument('--v16-report',required=True);a.add_argument('--contract',required=True);a.add_argument('--scoring-spec',required=True);a.add_argument('--out',required=True);x=a.parse_args()
    c=load(x.contract);spec=load(x.scoring_spec);manifest=load(x.v16_manifest);v16report=load(x.v16_report)
    if c['scientificStatus']!='FROZEN_BEFORE_ANY_V66_OUTCOME_SCORER_EXISTS':raise SystemExit('V66_SCORE_CONTRACT_NOT_FROZEN')
    if spec['scientificStatus']!='FROZEN_WINNER_SCORING_SEMANTICS_BEFORE_FIRST_V66_OUTCOME_RUN':raise SystemExit('V66_SCORE_SPEC_INVALID')
    rr=attach_outcomes(load_custody(x.custody),x.control_root)
    if len(rr)!=11407:raise SystemExit(f'V66_SCORE_ROWS_DRIFT:{len(rr)}')
    f5=evaluate_route(rr,manifest,'F5','f5',c['promotionRubric']['routePassingClassifications']['V66_B_F5_WINNER'],'V66_B_F5_WINNER_'+c['promotionRubric']['routeFailingClassificationSuffix'])
    fg=evaluate_route(rr,manifest,'FG','fg',c['promotionRubric']['routePassingClassifications']['V66_C_FULL_GAME_WINNER'],'V66_C_FULL_GAME_WINNER_'+c['promotionRubric']['routeFailingClassificationSuffix'])
    parity={}
    for route,key,obj in [('V66_B_F5_WINNER','first5',f5),('V66_C_FULL_GAME_WINNER','fullGame',fg)]:
        diffs={}
        for season in EVAL:
            expected=v16report['evaluationBySeason'][season][key]['model'];actual=obj['evaluationBySeason'][season]['formalControl']
            for metric in ('logLoss','brier'):
                d=abs(float(actual[metric])-float(expected[metric]));diffs[f'{season}_{metric}']=d
                if d>1e-12:raise SystemExit(f'V66_SCORE_V16_CONTROL_PARITY_FAILED:{route}:{season}:{metric}:{d}')
        expected=v16report['combinedEvaluation'][key]['model'];actual=obj['combinedEvaluation']['formalControl']
        for metric in ('logLoss','brier'):
            d=abs(float(actual[metric])-float(expected[metric]));diffs[f'combined_{metric}']=d
            if d>1e-12:raise SystemExit(f'V66_SCORE_V16_CONTROL_PARITY_FAILED:{route}:combined:{metric}:{d}')
        parity[route]={'absoluteTolerance':1e-12,'passed':True,'absoluteDifferences':diffs}
    report={'schemaVersion':'courtedge-p0-step12v66-f5-fullgame-winner-score.v1','scientificStatus':'OUTCOME_SCORING_COMPLETED_WITH_PREDECLARED_MODELS_AND_GATES','v16ControlParity':parity,'routes':{'V66_B_F5_WINNER':f5,'V66_C_FULL_GAME_WINNER':fg},'crossHorizonDiagnostic':{'fullPrimaryCombinedLogLossImprovementF5':f5['combinedEvaluation']['delta']['logLossImprovement'],'fullPrimaryCombinedLogLossImprovementFullGame':fg['combinedEvaluation']['delta']['logLossImprovement'],'fullPrimaryCombinedBrierImprovementF5':f5['combinedEvaluation']['delta']['brierImprovement'],'fullPrimaryCombinedBrierImprovementFullGame':fg['combinedEvaluation']['delta']['brierImprovement']},'policy':{'researchOnly':True,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'positiveEvEstablished':False,'v16ProductionChanged':False,'routingChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'F5':f5['classification'],'FULL_GAME':fg['classification'],'F5delta':f5['combinedEvaluation']['delta'],'FGdelta':fg['combinedEvaluation']['delta']},indent=2))
if __name__=='__main__':main()

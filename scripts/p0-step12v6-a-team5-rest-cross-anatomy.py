#!/usr/bin/env python3
import argparse,json,math,os
from collections import defaultdict
from datetime import date
from bisect import bisect_left
import numpy as np
import pandas as pd
from xgboost import XGBClassifier
from scipy.stats import fisher_exact

SCHEMA='courtedge-p0-step12v6-a-team5-rest-cross-anatomy.v1'
SEASONS=('2022','2023','2024','2025','2026_YTD')
EVAL=('2024','2025','2026_YTD')
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False
def label(r):
    o=r['outcomes']['FULL_GAME']
    if o['homeRuns']==o['awayRuns']:return None
    return int(o['homeRuns']>o['awayRuns'])
def wilson(w,n,z=1.96):
    if not n:return {'lower':None,'upper':None}
    p=w/n;den=1+z*z/n;ctr=(p+z*z/(2*n))/den;half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':ctr-half,'upper':ctr+half}
def sigmoid(x):
    if x>=0:
        e=math.exp(-x);return 1/(1+e)
    e=math.exp(x);return e/(1+e)
def frozen_prob(row,spec):
    z=float(spec['intercept'])
    for x in spec['features']:
        v=row.get(x['name'])
        if not finite(v):v=x['medianImpute']
        z+=float(x['coef'])*((float(v)-float(x['mean']))/float(x['scale']))
    return sigmoid(z)
def summary(df,mask):
    s=df[mask].copy();n=len(s);w=int(s.y.sum()) if n else 0
    by={}
    for season in EVAL:
        q=s[s.season==season];ns=len(q);ws=int(q.y.sum()) if ns else 0
        by[season]={'rows':ns,'wins':ws,'losses':ns-ws,'hitRate':ws/ns if ns else None}
    months=s.date.str[:7] if n else pd.Series(dtype=str);lomo=[]
    for mo in sorted(months.unique()):
        q=s[months!=mo];nq=len(q)
        if nq:lomo.append({'removedMonth':mo,'rows':nq,'wins':int(q.y.sum()),'hitRate':float(q.y.mean())})
    teams=s.homeTeamId.value_counts() if n else pd.Series(dtype=int);pitchers=s.homePitcherId.dropna().astype(int).value_counts() if n else pd.Series(dtype=int)
    return {'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilson95':wilson(w,n),'bySeason':by,'uniqueDates':int(s.date.nunique()) if n else 0,'uniqueMonths':int(months.nunique()) if n else 0,'minimumLeaveOneMonth':min(lomo,key=lambda x:x['hitRate']) if lomo else None,'concentration':{'uniqueHomeTeams':int(s.homeTeamId.nunique()) if n else 0,'maxHomeTeamShare':float(teams.iloc[0]/n) if n and len(teams) else None,'uniqueHomePitchers':int(s.homePitcherId.nunique()) if n else 0,'maxHomePitcherShare':float(pitchers.iloc[0]/n) if n and len(pitchers) else None}}
def holm(ps):
    order=sorted(range(len(ps)),key=lambda i:ps[i]);out=[0.0]*len(ps);prev=0.0;m=len(ps)
    for rank,i in enumerate(order):
        adj=min(1.0,(m-rank)*ps[i]);prev=max(prev,adj);out[i]=prev
    return out

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();c=load(a.contract);base={};starters={}
    for s in SEASONS:
        base[s]=load(f'{a.root}/{s}/game-anatomy-feature-table.json');starters[s]=load(f'{a.root}/{s}/cohort/starting-pitcher-history.json')
        if base[s].get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('STEP12V6_BASE_SCHEMA_INVALID')
    base_names=list(base['2024']['featureNames'])
    if len(base_names)!=44:raise SystemExit('STEP12V6_BASE44_INVALID')

    ph=defaultdict(list)
    for s in SEASONS:
        for g in starters[s]['games']:
            for side in ('homeStarter','awayStarter'):
                x=g.get(side)
                if x:ph[int(x['pitcherId'])].append(x)
    ph_dates={}
    for pid,v in ph.items():
        v.sort(key=lambda x:(x['officialDate'],int(x['gamePk'])));ph_dates[pid]=[x['officialDate'] for x in v]

    team_all=defaultdict(list)
    for s in SEASONS:
        for r in base[s]['rows']:
            o=r['outcomes']['FULL_GAME'];ht=int(r['homeTeamId']);at=int(r['awayTeamId']);d=r['officialDate'];gp=int(r['gamePk'])
            team_all[ht].append({'date':d,'gamePk':gp,'rf':o['homeRuns'],'ra':o['awayRuns'],'win':int(o['homeRuns']>o['awayRuns'])})
            team_all[at].append({'date':d,'gamePk':gp,'rf':o['awayRuns'],'ra':o['homeRuns'],'win':int(o['awayRuns']>o['homeRuns'])})
    team_dates={}
    for tid,v in team_all.items():
        v.sort(key=lambda x:(x['date'],x['gamePk']));team_dates[tid]=[x['date'] for x in v]
    def recent(tid,cur,n=5):
        v=team_all.get(tid,[]);ds=team_dates.get(tid,[]);i=bisect_left(ds,cur);z=v[max(0,i-n):i]
        if not z:return {}
        return {'win':sum(x['win'] for x in z)/len(z),'rs':sum(x['rf'] for x in z)/len(z),'ra':sum(x['ra'] for x in z)/len(z),'rd':sum(x['rf']-x['ra'] for x in z)/len(z)}

    rows=[]
    for s in SEASONS:
        for r in base[s]['rows']:
            if not r.get('t5PregameValid'):continue
            y=label(r)
            if y is None:continue
            cur=r['officialDate'];f=dict(r['features'])
            for side,pid in (('home',r.get('t5HomeProbablePitcherId')),('away',r.get('t5AwayProbablePitcherId'))):
                prior=[]
                if pid:
                    pid=int(pid);v=ph.get(pid,[]);ds=ph_dates.get(pid,[]);i=bisect_left(ds,cur);prior=v[:i]
                f[f'{side}_starter_rest_days']=(date.fromisoformat(cur)-date.fromisoformat(prior[-1]['officialDate'])).days if prior else None
            if finite(f.get('home_starter_rest_days')) and finite(f.get('away_starter_rest_days')):f['starter_rest_adv']=float(f['home_starter_rest_days'])-float(f['away_starter_rest_days'])
            ht=int(r['homeTeamId']);at=int(r['awayTeamId']);h=recent(ht,cur);v=recent(at,cur)
            for k in ('win','rs','ra','rd'):
                if k in h and k in v:f[f'team_{k}5_{"adv" if k=="ra" else "diff"}']=(v[k]-h[k]) if k=='ra' else (h[k]-v[k])
            z={'season':s,'date':cur,'gamePk':int(r['gamePk']),'homeTeamId':ht,'awayTeamId':at,'homePitcherId':r.get('t5HomeProbablePitcherId'),'y':y};z.update(f);rows.append(z)
    df=pd.DataFrame(rows)

    c03=c['team5Rest'];cols=base_names+c03['addedFeatures'];cfg=c03['model'];tr=df[df.season=='2022'];te=df[df.season.isin(EVAL)].copy()
    model=XGBClassifier(n_estimators=cfg['nEstimators'],max_depth=cfg['maxDepth'],learning_rate=cfg['learningRate'],subsample=cfg['subsample'],colsample_bytree=cfg['colsampleBytree'],reg_lambda=cfg['regLambda'],reg_alpha=cfg['regAlpha'],min_child_weight=cfg['minChildWeight'],eval_metric='logloss',n_jobs=2,random_state=cfg['randomState'])
    model.fit(tr[cols],tr.y.to_numpy(int));te['team5RestP']=model.predict_proba(te[cols])[:,1];te['TEAM5_REST']=te.team5RestP>=float(c03['frozenThreshold'])
    c03sum=summary(te,te.TEAM5_REST);expected=c03['expectedV5Replication']
    if (c03sum['rows'],c03sum['wins'],c03sum['losses'])!=(expected['rows'],expected['wins'],expected['losses']):raise SystemExit(f"STEP12V6_C03_REPRO_MISMATCH:{c03sum['rows']}:{c03sum['wins']}:{c03sum['losses']}")

    te['PREMIUM_A']=True
    for cond in c['premiumA']['all']:te['PREMIUM_A']&=pd.to_numeric(te[cond['feature']],errors='coerce').ge(float(cond['threshold']))
    ap=c['aPlusConsensus'];te['c4P']=te.apply(lambda r:frozen_prob(r,ap['models']['ML_C4_2022_FROZEN']),axis=1);te['full13P']=te.apply(lambda r:frozen_prob(r,ap['models']['ML_FULL13_2022_FROZEN']),axis=1)
    te['ML_CONSENSUS']=(te.c4P>=float(ap['thresholds']['c4PHomeGTE']))&(te.full13P>=float(ap['thresholds']['full13PHomeGTE']));te['A_PLUS']=te.PREMIUM_A&te.ML_CONSENSUS

    masks={'PREMIUM_A':te.PREMIUM_A,'A_PLUS':te.A_PLUS,'TEAM5_REST':te.TEAM5_REST,'A_INTERSECT_TEAM5_REST':te.PREMIUM_A&te.TEAM5_REST,'A_OUTSIDE_TEAM5_REST':te.PREMIUM_A&~te.TEAM5_REST,'TEAM5_REST_OUTSIDE_A':te.TEAM5_REST&~te.PREMIUM_A,'A_PLUS_INTERSECT_TEAM5_REST':te.A_PLUS&te.TEAM5_REST,'A_PLUS_OUTSIDE_TEAM5_REST':te.A_PLUS&~te.TEAM5_REST,'TEAM5_REST_OUTSIDE_A_PLUS':te.TEAM5_REST&~te.A_PLUS,'A_NONPLUS_INTERSECT_TEAM5_REST':te.PREMIUM_A&~te.A_PLUS&te.TEAM5_REST,'UNION_A_TEAM5_REST':te.PREMIUM_A|te.TEAM5_REST}
    cohorts={k:summary(te,v) for k,v in masks.items()}
    defs=[('TEAM5_REST_WITHIN_A','A_INTERSECT_TEAM5_REST','A_OUTSIDE_TEAM5_REST'),('A_STATUS_WITHIN_TEAM5_REST','A_INTERSECT_TEAM5_REST','TEAM5_REST_OUTSIDE_A'),('TEAM5_REST_WITHIN_A_PLUS','A_PLUS_INTERSECT_TEAM5_REST','A_PLUS_OUTSIDE_TEAM5_REST')]
    raw=[];contrasts=[]
    for name,left,right in defs:
        L=cohorts[left];R=cohorts[right];_,p=fisher_exact([[L['wins'],L['losses']],[R['wins'],R['losses']]],alternative='two-sided');raw.append(float(p));contrasts.append({'name':name,'left':left,'right':right,'hitRateDiffPp':(L['hitRate']-R['hitRate'])*100,'rawFisherP':float(p)})
    for x,p in zip(contrasts,holm(raw)):x['holmAdjustedP']=p
    report={'schemaVersion':SCHEMA,'classification':'CROSS_ANATOMY_DISCOVERY_NOT_EXTERNAL_CONFIRMATION','parentEvidence':c['parentEvidence'],'cohorts':cohorts,'contrasts':contrasts,'interpretation':{'team5RestRoleForA':'AMPLIFIER_IF_A_INTERSECTION_MATERIALLY_OUTPERFORMS_TEAM5_REST_OUTSIDE_A','independentSecondEliteRoute':'SUPPORTED_ONLY_IF_TEAM5_REST_OUTSIDE_A_IS_STABLE_AND_ELITE_LEVEL','aPlusIncrement':'SUPPORTED_ONLY_IF_A_PLUS_INTERSECTION_MATERIALLY_OUTPERFORMS_A_PLUS_OUTSIDE_TEAM5_REST','scientificBoundary':'All 2024-2026 outcomes were already inspected in V4/V5/A+ discovery; this is cross-anatomy discovery, not external confirmation.'},'policy':{'noThresholdSearch':True,'team5RestThresholdFrozen':c03['frozenThreshold'],'premiumAFrozen':True,'aPlusFrozen':True,'sameDateOutcomeLeakageAllowed':False,'futureSeasonStatsAllowed':False,'liveFilterChanged':False,'betEliteProduced':False,'prospective11cRequired':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'cohorts':cohorts,'contrasts':contrasts},indent=2))
if __name__=='__main__':main()

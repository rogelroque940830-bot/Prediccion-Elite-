#!/usr/bin/env python3
import argparse,json,math,os
from collections import Counter
import numpy as np
import pandas as pd
from scipy.stats import fisher_exact
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression

SCHEMA='courtedge-p0-step12v7-f5-elite-route-anatomy.v1'
SEASONS=('2022','2023','2024','2025','2026_YTD')
EVAL=('2024','2025','2026_YTD')
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def wilson(w,n):
    if not n:return {'lower':0.0,'upper':0.0}
    z=1.96;p=w/n;den=1+z*z/n
    mid=(p+z*z/(2*n))/den
    half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':mid-half,'upper':mid+half}

def sigmoid(z):return 1.0/(1.0+np.exp(-z))

def frozen_prob(df,model):
    z=np.full(len(df),float(model['intercept']))
    for f in model['features']:
        x=pd.to_numeric(df[f['name']],errors='coerce').fillna(float(f['medianImpute'])).to_numpy(float)
        z+=float(f['coef'])*((x-float(f['mean']))/float(f['scale']))
    return sigmoid(z)

def holm(ps):
    m=len(ps);order=sorted(range(m),key=lambda i:ps[i]);adj=[1.0]*m;running=0.0
    for rank,i in enumerate(order):
        v=min(1.0,(m-rank)*ps[i]);running=max(running,v);adj[i]=running
    return adj

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--a-contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();c=load(a.contract);ac=load(a.a_contract)
    rows=[]
    for s in SEASONS:
        d=load(f'{a.root}/{s}/game-anatomy-feature-table.json')
        if d.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('STEP12V7_BASE_SCHEMA_INVALID')
        for r in d['rows']:
            if not r.get('t5PregameValid'):continue
            f=dict(r['features']);f.update({'season':s,'date':r['officialDate'],'gamePk':int(r['gamePk']),'homeTeamId':int(r['homeTeamId']),'homePitcherId':r.get('t5HomeProbablePitcherId')})
            o5=r['outcomes']['FIRST_5'];ofg=r['outcomes']['FULL_GAME']
            f['f5y']=None if o5['homeRuns']==o5['awayRuns'] else int(o5['homeRuns']>o5['awayRuns'])
            f['fgy']=int(ofg['homeRuns']>ofg['awayRuns'])
            rows.append(f)
    df=pd.DataFrame(rows)

    # Premium A and frozen A+ are copied only from the already frozen V6 contract.
    am=np.ones(len(df),dtype=bool)
    for rule in ac['premiumA']['all']:
        am &= pd.to_numeric(df[rule['feature']],errors='coerce').to_numpy(float)>=float(rule['threshold'])
    df['A']=am
    apc=ac['aPlusConsensus'];p1=frozen_prob(df,apc['models']['ML_C4_2022_FROZEN']);p2=frozen_prob(df,apc['models']['ML_FULL13_2022_FROZEN'])
    df['Aplus']=am&(p1>=float(apc['thresholds']['c4PHomeGTE']))&(p2>=float(apc['thresholds']['full13PHomeGTE']))

    # Train the two F5 models on 2022 decisive F5 outcomes only.
    models={};probs={}
    tr=df[(df.season=='2022')&df.f5y.notna()].copy();ytr=tr.f5y.astype(int).to_numpy()
    for name,spec in c['models'].items():
        if name in ('family','imputation','randomState'):continue
        cols=spec['features'];imp=SimpleImputer(strategy='median');sc=StandardScaler()
        X=sc.fit_transform(imp.fit_transform(tr[cols]))
        lr=LogisticRegression(max_iter=2000,random_state=int(c['models']['randomState']))
        lr.fit(X,ytr);models[name]=(cols,imp,sc,lr)
        probs[name]=lr.predict_proba(sc.transform(imp.transform(df[cols])))[:,1]
    df['pC4']=probs['F5_C4'];df['pFull13']=probs['F5_FULL13']

    # Threshold selection is confined to 2023 by the predeclared rule.
    dv=df[(df.season=='2023')&df.f5y.notna()].copy();grid=[float(x) for x in c['selection']['thresholdGrid']];best=None
    for t1 in grid:
        for t2 in grid:
            m=(dv.pC4>=t1)&(dv.pFull13>=t2);n=int(m.sum())
            if n<int(c['selection']['minimumDevelopmentDecisiveRows']):continue
            w=int(dv.loc[m,'f5y'].sum());wi=wilson(w,n)
            key=(wi['lower'],n,t1+t2,t1,t2)
            if best is None or key>best['key']:
                best={'key':key,'c4':t1,'full13':t2,'rows':n,'wins':w,'losses':n-w,'hitRate':w/n,'wilson95':wi}
    if best is None:raise SystemExit('STEP12V7_NO_DEVELOPMENT_THRESHOLD')
    df['F5route']=(df.pC4>=best['c4'])&(df.pFull13>=best['full13'])

    ev=df[df.season.isin(EVAL)].copy()
    masks={
      'F5_CONSENSUS':ev.F5route,
      'F5_CONSENSUS_OUTSIDE_A':ev.F5route&(~ev.A),
      'A_INTERSECT_F5_CONSENSUS':ev.F5route&ev.A,
      'A_PLUS_INTERSECT_F5_CONSENSUS':ev.F5route&ev.Aplus,
      'A_PLUS_OUTSIDE_F5_CONSENSUS':(~ev.F5route)&ev.Aplus,
      'F5_CONSENSUS_OUTSIDE_A_PLUS':ev.F5route&(~ev.Aplus),
      'A_PLUS_ALL':ev.Aplus
    }
    def cohort(mask):
        z=ev[mask].copy();dec=z[z.f5y.notna()];n=len(dec);w=int(dec.f5y.sum()) if n else 0;months=dec.date.astype(str).str[:7] if n else pd.Series(dtype=str)
        by={}
        for s in EVAL:
            q=dec[dec.season==s];ns=len(q);ws=int(q.f5y.sum()) if ns else 0
            by[s]={'decisiveRows':ns,'wins':ws,'losses':ns-ws,'hitRate':ws/ns if ns else None,'selectedRows':int((z.season==s).sum()),'pushes':int(((z.season==s)&z.f5y.isna()).sum())}
        loo=None
        if n:
            vals=[]
            for mon in sorted(months.unique()):
                q=dec[months!=mon];nn=len(q);ww=int(q.f5y.sum());vals.append((ww/nn if nn else 0,mon,nn,ww))
            hr,mon,nn,ww=min(vals)
            loo={'removedMonth':mon,'decisiveRows':nn,'wins':ww,'hitRate':hr}
        team=Counter(z.homeTeamId.astype(int));pitch=Counter(int(x) for x in z.homePitcherId.dropna())
        fgN=len(z);fgW=int(z.fgy.sum()) if fgN else 0
        return {'selectedRows':len(z),'decisiveRows':n,'pushes':len(z)-n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilson95':wilson(w,n),'fullGameWinsSameSelected':fgW,'fullGameLossesSameSelected':fgN-fgW,'fullGameHitRateSameSelected':fgW/fgN if fgN else None,'bySeason':by,'uniqueDates':int(z.date.nunique()),'uniqueMonths':int(z.date.astype(str).str[:7].nunique()),'minimumLeaveOneMonth':loo,'concentration':{'uniqueHomeTeams':len(team),'maxHomeTeamShare':max(team.values())/len(z) if z.size and team else None,'uniqueHomePitchers':len(pitch),'maxHomePitcherShare':max(pitch.values())/len(z) if z.size and pitch else None}}
    cohorts={k:cohort(v) for k,v in masks.items()}

    def table(left,right,target):
        l=ev[masks[left]];r=ev[masks[right]]
        if target=='f5y':l=l[l.f5y.notna()];r=r[r.f5y.notna()]
        ly=l[target].astype(int);ry=r[target].astype(int)
        a1=int(ly.sum());b1=len(ly)-a1;a2=int(ry.sum());b2=len(ry)-a2
        p=float(fisher_exact([[a1,b1],[a2,b2]],alternative='two-sided').pvalue)
        return {'left':left,'right':right,'target':target,'leftRows':len(ly),'rightRows':len(ry),'leftHitRate':a1/len(ly) if len(ly) else None,'rightHitRate':a2/len(ry) if len(ry) else None,'hitRateDiffPp':((a1/len(ly))-(a2/len(ry)))*100 if len(ly) and len(ry) else None,'rawFisherP':p}
    contrasts=[
      {'name':'A_STATUS_WITHIN_F5_ROUTE',**table('A_INTERSECT_F5_CONSENSUS','F5_CONSENSUS_OUTSIDE_A','f5y')},
      {'name':'F5_ROUTE_WITHIN_A_PLUS_F5_TARGET',**table('A_PLUS_INTERSECT_F5_CONSENSUS','A_PLUS_OUTSIDE_F5_CONSENSUS','f5y')},
      {'name':'F5_ROUTE_WITHIN_A_PLUS_FULL_GAME_TARGET',**table('A_PLUS_INTERSECT_F5_CONSENSUS','A_PLUS_OUTSIDE_F5_CONSENSUS','fgy')}
    ]
    adj=holm([x['rawFisherP'] for x in contrasts])
    for x,pv in zip(contrasts,adj):x['holmAdjustedP']=pv

    fitted={}
    for name,(cols,imp,sc,lr) in models.items():
        fitted[name]={'features':cols,'intercept':float(lr.intercept_[0]),'coef':[float(x) for x in lr.coef_[0]],'medianImpute':[float(x) for x in imp.statistics_],'mean':[float(x) for x in sc.mean_],'scale':[float(x) for x in sc.scale_]}
    report={'schemaVersion':SCHEMA,'classification':'F5_ROUTE_DISCOVERY_NOT_EXTERNAL_CONFIRMATION','thresholdSelection2023':{k:v for k,v in best.items() if k!='key'},'fitted2022Models':fitted,'cohorts':cohorts,'contrasts':contrasts,'policy':{'sameDateOutcomeLeakageAllowed':False,'futureSeasonStatsAllowed':False,'historicalPricesUsed':False,'liveFilterChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteProduced':False,'prospective11cRequired':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'thresholds':report['thresholdSelection2023'],'cohorts':cohorts,'contrasts':contrasts},indent=2))
if __name__=='__main__':main()

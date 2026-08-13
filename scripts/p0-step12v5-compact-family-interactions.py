#!/usr/bin/env python3
import argparse,json,math,os
from collections import defaultdict
from datetime import date,timedelta
from bisect import bisect_left
import numpy as np
import pandas as pd
from xgboost import XGBClassifier
from sklearn.metrics import roc_auc_score,brier_score_loss,log_loss

SCHEMA='courtedge-p0-step12v5-compact-family-interactions.v1'
SEASONS=('2022','2023','2024','2025','2026_YTD')
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False
def wilson(w,n):
    if not n:return 0.0
    z=1.96;p=w/n;den=1+z*z/n
    return (p+z*z/(2*n)-z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/den
def pitch3(lines):
    if not lines:return {}
    bf=sum(int(x.get('battersFaced') or 0) for x in lines)
    if bf<=0:return {}
    k=sum(int(x.get('strikeOuts') or 0) for x in lines);bb=sum(int(x.get('baseOnBalls') or 0) for x in lines)
    er=sum(int(x.get('earnedRuns') or 0) for x in lines);hr=sum(int(x.get('homeRuns') or 0) for x in lines)
    h=sum(int(x.get('hits') or 0) for x in lines);p=sum(int(x.get('numberOfPitches') or 0) for x in lines)
    st=sum(int(x.get('strikes') or 0) for x in lines);outs=sum(int(x.get('outsRecorded') or 0) for x in lines)
    return {'kbb':(k-bb)/bf,'erbf':er/bf,'hrbf':hr/bf,'hbbbf':(h+bb)/bf,
            'strike_rate':st/p if p else None,'pitches_per_bf':p/bf,'outs_per_bf':outs/bf,
            'outs_per_start':outs/len(lines)}
def label(r):
    o=r['outcomes']['FULL_GAME']
    if o['homeRuns']==o['awayRuns']:return None
    return int(o['homeRuns']>o['awayRuns'])

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();c=load(a.contract);cfg=c['model'];grid=c['selection']['thresholdGrid']
    base={};starters={}
    for s in SEASONS:
        base[s]=load(f'{a.root}/{s}/game-anatomy-feature-table.json')
        starters[s]=load(f'{a.root}/{s}/cohort/starting-pitcher-history.json')
        if base[s].get('schemaVersion')!=BASE_SCHEMA:raise SystemExit('STEP12V5_BASE_SCHEMA_INVALID')
    base_names=list(base['2024']['featureNames'])
    if len(base_names)!=44:raise SystemExit('STEP12V5_BASE44_INVALID')

    # Build chronological starter history and starter-outs lookup.
    ph=defaultdict(list);starter_game={}
    for s in SEASONS:
        for g in starters[s]['games']:
            starter_game[int(g['gamePk'])]=g
            for side in ('homeStarter','awayStarter'):
                x=g.get(side)
                if x:ph[int(x['pitcherId'])].append(x)
    ph_dates={}
    for pid,v in ph.items():
        v.sort(key=lambda x:(x['officialDate'],int(x['gamePk'])));ph_dates[pid]=[x['officialDate'] for x in v]

    # Build prior team/venue histories and bullpen-outs proxy by date.
    team_all=defaultdict(list);team_home=defaultdict(list);team_away=defaultdict(list)
    bp_by_date=defaultdict(lambda:defaultdict(int))
    for s in SEASONS:
        for r in base[s]['rows']:
            o=r['outcomes']['FULL_GAME'];ht=int(r['homeTeamId']);at=int(r['awayTeamId']);d=r['officialDate'];gp=int(r['gamePk'])
            he={'date':d,'gamePk':gp,'rf':o['homeRuns'],'ra':o['awayRuns'],'win':int(o['homeRuns']>o['awayRuns'])}
            ae={'date':d,'gamePk':gp,'rf':o['awayRuns'],'ra':o['homeRuns'],'win':int(o['awayRuns']>o['homeRuns'])}
            team_all[ht].append(he);team_home[ht].append(he);team_all[at].append(ae);team_away[at].append(ae)
            sg=starter_game.get(gp)
            if sg:
                hs=sg.get('homeStarter');avs=sg.get('awayStarter')
                if hs and hs.get('outsRecorded') is not None:bp_by_date[ht][d]+=max(0,27-int(hs['outsRecorded']))
                if avs and avs.get('outsRecorded') is not None:bp_by_date[at][d]+=max(0,27-int(avs['outsRecorded']))
    for coll in (team_all,team_home,team_away):
        for tid,v in coll.items():v.sort(key=lambda x:(x['date'],x['gamePk']))
    dates_by_coll={id(coll):{tid:[x['date'] for x in v] for tid,v in coll.items()} for coll in (team_all,team_home,team_away)}
    def recent(coll,tid,cur,n=5):
        v=coll.get(tid,[]);ds=dates_by_coll[id(coll)].get(tid,[]);i=bisect_left(ds,cur);z=v[max(0,i-n):i]
        if not z:return {}
        return {'win':sum(x['win'] for x in z)/len(z),'rs':sum(x['rf'] for x in z)/len(z),
                'ra':sum(x['ra'] for x in z)/len(z),'rd':sum(x['rf']-x['ra'] for x in z)/len(z)}
    def bp(tid,cur,days):
        d=date.fromisoformat(cur)
        return sum(bp_by_date[tid].get((d-timedelta(days=i)).isoformat(),0) for i in range(1,days+1))

    rows=[]
    for s in SEASONS:
        for r in base[s]['rows']:
            if not r.get('t5PregameValid'):continue
            y=label(r)
            if y is None:continue
            cur=r['officialDate'];f=dict(r['features'])
            for side,pid in (('home',r.get('t5HomeProbablePitcherId')),('away',r.get('t5AwayProbablePitcherId'))):
                if pid:
                    pid=int(pid);v=ph.get(pid,[]);ds=ph_dates.get(pid,[]);i=bisect_left(ds,cur);prior=v[:i]
                else:prior=[]
                f[f'{side}_starter_rest_days']=(date.fromisoformat(cur)-date.fromisoformat(prior[-1]['officialDate'])).days if prior else None
                for k,val in pitch3(prior[-3:]).items():f[f'{side}_starter_l3_{k}']=val
            for k in ('kbb','erbf','hrbf','hbbbf','strike_rate','pitches_per_bf','outs_per_bf','outs_per_start'):
                hv=f.get(f'home_starter_l3_{k}');av=f.get(f'away_starter_l3_{k}')
                if finite(hv) and finite(av):f[f'starter_l3_{k}_adv']=(float(av)-float(hv)) if k in ('erbf','hrbf','hbbbf','pitches_per_bf') else (float(hv)-float(av))
            if finite(f.get('home_starter_rest_days')) and finite(f.get('away_starter_rest_days')):
                f['starter_rest_adv']=float(f['home_starter_rest_days'])-float(f['away_starter_rest_days'])
            ht=int(r['homeTeamId']);at=int(r['awayTeamId'])
            h=recent(team_all,ht,cur);v=recent(team_all,at,cur);vh=recent(team_home,ht,cur);vv=recent(team_away,at,cur)
            for k in ('win','rs','ra','rd'):
                if k in h and k in v:f[f'team_{k}5_{"adv" if k=="ra" else "diff"}']=(v[k]-h[k]) if k=='ra' else (h[k]-v[k])
                if k in vh and k in vv:f[f'venue_{k}5_{"adv" if k=="ra" else "diff"}']=(vv[k]-vh[k]) if k=='ra' else (vh[k]-vv[k])
            for d in (1,2,3):f[f'bullpen_outs_adv_{d}d']=bp(at,cur,d)-bp(ht,cur,d)
            z={'season':s,'date':cur,'gamePk':int(r['gamePk']),'y':y};z.update(f);rows.append(z)
    df=pd.DataFrame(rows)

    family_cols=c['families'];all_extra={x for cols in family_cols.values() for x in cols}
    missing=sorted(x for x in all_extra if x not in df.columns)
    overlap=sorted(x for x in all_extra if x in base_names)
    if missing:raise SystemExit('STEP12V5_MISSING:'+','.join(missing))
    if overlap:raise SystemExit('STEP12V5_OVERLAP:'+','.join(overlap))

    tr=df[df.season=='2022'];dv=df[df.season=='2023'];te=df[df.season.isin(('2024','2025','2026_YTD'))]
    ytr=tr.y.to_numpy(int);ydv=dv.y.to_numpy(int);yte=te.y.to_numpy(int);season_arr=te.season.to_numpy()
    def model():return XGBClassifier(n_estimators=cfg['nEstimators'],max_depth=cfg['maxDepth'],learning_rate=cfg['learningRate'],subsample=cfg['subsample'],colsample_bytree=cfg['colsampleBytree'],reg_lambda=cfg['regLambda'],reg_alpha=cfg['regAlpha'],min_child_weight=cfg['minChildWeight'],eval_metric='logloss',n_jobs=2,random_state=cfg['randomState'])
    def fit(cols):
        m=model();m.fit(tr[cols],ytr);return m.predict_proba(dv[cols])[:,1],m.predict_proba(te[cols])[:,1]
    def stats(p,y,t):
        m=p>=t;n=int(m.sum());w=int(y[m].sum()) if n else 0
        return {'threshold':float(t),'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilsonLower':wilson(w,n) if n else 0.0}
    def choices(p,y):return [z for z in (stats(p,y,t) for t in grid) if z['rows']>=c['selection']['minimumDevelopmentRows']]
    def choose_quality(p,y):return sorted(choices(p,y),key=lambda z:(z['wilsonLower'],z['rows']),reverse=True)[0]
    def choose_volume(p,y,target):return sorted(choices(p,y),key=lambda z:(abs(z['rows']-target),-z['wilsonLower'],z['threshold']))[0]
    def rep(p,y,t):
        m=p>=t;n=int(m.sum());w=int(y[m].sum()) if n else 0;by={}
        for s in ('2024','2025','2026_YTD'):
            sm=(season_arr==s)&m;ns=int(sm.sum());ws=int(y[sm].sum()) if ns else 0
            by[s]={'rows':ns,'wins':ws,'losses':ns-ws,'hitRate':ws/ns if ns else None}
        return {'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilsonLower':wilson(w,n),'bySeason':by}
    def glob(p,y):
        pc=np.clip(p,1e-12,1-1e-12)
        return {'rocAuc':float(roc_auc_score(y,p)),'brier':float(brier_score_loss(y,p)),'logLoss':float(log_loss(y,pc,labels=[0,1]))}

    bpdv,bpte=fit(base_names);bq=choose_quality(bpdv,ydv);br=rep(bpte,yte,bq['threshold']);bg=glob(bpte,yte);target=bq['rows']
    baseline={'development':bq,'replication':br,'global':bg,'featureCount':44}
    out={}
    for name,fams in c['frozenCandidates'].items():
        extra=[]
        for fam in fams:extra.extend(family_cols[fam])
        cols=base_names+extra;pdv,pte=fit(cols);q=choose_quality(pdv,ydv);vm=choose_volume(pdv,ydv,target);rq=rep(pte,yte,q['threshold']);rv=rep(pte,yte,vm['threshold']);g=glob(pte,yte)
        season_lifts=[]
        for s in ('2024','2025','2026_YTD'):
            x=rq['bySeason'][s]['hitRate'];b=br['bySeason'][s]['hitRate']
            if x is not None and b is not None:season_lifts.append((x-b)*100)
        out[name]={'families':fams,'addedFeatureCount':len(extra),'developmentQuality':q,'replicationQuality':rq,'developmentVolumeMatched':vm,'replicationVolumeMatched':rv,'global':g,
          'diagnostics':{'hitLiftPp':(rq['hitRate']-br['hitRate'])*100,'volumeRatio':rq['rows']/br['rows'],'minSeasonLiftPp':min(season_lifts) if season_lifts else None,'volumeMatchedLiftPp':(rv['hitRate']-br['hitRate'])*100,'aucDelta':g['rocAuc']-bg['rocAuc'],'brierDelta':g['brier']-bg['brier'],'logLossDelta':g['logLoss']-bg['logLoss']}}
    ranking=sorted(({'candidate':k,'families':v['families'],'addedFeatureCount':v['addedFeatureCount'],'hitRate':v['replicationQuality']['hitRate'],'rows':v['replicationQuality']['rows'],'wilsonLower':v['replicationQuality']['wilsonLower'],**v['diagnostics']} for k,v in out.items()),key=lambda z:(z['wilsonLower'],z['minSeasonLiftPp'],z['volumeRatio'],z['aucDelta'],-z['addedFeatureCount']),reverse=True)
    report={'schemaVersion':SCHEMA,'classification':'SECONDARY_INTERACTION_DISCOVERY_NOT_EXTERNAL_CONFIRMATION','baseline':baseline,'candidates':out,'ranking':ranking,
      'policy':{'trainingSeason':'2022','thresholdSelectionSeason':'2023','evaluationSeasons':['2024','2025','2026_YTD'],'sameDateOutcomeLeakageAllowed':False,'futureSeasonStatsAllowed':False,'historicalPricesUsed':False,'liveFilterChanged':False,'betEliteProduced':False,'prospective11cRequired':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'baseline':baseline,'ranking':ranking},indent=2))
if __name__=='__main__':main()

#!/usr/bin/env python3
import argparse, json, math, os
from collections import defaultdict
from datetime import date, timedelta
from bisect import bisect_left
import numpy as np
import pandas as pd
from xgboost import XGBClassifier
from sklearn.metrics import roc_auc_score, brier_score_loss, log_loss

SCHEMA='courtedge-p0-step12v4-family-ablation.v1'
SEASONS=('2022','2023','2024','2025','2026_YTD')
BASE_FEATURE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False
def pitch_summary(lines):
    if not lines:return {}
    bf=sum(int(x.get('battersFaced') or 0) for x in lines)
    if bf<=0:return {}
    k=sum(int(x.get('strikeOuts') or 0) for x in lines);bb=sum(int(x.get('baseOnBalls') or 0) for x in lines)
    er=sum(int(x.get('earnedRuns') or 0) for x in lines);hr=sum(int(x.get('homeRuns') or 0) for x in lines)
    h=sum(int(x.get('hits') or 0) for x in lines);p=sum(int(x.get('numberOfPitches') or 0) for x in lines)
    st=sum(int(x.get('strikes') or 0) for x in lines);outs=sum(int(x.get('outsRecorded') or 0) for x in lines)
    return {'kbb':(k-bb)/bf,'erbf':er/bf,'hrbf':hr/bf,'hbbbf':(h+bb)/bf,'strike_rate':st/p if p else None,'pitches_per_bf':p/bf,'outs_per_bf':outs/bf,'outs_per_start':outs/len(lines)}
def wilson(w,n):
    if not n:return 0.0
    z=1.96;p=w/n;den=1+z*z/n
    return (p+z*z/(2*n)-z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/den
def label(row):
    o=row['outcomes']['FULL_GAME']
    if o['homeRuns']==o['awayRuns']:return None
    return 1 if o['homeRuns']>o['awayRuns'] else 0

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();contract=load(a.contract);cfg=contract['model'];grid=contract['selection']['thresholdGrid']
    seen={}
    for fam,cols in contract['families'].items():
        for c in cols:
            if c in seen:raise SystemExit(f'DUPLICATE_FAMILY_FEATURE:{c}:{seen[c]}:{fam}')
            seen[c]=fam
    base={};starters={}
    for s in SEASONS:
        base[s]=load(f'{a.root}/{s}/game-anatomy-feature-table.json');starters[s]=load(f'{a.root}/{s}/cohort/starting-pitcher-history.json')
        if base[s].get('schemaVersion')!=BASE_FEATURE_SCHEMA:raise SystemExit('STEP12V4_BASE_SCHEMA_INVALID')
    base_names=list(base['2024']['featureNames'])
    if len(base_names)!=contract['baseline']['featureCount']:raise SystemExit('STEP12V4_BASE44_COUNT_INVALID')

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

    team_all=defaultdict(list);team_home=defaultdict(list);team_away=defaultdict(list);bp_by_date=defaultdict(lambda:defaultdict(int))
    for s in SEASONS:
        for r in base[s]['rows']:
            fg=r['outcomes']['FULL_GAME'];ht=int(r['homeTeamId']);at=int(r['awayTeamId']);d=r['officialDate'];gp=int(r['gamePk'])
            he={'date':d,'gamePk':gp,'rf':fg['homeRuns'],'ra':fg['awayRuns'],'win':int(fg['homeRuns']>fg['awayRuns'])}
            ae={'date':d,'gamePk':gp,'rf':fg['awayRuns'],'ra':fg['homeRuns'],'win':int(fg['awayRuns']>fg['homeRuns'])}
            team_all[ht].append(he);team_home[ht].append(he);team_all[at].append(ae);team_away[at].append(ae)
            sg=starter_game.get(gp)
            if sg:
                hs=sg.get('homeStarter');avs=sg.get('awayStarter')
                if hs and hs.get('outsRecorded') is not None:bp_by_date[ht][d]+=max(0,27-int(hs['outsRecorded']))
                if avs and avs.get('outsRecorded') is not None:bp_by_date[at][d]+=max(0,27-int(avs['outsRecorded']))
    for coll in (team_all,team_home,team_away):
        for tid,v in coll.items():v.sort(key=lambda x:(x['date'],x['gamePk']))
    team_dates={id(coll):{tid:[x['date'] for x in v] for tid,v in coll.items()} for coll in (team_all,team_home,team_away)}
    def recent_team(coll,tid,cur,n):
        v=coll.get(tid,[]);dates=team_dates[id(coll)].get(tid,[]);i=bisect_left(dates,cur);z=v[max(0,i-n):i]
        if not z:return {}
        return {'win':sum(x['win'] for x in z)/len(z),'rs':sum(x['rf'] for x in z)/len(z),'ra':sum(x['ra'] for x in z)/len(z),'rd':sum(x['rf']-x['ra'] for x in z)/len(z)}
    def bp(tid,cur,days):
        d=date.fromisoformat(cur);return sum(bp_by_date[tid].get((d-timedelta(days=i)).isoformat(),0) for i in range(1,days+1))

    rows=[]
    for s in SEASONS:
        for r in base[s]['rows']:
            if not r.get('t5PregameValid'):continue
            y=label(r)
            if y is None:continue
            cur=r['officialDate'];f=dict(r['features'])
            for side,pid in (('home',r.get('t5HomeProbablePitcherId')),('away',r.get('t5AwayProbablePitcherId'))):
                if pid:
                    pid=int(pid);v=ph.get(pid,[]);dates=ph_dates.get(pid,[]);i=bisect_left(dates,cur);prior=v[:i]
                else:prior=[];i=0
                f[f'{side}_starter_prior_starts_all']=i
                f[f'{side}_starter_rest_days']=(date.fromisoformat(cur)-date.fromisoformat(prior[-1]['officialDate'])).days if prior else None
                for n in (1,3,5):
                    for k,val in pitch_summary(prior[-n:]).items():f[f'{side}_starter_l{n}_{k}']=val
            for n in (1,3,5):
                for k in ('kbb','erbf','hrbf','hbbbf','strike_rate','pitches_per_bf','outs_per_bf','outs_per_start'):
                    hv=f.get(f'home_starter_l{n}_{k}');av=f.get(f'away_starter_l{n}_{k}')
                    if finite(hv) and finite(av):f[f'starter_l{n}_{k}_adv']=(float(av)-float(hv)) if k in ('erbf','hrbf','hbbbf','pitches_per_bf') else (float(hv)-float(av))
            if finite(f.get('home_starter_rest_days')) and finite(f.get('away_starter_rest_days')):f['starter_rest_adv']=float(f['home_starter_rest_days'])-float(f['away_starter_rest_days'])
            ht=int(r['homeTeamId']);at=int(r['awayTeamId'])
            for n in (3,5):
                h=recent_team(team_all,ht,cur,n);v=recent_team(team_all,at,cur,n);vh=recent_team(team_home,ht,cur,n);vv=recent_team(team_away,at,cur,n)
                for k in ('win','rs','ra','rd'):
                    if k in h and k in v:f[f'team_{k}{n}_{"adv" if k=="ra" else "diff"}']=(v[k]-h[k]) if k=='ra' else (h[k]-v[k])
                    if k in vh and k in vv:f[f'venue_{k}{n}_{"adv" if k=="ra" else "diff"}']=(vv[k]-vh[k]) if k=='ra' else (vh[k]-vv[k])
            for d in (1,2,3):f[f'bullpen_outs_adv_{d}d']=bp(at,cur,d)-bp(ht,cur,d)
            z={'season':s,'date':cur,'gamePk':int(r['gamePk']),'y':y};z.update(f);rows.append(z)
    df=pd.DataFrame(rows)
    missing=[c for c in seen if c not in df.columns];overlap=[c for c in seen if c in base_names]
    if missing:raise SystemExit('STEP12V4_MISSING_FAMILY_FEATURES:'+','.join(missing))
    if overlap:raise SystemExit('STEP12V4_FAMILY_OVERLAPS_BASE44:'+','.join(overlap))

    tr=df[df.season=='2022'];dv=df[df.season=='2023'];te=df[df.season.isin(('2024','2025','2026_YTD'))]
    ytr=tr.y.to_numpy(int);ydv=dv.y.to_numpy(int);yte=te.y.to_numpy(int)
    def new_model():return XGBClassifier(n_estimators=cfg['nEstimators'],max_depth=cfg['maxDepth'],learning_rate=cfg['learningRate'],subsample=cfg['subsample'],colsample_bytree=cfg['colsampleBytree'],reg_lambda=cfg['regLambda'],reg_alpha=cfg['regAlpha'],min_child_weight=cfg['minChildWeight'],eval_metric='logloss',n_jobs=2,random_state=cfg['randomState'])
    def threshold_stats(p,y,t):
        m=p>=t;n=int(m.sum());w=int(y[m].sum()) if n else 0
        return {'threshold':float(t),'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'wilsonLower':wilson(w,n) if n else 0.0}
    def choices(p,y):return [x for x in (threshold_stats(p,y,t) for t in grid) if x['rows']>=contract['selection']['minimumDevelopmentRows']]
    def choose_quality(p,y):
        c=choices(p,y)
        if not c:raise SystemExit('STEP12V4_NO_QUALITY_THRESHOLD')
        return sorted(c,key=lambda z:(z['wilsonLower'],z['rows']),reverse=True)[0]
    def choose_volume(p,y,target):
        c=choices(p,y)
        if not c:raise SystemExit('STEP12V4_NO_VOLUME_THRESHOLD')
        return sorted(c,key=lambda z:(abs(z['rows']-target),-z['wilsonLower'],z['threshold']))[0]
    season_arr=te.season.to_numpy()
    def selected_rep(p,y,t):
        m=p>=t;n=int(m.sum());w=int(y[m].sum()) if n else 0;by={}
        for s in ('2024','2025','2026_YTD'):
            sm=(season_arr==s)&m;ns=int(sm.sum());ws=int(y[sm].sum()) if ns else 0;by[s]={'rows':ns,'wins':ws,'losses':ns-ws,'hitRate':ws/ns if ns else None}
        return {'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None,'bySeason':by}
    def gm(p,y):
        pc=np.clip(p,1e-12,1-1e-12);return {'rocAuc':float(roc_auc_score(y,p)),'brier':float(brier_score_loss(y,p)),'logLoss':float(log_loss(y,pc,labels=[0,1]))}
    def fit(features):
        m=new_model();m.fit(tr[features],ytr);return m,m.predict_proba(dv[features])[:,1],m.predict_proba(te[features])[:,1]

    bm,bpdv,bpte=fit(base_names);bq=choose_quality(bpdv,ydv);btarget=bq['rows'];brq=selected_rep(bpte,yte,bq['threshold']);bg=gm(bpte,yte)
    baseline={'featureCount':len(base_names),'developmentQuality':bq,'replicationQuality':brq,'globalReplication':bg}
    famout={}
    for fam,cols in contract['families'].items():
        features=base_names+list(cols);m,pdv,pte=fit(features);q=choose_quality(pdv,ydv);vm=choose_volume(pdv,ydv,btarget);rq=selected_rep(pte,yte,q['threshold']);rv=selected_rep(pte,yte,vm['threshold']);g=gm(pte,yte)
        qlift=(rq['hitRate']-brq['hitRate'])*100;vr=rq['rows']/brq['rows'];sl=[]
        for s in ('2024','2025','2026_YTD'):
            a1=rq['bySeason'][s]['hitRate'];a0=brq['bySeason'][s]['hitRate']
            if a1 is not None and a0 is not None:sl.append((a1-a0)*100)
        mins=min(sl) if sl else None;ad=g['rocAuc']-bg['rocAuc'];bd=g['brier']-bg['brier'];ld=g['logLoss']-bg['logLoss'];vml=(rv['hitRate']-brq['hitRate'])*100
        if qlift>=1.0 and vr>=0.70 and mins is not None and mins>=-2.0 and ad>=0:cl='HELPFUL'
        elif qlift<=-1.0 and ad<=0:cl='NOISY'
        elif abs(qlift)<0.5 and abs(ad)<0.002:cl='NEUTRAL'
        else:cl='MIXED'
        imp=sorted(({'feature':f,'importance':float(v)} for f,v in zip(features,m.feature_importances_) if f in cols),key=lambda z:-z['importance'])
        famout[fam]={'classification':cl,'addedFeatures':list(cols),'addedFeatureCount':len(cols),'developmentQuality':q,'developmentVolumeMatched':vm,'replicationQuality':rq,'replicationVolumeMatched':rv,'globalReplication':g,'diagnostics':{'qualityHitLiftPp':qlift,'qualityVolumeRatioVsBase44':vr,'minSeasonLiftPp':mins,'volumeMatchedHitLiftPp':vml,'aucDelta':ad,'brierDelta':bd,'logLossDelta':ld},'familyFeatureImportance':imp}
    ranking=sorted(({'family':k,'classification':v['classification'],**v['diagnostics'],'qualityHitRate':v['replicationQuality']['hitRate'],'qualityRows':v['replicationQuality']['rows'],'volumeMatchedHitRate':v['replicationVolumeMatched']['hitRate'],'volumeMatchedRows':v['replicationVolumeMatched']['rows']} for k,v in famout.items()),key=lambda z:(z['qualityHitLiftPp'],z['aucDelta']),reverse=True)
    report={'schemaVersion':SCHEMA,'classification':'RETROSPECTIVE_FAMILY_ABLATION_DISCOVERY_NOT_LIVE','contractSchemaVersion':contract['schemaVersion'],'baseline':baseline,'families':famout,'ranking':ranking,'policy':{'trainingSeason':'2022','thresholdSelectionSeason':'2023','replicationSeasons':['2024','2025','2026_YTD'],'sameDateOutcomeLeakageAllowed':False,'futureSeasonStatsAllowed':False,'historicalPricesUsed':False,'liveFilterChanged':False,'betEliteProduced':False,'prospective11cRequired':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'baseline':baseline,'ranking':ranking},indent=2))
if __name__=='__main__':main()

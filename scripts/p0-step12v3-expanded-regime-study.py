#!/usr/bin/env python3
import argparse, json, math, os
from collections import defaultdict
from datetime import date
import numpy as np
import pandas as pd
from xgboost import XGBClassifier

SCHEMA='courtedge-p0-step12v3-expanded-regime-study.v1'
SEASONS=('2022','2023','2024','2025','2026_YTD')
BASE_FEATURE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def dd(a,b): return (date.fromisoformat(a)-date.fromisoformat(b)).days

def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def pitch_summary(lines,n):
    z=lines[-n:]
    if not z:return {}
    bf=sum(int(x.get('battersFaced') or 0) for x in z)
    if bf<=0:return {}
    k=sum(int(x.get('strikeOuts') or 0) for x in z); bb=sum(int(x.get('baseOnBalls') or 0) for x in z)
    er=sum(int(x.get('earnedRuns') or 0) for x in z); hr=sum(int(x.get('homeRuns') or 0) for x in z)
    h=sum(int(x.get('hits') or 0) for x in z); p=sum(int(x.get('numberOfPitches') or 0) for x in z)
    st=sum(int(x.get('strikes') or 0) for x in z); outs=sum(int(x.get('outsRecorded') or 0) for x in z)
    return {'kbb':(k-bb)/bf,'erbf':er/bf,'hrbf':hr/bf,'hbbbf':(h+bb)/bf,
            'strike_rate':st/p if p else None,'pitches_per_bf':p/bf,'outs_per_bf':outs/bf,
            'outs_per_start':outs/len(z)}

def wilson(w,n):
    if not n:return 0.0
    z=1.96;p=w/n;den=1+z*z/n
    return (p+z*z/(2*n)-z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/den

def label(row,horizon):
    o=row['outcomes'][horizon]
    if o['homeRuns']==o['awayRuns']:return None
    return 1 if o['homeRuns']>o['awayRuns'] else 0

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();contract=load(a.contract)
    cfg=contract['model']; grid=contract['selection']['thresholdGrid']

    base={}; starters={}
    for s in SEASONS:
        base[s]=load(f'{a.root}/{s}/game-anatomy-feature-table.json')
        starters[s]=load(f'{a.root}/{s}/cohort/starting-pitcher-history.json')
        if base[s].get('schemaVersion')!=BASE_FEATURE_SCHEMA:raise SystemExit('STEP12V3_BASE_SCHEMA_INVALID')

    ph=defaultdict(list); starter_game={}; team_games=defaultdict(list)
    for s in SEASONS:
        for g in starters[s]['games']:
            starter_game[int(g['gamePk'])]=g
            for side in ('homeStarter','awayStarter'):
                x=g.get(side)
                if x: ph[int(x['pitcherId'])].append(x)
        for r in base[s]['rows']:
            fg=r['outcomes']['FULL_GAME']; ht=int(r['homeTeamId']);at=int(r['awayTeamId'])
            common={'officialDate':r['officialDate'],'gamePk':int(r['gamePk']),'homeTeamId':ht,'awayTeamId':at}
            team_games[ht].append({**common,'isHome':1,'rf':fg['homeRuns'],'ra':fg['awayRuns'],'win':int(fg['homeRuns']>fg['awayRuns'])})
            team_games[at].append({**common,'isHome':0,'rf':fg['awayRuns'],'ra':fg['homeRuns'],'win':int(fg['awayRuns']>fg['homeRuns'])})
    for v in ph.values():v.sort(key=lambda x:(x['officialDate'],int(x['gamePk'])))
    for v in team_games.values():v.sort(key=lambda x:(x['officialDate'],int(x['gamePk'])))

    def recent_team(tid,cur,n,venue=None):
        z=[x for x in team_games[tid] if x['officialDate']<cur and (venue is None or x['isHome']==venue)][-n:]
        if not z:return {}
        return {'win':sum(x['win'] for x in z)/len(z),'rs':sum(x['rf'] for x in z)/len(z),
                'ra':sum(x['ra'] for x in z)/len(z),'rd':sum(x['rf']-x['ra'] for x in z)/len(z)}
    def bp(tid,cur,days):
        total=0
        for x in team_games[tid]:
            d=dd(cur,x['officialDate'])
            if d<1 or d>days:continue
            g=starter_game.get(int(x['gamePk']))
            if not g:continue
            side='homeStarter' if int(x['homeTeamId'])==tid else 'awayStarter'; line=g.get(side)
            if line and line.get('outsRecorded') is not None: total += max(0,27-int(line['outsRecorded']))
        return total

    rows=[]
    for s in SEASONS:
        for r in base[s]['rows']:
            if not r.get('t5PregameValid'):continue
            cur=r['officialDate']; f=dict(r['features'])
            for side,pid in (('home',r.get('t5HomeProbablePitcherId')),('away',r.get('t5AwayProbablePitcherId'))):
                prior=[x for x in ph.get(int(pid),[]) if x['officialDate']<cur] if pid else []
                f[f'{side}_starter_prior_starts_all']=len(prior)
                f[f'{side}_starter_rest_days']=dd(cur,prior[-1]['officialDate']) if prior else None
                for n in (1,3,5):
                    for k,v in pitch_summary(prior,n).items():f[f'{side}_starter_l{n}_{k}']=v
            for n in (1,3,5):
                for k in ('kbb','erbf','hrbf','hbbbf','strike_rate','pitches_per_bf','outs_per_bf','outs_per_start'):
                    hv=f.get(f'home_starter_l{n}_{k}');av=f.get(f'away_starter_l{n}_{k}')
                    if finite(hv) and finite(av):f[f'starter_l{n}_{k}_adv']=(float(av)-float(hv)) if k in ('erbf','hrbf','hbbbf','pitches_per_bf') else (float(hv)-float(av))
            if finite(f.get('home_starter_rest_days')) and finite(f.get('away_starter_rest_days')):
                f['starter_rest_adv']=float(f['home_starter_rest_days'])-float(f['away_starter_rest_days'])
            ht=int(r['homeTeamId']);at=int(r['awayTeamId'])
            for n in (3,5):
                h=recent_team(ht,cur,n);v=recent_team(at,cur,n)
                vh=recent_team(ht,cur,n,1);vv=recent_team(at,cur,n,0)
                for k in ('win','rs','ra','rd'):
                    if k in h and k in v:f[f'team_{k}{n}_{"adv" if k=="ra" else "diff"}']=(v[k]-h[k]) if k=='ra' else (h[k]-v[k])
                    if k in vh and k in vv:f[f'venue_{k}{n}_{"adv" if k=="ra" else "diff"}']=(vv[k]-vh[k]) if k=='ra' else (vh[k]-vv[k])
            for d in (1,2,3):f[f'bullpen_outs_adv_{d}d']=bp(at,cur,d)-bp(ht,cur,d)
            rows.append({'season':s,'date':cur,'gamePk':r['gamePk'],'features':f,'outcomes':r['outcomes']})

    names=sorted({k for r in rows for k in r['features']})
    base_names=base['2024']['featureNames']
    extra=[n for n in names if n not in base_names]
    compact_extra=[n for n in extra if n.startswith('starter_l') or n.startswith('team_') or n.startswith('venue_') or n.startswith('bullpen_outs_adv') or n=='starter_rest_adv' or n.endswith('_starter_rest_days') or n.endswith('_starter_prior_starts_all')]
    extended=sorted(set(base_names+compact_extra))

    flat=[]
    for r in rows:
        z={'season':r['season'],'date':r['date'],'gamePk':r['gamePk']};z.update(r['features']);z['_row']=r;flat.append(z)
    df=pd.DataFrame(flat)

    def frame_for(season,horizon):
        x=df[df.season.isin(season if isinstance(season,(tuple,list)) else (season,))].copy(); ys=[]; keep=[]
        for i,r in x.iterrows():
            y=label(r['_row'],horizon); keep.append(y is not None);ys.append(-1 if y is None else y)
        x=x.loc[keep].copy(); y=np.array([v for v,k in zip(ys,keep) if k],dtype=int);return x,y
    def fit(features,horizon):
        tr,ytr=frame_for('2022',horizon);dv,ydv=frame_for('2023',horizon);te,yte=frame_for(('2024','2025','2026_YTD'),horizon)
        model=XGBClassifier(n_estimators=cfg['nEstimators'],max_depth=cfg['maxDepth'],learning_rate=cfg['learningRate'],
            subsample=cfg['subsample'],colsample_bytree=cfg['colsampleBytree'],reg_lambda=cfg['regLambda'],reg_alpha=cfg['regAlpha'],
            min_child_weight=cfg['minChildWeight'],eval_metric='logloss',n_jobs=2,random_state=cfg['randomState'])
        model.fit(tr[features],ytr);pdv=model.predict_proba(dv[features])[:,1];pte=model.predict_proba(te[features])[:,1]
        choices=[]
        for t in grid:
            m=pdv>=t;n=int(m.sum())
            if n<contract['selection']['minimumDevelopmentRows']:continue
            w=int(ydv[m].sum());choices.append({'threshold':t,'rows':n,'wins':w,'hitRate':w/n,'wilsonLower':wilson(w,n)})
        best=sorted(choices,key=lambda z:(z['wilsonLower'],z['rows']),reverse=True)[0];t=best['threshold'];m=pte>=t
        by={}
        for s in ('2024','2025','2026_YTD'):
            sm=(te.season.values==s)&m;n=int(sm.sum());w=int(yte[sm].sum());by[s]={'rows':n,'wins':w,'losses':n-w,'hitRate':w/n if n else None}
        n=int(m.sum());w=int(yte[m].sum())
        imp=sorted(({'feature':f,'importance':float(v)} for f,v in zip(features,model.feature_importances_)),key=lambda z:-z['importance'])[:20]
        return {'development2023':best,'replication2024to2026':{'rows':n,'wins':w,'losses':n-w,'hitRate':w/n,'bySeason':by},'topFeatureImportance':imp,'thresholdFrozenFrom2023':t,'featureCount':len(features),'model':cfg}

    result_base=fit(base_names,'FULL_GAME');result_ext=fit(extended,'FULL_GAME')
    lift=result_ext['replication2024to2026']['hitRate']-result_base['replication2024to2026']['hitRate']
    report={'schemaVersion':SCHEMA,'classification':'RETROSPECTIVE_CROSS_SEASON_DISCOVERY_NOT_LIVE',
      'featureExpansion':{'baseFeatureCount':len(base_names),'expandedFeatureCount':len(extended),'newFeatureCount':len(set(extended)-set(base_names)),
        'newFamilies':['STARTER_LAST_1_3_5','STARTER_REST','TEAM_LAST_3_5','VENUE_SPLITS_LAST_3_5','BULLPEN_OUTS_PROXY_1_2_3D']},
      'fullGameHomeML':{'base44':result_base,'expanded':result_ext,'expandedLiftVsBase44':lift},
      'policy':{'trainingSeason':2022,'thresholdSelectionSeason':2023,'replicationSeasons':['2024','2025','2026_YTD'],
        'sameDateOutcomeLeakageAllowed':False,'futureSeasonStatsAllowed':False,'historicalPricesUsed':False,'liveFilterChanged':False,'betEliteProduced':False,
        'prospective11cRequired':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'base':result_base['replication2024to2026'],'expanded':result_ext['replication2024to2026'],'lift':lift,'threshold':result_ext['thresholdFrozenFrom2023']},indent=2))
if __name__=='__main__':main()

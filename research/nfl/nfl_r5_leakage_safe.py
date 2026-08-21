#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, math
from pathlib import Path
import numpy as np, pandas as pd, requests
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import log_loss,brier_score_loss,accuracy_score,mean_absolute_error

PBP_URL='https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{y}.parquet'
GAMES_URL='https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'
FORBIDDEN=('moneyline','spread','total_line','odds','price','vig','book','over_under')
SCHED=['game_id','season','game_type','week','gameday','away_team','home_team','away_score','home_score']
PBP=['game_id','season_type','posteam','defteam','epa','success','pass_attempt','rush_attempt','qb_dropback','sack','yards_gained','drive','no_play','qb_kneel','qb_spike']
EPA=['off_epa','def_epa','off_success','def_success','pass_epa','def_pass_epa','rush_epa','def_rush_epa','pass_success','def_pass_success','rush_success','def_rush_success','sack_rate','def_sack_rate','explosive_pass','def_explosive_pass','explosive_rush','def_explosive_rush']

def dl(url,p):
    p=Path(p); p.parent.mkdir(parents=True,exist_ok=True)
    if p.exists() and p.stat().st_size: return p
    with requests.get(url,stream=True,timeout=180,headers={'User-Agent':'CourtEdge-NFL-R5'}) as r:
        r.raise_for_status(); t=Path(str(p)+'.part')
        with t.open('wb') as f:
            for c in r.iter_content(1<<20):
                if c:f.write(c)
        t.replace(p)
    return p

def schedule(cache,seasons):
    x=pd.read_csv(dl(GAMES_URL,cache/'games.csv'),low_memory=False)
    miss=[c for c in SCHED if c not in x]
    if miss: raise RuntimeError(f'missing schedule columns {miss}')
    x=x[SCHED].copy(); x=x[x.season.isin(seasons)&x.game_type.eq('REG')&x.home_score.notna()&x.away_score.notna()]
    x['season']=x.season.astype(int); x['week']=pd.to_numeric(x.week,errors='coerce'); x=x[x.week.notna()]; x['week']=x.week.astype(int)
    x['gameday']=pd.to_datetime(x.gameday,errors='coerce'); x=x[x.gameday.notna()]
    x['margin']=x.home_score-x.away_score; x['game_total']=x.home_score+x.away_score; x['home_win']=np.where(x['margin']>0,1,np.where(x['margin']<0,0,np.nan))
    return x.sort_values(['gameday','game_id']).reset_index(drop=True)

def pbp_games(cache,seasons):
    import pyarrow.parquet as pq
    out=[]; prov=[]
    for y in seasons:
        p=dl(PBP_URL.format(y=y),cache/f'play_by_play_{y}.parquet'); names=set(pq.ParquetFile(p).schema.names); cols=[c for c in PBP if c in names]
        x=pd.read_parquet(p,columns=cols)
        if 'season_type' in x:x=x[x.season_type.eq('REG')]
        for c in ['no_play','qb_kneel','qb_spike']:
            if c in x:x=x[pd.to_numeric(x[c],errors='coerce').fillna(0).eq(0)]
        for c in ['epa','success','pass_attempt','rush_attempt','qb_dropback','sack','yards_gained']:
            if c not in x:x[c]=np.nan
            x[c]=pd.to_numeric(x[c],errors='coerce')
        x=x[x.game_id.notna()&x.posteam.notna()&x.defteam.notna()]
        x=x[(x.pass_attempt.eq(1)|x.rush_attempt.eq(1))&x.epa.notna()].copy()
        x['pass']=(x.qb_dropback.eq(1)|x.pass_attempt.eq(1)); x['rush']=x.rush_attempt.eq(1)
        x['xp']=((x['pass'])&x.yards_gained.ge(20)).astype(float); x['xr']=((x['rush'])&x.yards_gained.ge(10)).astype(float)
        base=x.groupby(['game_id','posteam']).agg(off_epa=('epa','mean'),off_success=('success','mean'),plays=('epa','size'),drives=('drive','nunique')).reset_index().rename(columns={'posteam':'team'})
        def sub(mask,prefix):
            z=x[mask].groupby(['game_id','posteam']).agg(**{f'{prefix}_epa':('epa','mean'),f'{prefix}_success':('success','mean')}).reset_index().rename(columns={'posteam':'team'}); return z
        pa=sub(x['pass'],'pass'); ru=sub(x['rush'],'rush')
        sa=x[x['pass']].groupby(['game_id','posteam']).agg(sack_rate=('sack','mean'),explosive_pass=('xp','mean')).reset_index().rename(columns={'posteam':'team'})
        er=x[x['rush']].groupby(['game_id','posteam']).agg(explosive_rush=('xr','mean')).reset_index().rename(columns={'posteam':'team'})
        a=base.merge(pa,on=['game_id','team'],how='left').merge(ru,on=['game_id','team'],how='left').merge(sa,on=['game_id','team'],how='left').merge(er,on=['game_id','team'],how='left')
        out.append(a); prov.append({'season':y,'url':PBP_URL.format(y=y),'bytes':p.stat().st_size}); print('AGG',y,len(a))
    return pd.concat(out,ignore_index=True),prov

def val(s,k):
    v=s['v'].get(k,np.nan); return float(v) if v is not None else np.nan
def upd(s,k,n,a=.22):
    if n is None or not np.isfinite(n):return
    o=s['v'].get(k,np.nan); s['v'][k]=float(n) if not np.isfinite(o) else float((1-a)*o+a*n)
def tail(xs,n=8):
    z=[v for v in xs[-n:] if v is not None and np.isfinite(v)]; return float(np.mean(z)) if z else np.nan

def dataset(games,tg,alpha=.22):
    lk={(str(r.game_id),str(r.team)):r._asdict() for r in tg.itertuples(index=False)}; st={}; rows=[]; last=None
    for g in games.itertuples(index=False):
        if last is not None and g.season!=last:
            for s in st.values():
                for k in EPA:
                    if np.isfinite(val(s,k)):s['v'][k]*=.70
                for k in ['points_for','points_against']:
                    if np.isfinite(val(s,k)):s['v'][k]=.70*val(s,k)+.30*22.5
        last=g.season; h,a=str(g.home_team),str(g.away_team); hs=st.setdefault(h,{'v':{},'n':0,'oo':[],'od':[]}); as_=st.setdefault(a,{'v':{},'n':0,'oo':[],'od':[]})
        r={'game_id':g.game_id,'season':g.season,'week':g.week,'home_win':g.home_win,'margin':g.margin,'game_total':g.game_total,'home_score':g.home_score,'away_score':g.away_score,'home_prior_games':hs['n'],'away_prior_games':as_['n'],'home_uncertainty':1/math.sqrt(max(hs['n'],1)),'away_uncertainty':1/math.sqrt(max(as_['n'],1)),'home_sos_opp_off':tail(hs['oo']),'home_sos_opp_def':tail(hs['od']),'away_sos_opp_off':tail(as_['oo']),'away_sos_opp_def':tail(as_['od'])}
        keys=['points_for','points_against']+EPA+['plays','drives']
        for k in keys:r['home_'+k]=val(hs,k);r['away_'+k]=val(as_,k)
        rows.append(r); hs['oo'].append(val(as_,'off_epa'));hs['od'].append(val(as_,'def_epa'));as_['oo'].append(val(hs,'off_epa'));as_['od'].append(val(hs,'def_epa'))
        hm=lk.get((str(g.game_id),h),{});am=lk.get((str(g.game_id),a),{})
        def updates(me,own,opp,pf,pa_):
            d={'points_for':pf,'points_against':pa_,'off_epa':own.get('off_epa',np.nan),'def_epa':opp.get('off_epa',np.nan),'off_success':own.get('off_success',np.nan),'def_success':opp.get('off_success',np.nan),'pass_epa':own.get('pass_epa',np.nan),'def_pass_epa':opp.get('pass_epa',np.nan),'rush_epa':own.get('rush_epa',np.nan),'def_rush_epa':opp.get('rush_epa',np.nan),'pass_success':own.get('pass_success',np.nan),'def_pass_success':opp.get('pass_success',np.nan),'rush_success':own.get('rush_success',np.nan),'def_rush_success':opp.get('rush_success',np.nan),'sack_rate':own.get('sack_rate',np.nan),'def_sack_rate':opp.get('sack_rate',np.nan),'explosive_pass':own.get('explosive_pass',np.nan),'def_explosive_pass':opp.get('explosive_pass',np.nan),'explosive_rush':own.get('explosive_rush',np.nan),'def_explosive_rush':opp.get('explosive_rush',np.nan),'plays':own.get('plays',np.nan),'drives':own.get('drives',np.nan)}
            for k,v in d.items():upd(me,k,float(v) if v is not None else np.nan,alpha)
        updates(hs,hm,am,g.home_score,g.away_score);updates(as_,am,hm,g.away_score,g.home_score);hs['n']+=1;as_['n']+=1
    x=pd.DataFrame(rows); return x[(x.home_prior_games>=2)&(x.away_prior_games>=2)].reset_index(drop=True)

def fsets():
    b1=['home_points_for','home_points_against','away_points_for','away_points_against','home_uncertainty','away_uncertainty']
    pair=lambda ks:[f'{s}_{k}' for s in ['home','away'] for k in ks]
    core=pair(['off_epa','def_epa','off_success','def_success'])
    pas=pair(['pass_epa','def_pass_epa','pass_success','def_pass_success'])
    rush=pair(['rush_epa','def_rush_epa','rush_success','def_rush_success'])
    disrupt=pair(['sack_rate','def_sack_rate','explosive_pass','def_explosive_pass','explosive_rush','def_explosive_rush'])
    sos=['home_sos_opp_off','home_sos_opp_def','away_sos_opp_off','away_sos_opp_def']
    pace=pair(['plays','drives'])
    return {'B0':[],'B1':b1,'B2_CORE':b1+core,'B2_PASS':b1+pas,'B2_RUSH':b1+rush,'B2_DISRUPTION':b1+disrupt,'B2_FULL':b1+core+pas+rush+disrupt,'B3_PASS_SOS':b1+pas+sos,'B5_PASS_SOS_PACE':b1+pas+sos+pace}
def pipe(kind):
    m=LogisticRegression(C=.7,max_iter=2000) if kind=='logit' else Ridge(alpha=8.0)
    return Pipeline([('i',SimpleImputer(strategy='median')),('s',StandardScaler()),('m',m)])
def ece(y,p):
    z=0.; edges=np.linspace(0,1,11)
    for lo,hi in zip(edges[:-1],edges[1:]):
        m=(p>=lo)&(p<(hi if hi<1 else hi+1e-9))
        if m.any():z+=m.mean()*abs(y[m].mean()-p[m].mean())
    return float(z)

def run(x,test0,end):
    x=x[x.margin.ne(0)].copy()
    fs=fsets(); bad=[c for vv in fs.values() for c in vv if any(t in c.lower() for t in FORBIDDEN)]
    if bad:raise RuntimeError('market feature leak '+str(bad))
    if any(any(t in c.lower() for t in FORBIDDEN) for c in x.columns):raise RuntimeError('market column in frame')
    preds=[]; seasons=[]
    for name,cols in fs.items():
        for y in range(test0,end+1):
            tr=x[x.season<y];te=x[x.season==y]
            if tr.empty or te.empty:continue
            Xtr=tr[cols] if cols else pd.DataFrame({'c':np.ones(len(tr))});Xte=te[cols] if cols else pd.DataFrame({'c':np.ones(len(te))})
            lm=pipe('logit');lm.fit(Xtr,tr.home_win.astype(int));p=np.clip(lm.predict_proba(Xte)[:,1],1e-6,1-1e-6)
            pr={}
            for t in ['margin','game_total','home_score','away_score']:
                m=pipe('ridge');m.fit(Xtr,tr[t]);pr[t]=m.predict(Xte)
            q=pd.DataFrame({'game_id':te.game_id.to_numpy(),'season':y,'week':te.week.to_numpy(),'model':name,'y':te.home_win.to_numpy(),'p':p,'margin':te.margin.to_numpy(),'pm':pr['margin'],'game_total':te.game_total.to_numpy(),'pt':pr['game_total'],'home_score':te.home_score.to_numpy(),'ph':pr['home_score'],'away_score':te.away_score.to_numpy(),'pa':pr['away_score']})
            q['lli']=-(q.y*np.log(q.p)+(1-q.y)*np.log(1-q.p));preds.append(q)
            seasons.append({'model':name,'season':y,'n':len(q),'log_loss':log_loss(q.y,q.p),'brier':brier_score_loss(q.y,q.p),'accuracy':accuracy_score(q.y,q.p>=.5),'ece10':ece(q.y.to_numpy(),q.p.to_numpy()),'margin_mae':mean_absolute_error(q.margin,q.pm),'total_mae':mean_absolute_error(q.game_total,q.pt),'home_score_mae':mean_absolute_error(q.home_score,q.ph),'away_score_mae':mean_absolute_error(q.away_score,q.pa)})
    p=pd.concat(preds,ignore_index=True);sm=[]
    for n,g in p.groupby('model',sort=False):sm.append({'model':n,'n':len(g),'log_loss':log_loss(g.y,g.p),'brier':brier_score_loss(g.y,g.p),'accuracy':accuracy_score(g.y,g.p>=.5),'ece10':ece(g.y.to_numpy(),g.p.to_numpy()),'margin_mae':mean_absolute_error(g.margin,g.pm),'total_mae':mean_absolute_error(g.game_total,g.pt),'home_score_mae':mean_absolute_error(g.home_score,g.ph),'away_score_mae':mean_absolute_error(g.away_score,g.pa)})
    return pd.DataFrame(sm),pd.DataFrame(seasons),p

def boot(p,reps=400):
    rng=np.random.default_rng(940830); out=[]; names=[n for n in fsets() if n!='B0']
    comps=[('B0','B1')]+[('B1',n) for n in names if n not in ['B1','B3_PASS_SOS','B5_PASS_SOS_PACE']]+[('B2_PASS','B3_PASS_SOS'),('B3_PASS_SOS','B5_PASS_SOS_PACE')]
    for a,b in comps:
        if a not in set(p.model) or b not in set(p.model):continue
        x=p[p.model==a][['game_id','season','week','lli']].rename(columns={'lli':'a'}).merge(p[p.model==b][['game_id','lli']].rename(columns={'lli':'b'}),on='game_id');x['d']=x.b-x.a;cl=list(x.groupby(['season','week']).groups)
        vals=[]
        for _ in range(reps):
            ss=[cl[i] for i in rng.integers(0,len(cl),len(cl))];vals.append(np.mean(np.concatenate([x[(x.season==s)&(x.week==w)].d.to_numpy() for s,w in ss])))
        lo,hi=np.quantile(vals,[.025,.975]);out.append({'comparison':b+'-'+a,'mean_logloss_delta':x.d.mean(),'ci95_low':lo,'ci95_high':hi,'improvement_supported_95':bool(hi<0)})
    return pd.DataFrame(out)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--start-season',type=int,default=2012);ap.add_argument('--end-season',type=int,default=2025);ap.add_argument('--test-start',type=int,default=2018);ap.add_argument('--out-dir',default='nfl-r5-output');ap.add_argument('--cache-dir',default='.cache/nflverse');a=ap.parse_args()
    seasons=list(range(a.start_season,a.end_season+1));cache=Path(a.cache_dir);out=Path(a.out_dir);out.mkdir(parents=True,exist_ok=True)
    g=schedule(cache,seasons);tg,prov=pbp_games(cache,seasons);x=dataset(g,tg);x.to_parquet(out/'nfl_r5_leakage_safe_dataset.parquet',index=False)
    s,bs,p=run(x,a.test_start,a.end_season);bd=boot(p);s.to_csv(out/'nfl_r5_model_summary.csv',index=False);bs.to_csv(out/'nfl_r5_by_season.csv',index=False);p.to_parquet(out/'nfl_r5_oos_predictions.parquet',index=False);bd.to_csv(out/'nfl_r5_bootstrap_deltas.csv',index=False)
    m={'schemaVersion':'courtedge-nfl-r5-leakage-safe.v1','researchOnly':True,'marketDataUsedAsFeatures':False,'marketOptimizationPerformed':False,'regularSeasonOnly':True,'seasons':[a.start_season,a.end_season],'testSeasons':[a.test_start,a.end_season],'featureSets':fsets(),'sameGameRule':'pregame row emitted before target-game score/PBP state update','deferredForTimestampProof':{'B4_QB':'historical as-of starter source required','B6_personnel':'historical injury/inactive timestamps required','B7_weather':'archived pregame forecast required; observed weather forbidden','B8_NGS':'prior-publication timing audit required'},'rows':len(x),'tieHandling':'target ties excluded from binary signal-screen; ties remain in prior state updates and will be modeled explicitly by final score-distribution engine','featureFamilyPass':'diagnostic only; no family accepted without replicated OOS support','pbpProvenance':prov}
    (out/'nfl_r5_manifest.json').write_text(json.dumps(m,indent=2));(out/'nfl_r5_audit.json').write_text(json.dumps({'marketLeakageCheck':'PASS','sameGameFeatureLeakageCheck':'PASS_BY_CONSTRUCTION','validation':'EXPANDING_SEASON_WALK_FORWARD'},indent=2))
    print('NFL_R5_MODEL_SUMMARY');print(s.to_string(index=False));print('NFL_R5_BOOTSTRAP');print(bd.to_string(index=False));print('NFL_R5_COMPLETE')
if __name__=='__main__':main()

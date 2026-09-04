#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score,brier_score_loss,log_loss,mean_absolute_error
import nfl_r5_leakage_safe as base


def design(df,cols): return df[cols]

def build_hybrids(x):
    x=x.copy()
    for side in ['home','away']:
        out=(x[f'{side}_r5b_qb1_out'].fillna(0).eq(1)&x[f'{side}_r5b_replacement_used'].fillna(0).eq(1)&x[f'{side}_r5b_qb_known'].fillna(0).eq(1))
        ts=(x[f'{side}_r5b_source'].fillna('').eq('timestamped_depth')&x[f'{side}_r5b_changed_vs_last'].fillna(0).eq(1)&x[f'{side}_r5b_qb_known'].fillna(0).eq(1))
        hi=out|ts
        x[f'{side}_r5b2_out_switch']=out.astype(int)
        x[f'{side}_r5b2_ts_switch']=ts.astype(int)
        x[f'{side}_r5b2_hi_switch']=hi.astype(int)
        for k,proxy,r5b in [
            ('epa',f'{side}_qb_epa',f'{side}_r5b_qb_epa'),
            ('cpoe',f'{side}_qb_cpoe',f'{side}_r5b_qb_cpoe'),
            ('sack_rate',f'{side}_qb_sack_rate',f'{side}_r5b_qb_sack_rate'),
            ('uncertainty',f'{side}_qb_uncertainty',f'{side}_r5b_qb_uncertainty'),
        ]:
            pv=pd.to_numeric(x[proxy],errors='coerce')
            rv=pd.to_numeric(x[r5b],errors='coerce')
            use_out=out&rv.notna(); use_hi=hi&rv.notna()
            x[f'{side}_r5b2_out_{k}']=pv.where(~use_out,rv)
            x[f'{side}_r5b2_hi_{k}']=pv.where(~use_hi,rv)
            d=rv-pv
            x[f'{side}_r5b2_hi_delta_{k}']=d.where(hi,0.0).fillna(0.0)
    x['r5b2_any_out_switch']=((x.home_r5b2_out_switch+x.away_r5b2_out_switch)>0).astype(int)
    x['r5b2_any_ts_switch']=((x.home_r5b2_ts_switch+x.away_r5b2_ts_switch)>0).astype(int)
    x['r5b2_any_hi_switch']=((x.home_r5b2_hi_switch+x.away_r5b2_hi_switch)>0).astype(int)
    return x


def feature_sets():
    b=base.fsets(); foundation=b['B3_OA_CORE']; proxy=b['B4_QB_OA']
    outm=[f'{s}_r5b2_out_{k}' for s in ['home','away'] for k in ['epa','cpoe','sack_rate','uncertainty']]
    him=[f'{s}_r5b2_hi_{k}' for s in ['home','away'] for k in ['epa','cpoe','sack_rate','uncertainty']]
    hid=[f'{s}_r5b2_hi_delta_{k}' for s in ['home','away'] for k in ['epa','cpoe','sack_rate','uncertainty']]
    flags=[f'{s}_r5b2_{k}' for s in ['home','away'] for k in ['out_switch','ts_switch','hi_switch']]
    return {
        'B4_PROXY_OA':proxy,
        'R5B2_OUT_SWITCH':foundation+outm+[f'{s}_r5b2_out_switch' for s in ['home','away']],
        'R5B2_HICONF_SWITCH':foundation+him+flags,
        'R5B2_HICONF_DELTA':proxy+hid+flags,
    }


def evaluate(x,test0,end):
    x=x[x.margin.ne(0)].copy(); fs=feature_sets(); preds=[]; seasons=[]
    for name,cols in fs.items():
        for y in range(test0,end+1):
            tr=x[x.season<y]; te=x[x.season==y]
            if tr.empty or te.empty: continue
            c=base.tune_logit(tr,cols); lm=base.pipe('logit',c); lm.fit(design(tr,cols),tr.home_win.astype(int))
            pp=np.clip(lm.predict_proba(design(te,cols))[:,1],1e-6,1-1e-6)
            pr={}
            for target in ['margin','game_total']:
                a=base.tune_ridge(tr,cols,target); rm=base.pipe('ridge',a); rm.fit(design(tr,cols),tr[target]); pr[target]=rm.predict(design(te,cols))
            q=pd.DataFrame({'game_id':te.game_id.to_numpy(),'season':y,'week':te.week.to_numpy(),'model':name,'y':te.home_win.to_numpy(),'p':pp,
                            'margin':te.margin.to_numpy(),'pm':pr['margin'],'game_total':te.game_total.to_numpy(),'pt':pr['game_total'],
                            'any_hi_switch':te.r5b2_any_hi_switch.to_numpy(),'any_out_switch':te.r5b2_any_out_switch.to_numpy(),'any_ts_switch':te.r5b2_any_ts_switch.to_numpy()})
            q['lli']=-(q.y*np.log(q.p)+(1-q.y)*np.log(1-q.p)); preds.append(q)
            seasons.append({'model':name,'season':y,'n':len(q),'log_loss':log_loss(q.y,q.p),'brier':brier_score_loss(q.y,q.p),'accuracy':accuracy_score(q.y,q.p>=.5),
                            'margin_mae':mean_absolute_error(q.margin,q.pm),'total_mae':mean_absolute_error(q.game_total,q.pt)})
    p=pd.concat(preds,ignore_index=True); sm=[]
    for n,g in p.groupby('model',sort=False):
        sm.append({'model':n,'n':len(g),'log_loss':log_loss(g.y,g.p),'brier':brier_score_loss(g.y,g.p),'accuracy':accuracy_score(g.y,g.p>=.5),
                   'margin_mae':mean_absolute_error(g.margin,g.pm),'total_mae':mean_absolute_error(g.game_total,g.pt)})
    return pd.DataFrame(sm),pd.DataFrame(seasons),p


def boot(p,a,b,reps=5000,seed=940830):
    x=p[p.model.eq(a)][['game_id','season','week','lli']].rename(columns={'lli':'a'}).merge(p[p.model.eq(b)][['game_id','lli']].rename(columns={'lli':'b'}),on='game_id'); x['d']=x.b-x.a
    arr=[g.d.to_numpy() for _,g in x.groupby(['season','week'],sort=False)]; sums=np.array([v.sum() for v in arr]); counts=np.array([len(v) for v in arr]); rng=np.random.default_rng(seed); vals=np.empty(reps)
    for i in range(reps):
        ix=rng.integers(0,len(arr),len(arr)); vals[i]=sums[ix].sum()/counts[ix].sum()
    lo,hi=np.quantile(vals,[.025,.975]); return {'comparison':f'{b}-{a}','mean_logloss_delta':x.d.mean(),'ci95_low':lo,'ci95_high':hi,'better95':bool(hi<0),'worse95':bool(lo>0)}


def subsets(p):
    out=[]; ref=p[p.model.eq('B4_PROXY_OA')][['game_id','lli']].rename(columns={'lli':'ref'})
    for model in ['R5B2_OUT_SWITCH','R5B2_HICONF_SWITCH','R5B2_HICONF_DELTA']:
        z=p[p.model.eq(model)].merge(ref,on='game_id'); z['delta']=z.lli-z.ref
        for label,mask in [('ALL',np.ones(len(z),dtype=bool)),('HI_SWITCH',z.any_hi_switch.eq(1)),('NO_HI_SWITCH',z.any_hi_switch.eq(0)),('OUT_SWITCH',z.any_out_switch.eq(1)),('TS_SWITCH',z.any_ts_switch.eq(1))]:
            q=z[mask]
            if q.empty: continue
            out.append({'model':model,'subset':label,'n':len(q),'mean_logloss_delta_vs_proxy':q.delta.mean(),'model_logloss':q.lli.mean(),'proxy_logloss':q.ref.mean()})
    return pd.DataFrame(out)


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input-dir',default='nfl-r5b-output'); ap.add_argument('--out-dir',default='nfl-r5b-hybrid-output'); ap.add_argument('--test-start',type=int,default=2018); ap.add_argument('--end-season',type=int,default=2025); a=ap.parse_args()
    src=Path(a.input_dir); out=Path(a.out_dir); out.mkdir(parents=True,exist_ok=True)
    x=build_hybrids(pd.read_parquet(src/'nfl_r5b_dataset.parquet')); x.to_parquet(out/'nfl_r5b_hybrid_dataset.parquet',index=False)
    s,by,p=evaluate(x,a.test_start,a.end_season); s.to_csv(out/'nfl_r5b_hybrid_summary.csv',index=False); by.to_csv(out/'nfl_r5b_hybrid_by_season.csv',index=False); p.to_parquet(out/'nfl_r5b_hybrid_predictions.parquet',index=False)
    comps=pd.DataFrame([boot(p,'B4_PROXY_OA',m) for m in ['R5B2_OUT_SWITCH','R5B2_HICONF_SWITCH','R5B2_HICONF_DELTA']]); comps.to_csv(out/'nfl_r5b_hybrid_bootstrap.csv',index=False)
    sub=subsets(p); sub.to_csv(out/'nfl_r5b_hybrid_subsets.csv',index=False)
    print('NFL_R5B_HYBRID_SUMMARY'); print(s.to_string(index=False)); print('NFL_R5B_HYBRID_BOOTSTRAP'); print(comps.to_string(index=False)); print('NFL_R5B_HYBRID_SUBSETS'); print(sub.to_string(index=False)); print('NFL_R5B_HYBRID_COMPLETE')
if __name__=='__main__': main()

#!/usr/bin/env python3
from pathlib import Path
import argparse
import numpy as np
import pandas as pd
from sklearn.metrics import log_loss, brier_score_loss, accuracy_score, mean_absolute_error


def clustered_bootstrap(p, a, b, reps=1200, seed=940830):
    x = (
        p[p.model.eq(a)][['game_id','season','week','lli']]
        .rename(columns={'lli':'a'})
        .merge(
            p[p.model.eq(b)][['game_id','lli']].rename(columns={'lli':'b'}),
            on='game_id',
        )
    )
    x['d'] = x.b - x.a
    clusters = list(x.groupby(['season','week']).groups)
    rng = np.random.default_rng(seed)
    vals=[]
    for _ in range(reps):
        ss=[clusters[i] for i in rng.integers(0,len(clusters),len(clusters))]
        vals.append(np.mean(np.concatenate([
            x[(x.season.eq(s)) & (x.week.eq(w))].d.to_numpy() for s,w in ss
        ])))
    lo,hi=np.quantile(vals,[.025,.975])
    return {
        'comparison': f'{b}-{a}',
        'mean_logloss_delta': float(x.d.mean()),
        'ci95_low': float(lo),
        'ci95_high': float(hi),
        'improvement_supported_95': bool(hi < 0),
        'clusters': len(clusters),
        'games': len(x),
    }


def metrics(g):
    return {
        'n': len(g),
        'log_loss': log_loss(g.y,g.p),
        'brier': brier_score_loss(g.y,g.p),
        'accuracy': accuracy_score(g.y,g.p>=.5),
        'margin_mae': mean_absolute_error(g.margin,g.pm),
        'total_mae': mean_absolute_error(g.game_total,g.pt),
    }


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--out-dir',default='nfl-r5-output')
    a=ap.parse_args()
    out=Path(a.out_dir)
    p=pd.read_parquet(out/'nfl_r5_oos_predictions.parquet')
    by=pd.read_csv(out/'nfl_r5_by_season.csv')

    comps=[
        ('B1','B3_OA_CORE'),
        ('B1','B4_QB_OA'),
        ('B2_CORE','B4_QB_OA'),
        ('B1','B5_QB_OA_PACE'),
    ]
    cb=pd.DataFrame([clustered_bootstrap(p,x,y) for x,y in comps])
    cb.to_csv(out/'nfl_r5_cumulative_bootstrap.csv',index=False)

    pv=by.pivot(index='season',columns='model',values='log_loss')
    stability=pd.DataFrame({'season':pv.index})
    stability['B3_OA_CORE_minus_B1']=(pv['B3_OA_CORE']-pv['B1']).to_numpy()
    stability['B4_QB_OA_minus_B1']=(pv['B4_QB_OA']-pv['B1']).to_numpy()
    stability['B5_QB_OA_PACE_minus_B1']=(pv['B5_QB_OA_PACE']-pv['B1']).to_numpy()
    stability.to_csv(out/'nfl_r5_selected_by_season_delta.csv',index=False)

    def band(w):
        if w <= 4: return 'W01_04'
        if w <= 9: return 'W05_09'
        if w <= 14: return 'W10_14'
        return 'W15_18'
    q=p[p.model.isin(['B1','B2_CORE','B3_OA_CORE','B4_QB_OA','B5_QB_OA_PACE'])].copy()
    q['week_band']=q.week.map(band)
    seg=[]
    for (model,band_name),g in q.groupby(['model','week_band'],sort=False):
        seg.append({'model':model,'week_band':band_name,**metrics(g)})
    seg=pd.DataFrame(seg)
    seg.to_csv(out/'nfl_r5_week_segment.csv',index=False)

    print('NFL_R5_CUMULATIVE_BOOTSTRAP')
    print(cb.to_string(index=False))
    print('NFL_R5_SELECTED_SEASON_DELTAS')
    print(stability.to_string(index=False))
    print('NFL_R5_WEEK_SEGMENTS')
    print(seg.to_string(index=False))

if __name__=='__main__':
    main()

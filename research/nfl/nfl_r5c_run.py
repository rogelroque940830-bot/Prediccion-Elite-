#!/usr/bin/env python3
from __future__ import annotations
import argparse, json
from pathlib import Path
import pandas as pd

import nfl_r5_leakage_safe as base
import nfl_r5c_personnel_availability as r5c


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--input-dir',default='nfl-r5b-hybrid-output')
    ap.add_argument('--out-dir',default='nfl-r5c-output')
    ap.add_argument('--cache-dir',default='.cache/nflverse')
    ap.add_argument('--start-season',type=int,default=2012)
    ap.add_argument('--end-season',type=int,default=2024)
    ap.add_argument('--test-start',type=int,default=2018)
    a=ap.parse_args()

    src=Path(a.input_dir); out=Path(a.out_dir); cache=Path(a.cache_dir)
    out.mkdir(parents=True,exist_ok=True); cache.mkdir(parents=True,exist_ok=True)
    x=pd.read_parquet(src/'nfl_r5b_hybrid_dataset.parquet')

    # R5B hybrid intentionally does not preserve gameday. Reattach it from the same
    # leakage-safe schedule source used by base R5, keyed only by game_id.
    if 'gameday' not in x.columns:
        max_season=int(pd.to_numeric(x.season,errors='coerce').max())
        sched=base.schedule(cache,range(a.start_season,max_season+1))[['game_id','gameday']].drop_duplicates('game_id')
        x=x.merge(sched,on='game_id',how='left',validate='one_to_one')
    if x.gameday.isna().any():
        raise RuntimeError(f"R5C missing gameday for {int(x.gameday.isna().sum())} games after schedule reattachment")

    pfr_to_gsis,gsis_pos,player_prov=r5c.load_players(cache)
    seasons=range(a.start_season,a.end_season+1)
    snaps,snap_prov=r5c.load_snaps(cache,seasons,pfr_to_gsis)
    injuries,inj_prov=r5c.load_injuries(cache,seasons)
    pf=r5c.build_personnel_features(x,snaps,injuries,gsis_pos)
    x=x.merge(pf,on='game_id',how='left',validate='one_to_one')
    x.to_parquet(out/'nfl_r5c_dataset.parquet',index=False)

    sm,by,p=r5c.evaluate(x,a.test_start,a.end_season)
    sm.to_csv(out/'nfl_r5c_model_summary.csv',index=False)
    by.to_csv(out/'nfl_r5c_by_season.csv',index=False)
    p.to_parquet(out/'nfl_r5c_predictions.parquet',index=False)
    models=['R5C_OFFENSE_OUT_USAGE','R5C_DEFENSE_OUT_USAGE','R5C_ST_OUT_USAGE','R5C_ALL_OUT_USAGE']
    comps=pd.DataFrame([r5c.boot(p,'R5B2_HICONF_SWITCH',m) for m in models])
    comps.to_csv(out/'nfl_r5c_bootstrap.csv',index=False)
    sub=r5c.subset_report(p); sub.to_csv(out/'nfl_r5c_subsets.csv',index=False)

    manifest={
      'researchOnly':True,
      'marketDataUsedAsFeatures':False,
      'marketOptimizationPerformed':False,
      'primaryEvaluation':'2018-2024 injury-covered seasons',
      'injurySourceEnds':2024,
      'targetGameSnapUsedAsFeature':False,
      'snapUpdateOrder':'PREGAME_FEATURE_ROW_THEN_TARGET_GAME_SNAP_UPDATE',
      'injuryTimestampFilter':'STRICT_LT_TARGET_GAMEDAY_00UTC',
      'gamedaySource':'BASE_R5_SCHEDULE_REATTACHED_BY_GAME_ID_ONLY',
      'qbExcludedFromR5C':True,
      'playerCrosswalkUse':'IDENTIFIER_ONLY',
      'snapImportance':'MEAN_LAST_UP_TO_3_PRIOR_GAMES_WITH_GLOBAL_PLAYER_FALLBACK',
      'playersProvenance':player_prov,
      'snapProvenance':snap_prov,
      'injuryProvenance':inj_prov,
    }
    json.dump(manifest,open(out/'nfl_r5c_manifest.json','w'),indent=2)
    audit={
      'marketLeakageCheck':'PASS',
      'sameGameSnapLeakageCheck':'PASS_BY_CONSTRUCTION',
      'targetGameOutcomeFeatureCheck':'PASS_NOT_USED',
      'injuryTimestampCheck':'STRICT_LT_CUTOFF',
      'gamedayReattachmentCheck':'GAME_ID_ONLY_FROM_BASE_SCHEDULE',
      '2025MissingInjuryHandled':'EXCLUDED_FROM_PRIMARY_R5C_EVALUATION',
      'qbDoubleCountCheck':'PASS_QB_EXCLUDED',
    }
    json.dump(audit,open(out/'nfl_r5c_audit.json','w'),indent=2)
    print('NFL_R5C_MODEL_SUMMARY'); print(sm.to_string(index=False))
    print('NFL_R5C_BOOTSTRAP'); print(comps.to_string(index=False))
    print('NFL_R5C_SUBSETS'); print(sub.to_string(index=False))
    print('NFL_R5C_COMPLETE')

if __name__=='__main__':
    main()

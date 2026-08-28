#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, math, os, tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen
import pyarrow.parquet as pq

CONTRACT = Path('research/wnba/WNBA_R3A1B_2020_FOUR_FACTORS_SOURCE_CONTRACT.json')
OUT = Path('wnba-r3a1b-2020-four-factors-evidence.json')
API = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
SCHEDULE_COLS = ['game_id','season','season_type','game_date_time','game_date','home_id','away_id','home_display_name','away_display_name','home_is_active','away_is_active','neutral_site','notes_type','notes_headline']
BOX_COLS = ['game_id','season','season_type','game_date','team_id','team_home_away','opponent_team_id','field_goals_made','field_goals_attempted','three_point_field_goals_made','three_point_field_goals_attempted','free_throws_attempted','offensive_rebounds','defensive_rebounds','turnovers']
FORMULAS = ['efg_pct','tov_pct','orb_pct','ftr','three_point_attempt_rate']

def norm_id(v: Any) -> str:
    s = str(v or '').strip()
    return s[:-2] if s.endswith('.0') and s[:-2].isdigit() else s

def norm_text(v: Any) -> str:
    return str(v or '').strip().lower().replace('_','').replace('-','').replace(' ','')

def regular(v: Any) -> bool:
    return norm_text(v) in {'regular','regularseason','2'}

def finite(v: Any) -> float | None:
    try:
        x=float(v); return x if math.isfinite(x) else None
    except (TypeError,ValueError): return None

def headers(accept: str) -> dict[str,str]:
    h={'Accept':accept,'User-Agent':'Prediccion-Elite-WNBA-R3A1B/1.0','X-GitHub-Api-Version':'2022-11-28'}
    tok=os.getenv('GITHUB_TOKEN','').strip()
    if tok: h['Authorization']=f'Bearer {tok}'
    return h

def download(pin: dict[str,Any], path: Path) -> dict[str,Any]:
    aid=int(pin['asset_id'])
    with urlopen(Request(API.format(asset_id=aid),headers=headers('application/octet-stream')),timeout=120) as r: payload=r.read()
    path.write_bytes(payload)
    sha=hashlib.sha256(payload).hexdigest(); exp=str(pin['sha256']).removeprefix('sha256:')
    return {'asset_id':aid,'bytes':len(payload),'expected_bytes':int(pin['size']),'sha256':sha,'expected_sha256':exp,'custody_verified':len(payload)==int(pin['size']) and sha==exp}

def factor_counts() -> dict[str,dict[str,int]]:
    return {k:{'valid_side_rows':0,'invalid_or_zero_denominator_rows':0} for k in FORMULAS}

def main() -> None:
    c=json.loads(CONTRACT.read_text())
    ev={'name':'WNBA_R3A1B_2020_FOUR_FACTORS_EVIDENCE_V1','contract':str(CONTRACT),'winner_or_score_columns_projected':False,'market_data_consumed':False,'model_fit':False,'hit_rate_tested':False,'schedule_special_metadata_candidates':[],'factor_counts':factor_counts()}
    with tempfile.TemporaryDirectory(prefix='wnba-r3a1b-') as td:
        root=Path(td); sp=root/'schedule.parquet'; bp=root/'team_box_2020.parquet'
        ev['schedule_asset']=download(c['frozen_sources']['schedule_master'],sp); ev['team_box_asset']=download(c['frozen_sources']['team_box_2020'],bp)
        sfile=pq.ParquetFile(sp); bfile=pq.ParquetFile(bp)
        ev['schedule_missing_columns']=[x for x in SCHEDULE_COLS if x not in sfile.schema_arrow.names]
        ev['team_box_missing_columns']=[x for x in BOX_COLS if x not in bfile.schema_arrow.names]
        if ev['schedule_missing_columns'] or ev['team_box_missing_columns']:
            OUT.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n'); raise SystemExit('required schema missing')
        srows=sfile.read(columns=SCHEDULE_COLS).to_pylist(); brows=bfile.read(columns=BOX_COLS).to_pylist()
        sched={}
        for r in srows:
            try: season=int(r.get('season'))
            except (TypeError,ValueError): continue
            if season!=2020 or not regular(r.get('season_type')): continue
            gid=norm_id(r.get('game_id'))
            if not gid: continue
            sched[gid]=r
            note=str(r.get('notes_headline') or '').strip(); ntype=str(r.get('notes_type') or '').strip()
            inactive=(r.get('home_is_active') is False or r.get('away_is_active') is False)
            if note or ntype or inactive:
                ev['schedule_special_metadata_candidates'].append({'game_id':gid,'notes_type':ntype,'notes_headline':note,'home_is_active':r.get('home_is_active'),'away_is_active':r.get('away_is_active')})
        grouped=defaultdict(list)
        for r in brows:
            try: season=int(r.get('season'))
            except (TypeError,ValueError): continue
            if season==2020 and regular(r.get('season_type')):
                gid=norm_id(r.get('game_id'))
                if gid: grouped[gid].append(r)
        ev['schedule_type2_games']=len(sched); ev['team_box_type2_games']=len(grouped)
        ev['schedule_only_game_ids']=sorted(set(sched)-set(grouped)); ev['team_box_only_game_ids']=sorted(set(grouped)-set(sched))
        ev['pair_integrity_failures']=0
        for gid,pair in grouped.items():
            if len(pair)!=2:
                ev['pair_integrity_failures']+=1; continue
            a,b=pair; aid,bid=norm_id(a.get('team_id')),norm_id(b.get('team_id'))
            if not aid or not bid or aid==bid or norm_id(a.get('opponent_team_id'))!=bid or norm_id(b.get('opponent_team_id'))!=aid:
                ev['pair_integrity_failures']+=1
            for side,opp in ((a,b),(b,a)):
                fgm,fga,pm3,pa3,fta,oreb,tov,odreb=[finite(side.get(k)) for k in ['field_goals_made','field_goals_attempted','three_point_field_goals_made','three_point_field_goals_attempted','free_throws_attempted','offensive_rebounds','turnovers']] + [finite(opp.get('defensive_rebounds'))]
                checks={
                    'efg_pct': fgm is not None and pm3 is not None and fga is not None and fga>0,
                    'tov_pct': fga is not None and fta is not None and tov is not None and (fga+.44*fta+tov)>0,
                    'orb_pct': oreb is not None and odreb is not None and (oreb+odreb)>0,
                    'ftr': fta is not None and fga is not None and fga>0,
                    'three_point_attempt_rate': pa3 is not None and fga is not None and fga>0,
                }
                for k,ok in checks.items(): ev['factor_counts'][k]['valid_side_rows' if ok else 'invalid_or_zero_denominator_rows']+=1
        sides=2*len(grouped)
        candidate_free=len(ev['schedule_special_metadata_candidates'])==0
        exact=(ev['schedule_asset']['custody_verified'] and ev['team_box_asset']['custody_verified'] and not ev['schedule_only_game_ids'] and not ev['team_box_only_game_ids'] and ev['pair_integrity_failures']==0 and all(v['valid_side_rows']==sides and v['invalid_or_zero_denominator_rows']==0 for v in ev['factor_counts'].values()))
        ev['special_event_classification']='NO_SPECIAL_METADATA_CANDIDATES' if candidate_free else 'SPECIAL_METADATA_CANDIDATES_REQUIRE_REVIEW'
        ev['component_custody_exact']=exact
        ev['decision']='PASS_2020_EXACT_COMPONENT_CUSTODY' if exact and candidate_free else ('BLOCKED_SPECIAL_EVENT_CLASSIFICATION_REVIEW' if exact else 'FAIL_COMPONENT_OR_IDENTITY_CUSTODY')
        ev['next_gate']='R3A2_STRICT_PRIOR_DATE_PREFIX_FEATURE_CONSTRUCTOR' if ev['decision']=='PASS_2020_EXACT_COMPONENT_CUSTODY' else 'R3A1B_RESOLUTION_REQUIRED'
    OUT.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n')
    print(json.dumps({'decision':ev['decision'],'schedule_games':ev['schedule_type2_games'],'team_box_games':ev['team_box_type2_games'],'special_candidates':len(ev['schedule_special_metadata_candidates']),'pair_failures':ev['pair_integrity_failures'],'next_gate':ev['next_gate']},indent=2))
    if not ev['schedule_asset']['custody_verified'] or not ev['team_box_asset']['custody_verified']: raise SystemExit('asset custody failed')

if __name__=='__main__': main()

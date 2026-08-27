#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT=Path('research/wnba/WNBA_R2A_2020_SEED_SEASON_CUSTODY_CONTRACT.json')
PINS=Path('research/wnba/WNBA_R2A_2020_SOURCE_PINS.json')
BASE_SCRIPT=Path('scripts/wnba-r1a4c-prefix-constructor.py')
TRAVEL_TS=Path('frontend/client/src/lib/travel.ts')
MODEL_TS=Path('frontend/client/src/lib/wnba-model.ts')
PREFIX_ROWS=Path('wnba-r2a-2020-prefix-rowset.jsonl')
PREFIX_EVIDENCE=Path('wnba-r2a-2020-prefix-evidence.json')
OUT_ROWS=Path('wnba-r2a-2020-seed-candidate-rowset.jsonl')
OUT_EVIDENCE=Path('wnba-r2a-2020-seed-candidate-evidence.json')
API='https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
SAFE_SCHEDULE_COLS=['game_id','season','season_type','home_display_name','away_display_name']


def get_bytes(url:str,accept:str,timeout:int=90)->bytes:
    h={'Accept':accept,'User-Agent':'Prediccion-Elite-WNBA-R2A/1.0','X-GitHub-Api-Version':'2022-11-28'}
    tok=os.getenv('GITHUB_TOKEN','').strip()
    if tok: h['Authorization']=f'Bearer {tok}'
    with urlopen(Request(url,headers=h),timeout=timeout) as r: return r.read()


def git_blob_sha(data:bytes)->str:
    return hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()


def norm_id(v:Any)->str:
    if v is None:return ''
    s=str(v).strip()
    if s.endswith('.0') and s[:-2].isdigit():s=s[:-2]
    return s


def regular(v:Any)->bool:
    try:return int(v)==2
    except (TypeError,ValueError):return str(v or '').strip().lower().replace(' ','') in {'regular','regularseason'}


def parse_arena_map(text:str)->dict[str,tuple[float,float]]:
    m=re.search(r'export const WNBA_ARENAS:[^=]+?=\s*\{(.*?)\n\};',text,flags=re.S)
    if not m:raise RuntimeError('WNBA_ARENAS block not found')
    return {n:(float(a),float(b)) for n,a,b in re.findall(r'"([^"]+)"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]',m.group(1))}


def haversine(a:tuple[float,float],b:tuple[float,float])->float:
    lat1,lon1=a;lat2,lon2=b;R=3959.0
    dlat=math.radians(lat2-lat1);dlon=math.radians(lon2-lon1)
    q=math.sin(dlat/2)**2+math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return R*2*math.atan2(math.sqrt(q),math.sqrt(1-q))


def bucket(miles:float)->tuple[str,float]:
    if miles<500:return 'LT500',0.0
    if miles<1000:return '500_999',0.007
    if miles<2000:return '1000_1999',0.014
    if miles<2500:return '2000_2499',0.020
    return 'GTE2500',0.028


def main()->None:
    contract=json.loads(CONTRACT.read_text())
    pins=json.loads(PINS.read_text())

    # Reuse the already-certified prefix constructor mechanics, but force only 2020 and R2A pins.
    spec=importlib.util.spec_from_file_location('r2a_base',BASE_SCRIPT)
    if spec is None or spec.loader is None:raise SystemExit('cannot load prefix constructor')
    base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
    runtime_contract={
      'candidate':contract['candidate'],
      'empirical_gate':{
        'minimum_targets_per_season_with_two_team_prefix':int(contract['pregame_rowset_gate']['minimum_two_team_prefix_rows']),
        'minimum_total_targets_with_two_team_prefix':int(contract['pregame_rowset_gate']['minimum_two_team_prefix_rows']),
        'identity_join_rate_min':float(contract['pregame_rowset_gate']['schedule_team_box_join_rate_min'])
      }
    }
    runtime_contract_path=Path('wnba-r2a-runtime-prefix-contract.json')
    runtime_contract_path.write_text(json.dumps(runtime_contract,sort_keys=True)+'\n')
    base.CONTRACT=runtime_contract_path
    base.PINS=PINS
    base.SEASONS=(2020,)
    base.OUT_ROWS=PREFIX_ROWS
    base.OUT_EVIDENCE=PREFIX_EVIDENCE
    base.main()

    prefix_ev=json.loads(PREFIX_EVIDENCE.read_text())
    prefix_bytes=PREFIX_ROWS.read_bytes();prefix_rows=[json.loads(x) for x in prefix_bytes.splitlines() if x.strip()]
    expected_regular=int(contract['competition_structure_gate']['expected_regular_season_games'])
    actual_regular=int(prefix_ev.get('season',{}).get('2020',{}).get('regular_team_box_games',-1))
    if actual_regular!=expected_regular:
        OUT_EVIDENCE.write_text(json.dumps({'name':'WNBA_R2A_2020_STRUCTURE_FAILURE','decision':'R2A_NOT_CERTIFIED','expected_regular_games':expected_regular,'actual_regular_games':actual_regular,'2020_labels_opened_for_calibration':False},indent=2)+'\n')
        raise SystemExit(2)

    # Reverify frozen production source blobs before any enrichment.
    travel_bytes=TRAVEL_TS.read_bytes();model_bytes=MODEL_TS.read_bytes()
    travel_blob=git_blob_sha(travel_bytes);model_blob=git_blob_sha(model_bytes)
    if travel_blob!=contract['frozen_sources']['travel_ts']['git_blob_sha'] or model_blob!=contract['frozen_sources']['wnba_model_ts']['git_blob_sha']:
        raise SystemExit('FROZEN_SOURCE_BLOB_DRIFT')
    arena=parse_arena_map(travel_bytes.decode())

    # Safe schedule projection only: no score/winner/market columns.
    spin=pins['frozen_asset_pins']['schedule_master'];aid=int(spin['asset_id'])
    with tempfile.TemporaryDirectory(prefix='wnba-r2a-') as td:
        p=Path(td)/'schedule.parquet';payload=get_bytes(API.format(asset_id=aid),'application/octet-stream');p.write_bytes(payload)
        schedule_sha=hashlib.sha256(payload).hexdigest()
        schedule_ok=len(payload)==int(spin['size']) and schedule_sha==spin['sha256']
        schema=set(pq.ParquetFile(p).schema_arrow.names);missing=sorted(set(SAFE_SCHEDULE_COLS)-schema)
        safe=[] if missing else pq.read_table(p,columns=SAFE_SCHEDULE_COLS).to_pylist()
    schedule={}
    for r in safe:
        try:season=int(r.get('season') or 0)
        except (TypeError,ValueError):continue
        if season!=2020 or not regular(r.get('season_type')):continue
        gid=norm_id(r.get('game_id'))
        if gid:schedule[gid]={'home':str(r.get('home_display_name') or '').strip(),'away':str(r.get('away_display_name') or '').strip()}

    out=[];seen=set();duplicates=0;missing_join=[];missing_coord=[];outcomes=0;markets=0;bad_avail=0
    bucket_counts={}
    for src in prefix_rows:
        gid=str(src['gameId'])
        if gid in seen:duplicates+=1
        seen.add(gid)
        fixture=schedule.get(gid)
        if not fixture:missing_join.append(gid);continue
        hn,an=fixture['home'],fixture['away']
        if hn not in arena or an not in arena:missing_coord.append({'gameId':gid,'home':hn,'away':an});continue
        miles=haversine(arena[an],arena[hn]);label,adj=bucket(miles)
        x=copy.deepcopy(src)
        x['candidate']=contract['candidate']
        x['home']['travelMiles']=0.0;x['home']['travelStatus']='DEPLOYED_COORDINATE_EXACT'
        x['away']['travelMiles']=round(miles,6);x['away']['travelStatus']='DEPLOYED_COORDINATE_EXACT'
        x['travel']={'awayTeam':an,'homeTeam':hn,'bucket':label,'logitAdjustment':adj,'semantics':'DEPLOYED_FRANCHISE_COORDINATE_DISTANCE','2020BubblePhysicalTravelClaim':False}
        x['availabilityPolicy']='NEUTRAL_FEATURE_OMISSION_V1'
        for side in ('home','away'):
            x[side]['injuryAdj']=0.0;x[side]['injuryStatus']='OMITTED_BY_PREREGISTERED_CANDIDATE'
            x[side]['manualAdjustment']=0.0;x[side]['manualStatus']='OMITTED_BY_PREREGISTERED_CANDIDATE'
            if x[side]['injuryAdj']!=0.0 or x[side]['manualAdjustment']!=0.0:bad_avail+=1
        outcomes+=int(bool(x.get('targetOutcomeAttached')));markets+=int(bool(x.get('marketAttached')))
        bucket_counts[label]=bucket_counts.get(label,0)+1
        out.append(x)

    canonical=''.join(json.dumps(r,sort_keys=True,separators=(',',':'))+'\n' for r in out).encode()
    OUT_ROWS.write_bytes(canonical);out_sha=hashlib.sha256(canonical).hexdigest()
    join_rate=len(out)/len(prefix_rows) if prefix_rows else 0.0
    gate=contract['pregame_rowset_gate']
    passed=all([
      prefix_ev.get('decision','').startswith('CERTIFIED_'),actual_regular==expected_regular,
      len(prefix_rows)>=int(gate['minimum_two_team_prefix_rows']),schedule_ok,not missing,
      join_rate==1.0,not missing_join,not missing_coord,duplicates==0,outcomes==0,markets==0,bad_avail==0,
      int(prefix_ev.get('target_self_in_prefix_count',-1))==0,int(prefix_ev.get('same_day_value_used_count',-1))==0,int(prefix_ev.get('future_value_used_count',-1))==0
    ])
    ev={
      'name':'WNBA_R2A_2020_SEED_CANDIDATE_EVIDENCE_V1','decision':'R2A_2020_PREGAME_CANDIDATE_FROZEN_LABELS_STILL_CLOSED' if passed else 'R2A_NOT_CERTIFIED',
      'candidate':contract['candidate'],'seedSeason':2020,'seedRole':'TRAINING_ONLY_NEVER_TARGET_FOLD',
      '2020_labels_opened_for_calibration':False,'market_data_consumed':False,'production_changed':False,
      'sourceCustody':{'scheduleSha256':schedule_sha,'scheduleMatch':schedule_ok,'teamBoxCustody':prefix_ev.get('assets',{}).get('2020',{})},
      'competition':{'expectedRegularGames':expected_regular,'actualRegularGames':actual_regular},
      'prefix':{'rows':len(prefix_rows),'sha256':hashlib.sha256(prefix_bytes).hexdigest(),'evidenceDecision':prefix_ev.get('decision'),'coldStart':prefix_ev.get('season',{}).get('2020',{}).get('cold_start_or_unavailable_targets'),'bothSosReady':prefix_ev.get('season',{}).get('2020',{}).get('targets_with_both_sos_ready')},
      'travel':{'semantics':contract['2020_bubble_travel_rule']['frozen_replay_semantics'],'physicalBubbleTravelClaim':False,'bucketCounts':bucket_counts,'missingCoordinateRows':missing_coord},
      'gates':{'joinRate':join_rate,'missingJoinCount':len(missing_join),'duplicateGameIds':duplicates,'targetOutcomeAttachedRows':outcomes,'marketAttachedRows':markets,'availabilityOmissionErrors':bad_avail,'selfLeakage':prefix_ev.get('target_self_in_prefix_count'),'sameDayLeakage':prefix_ev.get('same_day_value_used_count'),'futureLeakage':prefix_ev.get('future_value_used_count')},
      'candidateRowset':{'rows':len(out),'bytes':len(canonical),'sha256':out_sha},
      'closure':{'r2aCandidateBuild':'PASS' if passed else 'FAIL','2020_probability_rowset_may_now_be_built':passed,'2020_labels_may_be_opened':False,'nextGate':'R2A_2020_DIRECT_MODEL_PROBABILITY_FREEZE' if passed else 'R2A_REPAIR'}
    }
    OUT_EVIDENCE.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n');print(json.dumps(ev,indent=2,sort_keys=True))
    if not passed:raise SystemExit(2)

if __name__=='__main__':main()

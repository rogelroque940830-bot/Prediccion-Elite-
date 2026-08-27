#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT = Path('research/wnba/WNBA_R1A4D3_TRAVEL_ENRICHED_PREFIX_CUSTODY.json')
PINS = Path('research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json')
SPECIAL = Path('research/wnba/WNBA_R1A4C2_SPECIAL_EVENT_EXCLUSION_AND_PREFIX_CUSTODY.json')
TRAVEL_TS = Path('frontend/client/src/lib/travel.ts')
MODEL_TS = Path('frontend/client/src/lib/wnba-model.ts')
BASE_SCRIPT = Path('scripts/wnba-r1a4c2-prefix-constructor.py')
BASE_ROWS = Path('wnba-r1a4c-prefix-rowset.jsonl')
BASE_EVIDENCE = Path('wnba-r1a4c-prefix-evidence.json')
OUT_ROWS = Path('wnba-r1a4d3-travel-enriched-prefix-rowset.jsonl')
OUT_EVIDENCE = Path('wnba-r1a4d3-travel-enriched-prefix-evidence.json')
API = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
SAFE_COLS = ['game_id','season','season_type','home_display_name','away_display_name']
SEASONS = (2021, 2022, 2023, 2024, 2025)


def headers(accept: str) -> dict[str, str]:
    h = {'Accept':accept,'User-Agent':'Prediccion-Elite-WNBA-R1A4D3/1.0','X-GitHub-Api-Version':'2022-11-28'}
    token = os.getenv('GITHUB_TOKEN','').strip()
    if token: h['Authorization'] = f'Bearer {token}'
    return h


def get_bytes(url: str, accept: str, timeout: int = 90) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as r:
        return r.read()


def norm_id(v: Any) -> str:
    if v is None: return ''
    s = str(v).strip()
    if s.endswith('.0') and s[:-2].isdigit(): s = s[:-2]
    return s


def is_regular(v: Any) -> bool:
    try: return int(v) == 2
    except (TypeError, ValueError): return str(v or '').strip().lower().replace(' ','') in {'regular','regularseason'}


def git_blob_sha(content: bytes) -> str:
    return hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()


def parse_arena_map(text: str) -> dict[str, tuple[float,float]]:
    m = re.search(r'export const WNBA_ARENAS:[^=]+?=\s*\{(.*?)\n\};', text, flags=re.S)
    if not m: raise RuntimeError('WNBA_ARENAS block not found')
    rows = re.findall(r'"([^"]+)"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]', m.group(1))
    return {n:(float(a),float(b)) for n,a,b in rows}


def haversine(a: tuple[float,float], b: tuple[float,float]) -> float:
    lat1,lon1=a; lat2,lon2=b; R=3959.0
    dlat=math.radians(lat2-lat1); dlon=math.radians(lon2-lon1)
    q=math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(q), math.sqrt(1-q))


def bucket(miles: float) -> tuple[str,float]:
    if miles < 500: return 'LT500',0.0
    if miles < 1000: return '500_999',0.007
    if miles < 2000: return '1000_1999',0.014
    if miles < 2500: return '2000_2499',0.020
    return 'GTE2500',0.028


def restore_base_shape(row: dict[str,Any]) -> dict[str,Any]:
    x=copy.deepcopy(row)
    x.pop('travel',None)
    for side in ('home','away'):
        x[side]['travelMiles']=None
        x[side]['travelStatus']='PENDING_SEASON_VENUE_CERTIFICATION'
    return x


def main() -> None:
    contract=json.loads(CONTRACT.read_text())
    pins=json.loads(PINS.read_text())
    special=json.loads(SPECIAL.read_text())
    expected_sha=contract['frozen_base_rowset']['expected_sha256']
    expected_rows=int(contract['frozen_base_rowset']['expected_rows'])

    # First reconstruct R1A.4C2 exactly. No enrichment is permitted until its frozen digest matches.
    proc=subprocess.run([sys.executable,str(BASE_SCRIPT)], capture_output=True, text=True, env=os.environ.copy())
    if proc.returncode != 0:
        OUT_EVIDENCE.write_text(json.dumps({'name':'WNBA_R1A4D3_OPERATIONAL_FAILURE','decision':'BASE_CONSTRUCTOR_FAILED','returncode':proc.returncode,'stderr':proc.stderr[-4000:],'r1b_outcome_opening_authorized':False},indent=2)+'\n')
        raise SystemExit(proc.returncode)
    base_bytes=BASE_ROWS.read_bytes()
    base_sha=hashlib.sha256(base_bytes).hexdigest()
    base_lines=[ln for ln in base_bytes.splitlines() if ln.strip()]
    base_sha_ok=(base_sha==expected_sha)
    base_count_ok=(len(base_lines)==expected_rows)
    if not base_sha_ok or not base_count_ok:
        OUT_EVIDENCE.write_text(json.dumps({'name':'WNBA_R1A4D3_BASE_DRIFT','decision':'TRAVEL_ENRICHED_PREFIX_NOT_CERTIFIED','base_sha256':base_sha,'expected_sha256':expected_sha,'base_rows':len(base_lines),'expected_rows':expected_rows,'r1b_outcome_opening_authorized':False},indent=2)+'\n')
        raise SystemExit(2)
    base_rows=[json.loads(ln) for ln in base_lines]
    base_by_gid={str(r['gameId']):r for r in base_rows}

    # Freeze production travel source blobs again at attachment time.
    travel_bytes=TRAVEL_TS.read_bytes(); model_bytes=MODEL_TS.read_bytes()
    travel_blob=git_blob_sha(travel_bytes); model_blob=git_blob_sha(model_bytes)
    travel_blob_ok=travel_blob==contract['frozen_travel_semantics']['travel_ts_blob_sha']
    model_blob_ok=model_blob==contract['frozen_travel_semantics']['wnba_model_ts_blob_sha']
    arena=parse_arena_map(travel_bytes.decode('utf-8'))

    excluded=set()
    for ids in special['special_event_classification']['excluded_game_ids_by_season'].values(): excluded.update(str(x) for x in ids)

    # Safe schedule join: no score/winner/market columns.
    pin=pins['frozen_asset_pins']['schedule_master']; aid=int(pin['asset_id'])
    with tempfile.TemporaryDirectory(prefix='wnba-r1a4d3-') as td:
        p=Path(td)/'schedule.parquet'; payload=get_bytes(API.format(asset_id=aid),'application/octet-stream'); p.write_bytes(payload)
        source_sha=hashlib.sha256(payload).hexdigest()
        source_ok=(len(payload)==int(pin['size']) and source_sha==str(pin['sha256']).removeprefix('sha256:'))
        schema=set(pq.ParquetFile(p).schema_arrow.names); missing_cols=sorted(set(SAFE_COLS)-schema)
        rows=[] if missing_cols else pq.read_table(p,columns=SAFE_COLS).to_pylist()

    schedule={}
    special_used=0
    for r in rows:
        try: season=int(r.get('season') or 0)
        except (TypeError,ValueError): continue
        if season not in SEASONS or not is_regular(r.get('season_type')): continue
        gid=norm_id(r.get('game_id'))
        if gid in excluded: continue
        schedule[gid]={'season':season,'home':str(r.get('home_display_name') or '').strip(),'away':str(r.get('away_display_name') or '').strip()}
        if gid in excluded: special_used += 1

    enriched=[]; missing_join=[]; missing_coord=[]; nontravel_mutations=0; bucket_counts=Counter(); market_attached=0; outcome_attached=0; injury_manual_imputed=0
    seen=set(); duplicates=0
    for base_row in base_rows:
        gid=str(base_row['gameId'])
        if gid in seen: duplicates+=1
        seen.add(gid)
        fixture=schedule.get(gid)
        if not fixture:
            missing_join.append(gid); continue
        home_name,away_name=fixture['home'],fixture['away']
        if home_name not in arena or away_name not in arena:
            missing_coord.append({'gameId':gid,'home':home_name,'away':away_name}); continue
        miles=haversine(arena[away_name],arena[home_name]); label,adj=bucket(miles)
        row=copy.deepcopy(base_row)
        row['home']['travelMiles']=0.0
        row['home']['travelStatus']='DEPLOYED_COORDINATE_EXACT'
        row['away']['travelMiles']=round(miles,6)
        row['away']['travelStatus']='DEPLOYED_COORDINATE_EXACT'
        row['travel']={'awayTeam':away_name,'homeTeam':home_name,'bucket':label,'logitAdjustment':adj,'semantics':'DEPLOYED_FRANCHISE_COORDINATE_DISTANCE'}
        bucket_counts[label]+=1
        if restore_base_shape(row) != base_row: nontravel_mutations += 1
        if bool(row.get('marketAttached')): market_attached += 1
        if bool(row.get('targetOutcomeAttached')): outcome_attached += 1
        for side in ('home','away'):
            if row[side].get('injuryAdj') is not None or row[side].get('manualAdjustment') is not None: injury_manual_imputed += 1
        enriched.append(row)

    canonical=''.join(json.dumps(r,sort_keys=True,separators=(',',':'))+'\n' for r in enriched).encode()
    OUT_ROWS.write_bytes(canonical)
    enriched_sha=hashlib.sha256(canonical).hexdigest()
    join_coverage=len(enriched)/len(base_rows) if base_rows else 0.0
    gates={
      'base_sha256_matches':base_sha_ok,'base_rows_match':base_count_ok,'travel_ts_blob_matches':travel_blob_ok,'wnba_model_blob_matches':model_blob_ok,
      'schedule_custody_verified':source_ok,'schedule_required_columns_missing':missing_cols,'base_rows':len(base_rows),'enriched_rows':len(enriched),
      'game_id_join_coverage':round(join_coverage,6),'travel_ready_rows':len(enriched),'missing_join_count':len(missing_join),'missing_coordinate_count':len(missing_coord),
      'non_travel_mutation_count':nontravel_mutations,'duplicate_game_ids':duplicates,'special_event_rows':special_used,'target_outcome_fields':outcome_attached,
      'market_attached_rows':market_attached,'injury_or_manual_imputation':injury_manual_imputed
    }
    passed=all([base_sha_ok,base_count_ok,travel_blob_ok,model_blob_ok,source_ok,not missing_cols,len(enriched)==expected_rows,join_coverage==1.0,not missing_join,not missing_coord,nontravel_mutations==0,duplicates==0,special_used==0,outcome_attached==0,market_attached==0,injury_manual_imputed==0])
    ev={
      'name':'WNBA_R1A4D3_TRAVEL_ENRICHED_PREFIX_EVIDENCE_V1','decision':'CERTIFIED_TRAVEL_ENRICHED_PREFIX_ROWSET' if passed else 'TRAVEL_ENRICHED_PREFIX_NOT_CERTIFIED',
      'target_outcomes_opened':False,'outcome_fields_loaded_from_schedule':0,'market_data_consumed':False,'r1b_outcome_opening_authorized':False,
      'base_rowset':{'sha256':base_sha,'expected_sha256':expected_sha,'rows':len(base_rows),'byte_exact_match':base_sha_ok},
      'production_blobs':{'travel_ts':travel_blob,'travel_ts_match':travel_blob_ok,'wnba_model_ts':model_blob,'wnba_model_match':model_blob_ok},
      'schedule_source':{'asset_id':aid,'sha256':source_sha,'custody_verified':source_ok,'required_columns_missing':missing_cols},
      'gates':gates,'travel_bucket_counts':dict(sorted(bucket_counts.items())),'missing_join_game_ids':missing_join[:50],'missing_coordinate_rows':missing_coord[:50],
      'enriched_rowset':{'rows':len(enriched),'bytes':len(canonical),'sha256':enriched_sha},
      'closure':{'r1a4d3':'PASS' if passed else 'FAIL','travel_closed_for_historical_fallback_candidate':passed,'target_outcomes_may_be_evaluated':False,'r1b_remains_closed':True,'next_gate':'R1A5_INJURY_AND_MANUAL_STATE_CANDIDATE_FREEZE' if passed else 'R1A4D3_REPAIR'}
    }
    OUT_EVIDENCE.write_text(json.dumps(ev,indent=2,sort_keys=True)+'\n')
    print(json.dumps(ev,indent=2,sort_keys=True))
    if not passed: raise SystemExit(2)


if __name__=='__main__': main()

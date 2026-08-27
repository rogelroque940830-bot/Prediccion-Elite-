#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, tempfile
from pathlib import Path
from urllib.request import Request, urlopen
import pyarrow.parquet as pq

PINS=Path('research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json')
OUT=Path('wnba-r1a4c1-special-event-metadata.json')
API='https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
COLS=['game_id','season','season_type','game_date_time','game_date','home_id','away_id','home_display_name','away_display_name','home_is_active','away_is_active','neutral_site','notes_type','notes_headline']


def headers(accept):
    h={'Accept':accept,'User-Agent':'Prediccion-Elite-WNBA-R1A4C1/1.0','X-GitHub-Api-Version':'2022-11-28'}
    t=os.getenv('GITHUB_TOKEN','').strip()
    if t: h['Authorization']='Bearer '+t
    return h

def get(url,accept):
    with urlopen(Request(url,headers=headers(accept)),timeout=90) as r: return r.read()

pins=json.loads(PINS.read_text()); pin=pins['frozen_asset_pins']['schedule_master']; aid=int(pin['asset_id'])
with tempfile.TemporaryDirectory(prefix='r1a4c1-') as td:
    p=Path(td)/'schedule.parquet'; b=get(API.format(asset_id=aid),'application/octet-stream'); p.write_bytes(b)
    sha=hashlib.sha256(b).hexdigest(); custody=(len(b)==int(pin['size']) and sha==pin['sha256'])
    schema=set(pq.ParquetFile(p).schema_arrow.names); missing=[c for c in COLS if c not in schema]
    rows=[] if missing else pq.read_table(p,columns=COLS).to_pylist()
    out={'name':'WNBA_R1A4C1_SPECIAL_EVENT_METADATA_EVIDENCE_V1','custody_verified':custody,'sha256':sha,'required_columns_missing':missing,'forbidden_outcome_values_loaded':False,'season':{}}
    for season in (2021,2022,2023,2024,2025):
        srows=[r for r in rows if int(r.get('season') or 0)==season and int(r.get('season_type') or 0)==2]
        candidates=[]
        for r in srows:
            note=str(r.get('notes_headline') or '').strip()
            if note or r.get('home_is_active') is False or r.get('away_is_active') is False:
                candidates.append({k:(str(r[k]) if k in {'game_date_time','game_date'} and r.get(k) is not None else r.get(k)) for k in COLS})
        out['season'][str(season)]={'season_type_2_count':len(srows),'metadata_candidates':candidates}
OUT.write_text(json.dumps(out,indent=2,default=str)+'\n'); print(json.dumps(out,indent=2,default=str))

#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import re
import tempfile
from collections import defaultdict, Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow as pa
import pyarrow.dataset as pads
import pyarrow.parquet as pq

CONTRACT_PATH = Path('research/wnba/WNBA_R3B_STRICT_PREFIX_FEATURE_FORGE_CONTRACT.json')
R1_PINS_PATH = Path('research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json')
R3B0_CERT_PATH = Path('research/wnba/WNBA_R3B0_H2H_SUPPORT_CUSTODY_CERTIFICATION.json')
R1_PREFIX_SCRIPT = Path('scripts/wnba-r1a4c-prefix-constructor.py')
TRAVEL_TS = Path('frontend/client/src/lib/travel.ts')
MODEL_TS = Path('frontend/client/src/lib/wnba-model.ts')
OUT_ROWS = Path('wnba-r3b-strict-prefix-feature-rowset.jsonl')
OUT_EVIDENCE = Path('wnba-r3b-strict-prefix-feature-evidence.json')
ASSET_API = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
TARGET_SEASONS = (2020, 2021, 2022, 2023, 2024, 2025)
SUPPORT_SEASON = 2019
EXPECTED_FIXTURES = {2019: 204, 2020: 132, 2021: 192, 2022: 216, 2023: 240, 2024: 240, 2025: 286}
IDENTITY_COLS = ['game_id', 'season', 'season_type', 'team_id', 'team_home_away', 'opponent_team_id']
STAT_COLS = [
    'game_id', 'team_id', 'team_home_away', 'opponent_team_id',
    'team_score', 'opponent_team_score',
    'field_goals_made', 'field_goals_attempted',
    'three_point_field_goals_made', 'three_point_field_goals_attempted',
    'free_throws_attempted', 'offensive_rebounds', 'defensive_rebounds', 'turnovers',
]
SCHEDULE_BASE_COLS = [
    'game_id', 'season', 'season_type', 'game_date_time', 'game_date',
    'home_id', 'away_id', 'home_display_name', 'away_display_name',
]
BASE_KEYS = [
    'teamId','gamesPlayed','wins','losses','winRate','pace','ppg','offRtg','defRtg','netRtg',
    'recentPace','recentOffRtg','recentDefRtg','recentNetRtg','recentPpg','recentWinPct',
    'daysRest','isB2B','b2bWasRoad','gamesLast7','streak','sos'
]


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'cannot load {path}')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


R1 = load_module(R1_PREFIX_SCRIPT, 'wnba_r1_prefix_reference')


def headers(accept: str) -> dict[str, str]:
    h = {
        'Accept': accept,
        'User-Agent': 'Prediccion-Elite-WNBA-R3B/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    token = os.getenv('GITHUB_TOKEN', '').strip()
    if token:
        h['Authorization'] = f'Bearer {token}'
    return h


def get_bytes(url: str, accept: str, timeout: int = 120) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as response:
        return response.read()


def git_blob_sha(payload: bytes) -> str:
    return hashlib.sha1(f'blob {len(payload)}\0'.encode() + payload).hexdigest()


def download_spec(spec: dict[str, Any], dst: Path, require_name: bool = False) -> dict[str, Any]:
    aid = int(spec['asset_id'])
    meta = json.loads(get_bytes(ASSET_API.format(asset_id=aid), 'application/vnd.github+json').decode())
    payload = get_bytes(ASSET_API.format(asset_id=aid), 'application/octet-stream')
    dst.write_bytes(payload)
    sha = hashlib.sha256(payload).hexdigest()
    expected_sha = str(spec['sha256']).removeprefix('sha256:')
    expected_size = int(spec['size'])
    name_ok = (not require_name) or str(meta.get('name')) == str(spec.get('name'))
    ok = int(meta.get('id', -1)) == aid and len(payload) == expected_size and sha == expected_sha and name_ok
    return {
        'asset_id': aid,
        'name': meta.get('name'),
        'bytes': len(payload),
        'sha256': sha,
        'expected_bytes': expected_size,
        'expected_sha256': expected_sha,
        'name_verified': name_ok,
        'custody_verified': ok,
    }


def norm_id(v: Any) -> str:
    if v is None:
        return ''
    s = str(v).strip()
    if s.endswith('.0') and s[:-2].isdigit():
        return s[:-2]
    return s


def norm_text(v: Any) -> str:
    return str(v or '').strip().lower().replace('_','').replace('-','').replace(' ','')


def regular(v: Any) -> bool:
    return norm_text(v) in {'regular','regularseason','2'}


def parse_date(*vals: Any) -> date | None:
    for v in vals:
        if v is None:
            continue
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, date):
            return v
        s = str(v).strip()
        if not s:
            continue
        try:
            return datetime.fromisoformat(s.replace('Z','+00:00')).date()
        except ValueError:
            pass
        try:
            return datetime.strptime(s[:10], '%Y-%m-%d').date()
        except ValueError:
            pass
    return None


def finite(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def rf(v: float | None, digits: int = 8) -> float | None:
    if v is None:
        return None
    return round(float(v), digits)


def parse_arena_map(text: str) -> dict[str, tuple[float,float]]:
    m = re.search(r'export const WNBA_ARENAS:[^=]+?=\s*\{(.*?)\n\};', text, flags=re.S)
    if not m:
        raise RuntimeError('WNBA_ARENAS block not found')
    rows = re.findall(r'"([^"]+)"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]', m.group(1))
    if not rows:
        raise RuntimeError('WNBA_ARENAS rows not parsed')
    return {name: (float(lat), float(lon)) for name,lat,lon in rows}


def haversine(a: tuple[float,float], b: tuple[float,float]) -> float:
    lat1,lon1=a; lat2,lon2=b; R=3959.0
    dlat=math.radians(lat2-lat1); dlon=math.radians(lon2-lon1)
    x=math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlon/2)**2
    return R*2*math.atan2(math.sqrt(x), math.sqrt(1-x))


def travel_bucket(miles: float) -> tuple[str,float]:
    if miles < 500: return 'LT500',0.0
    if miles < 1000: return '500_999',0.007
    if miles < 2000: return '1000_1999',0.014
    if miles < 2500: return '2000_2499',0.020
    return 'GTE2500',0.028


def read_stats_for_ids(path: Path, game_ids: list[str]) -> list[dict[str,Any]]:
    ds = pads.dataset(str(path), format='parquet')
    missing = [c for c in STAT_COLS if c not in ds.schema.names]
    if missing:
        raise RuntimeError(f'{path.name} missing stat columns {missing}')
    field = ds.schema.field('game_id')
    vals = [int(float(x)) for x in game_ids] if pa.types.is_integer(field.type) else game_ids
    expr = pads.field('game_id').isin(pa.array(vals, type=field.type))
    return ds.to_table(columns=STAT_COLS, filter=expr).to_pylist()


def load_identity_groups(path: Path, special_ids: set[str]) -> dict[str,list[dict[str,Any]]]:
    schema = pq.ParquetFile(path).schema_arrow
    missing = [c for c in IDENTITY_COLS if c not in schema.names]
    if missing:
        raise RuntimeError(f'{path.name} missing identity columns {missing}')
    rows = pq.read_table(path, columns=IDENTITY_COLS).to_pylist()
    grouped: dict[str,list[dict[str,Any]]] = defaultdict(list)
    for r in rows:
        if not regular(r.get('season_type')):
            continue
        gid=norm_id(r.get('game_id'))
        if gid and gid not in special_ids:
            grouped[gid].append(r)
    return grouped


def load_schedule_map(path: Path, season: int) -> dict[str,dict[str,Any]]:
    pf = pq.ParquetFile(path)
    schema = set(pf.schema_arrow.names)
    required = {'game_id','season_type','home_id','away_id'}
    missing = sorted(required-schema)
    if missing:
        raise RuntimeError(f'{path.name} missing schedule columns {missing}')
    date_cols = [c for c in ('game_date_time','game_date','date','start_date') if c in schema]
    if not date_cols:
        raise RuntimeError(f'{path.name} has no usable date column')
    cols = [c for c in SCHEDULE_BASE_COLS if c in schema]
    for c in date_cols:
        if c not in cols: cols.append(c)
    rows = pq.read_table(path, columns=cols).to_pylist()
    out: dict[str,dict[str,Any]] = {}
    for r in rows:
        if 'season' in r and r.get('season') is not None:
            try:
                if int(r['season']) != season:
                    continue
            except (TypeError,ValueError):
                continue
        if not regular(r.get('season_type')):
            continue
        gid=norm_id(r.get('game_id'))
        d=parse_date(*(r.get(c) for c in date_cols))
        if not gid or d is None:
            continue
        if gid in out:
            raise RuntimeError(f'duplicate schedule game_id {season} {gid}')
        out[gid]={
            'game_id':gid,'date':d,
            'home_id':norm_id(r.get('home_id')),'away_id':norm_id(r.get('away_id')),
            'home_name':str(r.get('home_display_name') or '').strip(),
            'away_name':str(r.get('away_display_name') or '').strip(),
        }
    return out


def make_targets(groups: dict[str,list[dict[str,Any]]], schedule: dict[str,dict[str,Any]], season: int) -> tuple[dict[date,list[dict[str,Any]]],dict[str,int]]:
    by_date: dict[date,list[dict[str,Any]]] = defaultdict(list)
    stats={'groups':len(groups),'joined':0,'malformed':0,'missing_schedule':0,'identity_mismatch':0}
    for gid,sides in groups.items():
        if len(sides)!=2:
            stats['malformed']+=1; continue
        sched=schedule.get(gid)
        if not sched:
            stats['missing_schedule']+=1; continue
        sm={norm_text(r.get('team_home_away')):r for r in sides}
        home=sm.get('home'); away=sm.get('away')
        if not home or not away:
            stats['malformed']+=1; continue
        hid=norm_id(home.get('team_id')); aid=norm_id(away.get('team_id'))
        if hid!=sched['home_id'] or aid!=sched['away_id']:
            stats['identity_mismatch']+=1; continue
        stats['joined']+=1
        by_date[sched['date']].append({
            'game_id':gid,'season':season,'date':sched['date'],
            'home_id':hid,'away_id':aid,
            'home_name':sched['home_name'],'away_name':sched['away_name'],
        })
    return by_date,stats


def profile(games: list[dict[str,Any]], opponent: bool=False) -> dict[str,float] | None:
    if not games:
        return None
    p='opp_' if opponent else ''
    keys=['fgm','fga','pm3','pa3','fta','oreb','dreb','tov']
    sums={k:sum(float(g[p+k]) for g in games) for k in keys}
    if sums['fga']<=0:
        return None
    efg=(sums['fgm']+0.5*sums['pm3'])/sums['fga']
    tov_den=sums['fga']+0.44*sums['fta']+sums['tov']
    if opponent:
        orb_den=sums['oreb']+sum(float(g['dreb']) for g in games)
    else:
        orb_den=sums['oreb']+sum(float(g['opp_dreb']) for g in games)
    return {
        'eFG':rf(efg),
        'TOVpct':rf(sums['tov']/tov_den) if tov_den>0 else None,
        'ORBpct':rf(sums['oreb']/orb_den) if orb_den>0 else None,
        'FTr':rf(sums['fta']/sums['fga']),
        'threePointAttemptRate':rf(sums['pa3']/sums['fga']),
    }


def raw_recent_net(games: list[dict[str,Any]]) -> float | None:
    if not games:
        return None
    poss=sum(float(g['fga'])+0.44*float(g['fta'])-float(g['oreb'])+float(g['tov']) for g in games)
    if poss<=0:
        return None
    return rf(100.0*(sum(float(g['scored']) for g in games)-sum(float(g['allowed']) for g in games))/poss)


def mean_available(values: list[float | None]) -> float | None:
    xs=[float(x) for x in values if x is not None and math.isfinite(float(x))]
    return rf(sum(xs)/len(xs)) if xs else None


def h2h_for(side_id: str, opp_id: str, season: int, target_date: date, h2h_records: list[dict[str,Any]]) -> dict[str,Any]:
    eligible=[]
    allowed_seasons={season-1,season}
    for g in h2h_records:
        if g['season'] not in allowed_seasons or g['date']>=target_date:
            continue
        if {g['home_id'],g['away_id']} != {side_id,opp_id}:
            continue
        eligible.append(g)
    if not eligible:
        return {'meetings':0,'winShare':None,'avgMargin':None}
    wins=0; margins=[]
    for g in eligible:
        if g['home_id']==side_id:
            s,o=g['home_score'],g['away_score']
        else:
            s,o=g['away_score'],g['home_score']
        wins += int(s>o); margins.append(s-o)
    return {'meetings':len(eligible),'winShare':rf(wins/len(eligible)),'avgMargin':rf(sum(margins)/len(margins))}


def build_side(team_id: str, opp_id: str, target_date: date, season: int, history: dict[str,list[dict[str,Any]]], h2h_records: list[dict[str,Any]]) -> dict[str,Any] | None:
    base_full=R1.team_state(team_id,target_date,history)
    if not base_full:
        return None
    base={k:base_full[k] for k in BASE_KEYS}
    games=history.get(team_id,[])
    season_prof=profile(games,False); season_allowed=profile(games,True)
    l10=games[-10:]
    l10_prof=profile(l10,False); l10_allowed=profile(l10,True)
    if not season_prof or not season_allowed or not l10_prof or not l10_allowed:
        return None
    last5=games[-5:]; last10=games[-10:]
    rn5=raw_recent_net(last5); rn10=raw_recent_net(last10)
    season_net=float(base['netRtg'])
    qa5=mean_available([g.get('qualityAdjustedGameNet') for g in last5])
    qa10=mean_available([g.get('qualityAdjustedGameNet') for g in last10])
    last=games[-1]
    true_days=max(0,(target_date-last['date']).days)
    prior4=sum(1 for g in games if g['date']>=target_date-timedelta(days=4))
    prior6=sum(1 for g in games if g['date']>=target_date-timedelta(days=6))
    return {
        'baseR2':base,
        'fourFactors':{
            'season':{'offense':{k:season_prof[k] for k in ('eFG','TOVpct','ORBpct','FTr')},'opponentAllowed':{k:season_allowed[k] for k in ('eFG','TOVpct','ORBpct','FTr')}},
            'l10':{'offense':{k:l10_prof[k] for k in ('eFG','TOVpct','ORBpct','FTr')},'opponentAllowed':{k:l10_allowed[k] for k in ('eFG','TOVpct','ORBpct','FTr')}},
        },
        'shotProfile':{
            'season':{'offense':{k:season_prof[k] for k in ('eFG','FTr','threePointAttemptRate')},'opponentAllowed':{k:season_allowed[k] for k in ('eFG','FTr','threePointAttemptRate')}},
            'l10':{'offense':{k:l10_prof[k] for k in ('eFG','FTr','threePointAttemptRate')},'opponentAllowed':{k:l10_allowed[k] for k in ('eFG','FTr','threePointAttemptRate')}},
        },
        'qualityAdjustedForm':{
            'recentNetRtgL5':rn5,'recentNetRtgL10':rn10,
            'formDeltaL5':rf(rn5-season_net) if rn5 is not None else None,
            'formDeltaL10':rf(rn10-season_net) if rn10 is not None else None,
            'qualityAdjustedRecentL5':qa5,'qualityAdjustedRecentL10':qa10,
        },
        'h2hPrefix':h2h_for(team_id,opp_id,season,target_date,h2h_records),
        'fatigueCalendarV2':{
            'trueDaysRest':true_days,
            'trueB2B':true_days==1,
            'priorGamesLast4Days':prior4,
            'wouldBe3in5':prior4>=2,
            'priorGamesLast6Days':prior6,
            'wouldBe4in7':prior6>=3,
        },
    }


def add_matchup(side: dict[str,Any], opponent_side: dict[str,Any]) -> None:
    out={}
    for window in ('season','l10'):
        off=side['shotProfile'][window]['offense']
        allowed=opponent_side['shotProfile'][window]['opponentAllowed']
        out[window]={
            'eFGAdvantage':rf(off['eFG']-allowed['eFG']),
            'threePointAttemptRateAdvantage':rf(off['threePointAttemptRate']-allowed['threePointAttemptRate']),
            'FTrAdvantage':rf(off['FTr']-allowed['FTr']),
        }
    side['shotProfileMatchup']=out


def build_game_records(gid: str, d: date, rows: list[dict[str,Any]], history: dict[str,list[dict[str,Any]]]) -> tuple[list[tuple[str,dict[str,Any]]],dict[str,Any] | None]:
    if len(rows)!=2:
        return [],None
    by_side={norm_text(r.get('team_home_away')):r for r in rows}
    home=by_side.get('home'); away=by_side.get('away')
    if not home or not away:
        return [],None
    pairs=[(home,away,True),(away,home,False)]
    pre_net={tid:(R1.team_state(tid,d,history) or {}).get('netRtg') for tid in {norm_id(home.get('team_id')),norm_id(away.get('team_id'))}}
    records=[]
    for r,opp,is_home in pairs:
        tid=norm_id(r.get('team_id')); oid=norm_id(opp.get('team_id'))
        if not tid or not oid or norm_id(r.get('opponent_team_id'))!=oid:
            return [],None
        vals={
            'scored':finite(r.get('team_score')),'allowed':finite(r.get('opponent_team_score')),
            'fgm':finite(r.get('field_goals_made')),'fga':finite(r.get('field_goals_attempted')),
            'pm3':finite(r.get('three_point_field_goals_made')),'pa3':finite(r.get('three_point_field_goals_attempted')),
            'fta':finite(r.get('free_throws_attempted')),'oreb':finite(r.get('offensive_rebounds')),
            'dreb':finite(r.get('defensive_rebounds')),'tov':finite(r.get('turnovers')),
            'opp_fgm':finite(opp.get('field_goals_made')),'opp_fga':finite(opp.get('field_goals_attempted')),
            'opp_pm3':finite(opp.get('three_point_field_goals_made')),'opp_pa3':finite(opp.get('three_point_field_goals_attempted')),
            'opp_fta':finite(opp.get('free_throws_attempted')),'opp_oreb':finite(opp.get('offensive_rebounds')),
            'opp_dreb':finite(opp.get('defensive_rebounds')),'opp_tov':finite(opp.get('turnovers')),
        }
        if any(v is None for v in vals.values()):
            return [],None
        poss=vals['fga']+0.44*vals['fta']-vals['oreb']+vals['tov']
        if poss<=0:
            return [],None
        game_net=100.0*(vals['scored']-vals['allowed'])/poss
        opp_pre=pre_net.get(oid)
        qa=rf(game_net-float(opp_pre)) if opp_pre is not None else None
        rec={
            'game_id':gid,'date':d,'is_home':is_home,'opponent_id':oid,
            **vals,'won':vals['scored']>vals['allowed'],'gameNetRtg':rf(game_net),'qualityAdjustedGameNet':qa,
        }
        records.append((tid,rec))
    h2h={
        'date':d,
        'home_id':norm_id(home.get('team_id')),'away_id':norm_id(away.get('team_id')),
        'home_score':float(home.get('team_score')),'away_score':float(away.get('team_score')),
    }
    return records,h2h


def target_outcome_key_hits(obj: Any) -> int:
    forbidden={'targetScore','targetWinner','homeScore','awayScore','winner','actualWinner','outcome'}
    if isinstance(obj,dict):
        return sum((1 if k in forbidden else 0)+target_outcome_key_hits(v) for k,v in obj.items())
    if isinstance(obj,list):
        return sum(target_outcome_key_hits(x) for x in obj)
    return 0


def main() -> None:
    contract=json.loads(CONTRACT_PATH.read_text())
    r1pins=json.loads(R1_PINS_PATH.read_text())
    r3b0=json.loads(R3B0_CERT_PATH.read_text())
    special={int(s):set(ids) for s,ids in contract['source_custody']['special_events'].items()}
    evidence={
        'name':'WNBA_R3B_STRICT_PREFIX_FEATURE_FORGE_EVIDENCE_V1',
        'contract':str(CONTRACT_PATH),'production_mutation':False,
        'performance_metrics_computed':False,'market_data_loaded':False,'availability_history_loaded':False,
        'target_self_in_prefix_count':0,'same_day_value_used_count':0,'future_value_used_count':0,
        'target_outcome_fields_in_rowset':0,'duplicate_game_ids':0,'2019_target_rows':0,
        'phase2_bad_games':0,'cold_start_or_unavailable':{},'assets':{},'seasons':{},'hard_failures':[],
    }

    travel_bytes=TRAVEL_TS.read_bytes(); model_bytes=MODEL_TS.read_bytes()
    travel_blob=git_blob_sha(travel_bytes); model_blob=git_blob_sha(model_bytes)
    evidence['production_source_custody']={
        'travel_ts_actual_blob_sha':travel_blob,'travel_ts_expected_blob_sha':contract['source_custody']['production_travel_ts_blob_sha'],
        'travel_ts_match':travel_blob==contract['source_custody']['production_travel_ts_blob_sha'],
        'wnba_model_actual_blob_sha':model_blob,'wnba_model_expected_blob_sha':contract['source_custody']['production_wnba_model_ts_blob_sha'],
        'wnba_model_match':model_blob==contract['source_custody']['production_wnba_model_ts_blob_sha'],
        'r1_prefix_reference_script_blob_sha':git_blob_sha(R1_PREFIX_SCRIPT.read_bytes()),
    }
    if not evidence['production_source_custody']['travel_ts_match'] or not evidence['production_source_custody']['wnba_model_match']:
        evidence['hard_failures'].append('frozen production source blob mismatch')
    arena_map=parse_arena_map(travel_bytes.decode())

    canonical_rows=[]; seen=set(); h2h_records=[]; total_targets=0; total_eligible=0
    travel_buckets=Counter(); missing_travel=[]

    with tempfile.TemporaryDirectory(prefix='wnba-r3b-') as td:
        root=Path(td); box_paths={}; schedule_paths={}
        for season in (2019,2020):
            for kind in ('team_box','schedule'):
                key=f'{season}_{kind}'; spec=r3b0['frozen_assets'][key]
                p=root/spec['name']; ev=download_spec(spec,p,require_name=True)
                evidence['assets'][key]=ev
                if not ev['custody_verified']: evidence['hard_failures'].append(f'{key} custody mismatch')
                if kind=='team_box': box_paths[season]=p
                else: schedule_paths[season]=p
        sp=r1pins['frozen_asset_pins']['schedule_master']; sm=root/'schedule_master.parquet'; sev=download_spec(sp,sm)
        evidence['assets']['schedule_master']=sev
        if not sev['custody_verified']: evidence['hard_failures'].append('schedule_master custody mismatch')
        for season in range(2021,2026):
            spec=r1pins['frozen_asset_pins'][f'{season}_team_box']; p=root/f'team_box_{season}.parquet'; ev=download_spec(spec,p)
            evidence['assets'][f'{season}_team_box']=ev
            if not ev['custody_verified']: evidence['hard_failures'].append(f'{season}_team_box custody mismatch')
            box_paths[season]=p; schedule_paths[season]=sm
        if evidence['hard_failures']:
            OUT_EVIDENCE.write_text(json.dumps(evidence,indent=2,sort_keys=True)+'\n'); raise SystemExit(2)

        targets_by_season={}
        for season in (2019,2020,2021,2022,2023,2024,2025):
            groups=load_identity_groups(box_paths[season],special[season])
            sched=load_schedule_map(schedule_paths[season],season)
            by_date,st=make_targets(groups,sched,season)
            fixture_count=sum(len(v) for v in by_date.values())
            st['fixture_count']=fixture_count; st['expected_fixture_count']=EXPECTED_FIXTURES[season]
            evidence['seasons'][str(season)]={'identity':st}
            if fixture_count!=EXPECTED_FIXTURES[season] or st['joined']!=EXPECTED_FIXTURES[season] or st['malformed'] or st['missing_schedule'] or st['identity_mismatch']:
                evidence['hard_failures'].append(f'{season} fixture/identity gate failed: {st}')
            targets_by_season[season]=by_date
        if evidence['hard_failures']:
            OUT_EVIDENCE.write_text(json.dumps(evidence,indent=2,sort_keys=True)+'\n'); raise SystemExit(2)

        history: dict[str,list[dict[str,Any]]] = defaultdict(list)
        for d in sorted(targets_by_season[2019]):
            day=sorted(targets_by_season[2019][d],key=lambda x:x['game_id'])
            ids=[x['game_id'] for x in day]
            stat_rows=read_stats_for_ids(box_paths[2019],ids); by_game=defaultdict(list)
            for r in stat_rows: by_game[norm_id(r.get('game_id'))].append(r)
            for t in day:
                recs,h2h=build_game_records(t['game_id'],d,by_game.get(t['game_id'],[]),history)
                if len(recs)!=2 or h2h is None:
                    evidence['phase2_bad_games']+=1; continue
                h2h['season']=2019; h2h_records.append(h2h)
                for tid,rec in recs: history[tid].append(rec)
        evidence['seasons']['2019']['support_h2h_games_ingested']=len(h2h_records)
        evidence['2019_target_rows']=0

        for season in TARGET_SEASONS:
            history=defaultdict(list)
            season_total=0; season_eligible=0; cold=0; sos_ready=0; phase2_bad_before=evidence['phase2_bad_games']
            for d in sorted(targets_by_season[season]):
                day=sorted(targets_by_season[season][d],key=lambda x:x['game_id'])
                ids=[x['game_id'] for x in day]
                for t in day:
                    season_total+=1; total_targets+=1
                    gid=t['game_id']; hid=t['home_id']; aid=t['away_id']
                    for tid in (hid,aid):
                        for g in history.get(tid,[]):
                            if g['game_id']==gid: evidence['target_self_in_prefix_count']+=1
                            if g['date']==d: evidence['same_day_value_used_count']+=1
                            if g['date']>d: evidence['future_value_used_count']+=1
                    hs=build_side(hid,aid,d,season,history,h2h_records); aws=build_side(aid,hid,d,season,history,h2h_records)
                    if hs is None or aws is None:
                        cold+=1; continue
                    if t['home_name'] not in arena_map or t['away_name'] not in arena_map:
                        missing_travel.append({'season':season,'gameId':gid,'home':t['home_name'],'away':t['away_name']}); cold+=1; continue
                    miles=haversine(arena_map[t['away_name']],arena_map[t['home_name']]); bucket,adj=travel_bucket(miles); travel_buckets[bucket]+=1
                    hs['baseR2']['travelMiles']=0.0; hs['baseR2']['travelStatus']='DEPLOYED_STATIC_SEMANTICS'
                    aws['baseR2']['travelMiles']=rf(miles,6); aws['baseR2']['travelStatus']='DEPLOYED_STATIC_SEMANTICS'
                    add_matchup(hs,aws); add_matchup(aws,hs)
                    if hs['baseR2']['sos']['status']=='READY' and aws['baseR2']['sos']['status']=='READY': sos_ready+=1
                    row={
                        'schemaVersion':1,'candidate':'WNBA_R3B_FEATURE_ROWSET_V1','season':season,'targetDate':d.isoformat(),'gameId':gid,
                        'homeTeamId':hid,'awayTeamId':aid,'homeTeamName':t['home_name'],'awayTeamName':t['away_name'],
                        'home':hs,'away':aws,
                        'deployedTravel':{'awayMiles':rf(miles,6),'bucket':bucket,'homeLogitBenefit':adj,'physicalTripTruthClaimed':False},
                        'targetOutcomeAttached':False,'marketAttached':False,'availabilityHistoricalAttached':False,
                    }
                    evidence['target_outcome_fields_in_rowset'] += target_outcome_key_hits(row)
                    if gid in seen: evidence['duplicate_game_ids']+=1
                    seen.add(gid); canonical_rows.append(row); season_eligible+=1; total_eligible+=1
                stat_rows=read_stats_for_ids(box_paths[season],ids); by_game=defaultdict(list)
                for r in stat_rows: by_game[norm_id(r.get('game_id'))].append(r)
                pending=[]
                for t in day:
                    recs,h2h=build_game_records(t['game_id'],d,by_game.get(t['game_id'],[]),history)
                    if len(recs)!=2 or h2h is None:
                        evidence['phase2_bad_games']+=1; continue
                    h2h['season']=season; pending.append((recs,h2h))
                for recs,h2h in pending:
                    h2h_records.append(h2h)
                    for tid,rec in recs: history[tid].append(rec)
            evidence['cold_start_or_unavailable'][str(season)]=cold
            evidence['seasons'][str(season)].update({
                'targets':season_total,'eligible_rows':season_eligible,'cold_start_or_unavailable':cold,
                'both_sos_ready_rows':sos_ready,'phase2_bad_games':evidence['phase2_bad_games']-phase2_bad_before,
            })

    canonical_rows.sort(key=lambda r:(r['season'],r['targetDate'],r['gameId']))
    lines=[json.dumps(r,sort_keys=True,separators=(',',':'),allow_nan=False) for r in canonical_rows]
    payload=(('\n'.join(lines)+'\n') if lines else '').encode()
    OUT_ROWS.write_bytes(payload)
    sha=hashlib.sha256(payload).hexdigest()
    gates={
        'source_hashes_match':not any('custody mismatch' in x for x in evidence['hard_failures']),
        'regular_fixture_counts_exact':all(evidence['seasons'][str(s)]['identity']['fixture_count']==EXPECTED_FIXTURES[s] for s in EXPECTED_FIXTURES),
        'target_self_zero':evidence['target_self_in_prefix_count']==0,
        'same_day_zero':evidence['same_day_value_used_count']==0,
        'future_zero':evidence['future_value_used_count']==0,
        'target_outcome_fields_zero':evidence['target_outcome_fields_in_rowset']==0,
        'duplicates_zero':evidence['duplicate_game_ids']==0,
        'support_year_not_target':evidence['2019_target_rows']==0,
        'travel_complete':len(missing_travel)==0,
        'phase2_complete':evidence['phase2_bad_games']==0,
        'minimum_rows':total_eligible>=int(contract['empirical_gates']['minimum_total_eligible_rows']),
        'six_target_seasons':all(evidence['seasons'][str(s)].get('eligible_rows',0)>0 for s in TARGET_SEASONS),
    }
    passed=all(gates.values()) and not evidence['hard_failures']
    evidence.update({
        'target_regular_games_total':total_targets,'eligible_rowset_rows':total_eligible,
        'rowset_bytes':len(payload),'rowset_sha256':sha,'travel_bucket_counts':dict(sorted(travel_buckets.items())),
        'missing_travel_rows':missing_travel,'h2h_history_games_final':len(h2h_records),
        'gates':gates,'decision':'CERTIFIED_R3B_STRICT_PREFIX_FEATURE_ROWSET' if passed else 'R3B_NOT_CERTIFIED_REPAIR_REQUIRED',
        'next_gate':'R3C_PREREGISTERED_ROLLING_ORIGIN_ABLATION' if passed else 'R3B_REPAIR',
    })
    OUT_EVIDENCE.write_text(json.dumps(evidence,indent=2,sort_keys=True)+'\n')
    print(json.dumps({k:evidence[k] for k in ('decision','target_regular_games_total','eligible_rowset_rows','rowset_sha256','rowset_bytes','gates')},indent=2,sort_keys=True))
    if not passed: raise SystemExit(2)


if __name__=='__main__':
    main()

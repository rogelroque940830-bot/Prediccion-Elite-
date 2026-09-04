#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

CONTRACT = Path('research/wnba/WNBA_R1A4D2_DEPLOYED_COORDINATE_TRAVEL_BUCKET_CUSTODY.json')
PINS = Path('research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json')
SPECIAL = Path('research/wnba/WNBA_R1A4C2_SPECIAL_EVENT_EXCLUSION_AND_PREFIX_CUSTODY.json')
TRAVEL_TS = Path('frontend/client/src/lib/travel.ts')
MODEL_TS = Path('frontend/client/src/lib/wnba-model.ts')
OUT = Path('wnba-r1a4d2-deployed-travel-evidence.json')
API = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
SEASONS = (2021, 2022, 2023, 2024, 2025)
SAFE_COLS = ['game_id','season','season_type','home_display_name','away_display_name']


def headers(accept: str) -> dict[str, str]:
    h = {
        'Accept': accept,
        'User-Agent': 'Prediccion-Elite-WNBA-R1A4D2/1.0',
        'X-GitHub-Api-Version': '2022-11-28'
    }
    token = os.getenv('GITHUB_TOKEN', '').strip()
    if token:
        h['Authorization'] = f'Bearer {token}'
    return h


def get_bytes(url: str, accept: str, timeout: int = 90) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as r:
        return r.read()


def git_blob_sha(content: bytes) -> str:
    return hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()


def norm_id(v: Any) -> str:
    if v is None:
        return ''
    s = str(v).strip()
    if s.endswith('.0') and s[:-2].isdigit():
        s = s[:-2]
    return s


def is_regular(v: Any) -> bool:
    try:
        return int(v) == 2
    except (TypeError, ValueError):
        return str(v or '').strip().lower().replace(' ', '') in {'regular','regularseason'}


def parse_production_arena_map(text: str) -> dict[str, tuple[float, float]]:
    match = re.search(r'export const WNBA_ARENAS:[^=]+?=\s*\{(.*?)\n\};', text, flags=re.S)
    if not match:
        raise RuntimeError('WNBA_ARENAS block not found')
    block = match.group(1)
    rows = re.findall(r'"([^"]+)"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]', block)
    if not rows:
        raise RuntimeError('WNBA_ARENAS coordinates not parsed')
    return {name: (float(lat), float(lon)) for name, lat, lon in rows}


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    R = 3959.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    x = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(x), math.sqrt(1 - x))
    return R * c


def bucket(miles: float) -> tuple[str, float]:
    if miles < 500:
        return 'LT500', 0.0
    if miles < 1000:
        return '500_999', 0.007
    if miles < 2000:
        return '1000_1999', 0.014
    if miles < 2500:
        return '2000_2499', 0.020
    return 'GTE2500', 0.028


def main() -> None:
    contract = json.loads(CONTRACT.read_text())
    pins = json.loads(PINS.read_text())
    special = json.loads(SPECIAL.read_text())

    travel_bytes = TRAVEL_TS.read_bytes()
    model_bytes = MODEL_TS.read_bytes()
    travel_sha = git_blob_sha(travel_bytes)
    model_sha = git_blob_sha(model_bytes)
    expected_travel_sha = contract['frozen_production_sources']['travel_ts']['git_blob_sha']
    expected_model_sha = contract['frozen_production_sources']['wnba_model_ts']['git_blob_sha']
    travel_blob_ok = travel_sha == expected_travel_sha
    model_blob_ok = model_sha == expected_model_sha

    travel_text = travel_bytes.decode('utf-8')
    model_text = model_bytes.decode('utf-8')
    arena_map = parse_production_arena_map(travel_text)
    required_expr = contract['frozen_production_sources']['wnba_model_ts']['required_travel_bucket_expression']
    compact_model = re.sub(r'\s+', ' ', model_text).strip()
    compact_expr = re.sub(r'\s+', ' ', required_expr).strip()
    bucket_expression_ok = compact_expr in compact_model
    haversine_r_ok = 'const R = 3959' in travel_text
    missing_symbols = [s for s in contract['frozen_production_sources']['travel_ts']['required_symbols'] if s not in travel_text]

    excluded = set()
    for ids in special['special_event_classification']['excluded_game_ids_by_season'].values():
        excluded.update(str(x) for x in ids)

    pin = pins['frozen_asset_pins']['schedule_master']
    with tempfile.TemporaryDirectory(prefix='wnba-r1a4d2-') as td:
        path = Path(td) / 'schedule.parquet'
        aid = int(pin['asset_id'])
        payload = get_bytes(API.format(asset_id=aid), 'application/octet-stream')
        path.write_bytes(payload)
        source_sha = hashlib.sha256(payload).hexdigest()
        source_ok = len(payload) == int(pin['size']) and source_sha == str(pin['sha256']).removeprefix('sha256:')
        schema = set(pq.ParquetFile(path).schema_arrow.names)
        missing_cols = sorted(set(SAFE_COLS) - schema)
        rows = [] if missing_cols else pq.read_table(path, columns=SAFE_COLS).to_pylist()

    fixtures = []
    special_rows_used = 0
    for r in rows:
        try:
            season = int(r.get('season') or 0)
        except (TypeError, ValueError):
            continue
        if season not in SEASONS or not is_regular(r.get('season_type')):
            continue
        gid = norm_id(r.get('game_id'))
        if gid in excluded:
            continue
        fixtures.append({
            'game_id': gid,
            'season': season,
            'home': str(r.get('home_display_name') or '').strip(),
            'away': str(r.get('away_display_name') or '').strip(),
        })
        if gid in excluded:
            special_rows_used += 1

    season_teams: dict[int, set[str]] = defaultdict(set)
    missing_coordinate_rows = []
    season_buckets: dict[int, Counter] = defaultdict(Counter)
    all_buckets = Counter()
    pair_examples: dict[str, dict[str, Any]] = {}
    distances = []

    for f in fixtures:
        season_teams[f['season']].update([f['home'], f['away']])
        if f['home'] not in arena_map or f['away'] not in arena_map:
            missing_coordinate_rows.append(f)
            continue
        miles = haversine(arena_map[f['away']], arena_map[f['home']])
        label, adj = bucket(miles)
        season_buckets[f['season']][label] += 1
        all_buckets[label] += 1
        distances.append(miles)
        pair_key = f"{f['away']} -> {f['home']}"
        if pair_key not in pair_examples:
            pair_examples[pair_key] = {'miles': round(miles, 6), 'bucket': label, 'logit_adjustment': adj}

    season_mapping = {}
    for season in SEASONS:
        season_mapping[str(season)] = {
            name: {'lat': arena_map[name][0], 'lon': arena_map[name][1]}
            for name in sorted(season_teams.get(season, set())) if name in arena_map
        }

    expected_counts = {2021: 192, 2022: 216, 2023: 240, 2024: 240, 2025: 286}
    observed_counts = Counter(f['season'] for f in fixtures)
    fixture_structure_ok = all(observed_counts[s] == expected_counts[s] for s in SEASONS)
    coverage = (len(fixtures) - len(missing_coordinate_rows)) / len(fixtures) if fixtures else 0.0
    all_team_names_have_coordinates = len(missing_coordinate_rows) == 0
    required_seasons_ok = all(observed_counts[s] > 0 for s in SEASONS)

    gate = all([
        travel_blob_ok,
        model_blob_ok,
        bucket_expression_ok,
        haversine_r_ok,
        not missing_symbols,
        source_ok,
        not missing_cols,
        fixture_structure_ok,
        len(fixtures) == 1174,
        all_team_names_have_coordinates,
        coverage == 1.0,
        special_rows_used == 0,
        required_seasons_ok,
    ])
    decision = 'CERTIFIED_DEPLOYED_TRAVEL_COORDINATE_AND_BUCKET_CUSTODY' if gate else 'TRAVEL_CUSTODY_NOT_CERTIFIED'

    evidence = {
        'name': 'WNBA_R1A4D2_DEPLOYED_TRAVEL_CUSTODY_EVIDENCE_V1',
        'decision': decision,
        'target_outcomes_opened': False,
        'outcome_fields_loaded': 0,
        'market_data_consumed': False,
        'r1b_outcome_opening_authorized': False,
        'production_source_custody': {
            'travel_ts_expected_blob_sha': expected_travel_sha,
            'travel_ts_actual_blob_sha': travel_sha,
            'travel_ts_blob_matches': travel_blob_ok,
            'wnba_model_expected_blob_sha': expected_model_sha,
            'wnba_model_actual_blob_sha': model_sha,
            'wnba_model_blob_matches': model_blob_ok,
            'travel_bucket_expression_matches': bucket_expression_ok,
            'haversine_radius_3959_matches': haversine_r_ok,
            'missing_required_symbols': missing_symbols,
            'parsed_production_wnba_arena_keys': sorted(arena_map),
        },
        'schedule_source_custody': {
            'asset_id': aid,
            'bytes': len(payload),
            'sha256': source_sha,
            'custody_verified': source_ok,
            'required_columns_missing': missing_cols,
        },
        'regular_fixture_count': len(fixtures),
        'per_season_fixture_count': {str(s): observed_counts[s] for s in SEASONS},
        'fixture_structure_pass': fixture_structure_ok,
        'special_event_rows_used': special_rows_used,
        'travel_pair_ready': len(fixtures) - len(missing_coordinate_rows),
        'travel_pair_coverage': round(coverage, 6),
        'missing_coordinate_count': len(missing_coordinate_rows),
        'missing_coordinate_rows': missing_coordinate_rows[:50],
        'season_versioned_production_coordinate_map': season_mapping,
        'travel_bucket_counts_total': dict(sorted(all_buckets.items())),
        'travel_bucket_counts_by_season': {str(s): dict(sorted(season_buckets[s].items())) for s in SEASONS},
        'distance_summary_miles': {
            'min': round(min(distances), 6) if distances else None,
            'max': round(max(distances), 6) if distances else None,
        },
        'unique_directional_pair_examples': dict(sorted(pair_examples.items())),
        'scientific_interpretation': {
            'claim': 'Exact deployed travel-coordinate/bucket semantics for corrected 2021-2025 regular-season fixture identities.',
            'not_claimed': 'Physical trip mileage, actual target-game venue distance, or corrected arena geography.',
            'missing_production_coordinate_is_not_zero': True,
        },
        'closure': {
            'r1a4d2': 'PASS' if gate else 'FAIL',
            'target_outcomes_may_be_evaluated': False,
            'r1b_remains_closed': True,
            'next_gate': 'R1A4D3_ATTACH_TRAVEL_TO_FROZEN_PREFIX_ROWSET' if gate else 'R1A4D2_REPAIR'
        }
    }
    OUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + '\n')
    print(json.dumps(evidence, indent=2, sort_keys=True))
    if not gate:
        raise SystemExit(2)


if __name__ == '__main__':
    main()

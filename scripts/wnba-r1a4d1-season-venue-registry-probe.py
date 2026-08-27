#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

PINS = Path('research/wnba/WNBA_R1A4_STATIC_VERSIONED_DATASET_CERTIFICATION.json')
SPECIAL = Path('research/wnba/WNBA_R1A4C2_SPECIAL_EVENT_EXCLUSION_AND_PREFIX_CUSTODY.json')
OUT = Path('wnba-r1a4d1-season-venue-registry-evidence.json')
API = 'https://api.github.com/repos/sportsdataverse/sportsdataverse-data/releases/assets/{asset_id}'
SEASONS = (2021, 2022, 2023, 2024, 2025)
COLS = [
    'game_id','season','season_type','game_date_time','game_date',
    'home_id','away_id','home_display_name','away_display_name',
    'home_venue_id','away_venue_id','venue_id','venue_full_name',
    'venue_address_city','venue_address_state','neutral_site','notes_headline'
]


def headers(accept: str) -> dict[str, str]:
    h = {
        'Accept': accept,
        'User-Agent': 'Prediccion-Elite-WNBA-R1A4D1/1.0',
        'X-GitHub-Api-Version': '2022-11-28'
    }
    token = os.getenv('GITHUB_TOKEN', '').strip()
    if token:
        h['Authorization'] = f'Bearer {token}'
    return h


def get_bytes(url: str, accept: str, timeout: int = 90) -> bytes:
    with urlopen(Request(url, headers=headers(accept)), timeout=timeout) as r:
        return r.read()


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
        return str(v or '').strip().lower() in {'regular', 'regular season', 'regularseason'}


def main() -> None:
    pins = json.loads(PINS.read_text())
    special = json.loads(SPECIAL.read_text())
    schedule_pin = pins['frozen_asset_pins']['schedule_master']
    excluded = set()
    for ids in special['special_event_classification']['excluded_game_ids_by_season'].values():
        excluded.update(str(x) for x in ids)

    with tempfile.TemporaryDirectory(prefix='wnba-r1a4d1-') as td:
        path = Path(td) / 'schedule.parquet'
        aid = int(schedule_pin['asset_id'])
        payload = get_bytes(API.format(asset_id=aid), 'application/octet-stream')
        path.write_bytes(payload)
        sha = hashlib.sha256(payload).hexdigest()
        custody = len(payload) == int(schedule_pin['size']) and sha == str(schedule_pin['sha256']).removeprefix('sha256:')

        schema = set(pq.ParquetFile(path).schema_arrow.names)
        missing = sorted(set(COLS) - schema)
        rows = [] if missing else pq.read_table(path, columns=COLS).to_pylist()

    venue_catalog: dict[str, dict[str, Any]] = {}
    all_regular = []
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
        all_regular.append(r)
        if gid in excluded:
            special_rows_used += 1
        vid = norm_id(r.get('venue_id'))
        if vid:
            item = venue_catalog.setdefault(vid, {'names': Counter(), 'cities': Counter(), 'states': Counter(), 'appearances': 0})
            item['appearances'] += 1
            if r.get('venue_full_name'):
                item['names'][str(r['venue_full_name']).strip()] += 1
            if r.get('venue_address_city'):
                item['cities'][str(r['venue_address_city']).strip()] += 1
            if r.get('venue_address_state'):
                item['states'][str(r['venue_address_state']).strip()] += 1

    team_registry: dict[tuple[int, str, str], Counter] = defaultdict(Counter)
    team_actual_home: dict[tuple[int, str, str], Counter] = defaultdict(Counter)
    team_rows: dict[tuple[int, str, str], int] = Counter()
    missing_pair = 0
    per_season = {str(s): {'targets': 0, 'registered_venue_pair_ready': 0} for s in SEASONS}

    for r in all_regular:
        season = int(r['season'])
        home_id, away_id = norm_id(r.get('home_id')), norm_id(r.get('away_id'))
        home_name, away_name = str(r.get('home_display_name') or '').strip(), str(r.get('away_display_name') or '').strip()
        hv, av = norm_id(r.get('home_venue_id')), norm_id(r.get('away_venue_id'))
        actual = norm_id(r.get('venue_id'))
        per_season[str(season)]['targets'] += 1
        if hv and av:
            per_season[str(season)]['registered_venue_pair_ready'] += 1
        else:
            missing_pair += 1
        hk, ak = (season, home_id, home_name), (season, away_id, away_name)
        team_rows[hk] += 1
        team_rows[ak] += 1
        if hv:
            team_registry[hk][hv] += 1
        if av:
            team_registry[ak][av] += 1
        if actual and not bool(r.get('neutral_site')):
            team_actual_home[hk][actual] += 1

    team_evidence = []
    registered_ids = set()
    multi_registered = []
    registered_not_seen_actual = []
    for key in sorted(team_rows, key=lambda x: (x[0], x[2], x[1])):
        season, team_id, team_name = key
        reg = team_registry.get(key, Counter())
        actual = team_actual_home.get(key, Counter())
        registered_ids.update(reg.keys())
        row = {
            'season': season,
            'team_id': team_id,
            'team_name': team_name,
            'schedule_appearances': team_rows[key],
            'registered_venue_ids': dict(sorted(reg.items())),
            'distinct_registered_venue_ids': len(reg),
            'non_neutral_actual_home_venue_ids': dict(sorted(actual.items())),
            'registered_ids_seen_as_actual_venue': sorted(set(reg) & set(venue_catalog)),
        }
        team_evidence.append(row)
        if len(reg) != 1:
            multi_registered.append({'season': season, 'team_id': team_id, 'team_name': team_name, 'registered_venue_ids': dict(reg)})
        for vid in reg:
            if vid not in venue_catalog:
                registered_not_seen_actual.append({'season': season, 'team_id': team_id, 'team_name': team_name, 'venue_id': vid})

    catalog_out = {}
    for vid in sorted(venue_catalog):
        item = venue_catalog[vid]
        catalog_out[vid] = {
            'appearances': item['appearances'],
            'names': dict(item['names'].most_common()),
            'cities': dict(item['cities'].most_common()),
            'states': dict(item['states'].most_common()),
        }

    total = len(all_regular)
    ready = total - missing_pair
    coverage = ready / total if total else 0.0
    required_seasons_ok = all(per_season[str(s)]['targets'] > 0 for s in SEASONS)
    gate = custody and not missing and special_rows_used == 0 and coverage >= 0.99 and required_seasons_ok
    decision = 'VENUE_REGISTRY_SURFACE_CERTIFIED_COORDINATE_CUSTODY_NEXT' if gate else 'VENUE_REGISTRY_NOT_CERTIFIED'

    evidence = {
        'name': 'WNBA_R1A4D1_SEASON_VENUE_REGISTRY_EVIDENCE_V1',
        'decision': decision,
        'target_outcomes_opened': False,
        'forbidden_outcome_values_loaded': False,
        'market_data_consumed': False,
        'r1b_outcome_opening_authorized': False,
        'schedule_asset': {
            'asset_id': aid,
            'bytes': len(payload),
            'sha256': sha,
            'custody_verified': custody,
            'required_columns_missing': missing,
        },
        'special_event_rows_used': special_rows_used,
        'regular_targets_after_special_exclusion': total,
        'registered_venue_pair_ready': ready,
        'registered_venue_pair_missing': missing_pair,
        'registered_venue_pair_coverage': round(coverage, 6),
        'per_season': per_season,
        'franchise_season_registry_count': len(team_evidence),
        'franchise_season_multiple_registered_venue_ids': multi_registered,
        'registered_venue_ids_total': len(registered_ids),
        'registered_venue_ids': sorted(registered_ids),
        'registered_venue_ids_not_observed_as_actual_game_venue': registered_not_seen_actual,
        'team_registry': team_evidence,
        'venue_catalog_from_safe_schedule_metadata': catalog_out,
        'closure': {
            'r1a4d1': 'PASS' if gate else 'FAIL',
            'coordinate_custody_certified': False,
            'travel_bucket_certified': False,
            'target_outcomes_may_be_evaluated': False,
            'r1b_remains_closed': True,
            'next_gate': 'R1A4D2_COORDINATE_AND_TRAVEL_BUCKET_CUSTODY' if gate else 'R1A4D1_REPAIR'
        }
    }
    OUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + '\n')
    print(json.dumps(evidence, indent=2, sort_keys=True))
    if not gate:
        raise SystemExit(2)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pyarrow.compute as pc
import pyarrow.parquet as pq

BASE_PATH = Path('scripts/wnba-r1a4c-prefix-constructor.py')
CONTRACT_PATH = Path('research/wnba/WNBA_R1A4C2_SPECIAL_EVENT_EXCLUSION_AND_PREFIX_CUSTODY.json')
EVIDENCE_PATH = Path('wnba-r1a4c-prefix-evidence.json')
ROWSET_PATH = Path('wnba-r1a4c-prefix-rowset.jsonl')

spec = importlib.util.spec_from_file_location('wnba_r1a4c_base', BASE_PATH)
if spec is None or spec.loader is None:
    raise SystemExit('cannot load base R1A.4C constructor')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

contract = json.loads(CONTRACT_PATH.read_text())
EXCLUDED_BY_SEASON = {int(s): {str(x) for x in ids} for s, ids in contract['special_event_classification']['excluded_game_ids_by_season'].items()}
EXCLUDED_ALL = set().union(*EXCLUDED_BY_SEASON.values())
EXPECTED = {int(s): int(v['expected_games']) for s, v in contract['official_regular_season_structure_gate'].items()}

# Use the corrected contract for the base constructor's thresholds/candidate.
base.CONTRACT = CONTRACT_PATH

_ORIG_READ_TABLE = pq.read_table
_ORIG_READ_STATS = base.read_stats_for_ids
stat_guard_requests = 0


def _norm_gid(v: Any) -> str:
    if v is None:
        return ''
    s = str(v).strip()
    if s.endswith('.0') and s[:-2].isdigit():
        s = s[:-2]
    return s


def _filter_special_identity(table):
    if 'game_id' not in table.column_names:
        return table
    gids = table['game_id'].to_pylist()
    keep = [(_norm_gid(v) not in EXCLUDED_ALL) for v in gids]
    return table.filter(keep)


def filtered_read_table(source, *args, **kwargs):
    # The base constructor only uses pq.read_table for schedule/identity projections.
    # Filtering happens after those SAFE, explicitly requested columns are loaded.
    table = _ORIG_READ_TABLE(source, *args, **kwargs)
    cols = kwargs.get('columns')
    if cols is None and len(args) >= 1:
        cols = args[0]
    safe = set(cols or [])
    if 'game_id' in safe and not ({'team_score', 'opponent_team_score', 'home_score', 'away_score', 'team_winner', 'home_winner', 'away_winner'} & safe):
        return _filter_special_identity(table)
    return table


def guarded_read_stats(path, game_ids):
    global stat_guard_requests
    bad = sorted(EXCLUDED_ALL.intersection({_norm_gid(x) for x in game_ids}))
    if bad:
        stat_guard_requests += len(bad)
        raise SystemExit(f'ANTI_LEAKAGE_SPECIAL_EVENT_STAT_REQUEST: {bad}')
    return _ORIG_READ_STATS(path, game_ids)


base.pq.read_table = filtered_read_table
base.read_stats_for_ids = guarded_read_stats
base.main()

# Corrected post-run structural/classification gate.
ev = json.loads(EVIDENCE_PATH.read_text())
ev['name'] = 'WNBA_R1A4C2_PREFIX_CONSTRUCTOR_EVIDENCE_V1'
ev['special_event_classification'] = {
    'excluded_game_ids_by_season': {str(s): sorted(ids) for s, ids in EXCLUDED_BY_SEASON.items()},
    'excluded_special_event_count': len(EXCLUDED_ALL),
    'special_event_stat_request_count': stat_guard_requests,
    'special_event_values_loaded': False,
    'classification_evidence_run_id': contract['special_event_classification']['evidence_run_id'],
    'classification_evidence_artifact_id': contract['special_event_classification']['evidence_artifact_id'],
}
fixture_pass = True
fixture_check = {}
for season in sorted(EXPECTED):
    actual = int(ev['season'][str(season)]['regular_team_box_games'])
    expected = EXPECTED[season]
    ok = actual == expected
    fixture_pass = fixture_pass and ok
    fixture_check[str(season)] = {'expected_regular_games': expected, 'actual_regular_games_after_special_exclusion': actual, 'pass': ok}
ev['official_regular_fixture_structure'] = fixture_check
ev['official_regular_fixture_gate_pass'] = fixture_pass

rows = []
if ROWSET_PATH.exists():
    for line in ROWSET_PATH.read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
special_target_hits = sorted({_norm_gid(r.get('gameId')) for r in rows}.intersection(EXCLUDED_ALL))
ev['special_event_target_rows'] = len(special_target_hits)
ev['special_event_target_game_ids'] = special_target_hits

base_pass = ev.get('decision') == 'CERTIFIED_PREFIX_CUSTODY_RECONSTRUCTIBLE_GROUPS_TRAVEL_INJURY_MANUAL_STILL_OPEN'
classification_pass = fixture_pass and stat_guard_requests == 0 and not special_target_hits
if base_pass and classification_pass:
    ev['decision'] = 'CERTIFIED_CORRECTED_REGULAR_SEASON_PREFIX_CUSTODY_TRAVEL_INJURY_MANUAL_STILL_OPEN'
elif not classification_pass:
    ev['decision'] = 'NOT_CERTIFIED_SPECIAL_EVENT_CLASSIFICATION_OR_STRUCTURE'
ev['r1b_outcome_opening_authorized'] = False
ev['next_gate'] = 'R1A4D_SEASON_VENUE_TRAVEL_CUSTODY_OR_R1A5_INJURY_NEUTRAL_CANDIDATE_FREEZE' if ev['decision'].startswith('CERTIFIED_') else 'R1A4C2_REPAIR'
EVIDENCE_PATH.write_text(json.dumps(ev, indent=2, sort_keys=True) + '\n')
print(json.dumps(ev, indent=2, sort_keys=True))

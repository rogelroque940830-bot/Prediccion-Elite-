#!/usr/bin/env python3
import collections
import hashlib
import json
from pathlib import Path

PROTOCOL = Path('research/wnba/WNBA_R1A7_PROBABILITY_CUSTODY_AND_R1B_PROTOCOL.json')
EVIDENCE6 = Path('wnba-r1a6-model-replay-evidence.json')
ROWSET = Path('wnba-r1a6-sports-only-probability-rowset.jsonl')
OUT = Path('wnba-r1a7-closure-evidence.json')


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


protocol = json.loads(PROTOCOL.read_text())
ev6 = json.loads(EVIDENCE6.read_text())
rows = [json.loads(line) for line in ROWSET.read_text().splitlines() if line.strip()]
expected_sha = protocol['r1a6_success_custody']['probability_rowset_sha256']
expected_rows = int(protocol['frozen_cohort']['rows_total'])
expected_seasons = {int(k): int(v) for k, v in protocol['frozen_cohort']['rows_by_season'].items()}
actual_sha = sha256(ROWSET)
season_counts = collections.Counter(int(r['season']) for r in rows)
ids = [str(r['gameId']) for r in rows]
unique_ids = len(set(ids))
market_rows = sum(1 for r in rows if bool(r.get('marketAttached')))
outcome_rows = sum(1 for r in rows if bool(r.get('targetOutcomeAttached')))
special_rows = int(ev6.get('gates', {}).get('special_event_rows', -1))
prob_valid = sum(1 for r in rows if isinstance(r.get('p_win_selected_side'), (int, float)) and 0.5 <= float(r['p_win_selected_side']) < 1.0)
model_shas = {str(r.get('modelBlobSha')) for r in rows}
expected_model = protocol['r1a6_success_custody']['model_git_blob_sha']

checks = {
    'r1a6_decision_frozen': ev6.get('decision') == 'FROZEN_OUTCOME_BLIND_SPORTS_ONLY_PROBABILITY_ROWSET',
    'r1a6_pass': ev6.get('closure', {}).get('r1a6') == 'PASS',
    'probability_rowset_sha256_matches': actual_sha == expected_sha,
    'probability_rows_match': len(rows) == expected_rows,
    'season_counts_match': dict(sorted(season_counts.items())) == dict(sorted(expected_seasons.items())),
    'duplicate_game_ids_zero': unique_ids == len(rows),
    'market_rows_zero': market_rows == 0,
    'outcome_rows_zero': outcome_rows == 0,
    'special_event_rows_zero': special_rows == 0,
    'selected_probability_valid_all_rows': prob_valid == len(rows),
    'model_blob_sha_single_and_matches': model_shas == {expected_model},
    'input_sha_matches': ev6.get('input_custody', {}).get('sha256') == protocol['r1a6_success_custody']['candidate_input_sha256'],
    'outcomes_still_closed_during_r1a7': ev6.get('target_outcomes_opened') is False,
    'market_argument_not_passed': ev6.get('market_argument_passed') is False,
}
passed = all(checks.values())

closure = {
    'name': 'WNBA_R1A7_CLOSURE_EVIDENCE_V1',
    'decision': 'R1A_CLOSED_AND_R1B_OUTCOME_OPENING_AUTHORIZED' if passed else 'R1A_REMAINS_OPEN_OUTCOMES_FORBIDDEN',
    'candidate': protocol['candidate'],
    'exact_production_sports_only_v1_status': protocol['exact_production_sports_only_v1_status'],
    'target_outcomes_opened_during_r1a7': False,
    'market_data_consumed': False,
    'probability_rowset': {
        'rows': len(rows),
        'sha256': actual_sha,
        'expected_sha256': expected_sha,
        'rows_by_season': {str(k): v for k, v in sorted(season_counts.items())},
    },
    'model_custody': {
        'expected_git_blob_sha': expected_model,
        'rowset_model_blob_shas': sorted(model_shas),
    },
    'checks': checks,
    'r1b_protocol_frozen_before_outcomes': True,
    'r1b_label_asset_sha256': protocol['r1b_label_source']['asset_sha256'],
    'r1b_outcome_opening_authorized': passed,
    'global_ranker_promotion_authorized': False,
    'production_change_authorized': False,
    'next_gate': 'R1B1_OPEN_FROZEN_LABEL_ASSET_AND_EXACT_GAME_ID_LINKAGE' if passed else 'R1A7_REPAIR',
}
OUT.write_text(json.dumps(closure, indent=2, sort_keys=True) + '\n')
print(json.dumps(closure, indent=2, sort_keys=True))
if not passed:
    raise SystemExit(2)

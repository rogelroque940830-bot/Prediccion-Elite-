#!/usr/bin/env python3
import hashlib
import json
import math
import os
import re
import urllib.request
from pathlib import Path

import pyarrow.parquet as pq

CONTRACT_PATH = Path('research/wnba/WNBA_R1B1_LABEL_LINKAGE_CONTRACT.json')
PROBABILITY_PATH = Path('wnba-r1a6-sports-only-probability-rowset.jsonl')
ASSET_PATH = Path('wnba-r1b1-label-source.parquet')
LABELED_PATH = Path('wnba-r1b1-labeled-rowset.jsonl')
EVIDENCE_PATH = Path('wnba-r1b1-label-linkage-evidence.json')


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def stable(value):
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(str(k), separators=(',', ':')) + ':' + stable(value[k]) for k in sorted(value)) + '}'
    if isinstance(value, list):
        return '[' + ','.join(stable(v) for v in value) + ']'
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def canon_id(value) -> str:
    if value is None or isinstance(value, bool):
        raise ValueError(f'invalid id scalar: {value!r}')
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError(f'non-integer numeric id: {value!r}')
        return str(int(value))
    text = str(value).strip()
    if not text:
        raise ValueError('empty id')
    m = re.fullmatch(r'(\d+)(?:\.0+)?', text)
    if not m:
        raise ValueError(f'non-canonical id text: {text!r}')
    return str(int(m.group(1)))


def bool_strict(value, field: str) -> bool:
    if isinstance(value, bool):
        return value
    # Arrow/pandas scalar compatibility without accepting arbitrary truthy values.
    if value in (0, 1):
        return bool(value)
    text = str(value).strip().lower()
    if text == 'true':
        return True
    if text == 'false':
        return False
    raise ValueError(f'{field} is not strict boolean: {value!r}')


def finite_score(value, field: str) -> float:
    if value is None or isinstance(value, bool):
        raise ValueError(f'{field} missing/non-numeric')
    score = float(value)
    if not math.isfinite(score):
        raise ValueError(f'{field} non-finite')
    return score


def download_exact_asset(url: str, expected_size: int, expected_sha: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'Prediccion-Elite-WNBA-R1B1/1.0',
            'Accept': 'application/octet-stream',
        },
        method='GET',
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
        final_url = resp.geturl()
        status = getattr(resp, 'status', None)
    actual_sha = sha256_bytes(data)
    actual_size = len(data)
    if actual_size != expected_size:
        raise RuntimeError(f'label asset size mismatch: {actual_size} != {expected_size}')
    if actual_sha != expected_sha:
        raise RuntimeError(f'label asset sha256 mismatch: {actual_sha} != {expected_sha}')
    ASSET_PATH.write_bytes(data)
    return {
        'transport_status': status,
        'final_transport_url': final_url,
        'bytes': actual_size,
        'sha256': actual_sha,
        'verified_before_parquet_open': True,
    }


contract = json.loads(CONTRACT_PATH.read_text())
expected_prob_sha = contract['frozen_probability_rowset']['sha256']
expected_prob_rows = int(contract['frozen_probability_rowset']['rows'])
actual_prob_sha = sha256_file(PROBABILITY_PATH)
if actual_prob_sha != expected_prob_sha:
    raise RuntimeError(f'probability rowset sha mismatch: {actual_prob_sha} != {expected_prob_sha}')

prob_rows = [json.loads(line) for line in PROBABILITY_PATH.read_text().splitlines() if line.strip()]
if len(prob_rows) != expected_prob_rows:
    raise RuntimeError(f'probability row count mismatch: {len(prob_rows)} != {expected_prob_rows}')

prob_by_game = {}
prob_duplicate_ids = 0
for row in prob_rows:
    gid = canon_id(row['gameId'])
    if gid in prob_by_game:
        prob_duplicate_ids += 1
    prob_by_game[gid] = row
if prob_duplicate_ids:
    raise RuntimeError(f'duplicate probability game ids: {prob_duplicate_ids}')

asset = contract['label_asset']
asset_custody = download_exact_asset(
    asset['release_download_url'],
    int(asset['asset_size']),
    asset['sha256'],
)
# FIRST OUTCOME OPENING OCCURS ONLY BELOW THIS LINE, after exact-byte SHA verification.
allowed_columns = contract['first_outcome_opening']['allowed_columns_only']
table = pq.read_table(ASSET_PATH, columns=allowed_columns)
source_rows = table.to_pylist()

matched_labels = {}
source_duplicate_matched_ids = 0
source_rows_scanned = len(source_rows)
relevant_source_rows = 0
invalid_id_rows = 0
for src in source_rows:
    try:
        gid = canon_id(src['game_id'])
    except Exception:
        invalid_id_rows += 1
        continue
    if gid not in prob_by_game:
        continue
    relevant_source_rows += 1
    if gid in matched_labels:
        source_duplicate_matched_ids += 1
    else:
        matched_labels[gid] = src

team_identity_mismatches = 0
season_mismatches = 0
winner_consistency_failures = 0
score_consistency_failures = 0
label_validation_errors = []
labeled_rows = []

for prob in prob_rows:
    gid = canon_id(prob['gameId'])
    src = matched_labels.get(gid)
    if src is None:
        continue
    try:
        src_home = canon_id(src['home_id'])
        src_away = canon_id(src['away_id'])
        prob_home = canon_id(prob['homeTeamId'])
        prob_away = canon_id(prob['awayTeamId'])
        if src_home != prob_home or src_away != prob_away:
            team_identity_mismatches += 1
            raise ValueError(f'team identity mismatch {src_home}/{src_away} != {prob_home}/{prob_away}')

        src_season = int(src['season'])
        prob_season = int(prob['season'])
        if src_season != prob_season:
            season_mismatches += 1
            raise ValueError(f'season mismatch {src_season} != {prob_season}')

        home_score = finite_score(src['home_score'], 'home_score')
        away_score = finite_score(src['away_score'], 'away_score')
        home_winner = bool_strict(src['home_winner'], 'home_winner')
        away_winner = bool_strict(src['away_winner'], 'away_winner')

        if home_winner == away_winner:
            winner_consistency_failures += 1
            raise ValueError('winner booleans are not exactly complementary')
        if home_score == away_score:
            score_consistency_failures += 1
            raise ValueError('final scores tied')
        score_home_win = home_score > away_score
        if home_winner != score_home_win or away_winner != (away_score > home_score):
            score_consistency_failures += 1
            raise ValueError('winner boolean disagrees with final score')

        home_outcome = 1 if home_winner else 0
        winner_team_id = src_home if home_winner else src_away
        # Preserve every frozen probability field and append labels only.
        labeled = dict(prob)
        labeled.update({
            'homeOutcome': home_outcome,
            'winnerTeamId': winner_team_id,
            'homeScore': home_score,
            'awayScore': away_score,
            'labelSourceAssetId': int(asset['asset_id']),
            'labelSourceAssetSha256': asset['sha256'],
        })
        labeled_rows.append(labeled)
    except Exception as exc:
        if len(label_validation_errors) < 20:
            label_validation_errors.append({'gameId': gid, 'error': str(exc)})

matched = len(labeled_rows)
unmatched_probability_rows = expected_prob_rows - len(matched_labels)
canonical = ('\n'.join(stable(row) for row in labeled_rows) + ('\n' if labeled_rows else '')).encode('utf-8')
LABELED_PATH.write_bytes(canonical)
labeled_sha = sha256_bytes(canonical)

checks = {
    'probability_rowset_sha_matches': actual_prob_sha == expected_prob_sha,
    'asset_sha_matches_before_read': asset_custody['sha256'] == asset['sha256'] and asset_custody['verified_before_parquet_open'],
    'asset_size_matches': asset_custody['bytes'] == int(asset['asset_size']),
    'probability_rows_match': len(prob_rows) == expected_prob_rows,
    'matched_rows_exact': matched == expected_prob_rows,
    'unmatched_probability_rows_zero': unmatched_probability_rows == 0,
    'duplicate_probability_game_ids_zero': prob_duplicate_ids == 0,
    'duplicate_matched_label_game_ids_zero': source_duplicate_matched_ids == 0,
    'team_identity_mismatches_zero': team_identity_mismatches == 0,
    'season_mismatches_zero': season_mismatches == 0,
    'winner_consistency_failures_zero': winner_consistency_failures == 0,
    'score_consistency_failures_zero': score_consistency_failures == 0,
    'label_validation_errors_zero': len(label_validation_errors) == 0,
}
passed = all(checks.values())

evidence = {
    'name': 'WNBA_R1B1_LABEL_LINKAGE_EVIDENCE_V1',
    'decision': 'R1B1_LABELED_ROWSET_FROZEN_AND_R1B2_METRICS_AUTHORIZED' if passed else 'R1B1_FAIL_CLOSED_NO_METRICS',
    'candidate': contract['candidate'],
    'first_outcome_opening_occurred': True,
    'first_outcome_opening_after_asset_sha_verification': True,
    'metrics_computed': False,
    'thresholds_tuned': False,
    'candidate_switched': False,
    'probability_refit': False,
    'probability_custody': {
        'rows': len(prob_rows),
        'sha256': actual_prob_sha,
        'expected_sha256': expected_prob_sha,
    },
    'label_asset_custody': {
        'asset_id': int(asset['asset_id']),
        'asset_name': asset['asset_name'],
        'expected_bytes': int(asset['asset_size']),
        'expected_sha256': asset['sha256'],
        **asset_custody,
    },
    'source_scan': {
        'rows_scanned_from_allowed_columns': source_rows_scanned,
        'matched_source_rows_seen': relevant_source_rows,
        'invalid_game_id_rows_ignored_outside_or_inside_cohort': invalid_id_rows,
    },
    'linkage': {
        'matched_rows': matched,
        'unmatched_probability_rows': unmatched_probability_rows,
        'duplicate_probability_game_ids': prob_duplicate_ids,
        'duplicate_matched_label_game_ids': source_duplicate_matched_ids,
        'team_identity_mismatches': team_identity_mismatches,
        'season_mismatches': season_mismatches,
        'winner_consistency_failures': winner_consistency_failures,
        'score_consistency_failures': score_consistency_failures,
        'label_validation_errors': label_validation_errors,
    },
    'checks': checks,
    'labeled_rowset': {
        'rows': matched,
        'bytes': len(canonical),
        'sha256': labeled_sha,
        'selected_side_correctness_computed': False,
    },
    'r1b2_metrics_authorized': passed,
    'production_change_authorized': False,
    'global_ranker_promotion_authorized': False,
    'next_gate': 'R1B2_PREREGISTERED_METRICS_ON_FROZEN_LABELED_ROWSET' if passed else 'R1B1_REPAIR_WITHOUT_METRICS',
}
EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + '\n')
print(json.dumps(evidence, indent=2, sort_keys=True))
if not passed:
    raise SystemExit(2)

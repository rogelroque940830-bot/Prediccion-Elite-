#!/usr/bin/env python3
import collections
import hashlib
import json
import math
from pathlib import Path

SPEC_PATH = Path('research/wnba/WNBA_R1B2_METRIC_MECHANICS_SPEC.json')
LABELED_PATH = Path('wnba-r1b1-labeled-rowset.jsonl')
SCORED_PATH = Path('wnba-r1b2-scored-rowset.jsonl')
EVIDENCE_PATH = Path('wnba-r1b2-metrics-evidence.json')


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


def metrics(rows):
    n = len(rows)
    if n == 0:
        raise ValueError('empty metric rowset')
    ps = [float(r['p']) for r in rows]
    ys = [int(r['y']) for r in rows]
    if any((not math.isfinite(p) or not (0.0 < p < 1.0)) for p in ps):
        raise ValueError('probability outside open unit interval')
    if any(y not in (0, 1) for y in ys):
        raise ValueError('non-binary label')
    accuracy = sum(ys) / n
    brier = sum((p-y)**2 for p, y in zip(ps, ys)) / n
    log_loss = -sum(y*math.log(p) + (1-y)*math.log(1-p) for p, y in zip(ps, ys)) / n
    mean_p = sum(ps) / n
    mean_y = accuracy
    bias = mean_p - mean_y
    denom = math.sqrt(sum(p*(1-p) for p in ps))
    cal_z = abs(sum(y-p for p, y in zip(ps, ys))) / denom if denom > 0 else math.inf

    bins = []
    weighted_ece = 0.0
    for idx in range(10):
        lo = idx / 10.0
        hi = (idx + 1) / 10.0
        members = [(p, y) for p, y in zip(ps, ys) if (p >= lo and (p < hi or (idx == 9 and p <= 1.0)))]
        if members:
            bp = sum(p for p, _ in members) / len(members)
            by = sum(y for _, y in members) / len(members)
            gap = abs(bp-by)
            weighted_ece += (len(members)/n)*gap
            bins.append({'index': idx, 'lower': lo, 'upper': hi, 'right_closed': idx == 9, 'n': len(members), 'mean_predicted': bp, 'observed': by, 'abs_gap': gap})
        else:
            bins.append({'index': idx, 'lower': lo, 'upper': hi, 'right_closed': idx == 9, 'n': 0, 'mean_predicted': None, 'observed': None, 'abs_gap': None})
    return {
        'n': n,
        'accuracy': accuracy,
        'brier': brier,
        'log_loss': log_loss,
        'ece10': weighted_ece,
        'calibration_in_the_large_abs_z': cal_z,
        'mean_predicted': mean_p,
        'observed_rate': mean_y,
        'mean_predicted_minus_observed': bias,
        'ece10_bins': bins,
    }


spec = json.loads(SPEC_PATH.read_text())
expected_labeled_sha = spec['labeled_rowset_sha256']
actual_labeled_sha = sha256_file(LABELED_PATH)
if actual_labeled_sha != expected_labeled_sha:
    raise RuntimeError(f'labeled rowset sha mismatch: {actual_labeled_sha} != {expected_labeled_sha}')

labeled = [json.loads(line) for line in LABELED_PATH.read_text().splitlines() if line.strip()]
if len(labeled) != int(spec['labeled_rows']):
    raise RuntimeError(f'labeled row count mismatch: {len(labeled)} != {spec["labeled_rows"]}')

# Compute the frozen walk-forward HOME climatology using prior frozen seasons only.
home_by_season = collections.defaultdict(list)
for row in labeled:
    home_by_season[int(row['season'])].append(int(row['homeOutcome']))
seasons = [2021, 2022, 2023, 2024, 2025]
q_home = {2021: 0.5}
prior_outcomes = []
for season in seasons:
    if season > 2021:
        if not prior_outcomes:
            raise RuntimeError('missing prior-season outcomes for walk-forward climatology')
        q_home[season] = sum(prior_outcomes) / len(prior_outcomes)
    prior_outcomes.extend(home_by_season[season])

metric_rows = []
scored = []
for row in labeled:
    season = int(row['season'])
    selected_team = str(row['selectedTeamId'])
    winner_team = str(row['winnerTeamId'])
    y = 1 if selected_team == winner_team else 0
    p = float(row['p_win_selected_side'])
    if row['selectedSide'] == 'HOME':
        p_base = q_home[season]
    elif row['selectedSide'] == 'AWAY':
        p_base = 1.0 - q_home[season]
    else:
        raise RuntimeError(f'unknown selectedSide {row["selectedSide"]!r}')
    metric_rows.append({'season': season, 'p': p, 'y': y, 'p_baseline': p_base})
    scored_row = dict(row)
    scored_row.update({
        'selectedSideOutcome': y,
        'walkForwardClimatologyHomeProbability': q_home[season],
        'walkForwardClimatologySelectedProbability': p_base,
    })
    scored.append(scored_row)

model_overall = metrics([{'p': r['p'], 'y': r['y']} for r in metric_rows])
baseline_overall = metrics([{'p': r['p_baseline'], 'y': r['y']} for r in metric_rows])
season_report = {}
for season in seasons:
    subset = [r for r in metric_rows if r['season'] == season]
    season_report[str(season)] = {
        'model': metrics([{'p': r['p'], 'y': r['y']} for r in subset]),
        'walk_forward_climatology': metrics([{'p': r['p_baseline'], 'y': r['y']} for r in subset]),
        'walk_forward_home_probability': q_home[season],
    }

limits = spec['frozen_probability_gates']
gates = {
    'calibration_in_the_large_abs_z': {
        'value': model_overall['calibration_in_the_large_abs_z'],
        'limit_max': float(limits['calibration_in_the_large_abs_z_max']),
        'pass': model_overall['calibration_in_the_large_abs_z'] <= float(limits['calibration_in_the_large_abs_z_max']),
    },
    'ece10': {
        'value': model_overall['ece10'],
        'limit_max': float(limits['ece10_max']),
        'pass': model_overall['ece10'] <= float(limits['ece10_max']),
    },
    'abs_mean_predicted_minus_observed': {
        'value': abs(model_overall['mean_predicted_minus_observed']),
        'signed_value': model_overall['mean_predicted_minus_observed'],
        'limit_max': float(limits['abs_mean_predicted_minus_observed_max']),
        'pass': abs(model_overall['mean_predicted_minus_observed']) <= float(limits['abs_mean_predicted_minus_observed_max']),
    },
    'brier_vs_walk_forward_climatology': {
        'model': model_overall['brier'],
        'baseline': baseline_overall['brier'],
        'pass': model_overall['brier'] < baseline_overall['brier'],
    },
    'log_loss_vs_walk_forward_climatology': {
        'model': model_overall['log_loss'],
        'baseline': baseline_overall['log_loss'],
        'pass': model_overall['log_loss'] < baseline_overall['log_loss'],
    },
}
all_gates_pass = all(g['pass'] for g in gates.values())

canonical = ('\n'.join(stable(row) for row in scored) + '\n').encode('utf-8')
SCORED_PATH.write_bytes(canonical)
scored_sha = sha256_bytes(canonical)

evidence = {
    'name': 'WNBA_R1B2_PREREGISTERED_METRICS_EVIDENCE_V1',
    'candidate': spec['candidate'],
    'decision': 'FALLBACK_BASE_PROBABILITY_RESEARCH_QUALIFIED' if all_gates_pass else 'WNBA_BASE_PROBABILITY_REMAINS_BLOCKED_AND_R1_MAY_NOT_RETUNE_AFTER_RESULTS',
    'labeled_rowset_custody': {
        'rows': len(labeled),
        'sha256': actual_labeled_sha,
        'expected_sha256': expected_labeled_sha,
        'match': actual_labeled_sha == expected_labeled_sha,
    },
    'metric_mechanics_spec': str(SPEC_PATH),
    'model_metrics': model_overall,
    'walk_forward_climatology': {
        'home_probability_by_season': {str(k): v for k, v in q_home.items()},
        'overall_metrics_on_selected_side': baseline_overall,
    },
    'season_stability_report_only': season_report,
    'frozen_gates': gates,
    'all_probability_gates_pass': all_gates_pass,
    'accuracy_is_not_an_80_percent_gate': True,
    'threshold_search_performed': False,
    'elite_gate_discovery_performed': False,
    'candidate_switch_performed': False,
    'probability_refit_performed': False,
    'model_refit_performed': False,
    'rows_dropped_after_outcomes': 0,
    'scored_rowset': {
        'rows': len(scored),
        'bytes': len(canonical),
        'sha256': scored_sha,
    },
    'exact_production_sports_only_v1_rehabilitated': False,
    'global_ranker_promotion_authorized': False,
    'production_change_authorized': False,
    'next_gate': 'R1B3_FREEZE_R1B2_RESULT_AND_DEFINE_NEXT_RESEARCH_PHASE' if all_gates_pass else 'R1B3_FREEZE_FAILURE_NO_RETUNE_AND_DEFINE_INDEPENDENT_NEXT_PHASE',
}
EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + '\n')
print(json.dumps(evidence, indent=2, sort_keys=True))

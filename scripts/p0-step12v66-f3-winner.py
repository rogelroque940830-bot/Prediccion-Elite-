#!/usr/bin/env python3
import argparse
import gzip
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.optimize import minimize

EPS = 1e-15
SEASONS = ('2022', '2023', '2024', '2025', '2026_YTD')
EVAL = ('2024', '2025', '2026_YTD')
EXPECTED = {'2022': 2398, '2023': 2399, '2024': 2406, '2025': 2423, '2026_YTD': 1781}
QUALITY = (
    'starter_velocity_adv',
    'starter_spin_adv',
    'starter_swing_miss_adv',
    'starter_in_zone_adv',
    'starter_weak_contact_adv',
)
INTER = tuple(f'{q}_x_f3_mean_starter_share' for q in QUALITY)
CLASS = {'HOME': 0, 'DRAW': 1, 'AWAY': 2}
NAMES = ('HOME', 'DRAW', 'AWAY')


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')


def finite(value):
    try:
        return value is not None and math.isfinite(float(value))
    except Exception:
        return False


def load_custody(path):
    rows = []
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    counts = {s: sum(r.get('season') == s for r in rows) for s in SEASONS}
    if counts != EXPECTED:
        raise SystemExit(f'V66_F3_CUSTODY_ROWS_DRIFT:{counts}')
    if len({(r['season'], int(r['gamePk'])) for r in rows}) != len(rows):
        raise SystemExit('V66_F3_CUSTODY_DUPLICATE_GAME')
    return rows


def attach_f3_outcomes(rows, outcome_path):
    payload = load(outcome_path)
    if payload.get('schemaVersion') != 'courtedge-p0-step12v23-f3-outcomes.v1':
        raise SystemExit('V66_F3_OUTCOME_SCHEMA_INVALID')
    acq = payload.get('acquisition') or {}
    if float(acq.get('coverageShare', 0.0)) < 0.995:
        raise SystemExit('V66_F3_OUTCOME_COVERAGE_BELOW_FROZEN_FLOOR')
    by = {}
    for x in payload.get('rows', []):
        key = (x['season'], int(x['gamePk']))
        if key in by:
            raise SystemExit(f'V66_F3_OUTCOME_DUPLICATE:{key}')
        by[key] = x
    out = []
    misses = []
    identity_errors = []
    for r in rows:
        key = (r['season'], int(r['gamePk']))
        x = by.get(key)
        if x is None:
            misses.append(key)
            continue
        if (
            str(x.get('officialDate')) != str(r.get('officialDate'))
            or int(x.get('homeTeamId')) != int(r.get('homeTeamId'))
            or int(x.get('awayTeamId')) != int(r.get('awayTeamId'))
        ):
            identity_errors.append(key)
            continue
        if x.get('outcome') not in CLASS:
            raise SystemExit(f'V66_F3_OUTCOME_CLASS_INVALID:{key}:{x.get("outcome")}')
        z = dict(r)
        z['_f3ClassName'] = x['outcome']
        z['_f3Class'] = CLASS[x['outcome']]
        out.append(z)
    if identity_errors:
        raise SystemExit(f'V66_F3_OUTCOME_IDENTITY_MISMATCH:{identity_errors[:10]}')
    coverage = len(out) / len(rows) if rows else 0.0
    if coverage < 0.995:
        raise SystemExit(f'V66_F3_JOIN_COVERAGE_BELOW_FROZEN_FLOOR:{coverage}')
    return out, {
        'custodyRows': len(rows),
        'joinedRows': len(out),
        'coverageShare': coverage,
        'unresolvedCustodyKeys': [{'season': s, 'gamePk': g} for s, g in misses],
        'sourceAcquisition': acq,
    }


def prep(train, features):
    medians, means, scales = [], [], []
    for feature in features:
        values = [float(r[feature]) for r in train if finite(r.get(feature))]
        if not values:
            raise SystemExit(f'V66_F3_TRAIN_FEATURE_EMPTY:{feature}')
        median = float(np.median(values))
        a = np.asarray([float(r[feature]) if finite(r.get(feature)) else median for r in train], dtype=float)
        mean = float(a.mean())
        raw_scale = float(a.std())
        scale = 1.0 if (not math.isfinite(raw_scale) or raw_scale < 1e-12) else raw_scale
        medians.append(median)
        means.append(mean)
        scales.append(scale)
    return {
        'features': list(features),
        'medianImpute': medians,
        'mean': means,
        'scale': scales,
        'fitSeason': '2022',
    }


def transform(rows, preprocessor):
    X = np.empty((len(rows), len(preprocessor['features'])), dtype=float)
    for j, (feature, median, mean, scale) in enumerate(zip(
        preprocessor['features'],
        preprocessor['medianImpute'],
        preprocessor['mean'],
        preprocessor['scale'],
    )):
        X[:, j] = [
            ((float(r[feature]) if finite(r.get(feature)) else median) - mean) / scale
            for r in rows
        ]
    return X


def softmax(logits):
    z = np.asarray(logits, dtype=float)
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def unpack(theta, d):
    W = theta[:2 * d].reshape(2, d)
    b = theta[2 * d:2 * d + 2]
    return W, b


def raw_logits(theta, X):
    W, b = unpack(theta, X.shape[1])
    return np.column_stack([b[0] + X @ W[0], b[1] + X @ W[1], np.zeros(len(X))])


def fit_multinomial(X, y, l2=1.0):
    d = X.shape[1]
    def objective(theta):
        W, _ = unpack(theta, d)
        p = softmax(raw_logits(theta, X))
        nll = -float(np.mean(np.log(np.maximum(p[np.arange(len(y)), y], EPS))))
        penalty = 0.5 * float(l2) * float(np.sum(W * W)) / len(y)
        return nll + penalty
    result = minimize(
        objective,
        np.zeros(2 * d + 2, dtype=float),
        method='L-BFGS-B',
        options={'maxiter': 12000, 'ftol': 1e-13, 'gtol': 1e-8},
    )
    if not result.success or not np.all(np.isfinite(result.x)):
        raise SystemExit(f'V66_F3_MULTINOMIAL_FIT_FAILED:{result.message}')
    return result.x


def fit_candidate(rows, features):
    train = [r for r in rows if r['season'] == '2022']
    preprocessor = prep(train, features)
    X = transform(train, preprocessor)
    y = np.asarray([int(r['_f3Class']) for r in train], dtype=int)
    if set(y.tolist()) != {0, 1, 2}:
        raise SystemExit(f'V66_F3_TRAIN_CLASSES_INVALID:{sorted(set(y.tolist()))}')
    theta = fit_multinomial(X, y, l2=1.0)
    W, b = unpack(theta, len(features))
    return {
        'target': 'F3_HOME_DRAW_AWAY',
        'features': list(features),
        'preprocessor': preprocessor,
        'referenceClass': 'AWAY',
        'intercepts': {'HOME': float(b[0]), 'DRAW': float(b[1]), 'AWAY': 0.0},
        'coefficients': {
            'HOME': [float(x) for x in W[0]],
            'DRAW': [float(x) for x in W[1]],
            'AWAY': [0.0 for _ in features],
        },
        'calibration': None,
        'trainingOnlyFit': True,
    }


def predict_candidate(model, rows):
    X = transform(rows, model['preprocessor'])
    home = model['intercepts']['HOME'] + X @ np.asarray(model['coefficients']['HOME'], dtype=float)
    draw = model['intercepts']['DRAW'] + X @ np.asarray(model['coefficients']['DRAW'], dtype=float)
    return softmax(np.column_stack([home, draw, np.zeros(len(X))]))


def training_climatology(rows):
    train = [r for r in rows if r['season'] == '2022']
    y = np.asarray([int(r['_f3Class']) for r in train], dtype=int)
    p = np.asarray([float(np.mean(y == k)) for k in (0, 1, 2)], dtype=float)
    if not np.isclose(p.sum(), 1.0):
        raise SystemExit('V66_F3_CLIMATOLOGY_INVALID')
    return p


def predict_control(probs, rows):
    return np.tile(np.asarray(probs, dtype=float), (len(rows), 1))


def metrics(probs, y):
    p = np.asarray(probs, dtype=float)
    y = np.asarray(y, dtype=int)
    onehot = np.eye(3, dtype=float)[y]
    logloss = -float(np.mean(np.log(np.maximum(p[np.arange(len(y)), y], EPS))))
    brier = float(np.mean((p - onehot) ** 2))
    mean_pred = p.mean(axis=0)
    observed = np.bincount(y, minlength=3) / len(y)
    confidence = p.max(axis=1)
    correct = (p.argmax(axis=1) == y).astype(float)
    ece = 0.0
    for i in range(10):
        lo, hi = i / 10.0, (i + 1) / 10.0
        mask = (confidence >= lo) & ((confidence < hi) if i < 9 else (confidence <= hi))
        n = int(mask.sum())
        if n:
            ece += n / len(y) * abs(float(confidence[mask].mean()) - float(correct[mask].mean()))
    return {
        'n': int(len(y)),
        'logLoss': logloss,
        'brier': brier,
        'ece10': float(ece),
        'absoluteMeanProbabilityGap': float(np.mean(np.abs(mean_pred - observed))),
        'meanPredicted': {NAMES[k]: float(mean_pred[k]) for k in range(3)},
        'observedRate': {NAMES[k]: float(observed[k]) for k in range(3)},
    }


def per_row_losses(probs, y):
    p = np.asarray(probs, dtype=float)
    y = np.asarray(y, dtype=int)
    onehot = np.eye(3, dtype=float)[y]
    ll = -np.log(np.maximum(p[np.arange(len(y)), y], EPS))
    br = np.mean((p - onehot) ** 2, axis=1)
    return ll, br


def delta(control, candidate):
    return {
        'logLossImprovement': float(control['logLoss'] - candidate['logLoss']),
        'brierImprovement': float(control['brier'] - candidate['brier']),
    }


def bootstrap_dates(dates, control_probs, candidate_probs, y, resamples=5000, seed=20260816):
    cll, cbr = per_row_losses(control_probs, y)
    pll, pbr = per_row_losses(candidate_probs, y)
    dll, dbr = cll - pll, cbr - pbr
    groups = defaultdict(list)
    for i, day in enumerate(dates):
        groups[str(day)].append(i)
    keys = sorted(groups)
    agg = []
    for key in keys:
        idx = np.asarray(groups[key], dtype=int)
        agg.append((float(dll[idx].sum()), float(dbr[idx].sum()), len(idx)))
    a = np.asarray(agg, dtype=float)
    rng = np.random.default_rng(seed)
    values = np.empty((resamples, 2), dtype=float)
    K = len(keys)
    for b in range(resamples):
        picked = rng.integers(0, K, size=K)
        x = a[picked]
        n = x[:, 2].sum()
        values[b, 0] = x[:, 0].sum() / n
        values[b, 1] = x[:, 1].sum() / n
    return {
        'unit': 'OFFICIAL_DATE_CLUSTER',
        'distinctDates': K,
        'resamples': resamples,
        'seed': seed,
        'logLossImprovement': {
            'pointEstimate': float(dll.mean()),
            'ci95': [float(np.quantile(values[:, 0], 0.025)), float(np.quantile(values[:, 0], 0.975))],
        },
        'brierImprovement': {
            'pointEstimate': float(dbr.mean()),
            'ci95': [float(np.quantile(values[:, 1], 0.025)), float(np.quantile(values[:, 1], 0.975))],
        },
    }


def feature_sets():
    return {
        'STARTER_QUALITY5_ONLY': list(QUALITY),
        'EXPOSURE_ONLY_F3': ['f3_exposure_adv'],
        'STARTER_QUALITY5_PLUS_EXPOSURE_F3_PLUS_QUALITY_X_EXPOSURE5': list(QUALITY) + ['f3_exposure_adv'] + list(INTER),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--custody', required=True)
    parser.add_argument('--f3-outcomes', required=True)
    parser.add_argument('--v23-report', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--scoring-spec', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    contract = load(args.contract)
    spec = load(args.scoring_spec)
    if contract.get('schemaVersion') != 'courtedge-p0-step12v66-game-horizon-exposure-suite-contract.v1':
        raise SystemExit('V66_F3_PARENT_CONTRACT_INVALID')
    if spec.get('schemaVersion') != 'courtedge-p0-step12v66-f3-winner-scoring-spec.v1':
        raise SystemExit('V66_F3_SCORING_SPEC_INVALID')
    if spec.get('scientificStatus') != 'FROZEN_F3_WINNER_SCORING_SEMANTICS_BEFORE_FIRST_V66_F3_OUTCOME_SCORER':
        raise SystemExit('V66_F3_SCORING_SPEC_NOT_FROZEN')
    if contract['winnerControls']['F3']['formalBaseline'] != 'TRAINING_SEASON_HOME_DRAW_AWAY_CLIMATOLOGY':
        raise SystemExit('V66_F3_CONTROL_DRIFT')
    if contract['bullpenAvailability']['f3BullpenFeaturesAllowed'] is not False:
        raise SystemExit('V66_F3_BULLPEN_BOUNDARY_DRIFT')

    custody = load_custody(args.custody)
    rows, join = attach_f3_outcomes(custody, args.f3_outcomes)
    v23 = load(args.v23_report)
    if v23.get('schemaVersion') != 'courtedge-p0-step12v23-f3-model-suite.v1':
        raise SystemExit('V66_F3_V23_DIAGNOSTIC_REPORT_INVALID')

    climatology = training_climatology(rows)
    sets = feature_sets()
    models = {name: fit_candidate(rows, features) for name, features in sets.items()}
    primary_name = 'STARTER_QUALITY5_PLUS_EXPOSURE_F3_PLUS_QUALITY_X_EXPOSURE5'
    season_results = {}
    cache = {}
    for season in ('2023',) + EVAL:
        rs = [r for r in rows if r['season'] == season]
        y = np.asarray([int(r['_f3Class']) for r in rs], dtype=int)
        control_probs = predict_control(climatology, rs)
        candidates = {}
        for name, model in models.items():
            candidates[name] = metrics(predict_candidate(model, rs), y)
        season_results[season] = {
            'formalControl': metrics(control_probs, y),
            'candidates': candidates,
        }
        cache[season] = (rs, y, control_probs)

    combined_rows = []
    for season in EVAL:
        combined_rows.extend(cache[season][0])
    combined_y = np.asarray([int(r['_f3Class']) for r in combined_rows], dtype=int)
    combined_control_probs = predict_control(climatology, combined_rows)
    combined = {
        'formalControl': metrics(combined_control_probs, combined_y),
        'candidates': {},
    }
    for name, model in models.items():
        combined['candidates'][name] = metrics(predict_candidate(model, combined_rows), combined_y)

    validation_delta = delta(season_results['2023']['formalControl'], season_results['2023']['candidates'][primary_name])
    combined_delta = delta(combined['formalControl'], combined['candidates'][primary_name])
    season_deltas = {
        season: delta(season_results[season]['formalControl'], season_results[season]['candidates'][primary_name])
        for season in EVAL
    }
    primary_probs = predict_candidate(models[primary_name], combined_rows)
    bootstrap = bootstrap_dates(
        [r['officialDate'] for r in combined_rows],
        combined_control_probs,
        primary_probs,
        combined_y,
        resamples=5000,
        seed=20260816,
    )
    improves_both = sum(
        d['logLossImprovement'] > 0 and d['brierImprovement'] > 0
        for d in season_deltas.values()
    )
    any_worse_both = any(
        d['logLossImprovement'] < 0 and d['brierImprovement'] < 0
        for d in season_deltas.values()
    )
    primary_combined_metrics = combined['candidates'][primary_name]
    checks = {
        '2023LogLossImprovementPositive': validation_delta['logLossImprovement'] > 0,
        '2023BrierImprovementPositive': validation_delta['brierImprovement'] > 0,
        'combinedEvaluationLogLossImprovementPositive': combined_delta['logLossImprovement'] > 0,
        'combinedEvaluationBrierImprovementPositive': combined_delta['brierImprovement'] > 0,
        'bootstrapLogLoss95CiLowerBoundPositive': bootstrap['logLossImprovement']['ci95'][0] > 0,
        'bootstrapBrier95CiLowerBoundPositive': bootstrap['brierImprovement']['ci95'][0] > 0,
        'atLeastTwoOfThreeEvaluationSeasonsImproveBoth': improves_both >= 2,
        'noEvaluationSeasonWorseOnBoth': not any_worse_both,
        'combinedEce10Le002': primary_combined_metrics['ece10'] <= 0.02,
    }
    passed = all(checks.values())
    passing = contract['promotionRubric']['routePassingClassifications']['V66_A_F3_WINNER']
    classification = passing if passed else 'V66_A_F3_WINNER_NOT_ROBUST_ENOUGH_TO_ADVANCE'

    diagnostic = {}
    for name in ('STARTER_QUALITY5_ONLY', 'EXPOSURE_ONLY_F3'):
        diagnostic[name] = {
            'validation2023Delta': delta(season_results['2023']['formalControl'], season_results['2023']['candidates'][name]),
            'combinedDelta': delta(combined['formalControl'], combined['candidates'][name]),
        }

    report = {
        'schemaVersion': 'courtedge-p0-step12v66-f3-winner-score.v1',
        'scientificStatus': 'OUTCOME_SCORING_COMPLETED_WITH_PREDECLARED_F3_MODEL_AND_GATES',
        'route': 'V66_A_F3_WINNER',
        'classification': classification,
        'passed': passed,
        'formalControl': {
            'name': 'TRAINING_SEASON_HOME_DRAW_AWAY_CLIMATOLOGY',
            'trainingSeason': '2022',
            'classOrder': list(NAMES),
            'probabilities': {NAMES[k]: float(climatology[k]) for k in range(3)},
        },
        'primaryCandidate': primary_name,
        'candidateFeatureSets': sets,
        'models': models,
        'join': join,
        'evaluationBySeason': season_results,
        'combinedEvaluation': {
            **combined,
            'delta': combined_delta,
        },
        'validation2023Delta': validation_delta,
        'seasonDeltas': season_deltas,
        'pairedBootstrap': bootstrap,
        'promotionChecks': checks,
        'diagnosticAblations': diagnostic,
        'v23Full13DiagnosticReference': {
            'role': 'DIAGNOSTIC_ONLY_NOT_FORMAL_CONTROL',
            'validation2023': v23['moneyline']['validation2023'],
            'evaluation2024_2026Ytd': v23['moneyline']['evaluation2024_2026Ytd'],
            'candidateRubricPassed': v23['moneyline']['candidateRubricPassed'],
        },
        'policy': {
            'researchOnly': True,
            'historicalPricesUsed': False,
            'marketOddsUsedAsFeatures': False,
            'positiveEvEstablished': False,
            'v16ProductionChanged': False,
            'routingChanged': False,
            'rankingChanged': False,
            'stakeChanged': False,
            'betEliteAllowed': False,
            'finalRecommendationChanged': False,
            'automaticBetPlacementAllowed': False,
            'realFinancialExposure': 0,
        },
    }
    dump(args.out, report)
    print(json.dumps({
        'classification': classification,
        'passed': passed,
        'validation2023Delta': validation_delta,
        'combinedDelta': combined_delta,
        'seasonDeltas': season_deltas,
        'bootstrap': bootstrap,
        'combinedEce10': primary_combined_metrics['ece10'],
        'diagnosticAblations': diagnostic,
    }, indent=2))


if __name__ == '__main__':
    main()

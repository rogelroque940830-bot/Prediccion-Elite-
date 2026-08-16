#!/usr/bin/env python3
import argparse
import gzip
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson

SEASONS = ('2022', '2023', '2024', '2025', '2026_YTD')
EVAL = ('2024', '2025', '2026_YTD')
EXPECTED_CUSTODY = {'2022': 2398, '2023': 2399, '2024': 2406, '2025': 2423, '2026_YTD': 1781}


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')


def finite(v):
    try:
        return v is not None and math.isfinite(float(v))
    except Exception:
        return False


def load_custody(path):
    opener = gzip.open if str(path).endswith('.gz') else open
    rows = []
    with opener(path, 'rt', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    counts = {s: sum(r.get('season') == s for r in rows) for s in SEASONS}
    if counts != EXPECTED_CUSTODY:
        raise SystemExit(f'V66_TOTALS_CUSTODY_ROWS_DRIFT:{counts}')
    if len({(r['season'], int(r['gamePk'])) for r in rows}) != len(rows):
        raise SystemExit('V66_TOTALS_CUSTODY_DUPLICATE_GAME')
    return rows


def attach_f5(custody, path):
    payload = load(path)
    if payload.get('schemaVersion') != 'courtedge-p0-step12v28-f5-outcomes.v1':
        raise SystemExit('V66_F5_TOTAL_OUTCOME_SCHEMA_INVALID')
    acq = payload.get('acquisition') or {}
    if float(acq.get('coverageShare', 0.0)) < 0.995:
        raise SystemExit('V66_F5_TOTAL_OUTCOME_COVERAGE_LOW')
    by = {(r['season'], int(r['gamePk'])): r for r in payload.get('rows', [])}
    if len(by) != len(payload.get('rows', [])):
        raise SystemExit('V66_F5_TOTAL_OUTCOME_DUPLICATE')
    rows, misses = [], []
    for r in custody:
        x = by.get((r['season'], int(r['gamePk'])))
        if x is None:
            misses.append((r['season'], int(r['gamePk'])))
            continue
        if (str(x['officialDate']) != str(r['officialDate']) or int(x['homeTeamId']) != int(r['homeTeamId']) or int(x['awayTeamId']) != int(r['awayTeamId'])):
            raise SystemExit(f'V66_F5_TOTAL_OUTCOME_IDENTITY_MISMATCH:{r["gamePk"]}')
        z = dict(r)
        z['_totalRuns'] = int(x['totalRuns'])
        rows.append(z)
    coverage = len(rows) / len(custody)
    if coverage < 0.995:
        raise SystemExit(f'V66_F5_TOTAL_JOIN_COVERAGE_LOW:{coverage}')
    return rows, {
        'custodyRows': len(custody), 'joinedRows': len(rows), 'coverageShare': coverage,
        'unresolvedKeys': [{'season': s, 'gamePk': g} for s, g in misses], 'sourceAcquisition': acq,
    }


def attach_full_game(custody, root):
    maps = {}
    source_counts = {}
    for season in SEASONS:
        p = os.path.join(root, season, 'game-anatomy-feature-table.json')
        payload = load(p)
        if payload.get('schemaVersion') != 'courtedge-p0-step12v-game-anatomy-feature-table.v1':
            raise SystemExit(f'V66_FG_TOTAL_OUTCOME_SCHEMA_INVALID:{season}')
        rows = payload.get('rows', [])
        maps[season] = {int(r['gamePk']): r for r in rows}
        if len(maps[season]) != len(rows):
            raise SystemExit(f'V66_FG_TOTAL_OUTCOME_DUPLICATE:{season}')
        source_counts[season] = len(rows)
    out = []
    for r in custody:
        x = maps[r['season']].get(int(r['gamePk']))
        if x is None:
            raise SystemExit(f'V66_FG_TOTAL_OUTCOME_MISSING:{r["season"]}:{r["gamePk"]}')
        if (str(x['officialDate']) != str(r['officialDate']) or int(x['homeTeamId']) != int(r['homeTeamId']) or int(x['awayTeamId']) != int(r['awayTeamId'])):
            raise SystemExit(f'V66_FG_TOTAL_OUTCOME_IDENTITY_MISMATCH:{r["gamePk"]}')
        o = (x.get('outcomes') or {}).get('FULL_GAME')
        if not o or not isinstance(o.get('totalRuns'), int) or o['totalRuns'] < 0:
            raise SystemExit(f'V66_FG_TOTAL_OUTCOME_INVALID:{r["gamePk"]}')
        if int(o['homeRuns']) + int(o['awayRuns']) != int(o['totalRuns']):
            raise SystemExit(f'V66_FG_TOTAL_ARITHMETIC_INVALID:{r["gamePk"]}')
        z = dict(r)
        z['_totalRuns'] = int(o['totalRuns'])
        out.append(z)
    return out, {'custodyRows': len(custody), 'joinedRows': len(out), 'coverageShare': len(out) / len(custody), 'sourceRowsBySeason': source_counts}


def fit_preprocessor(train, features):
    medians, means, scales = [], [], []
    for feature in features:
        values = [float(r[feature]) for r in train if finite(r.get(feature))]
        if not values:
            raise SystemExit(f'V66_TOTAL_TRAIN_FEATURE_EMPTY:{feature}')
        median = float(np.median(values))
        a = np.asarray([float(r[feature]) if finite(r.get(feature)) else median for r in train], dtype=float)
        mean = float(a.mean())
        raw_scale = float(a.std())
        scale = 1.0 if raw_scale < 1e-12 or not math.isfinite(raw_scale) else raw_scale
        medians.append(median); means.append(mean); scales.append(scale)
    return {'features': list(features), 'medianImpute': medians, 'mean': means, 'scale': scales, 'fitSeason': '2022'}


def transform(rows, p):
    X = np.empty((len(rows), len(p['features'])), dtype=float)
    for j, (feature, median, mean, scale) in enumerate(zip(p['features'], p['medianImpute'], p['mean'], p['scale'])):
        X[:, j] = [((float(r[feature]) if finite(r.get(feature)) else median) - mean) / scale for r in rows]
    return X


def fit_poisson(rows, features, alpha=1.0):
    train = [r for r in rows if r['season'] == '2022']
    p = fit_preprocessor(train, features)
    X = transform(train, p)
    y = np.asarray([float(r['_totalRuns']) for r in train], dtype=float)

    def value_grad(theta):
        intercept, coef = float(theta[0]), theta[1:]
        eta = intercept + X @ coef
        if not np.all(np.isfinite(eta)) or float(np.max(eta)) > 50.0:
            return 1e100, np.zeros_like(theta)
        mu = np.exp(eta)
        value = float(np.mean(mu - y * eta) + 0.5 * alpha * np.sum(coef * coef))
        residual = mu - y
        grad = np.concatenate([[float(np.mean(residual))], X.T @ residual / len(y) + alpha * coef])
        return value, grad

    initial = np.concatenate([[math.log(max(float(np.mean(y)), 1e-9))], np.zeros(len(features), dtype=float)])
    result = minimize(lambda t: value_grad(t)[0], initial, jac=lambda t: value_grad(t)[1], method='L-BFGS-B', options={'maxiter': 12000, 'ftol': 1e-13, 'gtol': 1e-9})
    if not result.success or not np.all(np.isfinite(result.x)):
        raise SystemExit(f'V66_TOTAL_POISSON_FIT_FAILED:{result.message}')
    return {
        'features': list(features), 'preprocessor': p, 'intercept': float(result.x[0]),
        'coefficients': [float(x) for x in result.x[1:]], 'alpha': float(alpha),
        'trainingRows': len(train), 'trainingMeanRuns': float(np.mean(y)), 'solverSuccess': True,
        'solverIterations': int(result.nit), 'trainingOnlyFit': True,
    }


def predict(model, rows):
    X = transform(rows, model['preprocessor'])
    eta = model['intercept'] + X @ np.asarray(model['coefficients'], dtype=float)
    mu = np.exp(eta)
    if not np.all(np.isfinite(mu)) or np.any(mu <= 0):
        raise SystemExit('V66_TOTAL_INVALID_PREDICTED_MEAN')
    return mu


def poisson_deviance_loss(y, mu):
    y = np.asarray(y, dtype=float); mu = np.maximum(np.asarray(mu, dtype=float), 1e-12)
    term = np.zeros_like(y)
    mask = y > 0
    term[mask] = y[mask] * np.log(y[mask] / mu[mask])
    return 2.0 * (term - (y - mu))


def line_brier_loss(y, mu, lines):
    y = np.asarray(y, dtype=float); mu = np.asarray(mu, dtype=float)
    losses = []
    for line in lines:
        observed = (y > line).astype(float)
        probability = poisson.sf(math.floor(float(line)), mu)
        losses.append((probability - observed) ** 2)
    return np.mean(np.vstack(losses), axis=0)


def baseline_line_brier_loss(y, line_probs, lines):
    y = np.asarray(y, dtype=float)
    losses = []
    for line in lines:
        observed = (y > line).astype(float)
        losses.append((float(line_probs[str(line)]) - observed) ** 2)
    return np.mean(np.vstack(losses), axis=0)


def evaluate(rows, model, baseline_mean, line_probs, lines):
    y = np.asarray([float(r['_totalRuns']) for r in rows], dtype=float)
    mu = predict(model, rows)
    base_mu = np.full(len(y), baseline_mean, dtype=float)
    cand_dev = poisson_deviance_loss(y, mu)
    base_dev = poisson_deviance_loss(y, base_mu)
    cand_brier = line_brier_loss(y, mu, lines)
    base_brier = baseline_line_brier_loss(y, line_probs, lines)
    line_rows = {}
    for line in lines:
        observed = (y > line).astype(float)
        probability = poisson.sf(math.floor(float(line)), mu)
        baseline_probability = float(line_probs[str(line)])
        line_rows[str(line)] = {
            'observedOverRate': float(np.mean(observed)), 'meanCandidateOverProbability': float(np.mean(probability)),
            'trainingClimatologyOverProbability': baseline_probability,
            'candidateBrier': float(np.mean((probability - observed) ** 2)),
            'baselineBrier': float(np.mean((baseline_probability - observed) ** 2)),
        }
    return {
        'n': len(rows), 'observedMeanRuns': float(np.mean(y)), 'meanPredictedRuns': float(np.mean(mu)),
        'trainingConstantMeanRuns': float(baseline_mean),
        'absoluteMeanRunBias': abs(float(np.mean(mu)) - float(np.mean(y))),
        'baselineAbsoluteMeanRunBias': abs(float(baseline_mean) - float(np.mean(y))),
        'meanPoissonDeviance': float(np.mean(cand_dev)), 'baselineMeanPoissonDeviance': float(np.mean(base_dev)),
        'poissonDevianceImprovement': float(np.mean(base_dev - cand_dev)),
        'averageFixedLineBrier': float(np.mean(cand_brier)), 'baselineAverageFixedLineBrier': float(np.mean(base_brier)),
        'averageFixedLineBrierImprovement': float(np.mean(base_brier - cand_brier)), 'fixedLineDiagnostics': line_rows,
    }


def bootstrap(rows, model, baseline_mean, line_probs, lines, resamples=5000, seed=20260816):
    y = np.asarray([float(r['_totalRuns']) for r in rows], dtype=float)
    mu = predict(model, rows)
    base_mu = np.full(len(y), baseline_mean, dtype=float)
    dev_delta = poisson_deviance_loss(y, base_mu) - poisson_deviance_loss(y, mu)
    brier_delta = baseline_line_brier_loss(y, line_probs, lines) - line_brier_loss(y, mu, lines)
    groups = defaultdict(list)
    for i, r in enumerate(rows): groups[str(r['officialDate'])].append(i)
    keys = sorted(groups)
    agg = []
    for key in keys:
        idx = np.asarray(groups[key], dtype=int)
        agg.append((float(dev_delta[idx].sum()), float(brier_delta[idx].sum()), len(idx)))
    a = np.asarray(agg, dtype=float)
    rng = np.random.default_rng(seed)
    boot = np.empty((resamples, 2), dtype=float)
    for b in range(resamples):
        picked = rng.integers(0, len(keys), size=len(keys))
        x = a[picked]; n = float(x[:, 2].sum())
        boot[b, 0] = x[:, 0].sum() / n; boot[b, 1] = x[:, 1].sum() / n
    return {
        'unit': 'OFFICIAL_DATE_CLUSTER', 'distinctDates': len(keys), 'resamples': resamples, 'seed': seed,
        'poissonDevianceImprovement': {'pointEstimate': float(np.mean(dev_delta)), 'ci95': [float(np.quantile(boot[:,0], .025)), float(np.quantile(boot[:,0], .975))]},
        'averageFixedLineBrierImprovement': {'pointEstimate': float(np.mean(brier_delta)), 'ci95': [float(np.quantile(boot[:,1], .025)), float(np.quantile(boot[:,1], .975))]},
    }


def score_route(name, rows, spec, contract, diagnostic=None):
    cfg = spec['primaryCandidate']; features = cfg['featuresExactly']; lines = [float(x) for x in spec['formalBaseline']['fixedHalfRunLinesExactly']]
    train = [r for r in rows if r['season'] == '2022']
    y_train = np.asarray([float(r['_totalRuns']) for r in train], dtype=float)
    baseline_mean = float(np.mean(y_train))
    line_probs = {str(line): float(np.mean(y_train > line)) for line in lines}
    model = fit_poisson(rows, features, alpha=float(cfg['alpha']))
    by_season = {s: evaluate([r for r in rows if r['season'] == s], model, baseline_mean, line_probs, lines) for s in ('2023',) + EVAL}
    combined_rows = [r for r in rows if r['season'] in EVAL]
    combined = evaluate(combined_rows, model, baseline_mean, line_probs, lines)
    boot = bootstrap(combined_rows, model, baseline_mean, line_probs, lines, resamples=5000, seed=20260816)
    improve_both = sum(by_season[s]['poissonDevianceImprovement'] > 0 and by_season[s]['averageFixedLineBrierImprovement'] > 0 for s in EVAL)
    worse_both = any(by_season[s]['poissonDevianceImprovement'] < 0 and by_season[s]['averageFixedLineBrierImprovement'] < 0 for s in EVAL)
    checks = {
        '2023PoissonDevianceImprovementPositive': by_season['2023']['poissonDevianceImprovement'] > 0,
        '2023AverageFixedLineBrierImprovementPositive': by_season['2023']['averageFixedLineBrierImprovement'] > 0,
        'combinedEvaluationPoissonDevianceImprovementPositive': combined['poissonDevianceImprovement'] > 0,
        'combinedEvaluationAverageFixedLineBrierImprovementPositive': combined['averageFixedLineBrierImprovement'] > 0,
        'bootstrapPoissonDeviance95CiLowerBoundPositive': boot['poissonDevianceImprovement']['ci95'][0] > 0,
        'bootstrapAverageFixedLineBrier95CiLowerBoundPositive': boot['averageFixedLineBrierImprovement']['ci95'][0] > 0,
        'atLeastTwoOfThreeEvaluationSeasonsImproveBoth': improve_both >= 2,
        'noEvaluationSeasonWorseOnBoth': not worse_both,
        'combinedAbsoluteMeanRunBiasNotWorseThanFormalBaseline': combined['absoluteMeanRunBias'] <= combined['baselineAbsoluteMeanRunBias'],
    }
    passed = all(checks.values())
    passing = contract['promotionRubric']['routePassingClassifications'][name]
    classification = passing if passed else f'{name}_NOT_ROBUST_ENOUGH_TO_ADVANCE'
    return {
        'route': name, 'classification': classification, 'passed': passed,
        'formalBaseline': {'trainingSeason': '2022', 'meanRuns': baseline_mean, 'fixedHalfRunLines': lines, 'lineOverProbabilities': line_probs},
        'primaryCandidate': {'name': 'FROZEN_MECHANISTIC_POISSON_PRIMARY', 'model': model},
        'bySeason': by_season, 'combinedEvaluation': combined, 'pairedBootstrap': boot, 'promotionChecks': checks,
        'diagnosticReference': diagnostic,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--custody', required=True); p.add_argument('--f5-outcomes', required=True); p.add_argument('--fullgame-root', required=True)
    p.add_argument('--v30-report', required=True); p.add_argument('--contract', required=True); p.add_argument('--f5-spec', required=True); p.add_argument('--fg-spec', required=True); p.add_argument('--out', required=True)
    a = p.parse_args()
    contract = load(a.contract); f5spec = load(a.f5_spec); fgspec = load(a.fg_spec)
    if contract.get('scientificStatus') != 'FROZEN_BEFORE_ANY_V66_OUTCOME_SCORER_EXISTS': raise SystemExit('V66_TOTALS_PARENT_NOT_FROZEN')
    if f5spec.get('scientificStatus') != 'FROZEN_F5_TOTAL_SCORING_SEMANTICS_BEFORE_FIRST_V66_F5_TOTAL_OUTCOME_SCORER': raise SystemExit('V66_F5_TOTAL_SPEC_NOT_FROZEN')
    if fgspec.get('scientificStatus') != 'FROZEN_FULL_GAME_TOTAL_SCORING_SEMANTICS_BEFORE_FIRST_V66_FULL_GAME_TOTAL_OUTCOME_SCORER': raise SystemExit('V66_FG_TOTAL_SPEC_NOT_FROZEN')
    if contract['totalMechanisticFeatures']['F5Exactly'] != f5spec['primaryCandidate']['featuresExactly']: raise SystemExit('V66_F5_TOTAL_FEATURE_DRIFT')
    if contract['totalMechanisticFeatures']['FULL_GAMEExactly'] != fgspec['primaryCandidate']['featuresExactly']: raise SystemExit('V66_FG_TOTAL_FEATURE_DRIFT')
    custody = load_custody(a.custody)
    f5rows, f5join = attach_f5(custody, a.f5_outcomes)
    fgrows, fgjoin = attach_full_game(custody, a.fullgame_root)
    if fgjoin['coverageShare'] != 1.0: raise SystemExit('V66_FG_TOTAL_JOIN_NOT_EXACT')
    v30 = load(a.v30_report)
    if v30.get('schemaVersion') != 'courtedge-p0-step12v30-f5-total-no-retune-robustness.v1': raise SystemExit('V66_F5_TOTAL_V30_DIAGNOSTIC_INVALID')
    f5diag = {'classification': v30['classification'], 'robustnessGatePassed': v30['robustnessGatePassed'], 'role': 'DIAGNOSTIC_ONLY_NOT_CONTROL'}
    fgdiag = {'source': 'FROZEN_STEP12V_WINNER_ANATOMY_BINARY_TOTAL_GRID', 'exactTargetParityAvailable': True, 'fixedHalfRunLines': [6.5,7.5,8.5,9.5,10.5], 'role': 'DIAGNOSTIC_ONLY_NOT_CONTROL'}
    routes = {
        'V66_D_F5_TOTAL': score_route('V66_D_F5_TOTAL', f5rows, f5spec, contract, f5diag),
        'V66_E_FULL_GAME_TOTAL': score_route('V66_E_FULL_GAME_TOTAL', fgrows, fgspec, contract, fgdiag),
    }
    report = {
        'schemaVersion': 'courtedge-p0-step12v66-totals-score.v1', 'scientificStatus': 'OUTCOME_SCORING_COMPLETED_WITH_PREDECLARED_TOTAL_MODELS_AND_GATES',
        'joins': {'F5': f5join, 'FULL_GAME': fgjoin}, 'routes': routes,
        'crossHorizonDiagnostic': {
            'name': 'F5_TO_FULL_GAME_TOTAL_SIGNAL_RETENTION',
            'f5CombinedDevianceImprovement': routes['V66_D_F5_TOTAL']['combinedEvaluation']['poissonDevianceImprovement'],
            'f5CombinedBrierImprovement': routes['V66_D_F5_TOTAL']['combinedEvaluation']['averageFixedLineBrierImprovement'],
            'fullGameCombinedDevianceImprovement': routes['V66_E_FULL_GAME_TOTAL']['combinedEvaluation']['poissonDevianceImprovement'],
            'fullGameCombinedBrierImprovement': routes['V66_E_FULL_GAME_TOTAL']['combinedEvaluation']['averageFixedLineBrierImprovement'],
            'descriptiveOnly': True,
        },
        'policy': {'researchOnly': True, 'historicalPricesUsed': False, 'marketOddsUsedAsFeatures': False, 'positiveEvEstablished': False, 'v16ProductionChanged': False, 'routingChanged': False, 'rankingChanged': False, 'stakeChanged': False, 'betEliteAllowed': False, 'finalRecommendationChanged': False, 'automaticBetPlacementAllowed': False, 'realFinancialExposure': 0},
    }
    dump(a.out, report)
    print(json.dumps({k: {'classification': v['classification'], 'passed': v['passed'], 'validation2023': {'poissonDevianceImprovement': v['bySeason']['2023']['poissonDevianceImprovement'], 'averageFixedLineBrierImprovement': v['bySeason']['2023']['averageFixedLineBrierImprovement']}, 'combinedEvaluation': {'poissonDevianceImprovement': v['combinedEvaluation']['poissonDevianceImprovement'], 'averageFixedLineBrierImprovement': v['combinedEvaluation']['averageFixedLineBrierImprovement'], 'absoluteMeanRunBias': v['combinedEvaluation']['absoluteMeanRunBias'], 'baselineAbsoluteMeanRunBias': v['combinedEvaluation']['baselineAbsoluteMeanRunBias']}, 'bootstrap': v['pairedBootstrap'], 'promotionChecks': v['promotionChecks']} for k,v in routes.items()}, indent=2))


if __name__ == '__main__': main()

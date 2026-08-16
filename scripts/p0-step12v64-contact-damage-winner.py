#!/usr/bin/env python3
import argparse
import importlib.util
import json
import os
import numpy as np

REPORT_SCHEMA = 'courtedge-p0-step12v64-contact-damage-winner.v1'
CONTRACT_SCHEMA = 'courtedge-p0-step12v64-contact-damage-winner-contract.v1'
V62_REPORT_SCHEMA = 'courtedge-p0-step12v62-pitch-quality-winner.v1'


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def dump(path, value):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def finite(v):
    try:
        return v is not None and np.isfinite(float(v))
    except Exception:
        return False


def add_broad_features(rows, contract):
    pairs = [
        ('lineup_expected_hits_diff', 'lineup_platoon_hits_adjustment_diff', 'lineup_vs_hand_expected_hits_diff'),
        ('lineup_expected_total_bases_diff', 'lineup_platoon_total_bases_adjustment_diff', 'lineup_vs_hand_expected_total_bases_diff'),
        ('lineup_expected_walks_diff', 'lineup_platoon_walks_adjustment_diff', 'lineup_vs_hand_expected_walks_diff'),
        ('lineup_expected_strikeouts_diff', 'lineup_platoon_strikeouts_adjustment_diff', 'lineup_vs_hand_expected_strikeouts_diff'),
        ('lineup_expected_home_runs_diff', 'lineup_platoon_home_runs_adjustment_diff', 'lineup_vs_hand_expected_home_runs_diff'),
    ]
    expected = list(contract['broadBatterEngineering']['featuresExactly'])
    if [x[2] for x in pairs] != expected:
        raise SystemExit('V64_BROAD_FEATURE_CONTRACT_DRIFT')
    for season_rows in rows.values():
        for r in season_rows:
            for generic, adjustment, out in pairs:
                if finite(r.get(generic)) and finite(r.get(adjustment)):
                    r[out] = float(r[generic]) + float(r[adjustment])
                else:
                    r[out] = None
    return rows


def metric_improvement(control, challenger):
    return {
        'logLoss': float(control['logLoss']) - float(challenger['logLoss']),
        'brier': float(control['brier']) - float(challenger['brier']),
        'ece10': float(control['ece10']) - float(challenger['ece10']),
        'absoluteMeanHomeProbabilityGap': float(control['absoluteMeanHomeProbabilityGap']) - float(challenger['absoluteMeanHomeProbabilityGap']),
        'accuracyAtHalf': float(challenger['accuracyAtHalf']) - float(control['accuracyAtHalf']),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--control-root', required=True)
    ap.add_argument('--lineup-root', required=True)
    ap.add_argument('--batter-root', required=True)
    ap.add_argument('--hands-root', required=True)
    ap.add_argument('--pitch-root', required=True)
    ap.add_argument('--v16-report', required=True)
    ap.add_argument('--v16-manifest', required=True)
    ap.add_argument('--v62-report', required=True)
    ap.add_argument('--contract', required=True)
    ap.add_argument('--out', required=True)
    x = ap.parse_args()

    c = load(x.contract)
    if c.get('schemaVersion') != CONTRACT_SCHEMA or c.get('contractRevision') != 2:
        raise SystemExit('V64_CONTRACT_INVALID')
    if c.get('scientificStatus') != 'FROZEN_BROAD_CONTACT_DAMAGE_PLUS_STARTER_QUALITY_WINNER_HYPOTHESIS_BEFORE_V64_OUTCOME_SCORER':
        raise SystemExit('V64_CONTRACT_STATUS_INVALID')

    v60 = module('scripts/p0-step12v60-individual-lineup-platoon-winner.py', 'v60_v64')
    v61 = module('scripts/p0-step12v61-individual-pitchmix-winner.py', 'v61_v64')
    v62 = module('scripts/p0-step12v62-pitch-quality-winner.py', 'v62_v64')
    v60c = load('research/p0-step12v60-individual-lineup-platoon-winner-contract.json')
    v62c = load('research/p0-step12v62-pitch-quality-winner-contract.json')
    vr = load(x.v16_report)
    vm = load(x.v16_manifest)
    v62r = load(x.v62_report)

    if vr.get('classification') != c['parentEvidence']['v16RequiredClassification']:
        raise SystemExit('V64_V16_CLASSIFICATION_INVALID')
    if v60.digest(vm) != c['parentEvidence']['v16ManifestSha256']:
        raise SystemExit('V64_V16_MANIFEST_DIGEST_INVALID')
    if v62r.get('schemaVersion') != V62_REPORT_SCHEMA or v62r.get('target') != 'FULL_GAME_HOME_WIN':
        raise SystemExit('V64_V62_REPORT_INVALID')

    ctl = vm['fullGame']
    base = list(c['control']['featuresExactly'])
    if ctl.get('featureSet') != c['control']['featureSetRequired'] or ctl['preprocessor']['features'] != base:
        raise SystemExit('V64_CONTROL_FEATURE_DRIFT')

    seasons = [
        c['dataBoundary']['trainingSeason'],
        c['dataBoundary']['calibrationSeason'],
        *c['dataBoundary']['retrospectiveEvaluationSeasons'],
    ]
    rows = {}
    v60custody = {}
    for s in seasons:
        rows[s], v60custody[s] = v60.build_rows(
            x.control_root, x.lineup_root, x.batter_root, x.hands_root, s, v60c
        )
        exp = int(c['dataBoundary']['expectedRowsBySeason'][s])
        if len(rows[s]) != exp:
            raise SystemExit(f'V64_ROW_COUNT_DRIFT:{s}:{len(rows[s])}:{exp}')

    rows = add_broad_features(rows, c)
    rows, v62custody = v62.build_features(
        v60, v61, rows, x.lineup_root, x.batter_root, x.hands_root,
        x.pitch_root, seasons, v62c
    )

    gate = c['coverageGate']
    coverage = True
    for s in seasons:
        coverage = coverage and float(v60custody[s]['pregameStarterHandUsableShare']) >= float(gate['minimumPregameStarterHandPairShareEachSeason'])
        coverage = coverage and float(v62custody[s]['pregameStarterIdentityPairUsableShare']) >= float(gate['minimumPregameStarterIdentityPairShareEachSeason'])
        if s in c['dataBoundary']['retrospectiveEvaluationSeasons']:
            coverage = coverage and float(v62custody[s]['fullFeatureDerivedShare']) >= float(gate['minimumV62PitchTelemetryFullFeatureDerivedShareEachEvaluationSeason'])

    tol = float(c['control']['metricParityAbsoluteTolerance'])
    evs = list(c['dataBoundary']['retrospectiveEvaluationSeasons'])
    for s in evs:
        y = np.asarray([r['homeWin'] for r in rows[s]], float)
        cm = v60.metrics(v60.predict(ctl, rows[s]), y)
        expected = vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss', 'brier', 'ece10', 'meanPredictedHome', 'observedHomeRate', 'accuracyAtHalf'):
            v60.close(f'V64_V16:{s}:{k}', cm[k], expected[k], tol)

    eval_rows = [r for s in evs for r in rows[s]]
    y_eval = np.asarray([r['homeWin'] for r in eval_rows], float)
    control_pred = v60.predict(ctl, eval_rows)
    control_combined = v60.metrics(control_pred, y_eval)
    expected_combined = vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss', 'brier', 'ece10', 'meanPredictedHome', 'observedHomeRate', 'accuracyAtHalf'):
        v60.close(f'V64_V16:combined:{k}', control_combined[k], expected_combined[k], tol)

    broad = list(c['broadBatterEngineering']['featuresExactly'])
    quality = list(c['starterQualityEngineering']['featuresExactly'])
    broad_only_fs = tuple(base + broad)
    quality_only_fs = tuple(base + quality)
    full_fs = tuple(base + broad + quality)
    if len(full_fs) != int(c['challenger']['featureCount']) or len(set(full_fs)) != len(full_fs):
        raise SystemExit('V64_CHALLENGER_FEATURE_COUNT_INVALID')

    tr = rows[c['dataBoundary']['trainingSeason']]
    ca = rows[c['dataBoundary']['calibrationSeason']]
    l2 = float(c['challenger']['l2Strength'])
    broad_model = v60.fit_model(tr, ca, broad_only_fs, l2, c['predeclaredDiagnostics']['broadBatterOnly'])
    quality_model = v60.fit_model(tr, ca, quality_only_fs, l2, c['predeclaredDiagnostics']['starterQualityOnly'])
    full_model = v60.fit_model(tr, ca, full_fs, l2, c['challenger']['featureSet'])

    y_cal = np.asarray([r['homeWin'] for r in ca], float)
    val_control = v60.metrics(v60.predict(ctl, ca), y_cal)
    val_broad = v60.metrics(v60.predict(broad_model, ca), y_cal)
    val_quality = v60.metrics(v60.predict(quality_model, ca), y_cal)
    val_full = v60.metrics(v60.predict(full_model, ca), y_cal)
    validation = {
        'rows': len(ca),
        'control': val_control,
        'broadBatterOnly': val_broad,
        'starterQualityOnly': val_quality,
        'challenger': val_full,
        'challengerImprovementVsControl': metric_improvement(val_control, val_full),
    }

    by_season = {}
    for s in evs:
        ys = np.asarray([r['homeWin'] for r in rows[s]], float)
        cp = v60.predict(ctl, rows[s])
        bp = v60.predict(broad_model, rows[s])
        qp = v60.predict(quality_model, rows[s])
        fp = v60.predict(full_model, rows[s])
        cm = v60.metrics(cp, ys)
        bm = v60.metrics(bp, ys)
        qm = v60.metrics(qp, ys)
        fm = v60.metrics(fp, ys)
        by_season[s] = {
            'rows': len(rows[s]),
            'control': cm,
            'broadBatterOnly': bm,
            'starterQualityOnly': qm,
            'challenger': fm,
            'challengerImprovementVsControl': metric_improvement(cm, fm),
        }

    broad_pred = v60.predict(broad_model, eval_rows)
    quality_pred = v60.predict(quality_model, eval_rows)
    full_pred = v60.predict(full_model, eval_rows)
    broad_combined = v60.metrics(broad_pred, y_eval)
    quality_combined = v60.metrics(quality_pred, y_eval)
    full_combined = v60.metrics(full_pred, y_eval)
    combined = {
        'rows': len(eval_rows),
        'control': control_combined,
        'broadBatterOnly': broad_combined,
        'starterQualityOnly': quality_combined,
        'challenger': full_combined,
        'broadBatterOnlyImprovementVsControl': metric_improvement(control_combined, broad_combined),
        'starterQualityOnlyImprovementVsControl': metric_improvement(control_combined, quality_combined),
        'challengerImprovementVsControl': metric_improvement(control_combined, full_combined),
    }

    bcfg = c['pairedBootstrap']
    boot = v60.bootstrap(
        eval_rows, control_pred, full_pred, y_eval,
        int(bcfg['resamples']), int(bcfg['seed']), float(bcfg['confidenceLevel'])
    )

    v62_combined = v62r['combinedEvaluation2024_2026Ytd']['challenger']
    vs_v62 = metric_improvement(v62_combined, full_combined)

    imp = combined['challengerImprovementVsControl']
    val_imp = validation['challengerImprovementVsControl']
    both = [
        by_season[s]['challengerImprovementVsControl']['logLoss'] > 0 and
        by_season[s]['challengerImprovementVsControl']['brier'] > 0
        for s in evs
    ]
    worse = [
        by_season[s]['challengerImprovementVsControl']['logLoss'] < 0 and
        by_season[s]['challengerImprovementVsControl']['brier'] < 0
        for s in evs
    ]
    rub = c['candidateRubric']
    checks = {
        'controlManifestAndMetricParity': True,
        'validation2023LogLossImproved': val_imp['logLoss'] > 0,
        'validation2023BrierImproved': val_imp['brier'] > 0,
        'combinedLogLossImproved': imp['logLoss'] > 0,
        'combinedBrierImproved': imp['brier'] > 0,
        'bootstrapLogLossLowerBoundPositive': boot['logLossImprovement']['lower'] > 0,
        'bootstrapBrierLowerBoundPositive': boot['brierImprovement']['lower'] > 0,
        'atLeastTwoOfThreeEvaluationSeasonsImproveBoth': sum(both) >= 2,
        'noEvaluationSeasonWorseOnBoth': not any(worse),
        'challengerCombinedEce10WithinAbsoluteMax': full_combined['ece10'] <= float(rub['ece10AbsoluteMaximum']),
        'challengerAbsoluteMeanProbabilityGapNotWorseThanControl': full_combined['absoluteMeanHomeProbabilityGap'] <= control_combined['absoluteMeanHomeProbabilityGap'] + float(rub['meanProbabilityGapComparisonTolerance']),
    }
    passed = coverage and all(checks.values())
    if passed:
        classification = rub['passingClassification']
    elif coverage:
        classification = rub['failingClassification']
    else:
        classification = c['coverageGate']['belowGateClassification']

    report = {
        'schemaVersion': REPORT_SCHEMA,
        'classification': classification,
        'candidateRubricPassed': bool(passed),
        'coverageGatePassed': bool(coverage),
        'scientificStatus': c['scientificStatus'],
        'target': 'FULL_GAME_HOME_WIN',
        'data': {
            'seasonRows': {s: len(rows[s]) for s in seasons},
            'trainingSeason': c['dataBoundary']['trainingSeason'],
            'calibrationSeason': c['dataBoundary']['calibrationSeason'],
            'evaluationSeasons': evs,
            'v60HandCustody': v60custody,
            'v62StarterQualityCustody': v62custody,
        },
        'controlParity': {
            'modelVersion': vm['modelVersion'],
            'manifestSha256': v60.digest(vm),
            'featureSet': ctl['featureSet'],
            'features': ctl['preprocessor']['features'],
            'combinedAndBySeasonMetricsReproduced': True,
        },
        'features': {
            'controlCount': len(base),
            'broadVsHandContactDamageCount': len(broad),
            'starterQualityCount': len(quality),
            'challengerCount': len(full_fs),
            'challengerFeatures': list(full_fs),
        },
        'models': {
            'broadBatterOnly': broad_model,
            'starterQualityOnly': quality_model,
            'challenger': full_model,
        },
        'validation2023': validation,
        'evaluationBySeason': by_season,
        'combinedEvaluation2024_2026Ytd': combined,
        'pairedDateBootstrapVsControl2024_2026Ytd': boot,
        'candidateRubricChecks': checks,
        'diagnostics': {
            'frozenV62IsDiagnosticOnlyNotPromotionControl': True,
            'v62FrozenClassification': v62r['classification'],
            'v62Combined': v62_combined,
            'improvementVsFrozenV62Combined': vs_v62,
            'beatsFrozenV62CombinedLogLoss': vs_v62['logLoss'] > 0,
            'beatsFrozenV62CombinedBrier': vs_v62['brier'] > 0,
            'diagnosticResultsMayNotChoosePromotionCandidate': True,
        },
        'policy': {
            'researchOnly': True,
            'sameDateOutcomeLeakageAllowed': False,
            'futureGameDataAllowed': False,
            'historicalPricesUsed': False,
            'marketOddsUsedAsFeatures': False,
            'featureSearchUsed': False,
            'modelSearchUsed': False,
            'hyperparameterSearchUsed': False,
            'subsetMiningUsed': False,
            'homeAwaySubsetMiningUsed': False,
            'seasonExclusionAfterResultsUsed': False,
            'postResultRuleChangeAllowed': False,
            'postResultShrinkageChangeAllowed': False,
            'postResultLookbackChangeAllowed': False,
            'v16ProductionChanged': False,
            'productionMarketRegistryChanged': False,
            'rankingChanged': False,
            'stakeChanged': False,
            'betEliteAllowed': False,
            'finalRecommendationChanged': False,
            'automaticBetPlacementAllowed': False,
            'positiveEvEstablished': False,
            'realFinancialExposure': 0,
        },
    }
    dump(x.out, report)
    print(json.dumps({
        'classification': classification,
        'candidateRubricPassed': bool(passed),
        'coverageGatePassed': bool(coverage),
        'validation2023': val_imp,
        'combined': imp,
        'broadBatterOnly': combined['broadBatterOnlyImprovementVsControl'],
        'starterQualityOnly': combined['starterQualityOnlyImprovementVsControl'],
        'bootstrap': boot,
        'bySeason': {s: by_season[s]['challengerImprovementVsControl'] for s in evs},
        'vsV62': vs_v62,
        'checks': checks,
    }, indent=2))


if __name__ == '__main__':
    main()

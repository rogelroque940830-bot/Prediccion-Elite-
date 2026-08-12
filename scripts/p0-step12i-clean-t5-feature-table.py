#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
from collections import defaultdict

SCHEMA = 'courtedge-p0-step12i-clean-t5-feature-table.v1'


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def mean(xs):
    return sum(xs) / len(xs) if xs else None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def finite_or_none(v):
    return float(v) if v is not None and math.isfinite(float(v)) else None


def build_features(dataset, starter_history, lineup_history, t5_audit):
    full = [r for r in dataset['observations'] if r['horizon'] == 'FULL_GAME']
    full.sort(key=lambda r: (r['officialDate'], r['gamePk']))
    f5 = {r['gamePk']: r for r in dataset['observations'] if r['horizon'] == 'FIRST_5'}
    final_starters = {g['gamePk']: g for g in starter_history['games']}
    lineups = {s['gamePk']: s for s in lineup_history['snapshots']}
    t5 = {r['gamePk']: r for r in t5_audit['rows']}

    by_date = defaultdict(list)
    for r in full:
        by_date[r['officialDate']].append(r)

    team_hist = defaultdict(list)
    pitcher_hist = defaultdict(list)
    league_pitcher = []
    team_player_apps = defaultdict(int)
    team_prior_games = defaultdict(int)
    previous_lineup = {}
    rows = []

    def team_stats(tid):
        hist = team_hist[tid]
        if len(hist) < 5:
            return None
        recent = hist[-10:]
        return {
            'rs': mean([x['rs'] for x in recent]),
            'ra': mean([x['ra'] for x in recent]),
            'rd': mean([x['rs'] - x['ra'] for x in recent]),
            'win': mean([x['win'] for x in recent]),
        }

    def pitcher_stats(pid, prior_bf=72):
        # Current-game identity is T-5 probablePitcher. Only completed PRIOR-DATE
        # boxscore lines are allowed to populate the historical performance state.
        if not league_pitcher:
            return None
        lbf = sum(x['battersFaced'] for x in league_pitcher if x.get('battersFaced'))
        if lbf <= 0:
            return None
        ler = sum(x['earnedRuns'] for x in league_pitcher if x.get('battersFaced')) / lbf
        lkbb = sum(x['strikeOuts'] - x['baseOnBalls'] for x in league_pitcher if x.get('battersFaced')) / lbf
        lhr = sum(x['homeRuns'] for x in league_pitcher if x.get('battersFaced')) / lbf
        hist = [x for x in pitcher_hist[pid] if x.get('battersFaced')]
        bf = sum(x['battersFaced'] for x in hist)
        er = sum(x['earnedRuns'] for x in hist)
        kbb = sum(x['strikeOuts'] - x['baseOnBalls'] for x in hist)
        hr = sum(x['homeRuns'] for x in hist)
        return {
            'bf': bf,
            'erbf': (er + prior_bf * ler) / (bf + prior_bf),
            'kbb': (kbb + prior_bf * lkbb) / (bf + prior_bf),
            'hrbf': (hr + prior_bf * lhr) / (bf + prior_bf),
        }

    def lineup_exposure_rate(tid, order):
        prior_games = team_prior_games[tid]
        if prior_games <= 0:
            return None
        # Team-specific exposure avoids trades making a player's numerator exceed
        # the team's own prior-game denominator.
        return mean([team_player_apps[(tid, pid)] / prior_games for pid in order])

    def continuity_rate(tid, order):
        prev = previous_lineup.get(tid)
        if not prev:
            return None
        return len(set(order) & set(prev)) / 9.0

    for date in sorted(by_date):
        # Evaluate every game on the date before updating any state from that date.
        for r in sorted(by_date[date], key=lambda x: x['gamePk']):
            gpk = r['gamePk']
            h, a = r['homeTeamId'], r['awayTeamId']
            f = f5.get(gpk)
            if f is None:
                continue
            audit = t5.get(gpk)
            lineup = lineups.get(gpk)

            row = {
                'gamePk': gpk,
                'officialDate': date,
                'homeTeamId': h,
                'awayTeamId': a,
                # Outcomes are labels only; no feature below may derive from them.
                'fullResult': 'HOME' if r['homeRuns'] > r['awayRuns'] else 'AWAY',
                'f5Result': 'HOME' if f['homeRuns'] > f['awayRuns'] else ('AWAY' if f['homeRuns'] < f['awayRuns'] else 'PUSH'),
                't5PregameValid': False,
                't5BothProbablesKnown': False,
                't5LineupComplete': bool(lineup and lineup.get('complete')),
                't5HomeProbablePitcherId': None,
                't5AwayProbablePitcherId': None,
            }

            hs, aas = team_stats(h), team_stats(a)
            if hs and aas:
                row.update(
                    team_rd10_diff=hs['rd'] - aas['rd'],
                    team_win10_diff=hs['win'] - aas['win'],
                    team_rs10_diff=hs['rs'] - aas['rs'],
                    team_ra10_adv=aas['ra'] - hs['ra'],
                )
            else:
                for k in ('team_rd10_diff', 'team_win10_diff', 'team_rs10_diff', 'team_ra10_adv'):
                    row[k] = None

            audit_valid = bool(audit and audit.get('identityOk') and audit.get('sourceHistorical') and audit.get('pregame'))
            probable_known = bool(audit_valid and audit.get('probableBothKnown'))
            row['t5PregameValid'] = audit_valid
            row['t5BothProbablesKnown'] = probable_known
            if probable_known:
                hp_id = int(audit['homeProbablePitcherId'])
                ap_id = int(audit['awayProbablePitcherId'])
                row['t5HomeProbablePitcherId'] = hp_id
                row['t5AwayProbablePitcherId'] = ap_id
                hp, ap = pitcher_stats(hp_id), pitcher_stats(ap_id)
            else:
                hp = ap = None
            if hp and ap:
                row.update(
                    starter_runrisk_adv=ap['erbf'] - hp['erbf'],
                    starter_kbb_adv=hp['kbb'] - ap['kbb'],
                    starter_hr_adv=ap['hrbf'] - hp['hrbf'],
                    home_probable_prior_bf=hp['bf'],
                    away_probable_prior_bf=ap['bf'],
                )
            else:
                for k in ('starter_runrisk_adv', 'starter_kbb_adv', 'starter_hr_adv', 'home_probable_prior_bf', 'away_probable_prior_bf'):
                    row[k] = None

            if audit_valid and lineup and lineup.get('complete'):
                hl, al = lineup['homeBattingOrder'], lineup['awayBattingOrder']
                he, ae = lineup_exposure_rate(h, hl), lineup_exposure_rate(a, al)
                hc, ac = continuity_rate(h, hl), continuity_rate(a, al)
                row['lineup_exposure_rate_adv'] = he - ae if he is not None and ae is not None else None
                row['lineup_continuity_rate_adv'] = hc - ac if hc is not None and ac is not None else None
            else:
                row['lineup_exposure_rate_adv'] = None
                row['lineup_continuity_rate_adv'] = None

            rows.append(row)

        # Only after the whole date is scored may that date enter historical state.
        for r in sorted(by_date[date], key=lambda x: x['gamePk']):
            gpk = r['gamePk']
            h, a = r['homeTeamId'], r['awayTeamId']
            hw = 1 if r['homeRuns'] > r['awayRuns'] else 0
            team_hist[h].append({'rs': r['homeRuns'], 'ra': r['awayRuns'], 'win': hw})
            team_hist[a].append({'rs': r['awayRuns'], 'ra': r['homeRuns'], 'win': 1 - hw})

            # Final boxscore starter lines are legal ONLY after the game date has
            # completed, so they can inform later games but never identify this game.
            sg = final_starters.get(gpk)
            if sg:
                for side in ('homeStarter', 'awayStarter'):
                    line = sg[side]
                    pitcher_hist[line['pitcherId']].append(line)
                    league_pitcher.append(line)

            lineup = lineups.get(gpk)
            audit = t5.get(gpk)
            audit_valid = bool(audit and audit.get('identityOk') and audit.get('sourceHistorical') and audit.get('pregame'))
            if audit_valid and lineup and lineup.get('complete'):
                for tid, key in ((h, 'homeBattingOrder'), (a, 'awayBattingOrder')):
                    order = list(lineup[key])
                    for pid in order:
                        team_player_apps[(tid, pid)] += 1
                    previous_lineup[tid] = order
            team_prior_games[h] += 1
            team_prior_games[a] += 1

    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', required=True)
    ap.add_argument('--starter-history', required=True)
    ap.add_argument('--lineup-history', required=True)
    ap.add_argument('--t5-audit', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    dataset = load(args.dataset)
    starter = load(args.starter_history)
    lineup = load(args.lineup_history)
    audit = load(args.t5_audit)
    if audit.get('schemaVersion') != 'courtedge-p0-step12h-t5-starter-identity-audit.v1':
        raise SystemExit('STEP12I_T5_AUDIT_SCHEMA_INVALID')

    rows = build_features(dataset, starter, lineup, audit)
    if not rows:
        raise SystemExit('STEP12I_EMPTY_FEATURE_TABLE')

    valid_t5 = [r for r in rows if r['t5PregameValid']]
    both_prob = [r for r in valid_t5 if r['t5BothProbablesKnown']]
    complete = [r for r in both_prob if r['t5LineupComplete']]
    usable = [r for r in complete if all(r.get(k) is not None for k in (
        'starter_runrisk_adv', 'starter_hr_adv', 'lineup_exposure_rate_adv'))]

    # Structural invariants independent of outcome quality.
    for r in rows:
        for key in ('lineup_exposure_rate_adv', 'lineup_continuity_rate_adv'):
            v = finite_or_none(r.get(key))
            if v is not None and not (-1.000000001 <= v <= 1.000000001):
                raise SystemExit(f'STEP12I_NONSTATIONARY_LINEUP_RANGE:{key}:{v}')
        if r['t5BothProbablesKnown'] and (r['t5HomeProbablePitcherId'] is None or r['t5AwayProbablePitcherId'] is None):
            raise SystemExit('STEP12I_T5_PROBABLE_IDENTITY_INCONSISTENT')

    report = {
        'schemaVersion': SCHEMA,
        'evidenceStatus': 'CLEAN_T5_FEATURE_TABLE_RESEARCH_ONLY_NO_PROMOTION',
        'source': {
            'datasetSha256': sha256_file(args.dataset),
            'starterHistorySha256': sha256_file(args.starter_history),
            'lineupHistorySha256': sha256_file(args.lineup_history),
            't5AuditSha256': sha256_file(args.t5_audit),
        },
        'counts': {
            'rows': len(rows),
            'validT5PregameRows': len(valid_t5),
            'bothProbablePitchersKnownRows': len(both_prob),
            'completeLineupAndBothProbablesRows': len(complete),
            'coreFeatureUsableRows': len(usable),
        },
        'featureContract': {
            'currentGameStarterIdentity': 'T5_PROBABLE_PITCHER_ONLY',
            'starterPerformanceHistory': 'COMPLETED_PRIOR_DATES_ONLY_FROM_FINAL_BOXSCORES',
            'sameDateHistoryAllowed': False,
            'lineupSource': 'T5_COMPLETE_BATTING_ORDER_ONLY',
            'lineupExposureRate': 'MEAN_TEAM_SPECIFIC_PRIOR_LINEUP_APPEARANCES_DIVIDED_BY_TEAM_PRIOR_GAMES',
            'lineupExposureRateRange': [-1, 1],
            'lineupContinuityRate': 'CURRENT_VS_PREVIOUS_LINEUP_OVERLAP_DIVIDED_BY_9',
            'lineupContinuityRateRange': [-1, 1],
            'rawCumulativeLineupExperienceAllowedForDiscovery': False,
            'outcomesUsedAsFeatures': False,
        },
        'policy': {
            'thresholdSearchPerformed': False,
            'candidateSearchPerformed': False,
            'historicalPricesUsed': False,
            'historicalEvClaimProduced': False,
            'betEliteProduced': False,
            'livePickFiltersChanged': False,
            'step11cCapturePopulationChanged': False,
            'automaticBetPlacement': False,
        },
        'rows': rows,
    }

    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, sort_keys=True)
        f.write('\n')
    print(json.dumps({'ok': True, 'counts': report['counts'], 'researchOnly': True}, indent=2))


if __name__ == '__main__':
    main()

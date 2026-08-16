#!/usr/bin/env python3
import runpy

mod = runpy.run_path('scripts/p0-step12i-clean-t5-feature-table.py', run_name='step12i_testlib')
build_features = mod['build_features']


def obs(game, date, horizon, hr, ar):
    return {'gamePk': game, 'officialDate': date, 'horizon': horizon, 'homeTeamId': 1, 'awayTeamId': 2, 'homeRuns': hr, 'awayRuns': ar}


def starter_line(game, date, side, team, opp, pid, er, bf=20, so=5, bb=1, homers=1):
    return {
        'gamePk': game, 'officialDate': date, 'side': side, 'teamId': team, 'opponentTeamId': opp,
        'pitcherId': pid, 'pitcherName': str(pid), 'identityMethod': 'GAME_STARTED_FLAG_AND_ORDER',
        'outsRecorded': 15, 'inningsPitched': '5.0', 'battersFaced': bf, 'runs': er, 'earnedRuns': er,
        'hits': 4, 'baseOnBalls': bb, 'strikeOuts': so, 'homeRuns': homers,
        'hitByPitch': 0, 'numberOfPitches': 80, 'strikes': 50,
    }


def starter_game(game, date, hp, ap, her=1, aer=3):
    return {
        'gamePk': game, 'officialDate': date, 'homeTeamId': 1, 'awayTeamId': 2,
        'homeStarter': starter_line(game, date, 'home', 1, 2, hp, her),
        'awayStarter': starter_line(game, date, 'away', 2, 1, ap, aer),
    }


def lineup(game, date, home_base=1000, away_base=2000):
    return {
        'gamePk': game, 'officialDate': date, 'complete': True,
        'homeBattingOrder': list(range(home_base, home_base + 9)),
        'awayBattingOrder': list(range(away_base, away_base + 9)),
    }


def audit(game, date, hp, ap):
    return {
        'gamePk': game, 'officialDate': date, 'identityOk': True, 'sourceHistorical': True, 'pregame': True,
        'probableBothKnown': True, 'homeProbablePitcherId': hp, 'awayProbablePitcherId': ap,
    }


dates = [f'2025-04-{d:02d}' for d in range(1, 8)]
observations = []
starters = []
lineups = []
audits = []
for i, date in enumerate(dates, start=1):
    observations += [obs(i, date, 'FULL_GAME', 5 if i % 2 else 2, 2 if i % 2 else 4), obs(i, date, 'FIRST_5', 3, 1)]
    # Pitchers 101/201 establish prior history for the T-5 identities.
    final_hp = 101
    final_ap = 201
    if i == 7:
        # Deliberate post-T5 scratch: final starter differs from T-5 probable.
        final_hp = 999
    starters.append(starter_game(i, date, final_hp, final_ap, her=1 if final_hp == 101 else 5, aer=3))
    lineups.append(lineup(i, date))
    audits.append(audit(i, date, 101, 201))

dataset = {'observations': observations}
starter_history = {'games': starters}
lineup_history = {'snapshots': lineups}
t5_audit = {'rows': audits}
rows = build_features(dataset, starter_history, lineup_history, t5_audit)
target = next(r for r in rows if r['gamePk'] == 7)
assert target['t5HomeProbablePitcherId'] == 101, target
assert target['t5AwayProbablePitcherId'] == 201, target
assert target['starter_runrisk_adv'] is not None, target
assert target['starter_hr_adv'] is not None, target
assert target['lineup_exposure_rate_adv'] == 0.0, target
assert -1 <= target['lineup_continuity_rate_adv'] <= 1, target

# Same-date leakage check: add two games on a new date. Reversing their within-date
# outcomes must not alter either row's pregame team feature because updates occur only
# after the entire date is evaluated.
base_date = '2025-04-08'
for g, hr, ar in ((8, 20, 0), (9, 0, 20)):
    dataset['observations'] += [obs(g, base_date, 'FULL_GAME', hr, ar), obs(g, base_date, 'FIRST_5', 1, 0)]
    starter_history['games'].append(starter_game(g, base_date, 101, 201))
    lineup_history['snapshots'].append(lineup(g, base_date))
    t5_audit['rows'].append(audit(g, base_date, 101, 201))
rows2 = build_features(dataset, starter_history, lineup_history, t5_audit)
r8 = next(r for r in rows2 if r['gamePk'] == 8)
r9 = next(r for r in rows2 if r['gamePk'] == 9)
assert r8['team_rd10_diff'] == r9['team_rd10_diff'], (r8, r9)
assert r8['starter_runrisk_adv'] == r9['starter_runrisk_adv'], (r8, r9)

print('STEP12I_SYNTHETIC_INVARIANTS_OK')

#!/usr/bin/env python3
import argparse, hashlib, json, math, os
from collections import defaultdict
from datetime import datetime, timezone

QUANTILES = (0.1, 0.2, 0.3, 0.7, 0.8, 0.9)
ADV_FEATURES = (
    'team_rd10_diff','team_win10_diff','team_rs10_diff','team_ra10_adv',
    'starter_runrisk_adv','starter_kbb_adv','starter_hr_adv',
    'lineup_exp_adv','lineup_continuity_adv',
)

def sha256_file(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def quantile(values,q):
    values=sorted(v for v in values if v is not None and math.isfinite(v))
    if not values: raise ValueError('EMPTY_QUANTILE_SAMPLE')
    pos=(len(values)-1)*q; lo=math.floor(pos); hi=math.ceil(pos)
    if lo==hi: return float(values[lo])
    frac=pos-lo
    return float(values[lo]*(1-frac)+values[hi]*frac)

def wilson(hits,n,z=1.96):
    if n<=0: return (None,None)
    p=hits/n; den=1+z*z/n
    center=(p+z*z/(2*n))/den
    half=z*math.sqrt((p*(1-p)+z*z/(4*n))/n)/den
    return center-half, center+half

def binom_tail(k,n,p):
    if n<=0: return None
    return min(1.0,sum(math.comb(n,i)*(p**i)*((1-p)**(n-i)) for i in range(k,n+1)))

def mean(xs): return sum(xs)/len(xs) if xs else None

def load(path):
    with open(path,'r',encoding='utf-8') as f: return json.load(f)

def dump(path,value):
    os.makedirs(os.path.dirname(path) or '.',exist_ok=True)
    with open(path,'w',encoding='utf-8') as f: json.dump(value,f,indent=2,sort_keys=True); f.write('\n')

def signed_quantile_atoms(rows):
    atoms=[]
    for feature in ADV_FEATURES:
        values=[r['features'].get(feature) for r in rows if r['features'].get(feature) is not None]
        if len(values)<50: continue
        for q in QUANTILES:
            threshold=quantile(values,q)
            atoms.append({
                'feature':feature,
                'operator':'LTE' if q<0.5 else 'GTE',
                'threshold':threshold,
                'quantile':q,
            })
    return atoms

def matches(row,atoms):
    for atom in atoms:
        v=row['features'].get(atom['feature'])
        if v is None or not math.isfinite(v): return False
        if atom['operator']=='GTE' and v<atom['threshold']: return False
        if atom['operator']=='LTE' and v>atom['threshold']: return False
    return True

def observed_result(row,horizon):
    if horizon=='FULL_GAME':
        h,a=row['full_home'],row['full_away']
    elif horizon=='FIRST_5':
        h,a=row['f5_home'],row['f5_away']
    else: raise ValueError('UNSUPPORTED_HORIZON')
    return 'HOME' if h>a else 'AWAY' if h<a else 'PUSH'

def rule_side(atoms):
    dirs={a['operator'] for a in atoms}
    if dirs=={'GTE'}: return 'HOME'
    if dirs=={'LTE'}: return 'AWAY'
    return None

def metrics(rows,atoms,side,horizon,baseline_dates):
    selected=[r for r in rows if matches(r,atoms)]
    outcomes=[observed_result(r,horizon) for r in selected]
    hits=sum(o==side for o in outcomes)
    pushes=sum(o=='PUSH' for o in outcomes)
    losses=len(outcomes)-hits-pushes
    decisive=hits+losses
    dates={r['date'] for r in selected}
    return {
        'selectedRows':len(selected),'decisiveRows':decisive,'hits':hits,'losses':losses,'pushes':pushes,
        'decisiveHitRate':hits/decisive if decisive else None,'uniqueDates':len(dates),
        'retentionPct':100*len(selected)/len(rows) if rows else 0,
        'noPickDatePct':100*(len(baseline_dates)-len(dates))/len(baseline_dates) if baseline_dates else 0,
    }

def rule_key(horizon,side,atoms):
    raw=json.dumps({'horizon':horizon,'side':side,'atoms':atoms},sort_keys=True,separators=(',',':')).encode()
    return hashlib.sha256(raw).hexdigest()[:16]

def build_rows(dataset,starter_history,lineup_history):
    full={x['gamePk']:x for x in dataset['observations'] if x['horizon']=='FULL_GAME'}
    f5={x['gamePk']:x for x in dataset['observations'] if x['horizon']=='FIRST_5'}
    starters={g['gamePk']:g for g in starter_history['games']}
    lineups={s['gamePk']:s for s in lineup_history['snapshots'] if s.get('complete')}
    games=sorted(full.values(),key=lambda r:(r['officialDate'],r['gamePk']))
    team_hist=defaultdict(list); starter_hist=defaultdict(list); previous_lineup={}
    rows=[]
    by_date=defaultdict(list)
    for game in games: by_date[game['officialDate']].append(game)
    for date in sorted(by_date):
        todays=[]
        for game in by_date[date]:
            pk=game['gamePk']; home=game['homeTeamId']; away=game['awayTeamId']
            feats={k:None for k in ADV_FEATURES}
            hh=team_hist[home][-10:]; ah=team_hist[away][-10:]
            if len(hh)>=5 and len(ah)>=5:
                hrdf=mean([x['rs']-x['ra'] for x in hh]); ardf=mean([x['rs']-x['ra'] for x in ah])
                feats['team_rd10_diff']=hrdf-ardf
                feats['team_win10_diff']=mean([x['win'] for x in hh])-mean([x['win'] for x in ah])
                feats['team_rs10_diff']=mean([x['rs'] for x in hh])-mean([x['rs'] for x in ah])
                feats['team_ra10_adv']=mean([x['ra'] for x in ah])-mean([x['ra'] for x in hh])
            sg=starters.get(pk)
            if sg:
                hp=sg.get('homeStarterId'); ap=sg.get('awayStarterId')
                all_prior=[x for vals in starter_hist.values() for x in vals]
                if all_prior:
                    er0=sum(x['er'] for x in all_prior)/max(1,sum(x['bf'] for x in all_prior))
                    kbb0=sum(x['so']-x['bb'] for x in all_prior)/max(1,sum(x['bf'] for x in all_prior))
                    hr0=sum(x['hr'] for x in all_prior)/max(1,sum(x['bf'] for x in all_prior))
                    def pf(pid,key,prior):
                        h=starter_hist.get(pid,[]); bf=sum(x['bf'] for x in h)
                        num=sum(x[key] for x in h)
                        return (num+72*prior)/(bf+72)
                    if hp and ap:
                        feats['starter_runrisk_adv']=pf(ap,'er',er0)-pf(hp,'er',er0)
                        feats['starter_kbb_adv']=pf(hp,'kbb',kbb0)-pf(ap,'kbb',kbb0)
                        feats['starter_hr_adv']=pf(ap,'hr',hr0)-pf(hp,'hr',hr0)
            lu=lineups.get(pk)
            if lu:
                home_order=lu['home']['battingOrder']; away_order=lu['away']['battingOrder']
                if len(home_order)==9 and len(away_order)==9:
                    def exp(order): return mean([sum(pid in x for x in previous_lineup.values()) for pid in order])
                    feats['lineup_exp_adv']=exp(home_order)-exp(away_order)
                    hp=set(previous_lineup.get(home,[])); ap=set(previous_lineup.get(away,[]))
                    feats['lineup_continuity_adv']=len(hp & set(home_order))-len(ap & set(away_order))
            f5g=f5.get(pk)
            rows.append({
                'gamePk':pk,'date':date,'homeTeamId':home,'awayTeamId':away,'features':feats,
                'full_home':game['homeRuns'],'full_away':game['awayRuns'],
                'f5_home':f5g['homeRuns'] if f5g else None,'f5_away':f5g['awayRuns'] if f5g else None,
            })
            todays.append((game,sg,lu))
        # Update historical state only after every game on the date has been featurized.
        for game,sg,lu in todays:
            home=game['homeTeamId']; away=game['awayTeamId']; h=game['homeRuns']; a=game['awayRuns']
            team_hist[home].append({'rs':h,'ra':a,'win':1 if h>a else 0})
            team_hist[away].append({'rs':a,'ra':h,'win':1 if a>h else 0})
            if sg:
                for side in ('home','away'):
                    pid=sg.get(side+'StarterId'); line=sg.get(side+'StarterLine') or {}
                    if pid and line.get('battersFaced',0)>0:
                        starter_hist[pid].append({'bf':line['battersFaced'],'er':line['earnedRuns'],'so':line['strikeOuts'],'bb':line['baseOnBalls'],'hr':line['homeRuns'],'kbb':line['strikeOuts']-line['baseOnBalls']})
            if lu:
                if len(lu['home']['battingOrder'])==9: previous_lineup[home]=lu['home']['battingOrder']
                if len(lu['away']['battingOrder'])==9: previous_lineup[away]=lu['away']['battingOrder']
    return rows

def discover(rows,horizon,minimum_decisive=50,top_k=10):
    dates=sorted({r['date'] for r in rows}); atoms=signed_quantile_atoms(rows)
    candidates=[]
    import itertools
    for size in (1,2,3):
        for combo in itertools.combinations(atoms,size):
            if len({a['feature'] for a in combo})!=size: continue
            side=rule_side(combo)
            if not side: continue
            m=metrics(rows,combo,side,horizon,set(dates))
            if m['decisiveRows']<minimum_decisive: continue
            lo,_=wilson(m['hits'],m['decisiveRows'])
            candidates.append({'ruleKey':rule_key(horizon,side,combo),'side':side,'atoms':list(combo),'discovery':m,'discoveryWilsonLower95':lo})
    candidates.sort(key=lambda r:(r['discoveryWilsonLower95'],r['discovery']['decisiveRows']),reverse=True)
    return candidates[:top_k],len(candidates)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--dataset',required=True); ap.add_argument('--starter-history',required=True); ap.add_argument('--lineup-history',required=True)
    ap.add_argument('--discovery-end',default='2025-07-31'); ap.add_argument('--out',required=True)
    args=ap.parse_args()
    dataset=load(args.dataset); starters=load(args.starter_history); lineups=load(args.lineup_history)
    rows=build_rows(dataset,starters,lineups)
    discovery=[r for r in rows if r['date']<=args.discovery_end]; holdout=[r for r in rows if r['date']>args.discovery_end]
    report={
      'schemaVersion':'courtedge-p0-step12-pocket-pilot.v1','generatedAt':datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),
      'evidenceStatus':'PILOT_RESEARCH_ONLY_NOT_BET_ELITE',
      'source':{'datasetSha256':sha256_file(args.dataset),'starterHistorySha256':sha256_file(args.starter_history),'lineupHistorySha256':sha256_file(args.lineup_history),'officialGames':len({r['gamePk'] for r in rows}),'starterGames':len(starters['games']),'completeLineupGames':sum(1 for s in lineups['snapshots'] if s.get('complete'))},
      'split':{'discoveryEndDate':args.discovery_end,'discoveryRows':len(discovery),'holdoutRows':len(holdout),'discoveryDates':len({r['date'] for r in discovery}),'holdoutDates':len({r['date'] for r in holdout})},
      'featureMethod':{'team':'last up to 10 prior games with at least 5 prior games; same-date outcomes excluded','starter':'prior-date ER/BF K-BB/BF HR/BF shrunk by 72 BF to prior league baseline; same-date outcomes excluded','lineup':'T-5 official batting order; prior lineup appearance experience and previous-lineup continuity only; same-date lineups excluded','thresholds':'10/20/30/70/80/90 discovery quantiles only','maxAtomsPerRule':3},
      'policy':{'historicalPricesUsed':False,'historicalEvClaimProduced':False,'holdoutThresholdTuningAllowed':False,'automaticBestRulePromotion':False,'livePickFiltersChanged':False,'betEliteProduced':False},
      'targets':[],
    }
    for horizon in ('FULL_GAME','FIRST_5'):
        top,attempted=discover(discovery,horizon)
        hold_dates={r['date'] for r in holdout}
        hold_base_outcomes=[observed_result(r,horizon) for r in holdout]
        decisive=[x for x in hold_base_outcomes if x!='PUSH']; base=sum(x=='HOME' for x in decisive)/len(decisive)
        for r in top:
            hm=metrics(holdout,r['atoms'],r['side'],horizon,hold_dates); r['holdout']=hm
            p=binom_tail(hm['hits'],hm['decisiveRows'],base if r['side']=='HOME' else 1-base) if hm['decisiveRows'] else None
            r['holdoutOneSidedPValueVsBaseline']=p; r['holdoutBonferroniPValueTopK']=min(1,p*len(top)) if p is not None else None
        report['targets'].append({'horizon':horizon,'minimumDiscoveryDecisiveRows':50,'attemptedRules':attempted,'topK':len(top),'holdoutBaselineHomeDecisiveHitRate':base,'rules':top})
    dump(args.out,report)
    print(json.dumps({'out':args.out,'discoveryRows':len(discovery),'holdoutRows':len(holdout),'topFull':report['targets'][0]['rules'][0] if report['targets'][0]['rules'] else None,'topF5':report['targets'][1]['rules'][0] if report['targets'][1]['rules'] else None},indent=2))

if __name__=='__main__': main()

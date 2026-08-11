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

def build_features(dataset,starter_history,lineup_history):
    full=[r for r in dataset['observations'] if r['horizon']=='FULL_GAME']
    full.sort(key=lambda r:(r['officialDate'],r['gamePk']))
    f5={r['gamePk']:r for r in dataset['observations'] if r['horizon']=='FIRST_5'}
    starters={g['gamePk']:g for g in starter_history['games']}
    lineups={s['gamePk']:s for s in lineup_history['snapshots']}
    by_date=defaultdict(list)
    for r in full: by_date[r['officialDate']].append(r)
    team_hist=defaultdict(list); pitcher_hist=defaultdict(list); league_pitcher=[]
    player_apps=defaultdict(int); previous_lineup={}; rows=[]

    def team_stats(tid):
        hist=team_hist[tid]
        if len(hist)<5: return None
        recent=hist[-10:]
        return {'rs':mean([x['rs'] for x in recent]),'ra':mean([x['ra'] for x in recent]),
                'rd':mean([x['rs']-x['ra'] for x in recent]),'win':mean([x['win'] for x in recent])}

    def pitcher_stats(pid,prior_bf=72):
        if not league_pitcher: return None
        lbf=sum(x['battersFaced'] for x in league_pitcher)
        if lbf<=0: return None
        ler=sum(x['earnedRuns'] for x in league_pitcher)/lbf
        lkbb=sum(x['strikeOuts']-x['baseOnBalls'] for x in league_pitcher)/lbf
        lhr=sum(x['homeRuns'] for x in league_pitcher)/lbf
        hist=pitcher_hist[pid]; bf=sum(x['battersFaced'] for x in hist)
        er=sum(x['earnedRuns'] for x in hist); kbb=sum(x['strikeOuts']-x['baseOnBalls'] for x in hist); hr=sum(x['homeRuns'] for x in hist)
        return {'bf':bf,'erbf':(er+prior_bf*ler)/(bf+prior_bf),'kbb':(kbb+prior_bf*lkbb)/(bf+prior_bf),'hrbf':(hr+prior_bf*lhr)/(bf+prior_bf)}

    for date in sorted(by_date):
        # Evaluate entire date before updating any histories: no same-date leakage.
        for r in sorted(by_date[date],key=lambda x:x['gamePk']):
            gpk=r['gamePk']; h=r['homeTeamId']; a=r['awayTeamId']
            x={'gamePk':gpk,'officialDate':date,'fullResult':'HOME' if r['homeRuns']>r['awayRuns'] else 'AWAY'}
            f=f5[gpk]; x['f5Result']='HOME' if f['homeRuns']>f['awayRuns'] else ('AWAY' if f['homeRuns']<f['awayRuns'] else 'PUSH')
            hs,as_=team_stats(h),team_stats(a)
            if hs and as_:
                x.update(team_rd10_diff=hs['rd']-as_['rd'],team_win10_diff=hs['win']-as_['win'],team_rs10_diff=hs['rs']-as_['rs'],team_ra10_adv=as_['ra']-hs['ra'])
            else:
                for k in ('team_rd10_diff','team_win10_diff','team_rs10_diff','team_ra10_adv'): x[k]=None
            sg=starters.get(gpk); hp=ap=None
            if sg:
                hp=pitcher_stats(sg['homeStarter']['pitcherId']); ap=pitcher_stats(sg['awayStarter']['pitcherId'])
            if hp and ap:
                x.update(starter_runrisk_adv=ap['erbf']-hp['erbf'],starter_kbb_adv=hp['kbb']-ap['kbb'],starter_hr_adv=ap['hrbf']-hp['hrbf'])
            else:
                for k in ('starter_runrisk_adv','starter_kbb_adv','starter_hr_adv'): x[k]=None
            ls=lineups.get(gpk)
            if ls and ls.get('complete'):
                hl=ls['homeBattingOrder']; al=ls['awayBattingOrder']
                x['lineup_exp_adv']=mean([player_apps[p] for p in hl])-mean([player_apps[p] for p in al])
                ph=previous_lineup.get(h); pa=previous_lineup.get(a)
                x['lineup_continuity_adv']=(len(set(hl)&set(ph))-len(set(al)&set(pa))) if ph and pa else None
            else:
                x['lineup_exp_adv']=None; x['lineup_continuity_adv']=None
            rows.append(x)
        for r in sorted(by_date[date],key=lambda x:x['gamePk']):
            gpk=r['gamePk']; h=r['homeTeamId']; a=r['awayTeamId']; hw=1 if r['homeRuns']>r['awayRuns'] else 0
            team_hist[h].append({'rs':r['homeRuns'],'ra':r['awayRuns'],'win':hw}); team_hist[a].append({'rs':r['awayRuns'],'ra':r['homeRuns'],'win':1-hw})
            sg=starters.get(gpk)
            if sg:
                for side in ('homeStarter','awayStarter'):
                    line=sg[side]; pitcher_hist[line['pitcherId']].append(line); league_pitcher.append(line)
            ls=lineups.get(gpk)
            if ls and ls.get('complete'):
                for tid,key in ((h,'homeBattingOrder'),(a,'awayBattingOrder')):
                    order=ls[key]
                    for p in order: player_apps[p]+=1
                    previous_lineup[tid]=list(order)
    return rows

def atom_mask(row,atom):
    v=row.get(atom['feature'])
    if v is None or not math.isfinite(v): return False
    return v>=atom['threshold'] if atom['operator']=='GTE' else v<=atom['threshold']

def selected(rows,atoms): return [r for r in rows if all(atom_mask(r,a) for a in atoms)]

def metrics(rows,atoms,target):
    sel=selected(rows,atoms); side=target['side']; horizon=target['horizon']; hits=losses=pushes=0
    for r in sel:
        outcome=r['fullResult'] if horizon=='FULL_GAME' else r['f5Result']
        if outcome=='PUSH': pushes+=1
        elif outcome==side: hits+=1
        else: losses+=1
    decisive=hits+losses; dates=len({r['officialDate'] for r in sel}); baseline_dates=len({r['officialDate'] for r in rows})
    return {'selectedRows':len(sel),'decisiveRows':decisive,'hits':hits,'losses':losses,'pushes':pushes,
            'decisiveHitRate':hits/decisive if decisive else None,'uniqueDates':dates,
            'retentionPct':100*len(sel)/len(rows) if rows else 0,
            'noPickDatePct':100*(baseline_dates-dates)/baseline_dates if baseline_dates else 0}

def rule_signature(atoms,side): return side+'|'+'|'.join(sorted(f"{a['feature']}:{a['operator']}:{a['threshold']:.12g}" for a in atoms))

def search_target(discovery,holdout,horizon,top_k=10,min_decisive=50):
    atoms=[]
    for feature in ADV_FEATURES:
        values=[r[feature] for r in discovery if r.get(feature) is not None and math.isfinite(r[feature])]
        for q in QUANTILES:
            threshold=quantile(values,q)
            atom={'feature':feature,'operator':'LTE' if q<0.5 else 'GTE','threshold':threshold,'quantile':q}
            side='AWAY' if q<0.5 else 'HOME'
            m=metrics(discovery,[atom],{'horizon':horizon,'side':side})
            if m['decisiveRows']>=min_decisive:
                lo,_=wilson(m['hits'],m['decisiveRows']); atoms.append({'atom':atom,'side':side,'metrics':m,'lower95':lo})
    rules=[]
    for a in atoms: rules.append({'atoms':[a['atom']],'side':a['side']})
    for i,a in enumerate(atoms):
        for j in range(i+1,len(atoms)):
            b=atoms[j]
            if a['side']!=b['side'] or a['atom']['feature']==b['atom']['feature']: continue
            rules.append({'atoms':[a['atom'],b['atom']],'side':a['side']})
            for k in range(j+1,len(atoms)):
                c=atoms[k]
                if c['side']!=a['side'] or len({a['atom']['feature'],b['atom']['feature'],c['atom']['feature']})<3: continue
                rules.append({'atoms':[a['atom'],b['atom'],c['atom']],'side':a['side']})
    seen=set(); scored=[]
    for r in rules:
        sig=rule_signature(r['atoms'],r['side'])
        if sig in seen: continue
        seen.add(sig)
        dm=metrics(discovery,r['atoms'],{'horizon':horizon,'side':r['side']})
        if dm['decisiveRows']<min_decisive: continue
        lo,_=wilson(dm['hits'],dm['decisiveRows'])
        scored.append({'ruleKey':hashlib.sha256(sig.encode()).hexdigest()[:16],'side':r['side'],'atoms':r['atoms'],'discovery':dm,'discoveryWilsonLower95':lo})
    scored.sort(key=lambda r:(r['discoveryWilsonLower95'],r['discovery']['decisiveHitRate'],r['discovery']['decisiveRows']),reverse=True)
    chosen=scored[:top_k]
    if horizon=='FULL_GAME':
        home=sum(1 for r in holdout if r['fullResult']=='HOME'); dec=len(holdout)
    else:
        home=sum(1 for r in holdout if r['f5Result']=='HOME'); dec=sum(1 for r in holdout if r['f5Result']!='PUSH')
    home_rate=home/dec; away_rate=1-home_rate
    for r in chosen:
        hm=metrics(holdout,r['atoms'],{'horizon':horizon,'side':r['side']}); r['holdout']=hm
        if hm['decisiveRows']:
            p0=home_rate if r['side']=='HOME' else away_rate
            raw=binom_tail(hm['hits'],hm['decisiveRows'],p0)
            r['holdoutOneSidedPValueVsBaseline']=raw
            r['holdoutBonferroniPValueTopK']=min(1.0,raw*top_k)
        else:
            r['holdoutOneSidedPValueVsBaseline']=None; r['holdoutBonferroniPValueTopK']=None
    return {'horizon':horizon,'topK':top_k,'minimumDiscoveryDecisiveRows':min_decisive,'holdoutBaselineHomeDecisiveHitRate':home_rate,'rules':chosen,'attemptedRules':len(scored)}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--dataset',required=True); ap.add_argument('--starter-history',required=True); ap.add_argument('--lineup-history',required=True)
    ap.add_argument('--discovery-end',default='2025-07-31'); ap.add_argument('--out',required=True)
    args=ap.parse_args()
    dataset=load(args.dataset); starter=load(args.starter_history); lineup=load(args.lineup_history)
    rows=build_features(dataset,starter,lineup)
    discovery=[r for r in rows if r['officialDate']<=args.discovery_end]; holdout=[r for r in rows if r['officialDate']>args.discovery_end]
    if not discovery or not holdout: raise SystemExit('BOTH_PARTITIONS_REQUIRED')
    report={
      'schemaVersion':'courtedge-p0-step12-pocket-pilot.v1','generatedAt':datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),
      'evidenceStatus':'PILOT_RESEARCH_ONLY_NOT_BET_ELITE','source':{
        'datasetSha256':sha256_file(args.dataset),'starterHistorySha256':sha256_file(args.starter_history),'lineupHistorySha256':sha256_file(args.lineup_history),
        'officialGames':dataset['regularSeasonFinalGames'],'starterGames':starter['gamesWithBothStarters'],'completeLineupGames':lineup['completeLineupGames']},
      'split':{'discoveryEndDate':args.discovery_end,'discoveryRows':len(discovery),'discoveryDates':len({r['officialDate'] for r in discovery}),'holdoutRows':len(holdout),'holdoutDates':len({r['officialDate'] for r in holdout})},
      'featureMethod':{
        'team':'last up to 10 prior games with at least 5 prior games; same-date outcomes excluded',
        'starter':'prior-date ER/BF K-BB/BF HR/BF shrunk by 72 BF to prior league baseline; same-date outcomes excluded',
        'lineup':'T-5 official batting order; prior lineup appearance experience and previous-lineup continuity only; same-date lineups excluded',
        'thresholds':'10/20/30/70/80/90 discovery quantiles only','maxAtomsPerRule':3},
      'targets':[search_target(discovery,holdout,'FULL_GAME'),search_target(discovery,holdout,'FIRST_5')],
      'policy':{'historicalPricesUsed':False,'historicalEvClaimProduced':False,'holdoutThresholdTuningAllowed':False,'automaticBestRulePromotion':False,'betEliteProduced':False,'livePickFiltersChanged':False}
    }
    os.makedirs(os.path.dirname(args.out) or '.',exist_ok=True)
    with open(args.out,'w',encoding='utf-8') as f: json.dump(report,f,indent=2,sort_keys=True); f.write('\n')
    print(json.dumps({'out':args.out,'discoveryRows':len(discovery),'holdoutRows':len(holdout),'topFull':report['targets'][0]['rules'][0],'topF5':report['targets'][1]['rules'][0]},indent=2))
if __name__=='__main__': main()

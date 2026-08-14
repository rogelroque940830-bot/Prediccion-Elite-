#!/usr/bin/env python3
import argparse, json, math, os, statistics
from collections import Counter, defaultdict
from datetime import date, timedelta

SCHEMA='courtedge-p0-step12v19-volume-expansion-shadow.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
PACK_SCHEMA='courtedge-p0-step12v12-game-pitchmix-summary.v1'

def load(path):
    with open(path,encoding='utf-8') as f:return json.load(f)

def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def sigmoid(z):
    z=max(-50.0,min(50.0,float(z)))
    return 1.0/(1.0+math.exp(-z))

def frozen_prob(features,model):
    z=float(model['intercept'])
    for i,name in enumerate(model['features']):
        x=features.get(name)
        if not finite(x):x=model['medianImpute'][i]
        z += float(model['coef'][i])*((float(x)-float(model['mean'][i]))/float(model['scale'][i]))
    return sigmoid(z)

def is_premium_a(features,rules):
    return all(finite(features.get(rule['feature'])) and float(features[rule['feature']])>=float(rule['threshold']) for rule in rules)

def wilson(w,n):
    if not n:return {'lower':0.0,'upper':0.0}
    z=1.96;p=w/n;den=1+z*z/n
    mid=(p+z*z/(2*n))/den
    half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return {'lower':mid-half,'upper':mid+half}

def anchor_tuple(stats):
    return tuple(int(stats[k]) for k in ('selectedRows','decisiveRows','wins','losses','pushes'))

def basic_row_stats(rows,target):
    dec=[r for r in rows if r[target] is not None]
    w=sum(int(r[target]) for r in dec)
    return {'selectedRows':len(rows),'decisiveRows':len(dec),'wins':w,'losses':len(dec)-w,'pushes':len(rows)-len(dec)}

def build_pitchmix_history(pitch_dir,seasons,cfg):
    cats=tuple(cfg['families'])
    ph=defaultdict(list);th=defaultdict(list);lh=[]
    for season in seasons:
        pack=load(os.path.join(pitch_dir,f'pitchmix-{season}.json'))
        if pack.get('schemaVersion')!=PACK_SCHEMA:raise SystemExit(f'V19_PITCH_PACK_SCHEMA:{season}')
        for game in pack['games']:
            d=date.fromisoformat(game['officialDate'])
            for rec in game['pitcherTotals']:
                ph[int(rec['pitcherId'])].append((d,rec))
            by_team=defaultdict(list)
            for rec in game['teamPitchFamilyTotals']:
                by_team[int(rec['teamId'])].append(rec)
            for team_id,recs in by_team.items():th[team_id].append((d,recs))
            lh.append((d,game['teamPitchFamilyTotals']))
    for h in ph.values():h.sort(key=lambda x:x[0])
    for h in th.values():h.sort(key=lambda x:x[0])
    lh.sort(key=lambda x:x[0])
    return cats,ph,th,lh

def make_pitchmix_enricher(pitch_dir,seasons,cfg,lookback_days):
    cats,ph,th,lh=build_pitchmix_history(pitch_dir,seasons,cfg)
    pc={};tc={};lc={}
    def inside(d,t):return t-timedelta(days=lookback_days)<=d<t
    def sum_dict(dst,src):
        for k,v in src.items():
            if isinstance(v,(int,float)):dst[k]+=v
    def pagg(pid,t):
        key=(pid,t)
        if key in pc:return pc[key]
        out=defaultdict(float)
        for d,rec in ph.get(int(pid),[]):
            if inside(d,t):sum_dict(out,rec)
        pc[key]=dict(out);return pc[key]
    def tagg(tid,t):
        key=(tid,t)
        if key in tc:return tc[key]
        out={cat:defaultdict(float) for cat in cats}
        for d,recs in th.get(int(tid),[]):
            if not inside(d,t):continue
            for rec in recs:
                if rec['pitchFamily'] in out:sum_dict(out[rec['pitchFamily']],rec)
        tc[key]={cat:dict(v) for cat,v in out.items()};return tc[key]
    def lagg(t):
        if t in lc:return lc[t]
        out={cat:defaultdict(float) for cat in cats}
        for d,recs in lh:
            if not inside(d,t):continue
            for rec in recs:
                if rec['pitchFamily'] in out:sum_dict(out[rec['pitchFamily']],rec)
        lc[t]={cat:dict(v) for cat,v in out.items()};return lc[t]
    def smix(pid,t):
        p=pagg(pid,t);allp=float(p.get('allPitches',0));catp=float(p.get('categorizedPitches',0))
        return {'allPitches':allp,'categorizedShare':catp/allp if allp else 0.0,'mix':{cat:(float(p.get(cat,0))/catp if catp else 0.0) for cat in cats}}
    def rate(rec,metric):
        if metric in ('contact','whiff'):
            den=float(rec.get('swings',0));num=float(rec.get('contacts' if metric=='contact' else 'whiffs',0));mn=float(cfg['minimumTeamSwingsPerPitchFamily'])
        else:
            den=float(rec.get('terminalPa',0));num=float(rec.get('tb' if metric=='tbpa' else 'hr',0));mn=float(cfg['minimumTeamTerminalPaPerPitchFamily'])
        return num/den if den>=mn and den>0 else None
    def weighted_relative(tid,pid,t,metric):
        sm=smix(pid,t);ta=tagg(tid,t);la=lagg(t);num=cov=0.0
        for cat,weight in sm['mix'].items():
            tr=rate(ta[cat],metric);lr=rate(la[cat],metric)
            if tr is None or lr is None:continue
            num+=weight*(tr-lr);cov+=weight
        return {'value':num/cov if cov>0 else None,'coverage':cov,'starter':sm}
    def enrich(row):
        out=dict(row);t=date.fromisoformat(out['date']);reasons=[]
        if out['homeStarterId'] is None or out['awayStarterId'] is None:
            out.update({'pitchmix_rel_contact_adv':None,'pitchmix_rel_whiff_adv':None,'pitchmix_rel_tbpa_adv':None,'pitchmix_rel_hrpa_adv':None,'pitchmixEligible':False,'positiveCount':0})
            return out
        hs=smix(out['homeStarterId'],t);aws=smix(out['awayStarterId'],t)
        for label,sm in (('HOME',hs),('AWAY',aws)):
            if sm['allPitches']<float(cfg['minimumStarterAllPitches365d']):reasons.append(label+'_LOW_PITCHES')
            if sm['categorizedShare']<float(cfg['minimumStarterCategorizedShare']):reasons.append(label+'_LOW_CATEGORY_SHARE')
        pairs={}
        for label,metric in (('CONTACT','contact'),('WHIFF','whiff'),('TBPA','tbpa'),('HRPA','hrpa')):
            home=weighted_relative(out['homeTeamId'],out['awayStarterId'],t,metric)
            away=weighted_relative(out['awayTeamId'],out['homeStarterId'],t,metric)
            pairs[label]=(home,away)
            if home['coverage']<float(cfg['minimumWeightedMetricCoverageShare']) or away['coverage']<float(cfg['minimumWeightedMetricCoverageShare']):reasons.append(label+'_LOW_COVERAGE')
        vals={
          'pitchmix_rel_contact_adv':None if any(x['value'] is None for x in pairs['CONTACT']) else pairs['CONTACT'][0]['value']-pairs['CONTACT'][1]['value'],
          'pitchmix_rel_whiff_adv':None if any(x['value'] is None for x in pairs['WHIFF']) else pairs['WHIFF'][1]['value']-pairs['WHIFF'][0]['value'],
          'pitchmix_rel_tbpa_adv':None if any(x['value'] is None for x in pairs['TBPA']) else pairs['TBPA'][0]['value']-pairs['TBPA'][1]['value'],
          'pitchmix_rel_hrpa_adv':None if any(x['value'] is None for x in pairs['HRPA']) else pairs['HRPA'][0]['value']-pairs['HRPA'][1]['value']}
        if any(v is None for v in vals.values()):reasons.append('METRIC_VALUE_MISSING')
        out.update(vals);out['pitchmixEligible']=not reasons
        out['positiveCount']=sum(1 for v in vals.values() if finite(v) and float(v)>0)
        return out
    return enrich

def opp(row,market,route):
    target='fgY' if market=='FULL_GAME_HOME_ML' else 'f5Y'
    return {'season':row['season'],'date':row['date'],'gamePk':row['gamePk'],'market':market,'route':route,'y':row[target]}

def portfolio_stats(opportunities,eligible_dates,seasons):
    dec=[o for o in opportunities if o['y'] is not None];wins=sum(int(o['y']) for o in dec);n=len(dec)
    game_keys={(o['date'],o['gamePk']) for o in opportunities}
    markets_by_game=defaultdict(set)
    for o in opportunities:markets_by_game[(o['date'],o['gamePk'])].add(o['market'])
    same_multi=sum(1 for markets in markets_by_game.values() if len(markets)>1)
    counts=Counter(o['date'] for o in opportunities);unique_counts=Counter()
    for d,g in game_keys:unique_counts[d]+=1
    ordered=sorted(eligible_dates);vals=[counts[d] for d in ordered];uvals=[unique_counts[d] for d in ordered]
    def pct(predicate):return 100.0*sum(1 for x in vals if predicate(x))/len(vals) if vals else 0.0
    by={}
    for s in seasons:
        z=[o for o in opportunities if o['season']==s];zd=[o for o in z if o['y'] is not None];zw=sum(int(o['y']) for o in zd)
        by[s]={'opportunities':len(z),'decisiveRows':len(zd),'wins':zw,'losses':len(zd)-zw,'pushes':len(z)-len(zd),'uniqueGames':len({(o['date'],o['gamePk']) for o in z})}
    return {
      'opportunities':len(opportunities),'uniqueGames':len(game_keys),'decisiveRows':n,'wins':wins,'losses':n-wins,'pushes':len(opportunities)-n,
      'hitRate':wins/n if n else None,'wilson95':wilson(wins,n),'sameGameMultiMarketGames':same_multi,
      'eligibleSlateDays':len(ordered),'meanOpportunitiesPerEligibleSlateDay':sum(vals)/len(vals) if vals else 0.0,
      'medianOpportunitiesPerEligibleSlateDay':statistics.median(vals) if vals else 0.0,
      'meanUniqueGamesPerEligibleSlateDay':sum(uvals)/len(uvals) if uvals else 0.0,
      'pctDaysWithZero':pct(lambda x:x==0),'pctDaysWithAtLeast1':pct(lambda x:x>=1),'pctDaysWithAtLeast2':pct(lambda x:x>=2),'pctDaysWithAtLeast3':pct(lambda x:x>=3),
      'maxOpportunitiesOnOneDay':max(vals) if vals else 0,'bySeason':by,
      'dailyDistribution':dict(sorted(Counter(vals).items()))
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--root',required=True);ap.add_argument('--pitch-dir',required=True);ap.add_argument('--v7-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();c=load(a.contract);v7=load(a.v7_report)
    if c.get('schemaVersion')!='courtedge-p0-step12v19-volume-expansion-shadow-contract.v1':raise SystemExit('V19_CONTRACT_INVALID')
    seasons=tuple(c['dataBoundary']['evaluationSeasons']);all_pitch=(c['dataBoundary']['pitchmixWarmupSeason'],)+seasons
    thr=v7['thresholdSelection2023'];expected=c['frozenF5Consensus']['expectedThresholds']
    if abs(float(thr['c4'])-float(expected['c4']))>1e-12 or abs(float(thr['full13'])-float(expected['full13']))>1e-12:raise SystemExit('V19_F5_THRESHOLD_DRIFT')
    m1=v7['fitted2022Models']['F5_C4'];m2=v7['fitted2022Models']['F5_FULL13']
    rows=[];eligible_dates=set()
    for s in seasons:
        tab=load(os.path.join(a.root,s,'game-anatomy-feature-table.json'))
        if tab.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V19_BASE_SCHEMA:{s}')
        for raw in tab['rows']:
            if not raw.get('t5PregameValid'):continue
            d=raw['officialDate'];eligible_dates.add(d);f=raw['features']
            o5=raw['outcomes']['FIRST_5'];ofg=raw['outcomes']['FULL_GAME']
            hp=raw.get('t5HomeProbablePitcherId');ap0=raw.get('t5AwayProbablePitcherId')
            rows.append({'season':s,'date':d,'gamePk':int(raw['gamePk']),'homeTeamId':int(raw['homeTeamId']),'awayTeamId':int(raw['awayTeamId']),
              'homeStarterId':int(hp) if hp is not None else None,'awayStarterId':int(ap0) if ap0 is not None else None,
              'premiumA':is_premium_a(f,c['frozenPremiumA']['all']),
              'f5Consensus':frozen_prob(f,m1)>=float(thr['c4']) and frozen_prob(f,m2)>=float(thr['full13']),
              'fgY':int(ofg['homeRuns']>ofg['awayRuns']),'f5Y':None if o5['homeRuns']==o5['awayRuns'] else int(o5['homeRuns']>o5['awayRuns'])})
    premium=[r for r in rows if r['premiumA']];f5=[r for r in rows if r['f5Consensus']];af5=[r for r in f5 if r['premiumA']];outside=[r for r in f5 if not r['premiumA']]
    anchors=c['frozenAnchors']
    raw_anchors={
      'PREMIUM_A_FG':basic_row_stats(premium,'fgY'),
      'F5_CONSENSUS':basic_row_stats(f5,'f5Y'),
      'A_INTERSECT_F5_CONSENSUS':basic_row_stats(af5,'f5Y'),
      'F5_CONSENSUS_OUTSIDE_A':basic_row_stats(outside,'f5Y')}
    for name,actual in raw_anchors.items():
        expected_anchor=anchors[name]
        if anchor_tuple(actual)!=anchor_tuple(expected_anchor):raise SystemExit(f'V19_ANCHOR_DRIFT:{name}:{anchor_tuple(actual)}:{anchor_tuple(expected_anchor)}')
    enrich=make_pitchmix_enricher(a.pitch_dir,all_pitch,c['frozenPitchmix'],int(c['dataBoundary']['rollingPitchmixLookbackDays']))
    outside=[enrich(r) for r in outside]
    def flags(r):
        if not r['pitchmixEligible']:return False,False
        hr=finite(r['pitchmix_rel_hrpa_adv']) and float(r['pitchmix_rel_hrpa_adv'])>0
        tb=finite(r['pitchmix_rel_tbpa_adv']) and float(r['pitchmix_rel_tbpa_adv'])>0
        at2=int(r['positiveCount'])>=2
        return hr or at2,hr or tb or at2
    hrpa=[r for r in outside if flags(r)[0]];pareto=[r for r in outside if flags(r)[1]]
    refined_anchors={'F5_OUTSIDE_A_HRPA_OR_AT2':basic_row_stats(hrpa,'f5Y'),'F5_OUTSIDE_A_PARETO_UNION':basic_row_stats(pareto,'f5Y')}
    for name,actual in refined_anchors.items():
        if anchor_tuple(actual)!=anchor_tuple(anchors[name]):raise SystemExit(f'V19_ANCHOR_DRIFT:{name}:{anchor_tuple(actual)}:{anchor_tuple(anchors[name])}')
    premium_fg=[opp(r,'FULL_GAME_HOME_ML','PREMIUM_A_HOME_ML') for r in premium]
    f5_all=[opp(r,'FIRST_5_HOME_ML','F5_CONSENSUS') for r in f5]
    a_f5=[opp(r,'FIRST_5_HOME_ML','A_INTERSECT_F5_CONSENSUS') for r in af5]
    hrpa_f5=[opp(r,'FIRST_5_HOME_ML','F5_HRPA_OR_AT2') for r in hrpa]
    pareto_f5=[opp(r,'FIRST_5_HOME_ML','F5_PARETO_UNION') for r in pareto]
    switch=[]
    for r in premium:
        switch.append(opp(r,'FIRST_5_HOME_ML' if r['f5Consensus'] else 'FULL_GAME_HOME_ML','PREMIUM_A_ROUTE_SWITCH'))
    portfolios={
      'PREMIUM_A_FG_ONLY':premium_fg,
      'F5_CONSENSUS_ALL':f5_all,
      'PREMIUM_A_ROUTE_SWITCH':switch,
      'PREMIUM_A_PLUS_OUTSIDE_HRPA_OR_AT2':premium_fg+hrpa_f5,
      'PREMIUM_A_PLUS_OUTSIDE_PARETO':premium_fg+pareto_f5,
      'ROUTE_SWITCH_PLUS_OUTSIDE_HRPA_OR_AT2':switch+hrpa_f5,
      'ROUTE_SWITCH_PLUS_OUTSIDE_PARETO':switch+pareto_f5,
      'MULTI_MARKET_HRPA_OR_AT2':premium_fg+a_f5+hrpa_f5,
      'MULTI_MARKET_PARETO':premium_fg+a_f5+pareto_f5,
      'MAX_EXISTING_ROUTE_UNION':premium_fg+f5_all}
    results={name:portfolio_stats(opps,eligible_dates,seasons) for name,opps in portfolios.items()}
    base=results['PREMIUM_A_FG_ONLY'];target=float(c['operationalDiagnostics']['primaryTargetMeanOpportunitiesPerEligibleSlateDay'])
    comparisons={}
    for name,st in results.items():
        comparisons[name]={
          'meanOpportunityUpliftVsPremiumA':st['meanOpportunitiesPerEligibleSlateDay']-base['meanOpportunitiesPerEligibleSlateDay'],
          'daysAtLeast1UpliftPpVsPremiumA':st['pctDaysWithAtLeast1']-base['pctDaysWithAtLeast1'],
          'meetsPrimaryMeanOnePerDayDiagnostic':st['meanOpportunitiesPerEligibleSlateDay']>=target}
    report={'schemaVersion':SCHEMA,'classification':'SHADOW_VOLUME_EXPANSION_FROM_FROZEN_PRIOR_ROUTES_NOT_PROMOTION','eligibleSlateDays':len(eligible_dates),
      'anchors':{**raw_anchors,**refined_anchors},'portfolios':results,'comparisons':comparisons,
      'diagnosis':{'routeLedgerCanIncreaseResearchCoverage':True,'historicalPricesUsed':False,'positiveEvEstablished':False,'sameGameMultipleMarketsTreatedAsCorrelated':True},
      'policy':{'researchOnly':True,'shadowOnly':True,'sameDateOutcomeLeakageAllowed':False,'thresholdSearchUsed':False,'featureSearchUsed':False,'liveLookupAuthorizationChanged':False,'liveFilterChanged':False,'betEliteAllowed':False,'automaticBetPlacement':False,'realFinancialExposure':0,'prospectiveStep11cRequiredBeforePromotion':True}}
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'eligibleSlateDays':len(eligible_dates),'portfolios':{k:{x:v[x] for x in ('opportunities','uniqueGames','hitRate','meanOpportunitiesPerEligibleSlateDay','pctDaysWithAtLeast1','pctDaysWithAtLeast2','pctDaysWithAtLeast3','sameGameMultiMarketGames')} for k,v in results.items()}},indent=2))
if __name__=='__main__':main()

#!/usr/bin/env python3
import argparse,importlib.util,json,os
from collections import defaultdict,deque
from datetime import date,timedelta
import numpy as np

REPORT_SCHEMA='courtedge-p0-step12v65-contact-process-matchup-winner.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v65-contact-process-matchup-winner-contract.v1'
CONTACT_SCHEMA='courtedge-p0-step12v65-contact-process-pbp.v1'
V62_REPORT_SCHEMA='courtedge-p0-step12v62-pitch-quality-winner.v1'
V64_REPORT_SCHEMA='courtedge-p0-step12v64-contact-damage-winner.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def dump(p,v):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')

def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def empty_process():return {'swings':0.0,'whiffs':0.0,'battedBallEvents':0.0,'launchSpeedN':0.0,'launchSpeedSum':0.0,'hardHitN':0.0}

def add_process(a,b):
    for k in a:a[k]+=float(b.get(k,0) or 0)

def aggregate_history(q,d,lookback):
    cutoff=d-timedelta(days=int(lookback))
    while q and q[0][0]<cutoff:q.popleft()
    z=empty_process()
    for _,x in q:add_process(z,x)
    return z

def shrink_mean(total,n,anchor,w):return (float(total)+float(w)*float(anchor))/(float(n)+float(w))
def shrink_rate(num,den,anchor,w):return (float(num)+float(w)*float(anchor))/(float(den)+float(w))

def contact_rates(z,league,c,side):
    e=c['contactProcessEngineering']
    if side=='batter':we=float(e['batterExitVelocityShrinkagePriorBattedBalls']);whh=float(e['batterHardHitShrinkagePriorBattedBalls']);ww=float(e['batterWhiffShrinkagePriorSwings'])
    else:we=float(e['starterExitVelocityAllowedShrinkagePriorBattedBalls']);whh=float(e['starterHardHitAllowedShrinkagePriorBattedBalls']);ww=float(e['starterWhiffShrinkagePriorSwings'])
    lev=league['launchSpeedSum']/league['launchSpeedN'] if league['launchSpeedN']>0 else None
    lhh=league['hardHitN']/league['launchSpeedN'] if league['launchSpeedN']>0 else None
    lwh=league['whiffs']/league['swings'] if league['swings']>0 else None
    if lev is None or lhh is None or lwh is None:return None
    return {
      'ev':shrink_mean(z['launchSpeedSum'],z['launchSpeedN'],lev,we),
      'hh':shrink_rate(z['hardHitN'],z['launchSpeedN'],lhh,whh),
      'whiff':shrink_rate(z['whiffs'],z['swings'],lwh,ww),
      'leagueEv':float(lev),'leagueHh':float(lhh),'leagueWhiff':float(lwh)
    }

def normalized_weights(ids,sst,gst,v60,c):
    w=float(c['contactProcessEngineering']['lineupSlotWorkloadShrinkagePriorStarts']);vals=[]
    for pos,_ in enumerate(ids,1):
        pa=v60.slot_pa(sst[pos],gst,w)
        if pa is None or not v60.finite(pa) or float(pa)<=0:return None
        vals.append(float(pa))
    den=sum(vals)
    return [x/den for x in vals] if den>0 else None

def team_contact(ids,weights,starter_id,d,bhist,phist,league_hist,v60,c):
    lookback=int(c['contactProcessEngineering']['lookbackDays']);league=aggregate_history(league_hist,d,lookback);lr=contact_rates(league,league,c,'batter')
    if lr is None or weights is None or int(starter_id)<=0:return None
    ev=hh=wh=0.0
    for bid,w in zip(ids,weights):
        br=contact_rates(aggregate_history(bhist[int(bid)],d,lookback),league,c,'batter')
        if br is None:return None
        ev+=w*br['ev'];hh+=w*br['hh'];wh+=w*br['whiff']
    sr=contact_rates(aggregate_history(phist[int(starter_id)],d,lookback),league,c,'starter')
    if sr is None:return None
    return {
      'exit':(ev-lr['leagueEv'])+(sr['ev']-lr['leagueEv']),
      'hard':(hh-lr['leagueHh'])+(sr['hh']-lr['leagueHh']),
      'whiffResistance':(lr['leagueWhiff']-wh)+(lr['leagueWhiff']-sr['whiff'])
    }

def daily_process(events):
    bat=defaultdict(empty_process);pit=defaultdict(empty_process);league=empty_process()
    for g in events:
        for x in g.get('batterProcessTotals',[]):
            bid=int(x.get('batterId') or 0)
            if bid>0:add_process(bat[bid],x);add_process(league,x)
        for x in g.get('pitcherProcessTotals',[]):
            pid=int(x.get('pitcherId') or 0)
            if pid>0:add_process(pit[pid],x)
    return bat,pit,league

def add_contact_features(rows,lineup_root,batter_root,hands_root,contact_root,seasons,c,v60):
    lineups={};batgames={};hands={};packs={};events=defaultdict(list);bydate=defaultdict(list);slot_state={};stats={}
    for s in seasons:
        ls=load(os.path.join(lineup_root,s,'cohort','pregame-lineup-history.json'));lineups[s]={int(x['gamePk']):x for x in ls.get('snapshots',[])}
        bh=load(os.path.join(batter_root,s,'batter-history.json'));batgames[s]={int(x['gamePk']):x for x in bh.get('games',[])}
        hp=load(os.path.join(hands_root,f'pregame-hands-{s}.json'));hands[s]={int(x['gamePk']):x for x in hp.get('snapshots',[])}
        slot_state[s]=(defaultdict(v60.empty_slot),v60.empty_slot())
        stats[s]={'rows':len(rows[s]),'starterIdentityUsable':0,'contactAvailable':0,'minimumBatterPriorLaunchSpeedN':[],'minimumStarterPriorLaunchSpeedN':[]}
        for r in rows[s]:bydate[str(r['officialDate'])].append((s,r))
    warm=str(c['dataBoundary']['warmupSeason'])
    for s in [warm,*seasons]:
        p=load(os.path.join(contact_root,f'contact-process-{s}.json'))
        if p.get('schemaVersion')!=CONTACT_SCHEMA or int(p.get('contractRevision',-1))!=2:raise SystemExit(f'V65_CONTACT_PACK_INVALID:{s}')
        packs[s]=p
        for g in p.get('games',[]):events[str(g['officialDate'])].append(g)
    bhist=defaultdict(deque);phist=defaultdict(deque);league_hist=deque();lookback=int(c['contactProcessEngineering']['lookbackDays'])
    fns=list(c['contactProcessEngineering']['featuresExactly'])
    if len(fns)!=3:raise SystemExit('V65_CONTACT_FEATURE_COUNT_INVALID')
    processed=0
    for ds in sorted(events):
        d=date.fromisoformat(ds)
        targets=sorted(bydate.get(ds,[]),key=lambda z:int(z[1]['gamePk']))
        for s,r in targets:
            pk=int(r['gamePk']);lm=lineups[s].get(pk);h,a=v60.lineup(lm)
            if h is None or a is None:raise SystemExit(f'V65_COMPLETE_T5_LINEUP_REQUIRED:{s}:{pk}')
            hs=hands[s].get(pk) or {};identity_ok=hs.get('usable') is True and int(hs.get('homePitcherId') or 0)>0 and int(hs.get('awayPitcherId') or 0)>0
            if identity_ok:stats[s]['starterIdentityUsable']+=1
            hp=int(hs.get('homePitcherId') or 0) if identity_ok else 0;ap=int(hs.get('awayPitcherId') or 0) if identity_ok else 0
            sst,gst=slot_state[s];hw=normalized_weights(h,sst,gst,v60,c);aw=normalized_weights(a,sst,gst,v60,c)
            home=team_contact(h,hw,ap,d,bhist,phist,league_hist,v60,c) if identity_ok else None
            away=team_contact(a,aw,hp,d,bhist,phist,league_hist,v60,c) if identity_ok else None
            if home is not None and away is not None:
                r[fns[0]]=float(home['exit']-away['exit']);r[fns[1]]=float(home['hard']-away['hard']);r[fns[2]]=float(home['whiffResistance']-away['whiffResistance']);stats[s]['contactAvailable']+=1
                minb=min(aggregate_history(bhist[int(b)],d,lookback)['launchSpeedN'] for b in h+a);mins=min(aggregate_history(phist[p],d,lookback)['launchSpeedN'] for p in (hp,ap));stats[s]['minimumBatterPriorLaunchSpeedN'].append(float(minb));stats[s]['minimumStarterPriorLaunchSpeedN'].append(float(mins))
            else:
                for f in fns:r[f]=None
            processed+=1
        # Freeze every feature for the date above before any same-date contact process is added.
        dbat,dpit,dleague=daily_process(events[ds])
        for bid,z in dbat.items():bhist[bid].append((d,z))
        for pid,z in dpit.items():phist[pid].append((d,z))
        league_hist.append((d,dleague))
        # Reproduce V60 slot-workload chronology independently inside each season, also only after the date is scored.
        for s,r in targets:
            pk=int(r['gamePk']);h,a=v60.lineup(lineups[s].get(pk));bg=batgames[s].get(pk)
            if h is None or a is None or bg is None:raise SystemExit(f'V65_SLOT_UPDATE_INPUT_MISSING:{s}:{pk}')
            sst,gst=slot_state[s]
            for side,ids in (('homeBatters',h),('awayBatters',a)):
                m={int(x['batterId']):x for x in bg.get(side,[])}
                for pos,bid in enumerate(ids,1):
                    z=m.get(int(bid));pa=int(z.get('plateAppearances',0)) if z else 0
                    if pa>0:sst[pos]['starts']+=1;sst[pos]['pa']+=pa;gst['starts']+=1;gst['pa']+=pa
    expected=sum(len(rows[s]) for s in seasons)
    if processed!=expected:raise SystemExit(f'V65_CONTACT_TARGET_PROCESS_COUNT_DRIFT:{processed}:{expected}')
    out={}
    for s in seasons:
        n=len(rows[s]);z=stats[s]
        out[s]={
          'rows':n,
          'pregameStarterIdentityPairUsableGames':z['starterIdentityUsable'],
          'pregameStarterIdentityPairUsableShare':z['starterIdentityUsable']/n if n else 0.0,
          'gamesWithAllThreeContactProcessFeaturesAvailable':z['contactAvailable'],
          'contactProcessFullFeatureDerivedShare':z['contactAvailable']/n if n else 0.0,
          'gamesUsingTrainingMedianForAtLeastOneContactFeature':n-z['contactAvailable'],
          'medianMinimumBatterPriorLaunchSpeedN':float(np.median(z['minimumBatterPriorLaunchSpeedN'])) if z['minimumBatterPriorLaunchSpeedN'] else None,
          'medianMinimumStarterPriorLaunchSpeedN':float(np.median(z['minimumStarterPriorLaunchSpeedN'])) if z['minimumStarterPriorLaunchSpeedN'] else None
        }
    return out,packs

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--control-root',required=True);ap.add_argument('--lineup-root',required=True);ap.add_argument('--batter-root',required=True);ap.add_argument('--hands-root',required=True);ap.add_argument('--contact-root',required=True);ap.add_argument('--pitch-root',required=True);ap.add_argument('--v16-report',required=True);ap.add_argument('--v16-manifest',required=True);ap.add_argument('--v62-report',required=True);ap.add_argument('--v64-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);x=ap.parse_args()
    c=load(x.contract)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA or c.get('contractRevision')!=2:raise SystemExit('V65_CONTRACT_INVALID')
    if c.get('scientificStatus')!='FROZEN_CONTACT_PROCESS_SOURCE_SEMANTICS_CORRECTED_BEFORE_V65_OUTCOME_SCORER':raise SystemExit('V65_CONTRACT_STATUS_INVALID')
    if c['preOutcomeCorrection']['v65OutcomeMetricsAvailableAtCorrection'] is not False:raise SystemExit('V65_PRE_OUTCOME_CORRECTION_INVALID')
    v60=module('scripts/p0-step12v60-individual-lineup-platoon-winner.py','v60v65');v62=module('scripts/p0-step12v62-pitch-quality-winner.py','v62v65');v64=module('scripts/p0-step12v64-contact-damage-winner.py','v64v65')
    v60c=load('research/p0-step12v60-individual-lineup-platoon-winner-contract.json');v62c=load('research/p0-step12v62-pitch-quality-winner-contract.json');vr=load(x.v16_report);vm=load(x.v16_manifest);v62r=load(x.v62_report);v64r=load(x.v64_report)
    if vr.get('classification')!=c['parentEvidence']['v16RequiredClassification'] or v60.digest(vm)!=c['parentEvidence']['v16ManifestSha256']:raise SystemExit('V65_V16_PARENT_INVALID')
    if v62r.get('schemaVersion')!=V62_REPORT_SCHEMA or v62r.get('classification')!=c['parentEvidence']['v62FrozenClassification']:raise SystemExit('V65_V62_PARENT_INVALID')
    if v64r.get('schemaVersion')!=V64_REPORT_SCHEMA or v64r.get('classification')!=c['parentEvidence']['v64FrozenClassification']:raise SystemExit('V65_V64_PARENT_INVALID')
    ctl=vm['fullGame'];base=list(c['control']['featuresExactly'])
    if ctl.get('featureSet')!=c['control']['featureSetRequired'] or ctl['preprocessor']['features']!=base:raise SystemExit('V65_CONTROL_FEATURE_DRIFT')
    seasons=[c['dataBoundary']['trainingSeason'],c['dataBoundary']['calibrationSeason'],*c['dataBoundary']['retrospectiveEvaluationSeasons']];rows={};v60cust={}
    for s in seasons:
        rows[s],v60cust[s]=v60.build_rows(x.control_root,x.lineup_root,x.batter_root,x.hands_root,s,v60c)
        if len(rows[s])!=int(c['dataBoundary']['expectedRowsBySeason'][s]):raise SystemExit(f'V65_ROW_COUNT_DRIFT:{s}')
    contact_cust,contact_packs=add_contact_features(rows,x.lineup_root,x.batter_root,x.hands_root,x.contact_root,seasons,c,v60)
    starter_cust=v64.add_frozen_starter_quality(rows,x.hands_root,x.pitch_root,seasons,c,v62,v62c)
    evs=list(c['dataBoundary']['retrospectiveEvaluationSeasons']);tol=float(c['control']['metricParityAbsoluteTolerance'])
    for s in evs:
        y=np.asarray([r['homeWin'] for r in rows[s]],float);cm=v60.metrics(v60.predict(ctl,rows[s]),y);exp=vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V65_V16:{s}:{k}',cm[k],exp[k],tol)
    ev=[r for s in evs for r in rows[s]];y=np.asarray([r['homeWin'] for r in ev],float);cp=v60.predict(ctl,ev);cc=v60.metrics(cp,y);exp=vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V65_V16:combined:{k}',cc[k],exp[k],tol)
    contact=list(c['contactProcessEngineering']['featuresExactly']);quality=list(c['starterQualityEngineering']['featuresExactly']);cfs=tuple(base+contact);qfs=tuple(base+quality);ffs=tuple(base+contact+quality)
    if len(ffs)!=int(c['challenger']['featureCount']) or len(set(ffs))!=len(ffs):raise SystemExit('V65_FEATURE_COUNT_INVALID')
    tr=rows['2022'];ca=rows['2023'];l2=float(c['challenger']['l2Strength']);cm=v60.fit_model(tr,ca,cfs,l2,c['predeclaredDiagnostics']['contactProcessOnly']);qm=v60.fit_model(tr,ca,qfs,l2,c['predeclaredDiagnostics']['starterQualityOnly']);fm=v60.fit_model(tr,ca,ffs,l2,c['challenger']['featureSet'])
    yc=np.asarray([r['homeWin'] for r in ca],float);vc=v60.metrics(v60.predict(ctl,ca),yc);vcontact=v60.metrics(v60.predict(cm,ca),yc);vq=v60.metrics(v60.predict(qm,ca),yc);vf=v60.metrics(v60.predict(fm,ca),yc)
    val={'rows':len(ca),'control':vc,'contactProcessOnly':vcontact,'starterQualityOnly':vq,'challenger':vf,'challengerImprovementVsControl':v60.compare(vc,vf)}
    by={}
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]],float);a=v60.metrics(v60.predict(ctl,rows[s]),ys);b=v60.metrics(v60.predict(cm,rows[s]),ys);q=v60.metrics(v60.predict(qm,rows[s]),ys);f=v60.metrics(v60.predict(fm,rows[s]),ys);by[s]={'rows':len(rows[s]),'control':a,'contactProcessOnly':b,'starterQualityOnly':q,'challenger':f,'challengerImprovementVsControl':v60.compare(a,f)}
    contactp=v60.predict(cm,ev);qualityp=v60.predict(qm,ev);fp=v60.predict(fm,ev);contactm=v60.metrics(contactp,y);qualitym=v60.metrics(qualityp,y);fc=v60.metrics(fp,y)
    comb={'rows':len(ev),'control':cc,'contactProcessOnly':contactm,'starterQualityOnly':qualitym,'challenger':fc,'contactProcessOnlyImprovementVsControl':v60.compare(cc,contactm),'starterQualityOnlyImprovementVsControl':v60.compare(cc,qualitym),'challengerImprovementVsControl':v60.compare(cc,fc)}
    bcfg=c['pairedBootstrap'];boot=v60.bootstrap(ev,cp,fp,y,int(bcfg['resamples']),int(bcfg['seed']),float(bcfg['confidenceLevel']))
    gate=c['coverageGate'];coverage=True
    allpacks=[str(c['dataBoundary']['warmupSeason']),*seasons]
    for s in allpacks:
        p=contact_packs[s];coverage=coverage and float(p['failureShare'])<=float(gate['maximumTargetGameFetchFailureShareEachSeason'] if s!=str(c['dataBoundary']['warmupSeason']) else 0.01);coverage=coverage and float(p['launchSpeedTelemetryShareOfHitDataBattedBallEvents'])>=float(gate['minimumLaunchSpeedTelemetryShareOfHitDataBattedBallEventsEachTargetSeason'])
    parent_cust=v62r['data']['custody']
    for s in seasons:
        coverage=coverage and float(contact_cust[s]['pregameStarterIdentityPairUsableShare'])>=float(gate['minimumPregameStarterIdentityPairShareEachTargetSeason'])
        if s in evs:
            coverage=coverage and float(contact_cust[s]['contactProcessFullFeatureDerivedShare'])>=float(gate['minimumContactProcessFullFeatureDerivedShareEachEvaluationSeason'])
            coverage=coverage and float(parent_cust[s]['fullFeatureDerivedShare'])>=float(gate['minimumV62StarterQualityFullFeatureDerivedShareEachEvaluationSeason'])
    vi=val['challengerImprovementVsControl'];ci=comb['challengerImprovementVsControl'];both=[by[s]['challengerImprovementVsControl']['logLoss']>0 and by[s]['challengerImprovementVsControl']['brier']>0 for s in evs];worse=[by[s]['challengerImprovementVsControl']['logLoss']<0 and by[s]['challengerImprovementVsControl']['brier']<0 for s in evs];rub=c['candidateRubric']
    checks={'controlManifestAndMetricParity':True,'validation2023LogLossImproved':vi['logLoss']>0,'validation2023BrierImproved':vi['brier']>0,'combinedLogLossImproved':ci['logLoss']>0,'combinedBrierImproved':ci['brier']>0,'bootstrapLogLossLowerBoundPositive':boot['logLossImprovement']['lower']>0,'bootstrapBrierLowerBoundPositive':boot['brierImprovement']['lower']>0,'atLeastTwoOfThreeEvaluationSeasonsImproveBoth':sum(both)>=2,'noEvaluationSeasonWorseOnBoth':not any(worse),'challengerCombinedEce10WithinAbsoluteMax':fc['ece10']<=float(rub['ece10AbsoluteMaximum']),'challengerAbsoluteMeanProbabilityGapNotWorseThanControl':fc['absoluteMeanHomeProbabilityGap']<=cc['absoluteMeanHomeProbabilityGap']+float(rub['meanProbabilityGapComparisonTolerance'])}
    passed=coverage and all(checks.values());classification=rub['passingClassification'] if passed else (rub['failingClassification'] if coverage else gate['belowGateClassification'])
    v62combined=v62r['combinedEvaluation2024_2026Ytd']['challenger'];v64combined=v64r['combinedEvaluation2024_2026Ytd']['challenger']
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'scientificStatus':c['scientificStatus'],'target':'FULL_GAME_HOME_WIN','data':{'seasonRows':{s:len(rows[s]) for s in seasons},'contactProcessCustody':{s:{k:contact_packs[s][k] for k in ('gamesExpected','gamesFetched','failureShare','swings','whiffs','battedBallEvents','launchSpeedN','launchSpeedTelemetryShareOfHitDataBattedBallEvents','hardHitN')} for s in allpacks},'contactFeatureCustody':contact_cust,'starterQualityFeatureCustody':starter_cust,'frozenV62ParentCustody':parent_cust},'controlParity':{'modelVersion':vm['modelVersion'],'manifestSha256':v60.digest(vm),'featureSet':ctl['featureSet'],'features':ctl['preprocessor']['features'],'combinedAndBySeasonMetricsReproduced':True},'features':{'controlCount':len(base),'contactProcessCount':len(contact),'starterQualityCount':len(quality),'challengerCount':len(ffs),'challengerFeatures':list(ffs)},'models':{'contactProcessOnly':cm,'starterQualityOnly':qm,'challenger':fm},'validation2023':val,'evaluationBySeason':by,'combinedEvaluation2024_2026Ytd':comb,'pairedDateBootstrapVsControl2024_2026Ytd':boot,'candidateRubricChecks':checks,'diagnostics':{'frozenV62IsDiagnosticOnlyNotPromotionControl':True,'frozenV64IsDiagnosticOnlyNotPromotionControl':True,'diagnosticResultsMayNotChoosePromotionCandidate':True,'v62FrozenClassification':v62r['classification'],'v64FrozenClassification':v64r['classification'],'improvementVsFrozenV62Combined':v60.compare(v62combined,fc),'improvementVsFrozenV64Combined':v60.compare(v64combined,fc)},'policy':{'researchOnly':True,'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'subsetMiningUsed':False,'homeAwaySubsetMiningUsed':False,'seasonExclusionAfterResultsUsed':False,'postResultRuleChangeAllowed':False,'postResultFeatureAdditionAllowed':False,'postResultFeatureRemovalAllowed':False,'postResultShrinkageChangeAllowed':False,'postResultLookbackChangeAllowed':False,'postResultTelemetryDefinitionChangeAllowed':False,'v16ProductionChanged':False,'productionMarketRegistryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'positiveEvEstablished':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'validation2023':vi,'combined':ci,'contactProcessOnly':comb['contactProcessOnlyImprovementVsControl'],'starterQualityOnly':comb['starterQualityOnlyImprovementVsControl'],'bootstrap':boot,'bySeason':{s:by[s]['challengerImprovementVsControl'] for s in evs},'vsV62':report['diagnostics']['improvementVsFrozenV62Combined'],'vsV64':report['diagnostics']['improvementVsFrozenV64Combined'],'checks':checks},indent=2))

if __name__=='__main__':main()

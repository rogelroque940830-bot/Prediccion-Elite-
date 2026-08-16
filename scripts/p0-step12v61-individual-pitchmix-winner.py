#!/usr/bin/env python3
import argparse,importlib.util,json,math,os
from collections import defaultdict,deque
from datetime import date,timedelta
import numpy as np

REPORT_SCHEMA='courtedge-p0-step12v61-individual-pitchmix-winner.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v61-individual-pitchmix-winner-contract.v1'
PITCH_SCHEMA='courtedge-p0-step12v61-pitch-family-pbp.v1'
V60_REPORT_SCHEMA='courtedge-p0-step12v60-individual-lineup-platoon-winner.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,v):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def load_v60():
    p=os.path.join('scripts','p0-step12v60-individual-lineup-platoon-winner.py')
    spec=importlib.util.spec_from_file_location('v60frozen',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def empty_outcome():return {'pa':0.,'h':0.,'tb':0.,'bb':0.,'k':0.,'hr':0.}
def add_out(a,b):
    for k in a:a[k]+=float(b.get(k,0))
def sum_out(items):
    a=empty_outcome()
    for x in items:add_out(a,x)
    return a
def rate(rec,k):return float(rec[k])/float(rec['pa']) if rec['pa']>0 else None
def shrink(num,den,anchor,w):return (float(num)+float(w)*float(anchor))/(float(den)+float(w))
def recent_sum(dq,target,days,kind='outcome'):
    cutoff=target-timedelta(days=days)
    while dq and dq[0][0]<cutoff:dq.popleft()
    if kind=='pitch':
        z={'FASTBALL':0.,'BREAKING':0.,'OFFSPEED':0.}
        for _,r in dq:
            for f in z:z[f]+=float(r.get(f,0))
        return z
    if kind=='family':
        z={f:empty_outcome() for f in ('FASTBALL','BREAKING','OFFSPEED')}
        for _,r in dq:
            for f in z:add_out(z[f],r.get(f,{}) or {})
        return z
    z=empty_outcome()
    for _,r in dq:add_out(z,r)
    return z

def precompute_slot_epa(v60,lineup_root,batter_root,season,target_rows,prior_starts):
    ls=load(os.path.join(lineup_root,season,'cohort','pregame-lineup-history.json'));bh=load(os.path.join(batter_root,season,'batter-history.json'))
    lm={int(x['gamePk']):x for x in ls.get('snapshots',[])};bm={int(x['gamePk']):x for x in bh.get('games',[])}
    by=defaultdict(list)
    for r in target_rows:by[str(r['officialDate'])].append(r)
    sst=defaultdict(v60.empty_slot);gst=v60.empty_slot();out={}
    for d in sorted(by):
        games=sorted(by[d],key=lambda r:int(r['gamePk']))
        for r in games:
            pk=int(r['gamePk']);h,a=v60.lineup(lm.get(pk))
            if h is None or a is None:raise SystemExit(f'V61_T5_LINEUP_MISSING:{season}:{pk}')
            he=[v60.slot_pa(sst[pos],gst,prior_starts) for pos in range(1,10)];ae=[v60.slot_pa(sst[pos],gst,prior_starts) for pos in range(1,10)]
            out[pk]={'homeIds':h,'awayIds':a,'homeEpa':he,'awayEpa':ae}
        for r in games:
            pk=int(r['gamePk']);bg=bm.get(pk);line=out[pk]
            if bg is None:raise SystemExit(f'V61_BATTER_HISTORY_GAME_MISSING:{season}:{pk}')
            for side,ids in (('homeBatters',line['homeIds']),('awayBatters',line['awayIds'])):
                m={int(x['batterId']):x for x in bg.get(side,[])}
                for pos,bid in enumerate(ids,1):
                    x=m.get(int(bid));pa=int(x.get('plateAppearances',0)) if x else 0
                    if pa>0:sst[pos]['starts']+=1;sst[pos]['pa']+=pa;gst['starts']+=1;gst['pa']+=pa
    return out

def expected_team(ids,epas,starter_id,target,ph,bh,lph,lbh,c):
    fams=('FASTBALL','BREAKING','OFFSPEED');keys=('h','tb','bb','k','hr');look=int(c['dataBoundary']['rollingLookbackDays'])
    league_pitch=recent_sum(lph,target,look,'pitch');lpt=sum(league_pitch.values())
    league_out=recent_sum(lbh,target,look,'outcome')
    if lpt<=0 or league_out['pa']<=0 or starter_id<=0 or any(x is None for x in epas):return None,{'starterPriorPitches':0.,'meanBatterFamilyPa':None,'minBatterFamilyPa':None}
    league_share={f:league_pitch[f]/lpt for f in fams};sp=recent_sum(ph[int(starter_id)],target,look,'pitch');spt=sum(sp.values());sw=float(c['specificMatchupEngineering']['starterPitchMixShrinkagePriorPitches'])
    smix={f:(sp[f]+sw*league_share[f])/(spt+sw) for f in fams}
    league_rate={k:rate(league_out,k) for k in keys};gw=float(c['specificMatchupEngineering']['batterGenericShrinkagePriorPlateAppearances']);fw=float(c['specificMatchupEngineering']['batterPitchFamilyShrinkagePriorPlateAppearances'])
    if any(league_rate[k] is None for k in keys):return None,{'starterPriorPitches':spt,'meanBatterFamilyPa':None,'minBatterFamilyPa':None}
    adj={k:0. for k in keys};family_pas=[]
    for bid,epa in zip(ids,epas):
        hist=recent_sum(bh[int(bid)],target,look,'family');gen=sum_out(hist.values());gr={k:shrink(gen[k],gen['pa'],league_rate[k],gw) for k in keys}
        fr={}
        for f in fams:
            family_pas.append(hist[f]['pa']);fr[f]={k:shrink(hist[f][k],hist[f]['pa'],gr[k],fw) for k in keys}
        for k in keys:
            specific=sum(smix[f]*fr[f][k] for f in fams);adj[k]+=(specific-gr[k])*float(epa)
    return adj,{'starterPriorPitches':spt,'meanBatterFamilyPa':float(np.mean(family_pas)) if family_pas else None,'minBatterFamilyPa':float(min(family_pas)) if family_pas else None}

def build_pitchmix_features(v60,generic_rows,lineup_root,batter_root,hands_root,pitch_root,seasons,c):
    targets={};slot={};rows_by_game={};custody={}
    pw=float(c['specificMatchupEngineering']['lineupSlotWorkloadShrinkagePriorStarts'])
    for s in seasons:
        slot[s]=precompute_slot_epa(v60,lineup_root,batter_root,s,generic_rows[s],pw)
        hp=load(os.path.join(hands_root,f'pregame-hands-{s}.json'));hm={int(x['gamePk']):x for x in hp.get('snapshots',[])}
        usable=sum(1 for x in hp.get('snapshots',[]) if x.get('usable') is True and int(x.get('homePitcherId') or 0)>0 and int(x.get('awayPitcherId') or 0)>0)
        targets[s]={'hands':hm,'usable':usable,'total':len(generic_rows[s])}
        rows_by_game[s]={int(r['gamePk']):r for r in generic_rows[s]}
    packs={}
    for s in [str(c['dataBoundary']['warmupSeason']),*seasons]:
        p=load(os.path.join(pitch_root,f'pitch-family-{s}.json'))
        if p.get('schemaVersion')!=PITCH_SCHEMA:raise SystemExit(f'V61_PITCH_PACK_SCHEMA_INVALID:{s}')
        packs[s]=p
    events=defaultdict(list)
    for s,p in packs.items():
        for g in p.get('games',[]):events[str(g['officialDate'])].append((s,g))
    ph=defaultdict(deque);bh=defaultdict(deque);lph=deque();lbh=deque();feature_names=list(c['pitchMixAdjustmentLayer']['featuresExactly']);metric_keys=('h','tb','bb','k','hr')
    stat={s:{'derived':0,'bothStarters250':0,'starterPrior':[],'batterFamilyPa':[]} for s in seasons}
    for ds in sorted(events):
        target=date.fromisoformat(ds)
        # Score all target games for this official date before any same-date PBP enters history.
        for s in seasons:
            todays=[r for r in generic_rows[s] if str(r['officialDate'])==ds]
            for r in todays:
                pk=int(r['gamePk']);sl=slot[s][pk];hs=targets[s]['hands'].get(pk) or {};ok=hs.get('usable') is True
                home_starter=int(hs.get('awayPitcherId') or 0) if ok else 0;away_starter=int(hs.get('homePitcherId') or 0) if ok else 0
                # Home hitters face away starter; away hitters face home starter.
                ha,hd=expected_team(sl['homeIds'],sl['homeEpa'],home_starter,target,ph,bh,lph,lbh,c);aa,ad=expected_team(sl['awayIds'],sl['awayEpa'],away_starter,target,ph,bh,lph,lbh,c)
                if ha is not None and aa is not None:
                    for name,k in zip(feature_names,metric_keys):r[name]=float(ha[k])-float(aa[k])
                    stat[s]['derived']+=1;stat[s]['starterPrior'].append(min(hd['starterPriorPitches'],ad['starterPriorPitches']))
                    vals=[x for x in (hd['meanBatterFamilyPa'],ad['meanBatterFamilyPa']) if x is not None]
                    if vals:stat[s]['batterFamilyPa'].append(float(np.mean(vals)))
                    if hd['starterPriorPitches']>=250 and ad['starterPriorPitches']>=250:stat[s]['bothStarters250']+=1
                else:
                    for name in feature_names:r[name]=None
        # Update rolling state only after every target on the date has been scored.
        for _,g in events[ds]:
            gpitch={'FASTBALL':0.,'BREAKING':0.,'OFFSPEED':0.};gout=empty_outcome();per_batter=defaultdict(lambda:{f:empty_outcome() for f in ('FASTBALL','BREAKING','OFFSPEED')})
            for pr in g.get('pitcherFamilyTotals',[]):
                pid=int(pr.get('pitcherId') or 0);rec={f:float(pr.get(f,0)) for f in gpitch}
                if pid>0:ph[pid].append((target,rec))
                for f in gpitch:gpitch[f]+=rec[f]
            for br in g.get('batterFamilyTotals',[]):
                bid=int(br.get('batterId') or 0);fam=str(br.get('pitchFamily') or '')
                if bid<=0 or fam not in per_batter[bid]:continue
                rec={k:float(br.get(k,0)) for k in ('pa','h','tb','bb','k','hr')};add_out(per_batter[bid][fam],rec);add_out(gout,rec)
            for bid,rec in per_batter.items():bh[bid].append((target,rec))
            lph.append((target,gpitch));lbh.append((target,gout))
    for s in seasons:
        p=packs[s];total=len(generic_rows[s]);u=targets[s]['usable'];x=stat[s]
        custody[s]={'rows':total,'pregameStarterIdentityPairUsableGames':u,'pregameStarterIdentityPairUsableShare':u/total if total else 0.,'pitchPbpGamesExpected':int(p['gamesExpected']),'pitchPbpGamesFetched':int(p['gamesFetched']),'pitchPbpFailureShare':float(p['failureShare']),'mappedPitchShare':float(p['categorizedPitchShare']),'gamesWithAllFivePitchmixAdjustmentFeaturesAvailable':x['derived'],'pitchmixDerivedShare':x['derived']/total if total else 0.,'gamesBothStartersAtLeast250PriorCategorizedPitches':x['bothStarters250'],'medianMinimumStarterPriorCategorizedPitches':float(np.median(x['starterPrior'])) if x['starterPrior'] else None,'medianGameMeanBatterPriorFamilyPa':float(np.median(x['batterFamilyPa'])) if x['batterFamilyPa'] else None}
    return generic_rows,custody,packs

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--control-root',required=True);ap.add_argument('--lineup-root',required=True);ap.add_argument('--batter-root',required=True);ap.add_argument('--hands-root',required=True);ap.add_argument('--pitch-root',required=True);ap.add_argument('--v16-report',required=True);ap.add_argument('--v16-manifest',required=True);ap.add_argument('--v58-report',required=True);ap.add_argument('--v59-report',required=True);ap.add_argument('--v60-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);x=ap.parse_args()
    c=load(x.contract);v60=load_v60();vr=load(x.v16_report);vm=load(x.v16_manifest);v58=load(x.v58_report);v59=load(x.v59_report);v60r=load(x.v60_report)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA:raise SystemExit('V61_CONTRACT_INVALID')
    if v60r.get('schemaVersion')!=V60_REPORT_SCHEMA or v60r.get('classification')!=c['parentEvidence']['v60FrozenClassification']:raise SystemExit('V61_V60_PARENT_INVALID')
    if vr.get('classification')!=c['parentEvidence']['v16RequiredClassification'] or v60.digest(vm)!=c['parentEvidence']['v16ManifestSha256']:raise SystemExit('V61_V16_PARENT_INVALID')
    if v58.get('classification')!=c['parentEvidence']['v58FrozenClassification'] or v59.get('classification')!=c['parentEvidence']['v59FrozenClassification']:raise SystemExit('V61_PARENT_BENCHMARK_INVALID')
    ctl=vm['fullGame']
    if ctl.get('featureSet')!=c['control']['featureSetRequired'] or ctl['preprocessor']['features']!=c['control']['featuresExactly']:raise SystemExit('V61_CONTROL_FEATURE_DRIFT')
    seasons=[c['dataBoundary']['trainingSeason'],c['dataBoundary']['calibrationSeason'],*c['dataBoundary']['retrospectiveEvaluationSeasons']]
    generic={};v60cust={}
    for s in seasons:
        generic[s],v60cust[s]=v60.build_rows(x.control_root,x.lineup_root,x.batter_root,x.hands_root,s,load('research/p0-step12v60-individual-lineup-platoon-winner-contract.json'))
        if len(generic[s])!=int(c['dataBoundary']['expectedRowsBySeason'][s]):raise SystemExit(f'V61_ROW_COUNT_DRIFT:{s}')
    rows,custody,packs=build_pitchmix_features(v60,generic,x.lineup_root,x.batter_root,x.hands_root,x.pitch_root,seasons,c)
    gate=c['coverageGate'];coverage_ok=True
    for s in seasons:
        z=custody[s]
        coverage_ok=coverage_ok and z['pregameStarterIdentityPairUsableShare']>=float(gate['minimumPregameStarterIdentityPairShareEachTargetSeason']) and z['mappedPitchShare']>=float(gate['minimumMappedPitchShareEachTargetSeason']) and z['pitchPbpFailureShare']<=float(gate['maximumTargetGameFetchFailureShareEachSeason'])
    tol=float(c['control']['metricParityAbsoluteTolerance']);evs=list(c['dataBoundary']['retrospectiveEvaluationSeasons'])
    for s in evs:
        y=np.asarray([r['homeWin'] for r in rows[s]]);cm=v60.metrics(v60.predict(ctl,rows[s]),y);exp=vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V61_V16:{s}:{k}',cm[k],exp[k],tol)
    tr=rows['2022'];ca=rows['2023'];ev=[r for s in evs for r in rows[s]];y=np.asarray([r['homeWin'] for r in ev]);cp=v60.predict(ctl,ev);cc=v60.metrics(cp,y);exp=vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V61_V16:combined:{k}',cc[k],exp[k],tol)
    base=list(c['control']['featuresExactly']);gen=list(c['genericLineupBenchmark']['gameLevelFeaturesExactly']);adj=list(c['pitchMixAdjustmentLayer']['featuresExactly']);add_fs=tuple(base+gen);ch_fs=tuple(base+gen+adj)
    if len(ch_fs)!=int(c['challenger']['featureCount']) or len(set(ch_fs))!=len(ch_fs):raise SystemExit('V61_CHALLENGER_FEATURE_COUNT_INVALID')
    l2=float(c['challenger']['l2Strength']);additive=v60.fit_model(tr,ca,add_fs,l2,'V16_C4_PLUS_V58_LINEUP_DIFF5_REPRODUCED');challenger=v60.fit_model(tr,ca,ch_fs,l2,c['challenger']['featureSet'])
    comps={}
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]]);cm=v60.metrics(v60.predict(ctl,rows[s]),ys);am=v60.metrics(v60.predict(additive,rows[s]),ys);nm=v60.metrics(v60.predict(challenger,rows[s]),ys);comps[s]={'rows':len(rows[s]),'control':cm,'additiveBenchmark':am,'challenger':nm,'improvementVsControl':v60.compare(cm,nm),'improvementVsAdditiveBenchmark':v60.compare(am,nm)}
        exp58=v58['evaluationBySeason'][s]['challenger']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V61_V58:{s}:{k}',am[k],exp58[k],2e-8)
    apred=v60.predict(additive,ev);npred=v60.predict(challenger,ev);ac=v60.metrics(apred,y);nc=v60.metrics(npred,y);exp58=v58['combinedEvaluation2024_2026Ytd']['challenger']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V61_V58:combined:{k}',ac[k],exp58[k],2e-8)
    comb={'rows':len(ev),'control':cc,'additiveBenchmark':ac,'challenger':nc,'improvementVsControl':v60.compare(cc,nc),'improvementVsAdditiveBenchmark':v60.compare(ac,nc)}
    b=c['pairedBootstrap'];boot=v60.bootstrap(ev,cp,npred,y,int(b['resamples']),int(b['seed']),float(b['confidenceLevel']));bootadd=v60.bootstrap(ev,apred,npred,y,int(b['resamples']),int(b['seed']),float(b['confidenceLevel']))
    yc=np.asarray([r['homeWin'] for r in ca]);val={'control':v60.metrics(v60.predict(ctl,ca),yc),'additiveBenchmark':v60.metrics(v60.predict(additive,ca),yc),'challenger':v60.metrics(v60.predict(challenger,ca),yc)}
    rub=c['candidateRubric'];both=[comps[s]['improvementVsControl']['logLoss']>0 and comps[s]['improvementVsControl']['brier']>0 for s in evs];worse=[comps[s]['improvementVsControl']['logLoss']<0 and comps[s]['improvementVsControl']['brier']<0 for s in evs]
    checks={'controlManifestAndMetricParity':True,'v58AdditiveMetricParity':True,'combinedLogLossImproved':comb['improvementVsControl']['logLoss']>0,'combinedBrierImproved':comb['improvementVsControl']['brier']>0,'bootstrapLogLossLowerBoundPositive':boot['logLossImprovement']['lower']>0,'bootstrapBrierLowerBoundPositive':boot['brierImprovement']['lower']>0,'challengerCombinedEce10WithinAbsoluteMax':nc['ece10']<=float(rub['ece10AbsoluteMaximum']),'challengerAbsoluteMeanProbabilityGapNotWorseThanControl':nc['absoluteMeanHomeProbabilityGap']<=cc['absoluteMeanHomeProbabilityGap']+float(rub['meanProbabilityGapComparisonTolerance']),'atLeastTwoOfThreeEvaluationSeasonsImproveBoth':sum(both)>=2,'noEvaluationSeasonWorseOnBoth':not any(worse)}
    passed=coverage_ok and all(checks.values());classification=rub['passingClassification'] if passed else (rub['failingClassification'] if coverage_ok else gate['belowGateClassification'])
    v59c=v59['combinedEvaluation2024_2026Ytd']['challenger'];v60c=v60r['combinedEvaluation2024_2026Ytd']['challenger'];vs59=v60.compare(v59c,nc);vs60=v60.compare(v60c,nc)
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage_ok,'scientificStatus':c['scientificStatus'],'target':'FULL_GAME_HOME_WIN','data':{'seasonRows':{s:len(rows[s]) for s in seasons},'warmupSeason':c['dataBoundary']['warmupSeason'],'custody':custody,'trainingSeason':'2022','calibrationSeason':'2023','evaluationSeasons':evs},'controlParity':{'modelVersion':vm['modelVersion'],'manifestSha256':v60.digest(vm),'featureSet':ctl['featureSet'],'features':ctl['preprocessor']['features'],'combinedAndBySeasonMetricsReproduced':True},'features':{'controlCount':len(base),'genericLineupCount':len(gen),'pitchmixAdjustmentCount':len(adj),'challengerCount':len(ch_fs),'challengerFeatures':list(ch_fs)},'additiveBenchmarkModel':additive,'challengerModel':challenger,'validation2023':{**val,'challengerImprovementVsControl':v60.compare(val['control'],val['challenger']),'challengerImprovementVsAdditive':v60.compare(val['additiveBenchmark'],val['challenger'])},'evaluationBySeason':comps,'combinedEvaluation2024_2026Ytd':comb,'pairedDateBootstrapVsControl2024_2026Ytd':boot,'pairedDateBootstrapVsV58Additive2024_2026Ytd':bootadd,'candidateRubricChecks':checks,'diagnostics':{'improvementVsFrozenV59Combined':vs59,'improvementVsFrozenV60Combined':vs60,'beatsFrozenV59CombinedLogLoss':vs59['logLoss']>0,'beatsFrozenV59CombinedBrier':vs59['brier']>0,'beatsFrozenV60CombinedLogLoss':vs60['logLoss']>0,'beatsFrozenV60CombinedBrier':vs60['brier']>0},'policy':{'researchOnly':True,'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'subsetMiningUsed':False,'homeAwaySubsetMiningUsed':False,'seasonExclusionAfterResultsUsed':False,'postResultRuleChangeAllowed':False,'postResultShrinkageChangeAllowed':False,'v16ProductionChanged':False,'productionMarketRegistryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'positiveEvEstablished':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage_ok,'custody':custody,'combined':comb['improvementVsControl'],'bootstrapVsControl':boot,'bySeason':{s:comps[s]['improvementVsControl'] for s in evs},'vsV59':vs59,'vsV60':vs60,'checks':checks},indent=2))
if __name__=='__main__':main()

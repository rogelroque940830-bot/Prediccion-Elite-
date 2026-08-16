#!/usr/bin/env python3
import argparse,importlib.util,json,os
from collections import defaultdict,deque
from datetime import date,timedelta
import numpy as np

REPORT_SCHEMA='courtedge-p0-step12v62-pitch-quality-winner.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v62-pitch-quality-winner-contract.v1'
PACK_SCHEMA='courtedge-p0-step12v62-pitch-quality-pbp.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,v):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def empty_pitch():return {'pitches':0.,'strikes':0.,'swings':0.,'whiffs':0.,'velocityN':0.,'velocitySum':0.,'spinN':0.,'spinSum':0.,'battedBallN':0.,'hardHitN':0.}
def empty_out():return {'pa':0.,'h':0.,'tb':0.,'bb':0.,'k':0.,'hr':0.}
def add(dst,src):
    for k in dst:dst[k]+=float(src.get(k,0))
def add_type_map(dst,src,blank):
    for pt,r in src.items():
        if pt not in dst:dst[pt]=blank()
        add(dst[pt],r)
def sum_records(dq,target,days,blank):
    cutoff=target-timedelta(days=days)
    while dq and dq[0][0]<cutoff:dq.popleft()
    out={}
    for _,m in dq:add_type_map(out,m,blank)
    return out
def sum_out_map(m):
    z=empty_out()
    for r in m.values():add(z,r)
    return z
def rate(r,num,den):return float(r[num])/float(r[den]) if float(r[den])>0 else None
def mean(r,s,n):return float(r[s])/float(r[n]) if float(r[n])>0 else None
def shrink_rate(num,den,anchor,w):return (float(num)+float(w)*float(anchor))/(float(den)+float(w))
def shrink_mean(total,n,anchor,w):return (float(total)+float(w)*float(anchor))/(float(n)+float(w))

def team_expected(ids,epas,starter_id,target,ph,bh,lph,lbh,c):
    days=int(c['dataBoundary']['rollingLookbackDays']);sp=sum_records(ph[int(starter_id)],target,days,empty_pitch);lp=sum_records(lph,target,days,empty_pitch);lb=sum_records(lbh,target,days,empty_out)
    total=sum(float(r['pitches']) for r in sp.values())
    if starter_id<=0 or total<float(c['exactPitchTypeBatterEngineering']['hardEligibilityMinimumPriorRecognizedPitches']):return None,{'starterPriorRecognizedPitches':total}
    if any(epa is None for epa in epas):return None,{'starterPriorRecognizedPitches':total,'missingSlotExpectedPa':True}
    usage={pt:float(r['pitches'])/total for pt,r in sp.items() if r['pitches']>0}
    league_generic=sum_out_map(lb);keys=('h','tb','bb','k','hr')
    if league_generic['pa']<=0:return None,{'starterPriorRecognizedPitches':total}
    league_rates={k:league_generic[k]/league_generic['pa'] for k in keys};gw=float(c['exactPitchTypeBatterEngineering']['genericShrinkagePriorPlateAppearances']);pw=float(c['exactPitchTypeBatterEngineering']['pitchTypeShrinkagePriorPlateAppearances'])
    result={k:0. for k in keys};prior_type_pa=[]
    for bid,epa in zip(ids,epas):
        hm=sum_records(bh[int(bid)],target,days,empty_out);gen=sum_out_map(hm);gr={k:shrink_rate(gen[k],gen['pa'],league_rates[k],gw) for k in keys}
        for k in keys:
            sr=0.
            for pt,u in usage.items():
                r=hm.get(pt,empty_out());prior_type_pa.append(r['pa']);sr+=u*shrink_rate(r[k],r['pa'],gr[k],pw)
            result[k]+=sr*float(epa)
    return result,{'starterPriorRecognizedPitches':total,'meanBatterPitchTypePa':float(np.mean(prior_type_pa)) if prior_type_pa else None}

def starter_quality(starter_id,target,ph,lph,c):
    days=int(c['dataBoundary']['rollingLookbackDays']);sp=sum_records(ph[int(starter_id)],target,days,empty_pitch);lp=sum_records(lph,target,days,empty_pitch);total=sum(float(r['pitches']) for r in sp.values())
    if starter_id<=0 or total<float(c['starterQualityEngineering']['hardEligibilityMinimumPriorRecognizedPitches']):return None,{'starterPriorRecognizedPitches':total}
    q={'velocity':0.,'spin':0.,'whiff':0.,'strike':0.,'hard':0.};w=c['starterQualityEngineering']
    for pt,r in sp.items():
        if r['pitches']<=0:continue
        u=float(r['pitches'])/total;lg=lp.get(pt)
        if not lg or lg['pitches']<=0:continue
        lv=mean(lg,'velocitySum','velocityN');ls=mean(lg,'spinSum','spinN');lw=rate(lg,'whiffs','swings');lstr=rate(lg,'strikes','pitches');lh=rate(lg,'hardHitN','battedBallN')
        if lv is not None:
            sv=shrink_mean(r['velocitySum'],r['velocityN'],lv,float(w['velocityShrinkagePriorPitches']));q['velocity']+=u*(sv-lv)
        if ls is not None:
            ss=shrink_mean(r['spinSum'],r['spinN'],ls,float(w['spinShrinkagePriorPitches']));q['spin']+=u*(ss-ls)
        if lw is not None:
            sw=shrink_rate(r['whiffs'],r['swings'],lw,float(w['whiffShrinkagePriorSwings']));q['whiff']+=u*(sw-lw)
        if lstr is not None:
            st=shrink_rate(r['strikes'],r['pitches'],lstr,float(w['strikeShrinkagePriorPitches']));q['strike']+=u*(st-lstr)
        if lh is not None:
            hh=shrink_rate(r['hardHitN'],r['battedBallN'],lh,float(w['hardHitShrinkagePriorBallsInPlay']));q['hard']+=u*(lh-hh)
    return q,{'starterPriorRecognizedPitches':total}

def make_game_maps(pack):
    out=[]
    for g in pack.get('games',[]):
        pm=defaultdict(dict);bm=defaultdict(dict)
        for r in g.get('pitcherPitchTypeTotals',[]):pm[int(r['pitcherId'])][str(r['pitchType'])]={k:float(r.get(k,0)) for k in empty_pitch()}
        for r in g.get('batterPitchTypeTotals',[]):bm[int(r['batterId'])][str(r['pitchType'])]={k:float(r.get(k,0)) for k in empty_out()}
        league_p={};league_b={}
        for m in pm.values():add_type_map(league_p,m,empty_pitch)
        for m in bm.values():add_type_map(league_b,m,empty_out)
        out.append((str(g['officialDate']),int(g['gamePk']),pm,bm,league_p,league_b))
    return out

def build_features(v60,v61,rows,lineup_root,batter_root,hands_root,pitch_root,seasons,c):
    slot={};hands={};custody={};packs={};prior20=float(c['exactPitchTypeBatterEngineering']['lineupSlotWorkloadShrinkagePriorStarts'])
    for s in seasons:
        slot[s]=v61.precompute_slot_epa(v60,lineup_root,batter_root,s,rows[s],prior20)
        hp=load(os.path.join(hands_root,f'pregame-hands-{s}.json'));hands[s]={int(x['gamePk']):x for x in hp.get('snapshots',[])}
    allseasons=[str(c['dataBoundary']['warmupSeason']),*seasons];events=defaultdict(list)
    for s in allseasons:
        p=load(os.path.join(pitch_root,f'pitch-quality-{s}.json'))
        if p.get('schemaVersion')!=PACK_SCHEMA:raise SystemExit(f'V62_PACK_SCHEMA_INVALID:{s}')
        packs[s]=p
        for item in make_game_maps(p):events[item[0]].append(item)
    ph=defaultdict(deque);bh=defaultdict(deque);lph=deque();lbh=deque();stat={s:{'derived':0,'both250':0,'starterPrior':[],'batterTypePa':[]} for s in seasons}
    pitch_fs=c['exactPitchTypeBatterLayer']['featuresExactly'];qual_fs=c['starterQualityLayer']['featuresExactly'];metric_keys=('h','tb','bb','k','hr')
    bydate={s:defaultdict(list) for s in seasons}
    for s in seasons:
        for r in rows[s]:bydate[s][str(r['officialDate'])].append(r)
    for ds in sorted(events):
        d=date.fromisoformat(ds)
        for s in seasons:
            for r in bydate[s].get(ds,[]):
                pk=int(r['gamePk']);sl=slot[s].get(pk);hs=hands[s].get(pk) or {};usable=hs.get('usable') is True
                home_starter=int(hs.get('homePitcherId') or 0) if usable else 0;away_starter=int(hs.get('awayPitcherId') or 0) if usable else 0
                he,hd=team_expected(sl['homeIds'],sl['homeEpa'],away_starter,d,ph,bh,lph,lbh,c) if sl else (None,{});ae,ad=team_expected(sl['awayIds'],sl['awayEpa'],home_starter,d,ph,bh,lph,lbh,c) if sl else (None,{})
                hq,hqd=starter_quality(home_starter,d,ph,lph,c);aq,aqd=starter_quality(away_starter,d,ph,lph,c)
                ok=he is not None and ae is not None and hq is not None and aq is not None
                if ok:
                    for name,k in zip(pitch_fs,metric_keys):r[name]=float(he[k])-float(ae[k])
                    for name,k in zip(qual_fs,('velocity','spin','whiff','strike','hard')):r[name]=float(hq[k])-float(aq[k])
                    st=stat[s];st['derived']+=1;mn=min(hqd['starterPriorRecognizedPitches'],aqd['starterPriorRecognizedPitches']);st['starterPrior'].append(mn)
                    vals=[x for x in (hd.get('meanBatterPitchTypePa'),ad.get('meanBatterPitchTypePa')) if x is not None]
                    if vals:st['batterTypePa'].append(float(np.mean(vals)))
                    if mn>=250:st['both250']+=1
                else:
                    for name in [*pitch_fs,*qual_fs]:r[name]=None
        # No same-date leakage: only now update with this official date.
        for _,_,pm,bm,lp,lb in events[ds]:
            for pid,m in pm.items():ph[pid].append((d,m))
            for bid,m in bm.items():bh[bid].append((d,m))
            lph.append((d,lp));lbh.append((d,lb))
    gate=c['coverageGate']
    for s in seasons:
        p=packs[s];n=len(rows[s]);hm=hands[s];usable=sum(1 for r in rows[s] if (hm.get(int(r['gamePk'])) or {}).get('usable') is True);st=stat[s]
        custody[s]={'rows':n,'pregameStarterIdentityPairUsableGames':usable,'pregameStarterIdentityPairUsableShare':usable/n if n else 0.,'pitchPbpGamesExpected':int(p['gamesExpected']),'pitchPbpGamesFetched':int(p['gamesFetched']),'pitchPbpFailureShare':float(p['failureShare']),'recognizedPitchTypeShare':float(p['recognizedPitchTypeShare']),'velocityTelemetryShare':float(p['velocityTelemetryShare']),'spinTelemetryShare':float(p['spinTelemetryShare']),'gamesWithAllTenV62FeaturesAvailable':st['derived'],'fullFeatureDerivedShare':st['derived']/n if n else 0.,'gamesBothStartersAtLeast250PriorRecognizedPitchesDiagnostic':st['both250'],'medianMinimumStarterPriorRecognizedPitches':float(np.median(st['starterPrior'])) if st['starterPrior'] else None,'medianGameMeanBatterPriorExactPitchTypePa':float(np.median(st['batterTypePa'])) if st['batterTypePa'] else None}
    return rows,custody

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--control-root',required=True);ap.add_argument('--lineup-root',required=True);ap.add_argument('--batter-root',required=True);ap.add_argument('--hands-root',required=True);ap.add_argument('--pitch-root',required=True);ap.add_argument('--v16-report',required=True);ap.add_argument('--v16-manifest',required=True);ap.add_argument('--v61-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);x=ap.parse_args()
    c=load(x.contract);v60=module('scripts/p0-step12v60-individual-lineup-platoon-winner.py','v60f');v61=module('scripts/p0-step12v61-individual-pitchmix-winner.py','v61f');vr=load(x.v16_report);vm=load(x.v16_manifest);v61r=load(x.v61_report)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA or c.get('contractRevision')!=2:raise SystemExit('V62_CONTRACT_INVALID')
    if v61r.get('classification')!=c['parentEvidence']['v61FrozenClassification']:raise SystemExit('V62_V61_PARENT_INVALID')
    if vr.get('classification')!=c['parentEvidence']['v16RequiredClassification'] or v60.digest(vm)!=c['parentEvidence']['v16ManifestSha256']:raise SystemExit('V62_V16_PARENT_INVALID')
    ctl=vm['fullGame'];base=list(c['control']['featuresExactly'])
    if ctl.get('featureSet')!=c['control']['featureSetRequired'] or ctl['preprocessor']['features']!=base:raise SystemExit('V62_CONTROL_FEATURE_DRIFT')
    seasons=[c['dataBoundary']['trainingSeason'],c['dataBoundary']['calibrationSeason'],*c['dataBoundary']['retrospectiveEvaluationSeasons']];v60c=load('research/p0-step12v60-individual-lineup-platoon-winner-contract.json');rows={}
    for s in seasons:
        rows[s],_=v60.build_rows(x.control_root,x.lineup_root,x.batter_root,x.hands_root,s,v60c)
        if len(rows[s])!=int(c['dataBoundary']['expectedRowsBySeason'][s]):raise SystemExit(f'V62_ROW_COUNT_DRIFT:{s}')
    rows,custody=build_features(v60,v61,rows,x.lineup_root,x.batter_root,x.hands_root,x.pitch_root,seasons,c)
    gate=c['coverageGate'];coverage=True
    for s in seasons:
        z=custody[s];coverage=coverage and z['pregameStarterIdentityPairUsableShare']>=float(gate['minimumPregameStarterIdentityPairShareEachTargetSeason']) and z['recognizedPitchTypeShare']>=float(gate['minimumRecognizedPitchTypeShareEachTargetSeason']) and z['velocityTelemetryShare']>=float(gate['minimumVelocityTelemetryShareEachTargetSeason']) and z['spinTelemetryShare']>=float(gate['minimumSpinTelemetryShareEachTargetSeason']) and z['pitchPbpFailureShare']<=float(gate['maximumTargetGameFetchFailureShareEachSeason'])
        if s in c['dataBoundary']['retrospectiveEvaluationSeasons']:coverage=coverage and z['fullFeatureDerivedShare']>=float(gate['minimumFullFeatureDerivedShareEachEvaluationSeason'])
    tol=float(c['control']['metricParityAbsoluteTolerance']);evs=list(c['dataBoundary']['retrospectiveEvaluationSeasons'])
    for s in evs:
        y=np.asarray([r['homeWin'] for r in rows[s]]);m=v60.metrics(v60.predict(ctl,rows[s]),y);exp=vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V62_V16:{s}:{k}',m[k],exp[k],tol)
    tr=rows['2022'];ca=rows['2023'];ev=[r for s in evs for r in rows[s]];y=np.asarray([r['homeWin'] for r in ev]);cp=v60.predict(ctl,ev);cc=v60.metrics(cp,y);exp=vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V62_V16:combined:{k}',cc[k],exp[k],tol)
    pf=list(c['exactPitchTypeBatterLayer']['featuresExactly']);qf=list(c['starterQualityLayer']['featuresExactly']);l2=float(c['challenger']['l2Strength'])
    pitch_model=v60.fit_model(tr,ca,tuple(base+pf),l2,c['predeclaredAblations']['pitchTypeOnly']);quality_model=v60.fit_model(tr,ca,tuple(base+qf),l2,c['predeclaredAblations']['starterQualityOnly']);full_model=v60.fit_model(tr,ca,tuple(base+pf+qf),l2,c['challenger']['featureSet'])
    if len(base+pf+qf)!=int(c['challenger']['featureCount']):raise SystemExit('V62_FEATURE_COUNT_INVALID')
    comps={}
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]]);cm=v60.metrics(v60.predict(ctl,rows[s]),ys);pm=v60.metrics(v60.predict(pitch_model,rows[s]),ys);qm=v60.metrics(v60.predict(quality_model,rows[s]),ys);fm=v60.metrics(v60.predict(full_model,rows[s]),ys);comps[s]={'rows':len(rows[s]),'control':cm,'pitchTypeOnly':pm,'starterQualityOnly':qm,'challenger':fm,'challengerImprovementVsControl':v60.compare(cm,fm),'pitchTypeOnlyImprovementVsControl':v60.compare(cm,pm),'starterQualityOnlyImprovementVsControl':v60.compare(cm,qm)}
    pp=v60.predict(pitch_model,ev);qp=v60.predict(quality_model,ev);fp=v60.predict(full_model,ev);pc=v60.metrics(pp,y);qc=v60.metrics(qp,y);fc=v60.metrics(fp,y);combined={'rows':len(ev),'control':cc,'pitchTypeOnly':pc,'starterQualityOnly':qc,'challenger':fc,'challengerImprovementVsControl':v60.compare(cc,fc),'pitchTypeOnlyImprovementVsControl':v60.compare(cc,pc),'starterQualityOnlyImprovementVsControl':v60.compare(cc,qc)}
    b=c['pairedBootstrap'];boot=v60.bootstrap(ev,cp,fp,y,int(b['resamples']),int(b['seed']),float(b['confidenceLevel']));rub=c['candidateRubric'];both=[comps[s]['challengerImprovementVsControl']['logLoss']>0 and comps[s]['challengerImprovementVsControl']['brier']>0 for s in evs];worse=[comps[s]['challengerImprovementVsControl']['logLoss']<0 and comps[s]['challengerImprovementVsControl']['brier']<0 for s in evs]
    checks={'controlManifestAndMetricParity':True,'combinedLogLossImproved':combined['challengerImprovementVsControl']['logLoss']>0,'combinedBrierImproved':combined['challengerImprovementVsControl']['brier']>0,'bootstrapLogLossLowerBoundPositive':boot['logLossImprovement']['lower']>0,'bootstrapBrierLowerBoundPositive':boot['brierImprovement']['lower']>0,'challengerCombinedEce10WithinAbsoluteMax':fc['ece10']<=float(rub['ece10AbsoluteMaximum']),'challengerAbsoluteMeanProbabilityGapNotWorseThanControl':fc['absoluteMeanHomeProbabilityGap']<=cc['absoluteMeanHomeProbabilityGap']+float(rub['meanProbabilityGapComparisonTolerance']),'atLeastTwoOfThreeEvaluationSeasonsImproveBoth':sum(both)>=2,'noEvaluationSeasonWorseOnBoth':not any(worse)}
    passed=coverage and all(checks.values());classification=rub['passingClassification'] if passed else (rub['failingClassification'] if coverage else gate['belowGateClassification']);v61c=v61r['combinedEvaluation2024_2026Ytd']['challenger'];vs61=v60.compare(v61c,fc)
    yc=np.asarray([r['homeWin'] for r in ca]);val={'control':v60.metrics(v60.predict(ctl,ca),yc),'pitchTypeOnly':v60.metrics(v60.predict(pitch_model,ca),yc),'starterQualityOnly':v60.metrics(v60.predict(quality_model,ca),yc),'challenger':v60.metrics(v60.predict(full_model,ca),yc)}
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'scientificStatus':c['scientificStatus'],'target':'FULL_GAME_HOME_WIN','data':{'seasonRows':{s:len(rows[s]) for s in seasons},'warmupSeason':c['dataBoundary']['warmupSeason'],'custody':custody,'trainingSeason':'2022','calibrationSeason':'2023','evaluationSeasons':evs},'controlParity':{'modelVersion':vm['modelVersion'],'manifestSha256':v60.digest(vm),'featureSet':ctl['featureSet'],'features':ctl['preprocessor']['features'],'combinedAndBySeasonMetricsReproduced':True},'features':{'controlCount':len(base),'exactPitchTypeBatterCount':len(pf),'starterQualityCount':len(qf),'challengerCount':len(base+pf+qf),'challengerFeatures':base+pf+qf},'models':{'pitchTypeOnly':pitch_model,'starterQualityOnly':quality_model,'challenger':full_model},'validation2023':val,'evaluationBySeason':comps,'combinedEvaluation2024_2026Ytd':combined,'pairedDateBootstrapVsControl2024_2026Ytd':boot,'candidateRubricChecks':checks,'diagnostics':{'improvementVsFrozenV61Combined':vs61,'beatsFrozenV61CombinedLogLoss':vs61['logLoss']>0,'beatsFrozenV61CombinedBrier':vs61['brier']>0,'ablationResultsMayNotChoosePromotionCandidate':True},'policy':{'researchOnly':True,'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'subsetMiningUsed':False,'homeAwaySubsetMiningUsed':False,'seasonExclusionAfterResultsUsed':False,'postResultRuleChangeAllowed':False,'postResultShrinkageChangeAllowed':False,'postResultPitchTypeChangeAllowed':False,'v16ProductionChanged':False,'productionMarketRegistryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'positiveEvEstablished':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'custody':custody,'combined':combined['challengerImprovementVsControl'],'pitchTypeOnly':combined['pitchTypeOnlyImprovementVsControl'],'starterQualityOnly':combined['starterQualityOnlyImprovementVsControl'],'bootstrap':boot,'bySeason':{s:comps[s]['challengerImprovementVsControl'] for s in evs},'vsV61':vs61,'checks':checks},indent=2))
if __name__=='__main__':main()

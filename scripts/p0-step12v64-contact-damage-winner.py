#!/usr/bin/env python3
import argparse, importlib.util, json, os
from collections import defaultdict, deque
from datetime import date
import numpy as np

REPORT_SCHEMA='courtedge-p0-step12v64-contact-damage-winner.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v64-contact-damage-winner-contract.v1'
V62_REPORT_SCHEMA='courtedge-p0-step12v62-pitch-quality-winner.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,v):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def finite(v):
    try:return v is not None and np.isfinite(float(v))
    except Exception:return False

def add_broad(rows,c):
    pairs=[
      ('lineup_expected_hits_diff','lineup_platoon_hits_adjustment_diff','lineup_vs_hand_expected_hits_diff'),
      ('lineup_expected_total_bases_diff','lineup_platoon_total_bases_adjustment_diff','lineup_vs_hand_expected_total_bases_diff'),
      ('lineup_expected_walks_diff','lineup_platoon_walks_adjustment_diff','lineup_vs_hand_expected_walks_diff'),
      ('lineup_expected_strikeouts_diff','lineup_platoon_strikeouts_adjustment_diff','lineup_vs_hand_expected_strikeouts_diff'),
      ('lineup_expected_home_runs_diff','lineup_platoon_home_runs_adjustment_diff','lineup_vs_hand_expected_home_runs_diff')]
    if [x[2] for x in pairs]!=c['broadBatterEngineering']['featuresExactly']:raise SystemExit('V64_BROAD_FEATURE_CONTRACT_DRIFT')
    for rr in rows.values():
        for r in rr:
            for g,a,n in pairs:r[n]=float(r[g])+float(r[a]) if finite(r.get(g)) and finite(r.get(a)) else None

def add_frozen_starter_quality(rows,hands_root,pitch_root,seasons,c,v62,v62c):
    hands={};packs={};events=defaultdict(list);warm=str(v62c['dataBoundary']['warmupSeason'])
    for s in seasons:
        hp=load(os.path.join(hands_root,f'pregame-hands-{s}.json'));hands[s]={int(x['gamePk']):x for x in hp.get('snapshots',[])}
    for s in [warm,*seasons]:
        p=load(os.path.join(pitch_root,f'pitch-quality-{s}.json'))
        if p.get('schemaVersion')!=v62.PACK_SCHEMA:raise SystemExit(f'V64_V62_PACK_SCHEMA_INVALID:{s}')
        packs[s]=p
        for item in v62.make_game_maps(p):events[item[0]].append(item)
    ph=defaultdict(deque);lph=deque();bydate={s:defaultdict(list) for s in seasons};stat={s:{'available':0,'starterPrior':[]} for s in seasons}
    for s in seasons:
        for r in rows[s]:bydate[s][str(r['officialDate'])].append(r)
    qnames=list(c['starterQualityEngineering']['featuresExactly']);qkeys=('velocity','spin','whiff','strike','hard')
    if len(qnames)!=5:raise SystemExit('V64_STARTER_QUALITY_FEATURE_COUNT_INVALID')
    for ds in sorted(events):
        d=date.fromisoformat(ds)
        for s in seasons:
            for r in bydate[s].get(ds,[]):
                hs=hands[s].get(int(r['gamePk'])) or {};usable=hs.get('usable') is True
                hp=int(hs.get('homePitcherId') or 0) if usable else 0;ap=int(hs.get('awayPitcherId') or 0) if usable else 0
                hq,hd=v62.starter_quality(hp,d,ph,lph,v62c);aq,ad=v62.starter_quality(ap,d,ph,lph,v62c)
                if hq is not None and aq is not None:
                    for n,k in zip(qnames,qkeys):r[n]=float(hq[k])-float(aq[k])
                    stat[s]['available']+=1;stat[s]['starterPrior'].append(min(float(hd['starterPriorRecognizedPitches']),float(ad['starterPriorRecognizedPitches'])))
                else:
                    for n in qnames:r[n]=None
        # Same-date outcomes are unavailable to every game scored above. Update only after the date is fully scored.
        for _,_,pm,_,lp,_ in events[ds]:
            for pid,m in pm.items():ph[pid].append((d,m))
            lph.append((d,lp))
    out={}
    for s in seasons:
        n=len(rows[s]);st=stat[s];out[s]={'rows':n,'gamesWithAllFiveStarterQualityFeaturesAvailable':st['available'],'starterQualityFeatureAvailableShare':st['available']/n if n else 0.0,'medianMinimumStarterPriorRecognizedPitches':float(np.median(st['starterPrior'])) if st['starterPrior'] else None}
    return out

def improve(a,b):
    return {'logLoss':a['logLoss']-b['logLoss'],'brier':a['brier']-b['brier'],'ece10':a['ece10']-b['ece10'],'absoluteMeanHomeProbabilityGap':a['absoluteMeanHomeProbabilityGap']-b['absoluteMeanHomeProbabilityGap'],'accuracyAtHalf':b['accuracyAtHalf']-a['accuracyAtHalf']}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--control-root',required=True);ap.add_argument('--lineup-root',required=True);ap.add_argument('--batter-root',required=True);ap.add_argument('--hands-root',required=True);ap.add_argument('--pitch-root',required=True);ap.add_argument('--v16-report',required=True);ap.add_argument('--v16-manifest',required=True);ap.add_argument('--v62-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);x=ap.parse_args()
    c=load(x.contract)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA or c.get('contractRevision')!=2:raise SystemExit('V64_CONTRACT_INVALID')
    if c.get('scientificStatus')!='FROZEN_BROAD_CONTACT_DAMAGE_PLUS_STARTER_QUALITY_WINNER_HYPOTHESIS_BEFORE_V64_OUTCOME_SCORER':raise SystemExit('V64_CONTRACT_STATUS_INVALID')
    v60=module('scripts/p0-step12v60-individual-lineup-platoon-winner.py','v60v64');v62=module('scripts/p0-step12v62-pitch-quality-winner.py','v62v64')
    v60c=load('research/p0-step12v60-individual-lineup-platoon-winner-contract.json');v62c=load('research/p0-step12v62-pitch-quality-winner-contract.json');vr=load(x.v16_report);vm=load(x.v16_manifest);v62r=load(x.v62_report)
    if vr.get('classification')!=c['parentEvidence']['v16RequiredClassification'] or v60.digest(vm)!=c['parentEvidence']['v16ManifestSha256']:raise SystemExit('V64_V16_PARENT_INVALID')
    if v62r.get('schemaVersion')!=V62_REPORT_SCHEMA or v62r.get('target')!='FULL_GAME_HOME_WIN':raise SystemExit('V64_V62_REPORT_INVALID')
    ctl=vm['fullGame'];base=list(c['control']['featuresExactly'])
    if ctl.get('featureSet')!=c['control']['featureSetRequired'] or ctl['preprocessor']['features']!=base:raise SystemExit('V64_CONTROL_FEATURE_DRIFT')
    seasons=[c['dataBoundary']['trainingSeason'],c['dataBoundary']['calibrationSeason'],*c['dataBoundary']['retrospectiveEvaluationSeasons']];rows={};v60cust={}
    for s in seasons:
        rows[s],v60cust[s]=v60.build_rows(x.control_root,x.lineup_root,x.batter_root,x.hands_root,s,v60c)
        if len(rows[s])!=int(c['dataBoundary']['expectedRowsBySeason'][s]):raise SystemExit(f'V64_ROW_COUNT_DRIFT:{s}')
    add_broad(rows,c);quality_cust=add_frozen_starter_quality(rows,x.hands_root,x.pitch_root,seasons,c,v62,v62c)
    parent_cust=v62r['data']['custody'];gate=c['coverageGate'];coverage=True
    for s in seasons:
        coverage=coverage and float(v60cust[s]['pregameStarterHandUsableShare'])>=float(gate['minimumPregameStarterHandPairShareEachSeason'])
        coverage=coverage and float(parent_cust[s]['pregameStarterIdentityPairUsableShare'])>=float(gate['minimumPregameStarterIdentityPairShareEachSeason'])
        if s in c['dataBoundary']['retrospectiveEvaluationSeasons']:coverage=coverage and float(parent_cust[s]['fullFeatureDerivedShare'])>=float(gate['minimumV62PitchTelemetryFullFeatureDerivedShareEachEvaluationSeason'])
    evs=list(c['dataBoundary']['retrospectiveEvaluationSeasons']);tol=float(c['control']['metricParityAbsoluteTolerance'])
    for s in evs:
        y=np.asarray([r['homeWin'] for r in rows[s]],float);cm=v60.metrics(v60.predict(ctl,rows[s]),y);exp=vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V64_V16:{s}:{k}',cm[k],exp[k],tol)
    ev=[r for s in evs for r in rows[s]];y=np.asarray([r['homeWin'] for r in ev],float);cp=v60.predict(ctl,ev);cc=v60.metrics(cp,y);exp=vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V64_V16:combined:{k}',cc[k],exp[k],tol)
    broad=list(c['broadBatterEngineering']['featuresExactly']);quality=list(c['starterQualityEngineering']['featuresExactly']);bfs=tuple(base+broad);qfs=tuple(base+quality);ffs=tuple(base+broad+quality)
    if len(ffs)!=int(c['challenger']['featureCount']) or len(set(ffs))!=len(ffs):raise SystemExit('V64_FEATURE_COUNT_INVALID')
    tr=rows['2022'];ca=rows['2023'];l2=float(c['challenger']['l2Strength']);bm=v60.fit_model(tr,ca,bfs,l2,c['predeclaredDiagnostics']['broadBatterOnly']);qm=v60.fit_model(tr,ca,qfs,l2,c['predeclaredDiagnostics']['starterQualityOnly']);fm=v60.fit_model(tr,ca,ffs,l2,c['challenger']['featureSet'])
    yc=np.asarray([r['homeWin'] for r in ca],float);vc=v60.metrics(v60.predict(ctl,ca),yc);vb=v60.metrics(v60.predict(bm,ca),yc);vq=v60.metrics(v60.predict(qm,ca),yc);vf=v60.metrics(v60.predict(fm,ca),yc);val={'rows':len(ca),'control':vc,'broadBatterOnly':vb,'starterQualityOnly':vq,'challenger':vf,'challengerImprovementVsControl':improve(vc,vf)}
    by={}
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]],float);cm=v60.metrics(v60.predict(ctl,rows[s]),ys);b=v60.metrics(v60.predict(bm,rows[s]),ys);q=v60.metrics(v60.predict(qm,rows[s]),ys);f=v60.metrics(v60.predict(fm,rows[s]),ys);by[s]={'rows':len(rows[s]),'control':cm,'broadBatterOnly':b,'starterQualityOnly':q,'challenger':f,'challengerImprovementVsControl':improve(cm,f)}
    bp=v60.predict(bm,ev);qp=v60.predict(qm,ev);fp=v60.predict(fm,ev);bc=v60.metrics(bp,y);qc=v60.metrics(qp,y);fc=v60.metrics(fp,y);comb={'rows':len(ev),'control':cc,'broadBatterOnly':bc,'starterQualityOnly':qc,'challenger':fc,'broadBatterOnlyImprovementVsControl':improve(cc,bc),'starterQualityOnlyImprovementVsControl':improve(cc,qc),'challengerImprovementVsControl':improve(cc,fc)}
    bcfg=c['pairedBootstrap'];boot=v60.bootstrap(ev,cp,fp,y,int(bcfg['resamples']),int(bcfg['seed']),float(bcfg['confidenceLevel']));v62combined=v62r['combinedEvaluation2024_2026Ytd']['challenger'];vs62=improve(v62combined,fc)
    vi=val['challengerImprovementVsControl'];ci=comb['challengerImprovementVsControl'];both=[by[s]['challengerImprovementVsControl']['logLoss']>0 and by[s]['challengerImprovementVsControl']['brier']>0 for s in evs];worse=[by[s]['challengerImprovementVsControl']['logLoss']<0 and by[s]['challengerImprovementVsControl']['brier']<0 for s in evs];rub=c['candidateRubric']
    checks={'controlManifestAndMetricParity':True,'validation2023LogLossImproved':vi['logLoss']>0,'validation2023BrierImproved':vi['brier']>0,'combinedLogLossImproved':ci['logLoss']>0,'combinedBrierImproved':ci['brier']>0,'bootstrapLogLossLowerBoundPositive':boot['logLossImprovement']['lower']>0,'bootstrapBrierLowerBoundPositive':boot['brierImprovement']['lower']>0,'atLeastTwoOfThreeEvaluationSeasonsImproveBoth':sum(both)>=2,'noEvaluationSeasonWorseOnBoth':not any(worse),'challengerCombinedEce10WithinAbsoluteMax':fc['ece10']<=float(rub['ece10AbsoluteMaximum']),'challengerAbsoluteMeanProbabilityGapNotWorseThanControl':fc['absoluteMeanHomeProbabilityGap']<=cc['absoluteMeanHomeProbabilityGap']+float(rub['meanProbabilityGapComparisonTolerance'])}
    passed=coverage and all(checks.values());classification=rub['passingClassification'] if passed else (rub['failingClassification'] if coverage else c['coverageGate']['belowGateClassification'])
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'scientificStatus':c['scientificStatus'],'target':'FULL_GAME_HOME_WIN','data':{'seasonRows':{s:len(rows[s]) for s in seasons},'trainingSeason':'2022','calibrationSeason':'2023','evaluationSeasons':evs,'v60HandCustody':v60cust,'frozenV62ParentCustody':parent_cust,'starterQualityFeatureCustody':quality_cust},'controlParity':{'modelVersion':vm['modelVersion'],'manifestSha256':v60.digest(vm),'featureSet':ctl['featureSet'],'features':ctl['preprocessor']['features'],'combinedAndBySeasonMetricsReproduced':True},'features':{'controlCount':len(base),'broadVsHandContactDamageCount':len(broad),'starterQualityCount':len(quality),'challengerCount':len(ffs),'challengerFeatures':list(ffs)},'models':{'broadBatterOnly':bm,'starterQualityOnly':qm,'challenger':fm},'validation2023':val,'evaluationBySeason':by,'combinedEvaluation2024_2026Ytd':comb,'pairedDateBootstrapVsControl2024_2026Ytd':boot,'candidateRubricChecks':checks,'diagnostics':{'frozenV62IsDiagnosticOnlyNotPromotionControl':True,'v62FrozenClassification':v62r['classification'],'v62Combined':v62combined,'improvementVsFrozenV62Combined':vs62,'beatsFrozenV62CombinedLogLoss':vs62['logLoss']>0,'beatsFrozenV62CombinedBrier':vs62['brier']>0,'diagnosticResultsMayNotChoosePromotionCandidate':True},'policy':{'researchOnly':True,'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'subsetMiningUsed':False,'homeAwaySubsetMiningUsed':False,'seasonExclusionAfterResultsUsed':False,'postResultRuleChangeAllowed':False,'postResultShrinkageChangeAllowed':False,'postResultLookbackChangeAllowed':False,'v16ProductionChanged':False,'productionMarketRegistryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'positiveEvEstablished':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'validation2023':vi,'combined':ci,'broadBatterOnly':comb['broadBatterOnlyImprovementVsControl'],'starterQualityOnly':comb['starterQualityOnlyImprovementVsControl'],'bootstrap':boot,'bySeason':{s:by[s]['challengerImprovementVsControl'] for s in evs},'vsV62':vs62,'checks':checks},indent=2))
if __name__=='__main__':main()

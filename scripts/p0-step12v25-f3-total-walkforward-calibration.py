#!/usr/bin/env python3
import argparse
import json
import math
import os
from collections import defaultdict

import numpy as np
from scipy.stats import nbinom, poisson

SCHEMA='courtedge-p0-step12v25-f3-total-walkforward-calibration.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
V23_REPORT_SCHEMA='courtedge-p0-step12v23-f3-model-suite.v1'
V23_OUTCOME_SCHEMA='courtedge-p0-step12v23-f3-outcomes.v1'
V24_SCHEMA='courtedge-p0-step12v24-f3-total-robustness.v1'


def load(path):
    with open(path,encoding='utf-8') as f:return json.load(f)

def dump(path,payload):
    os.makedirs(os.path.dirname(path) or '.',exist_ok=True)
    with open(path,'w',encoding='utf-8') as f:
        json.dump(payload,f,indent=2,sort_keys=True);f.write('\n')

def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def deviance_row(y,mu):
    y=float(y);mu=max(float(mu),1e-12)
    return 2*mu if y==0 else 2*(y*math.log(y/mu)-y+mu)

def over_prob(mu,dispersion,line):
    cutoff=math.floor(float(line))
    if dispersion<=1e-12:return float(1-poisson.cdf(cutoff,mu))
    r=1/dispersion;p=r/(r+mu)
    return float(1-nbinom.cdf(cutoff,r,p))

def score_mu(features,s):
    z=float(s['intercept'])
    for i,name in enumerate(s['featureNames']):
        raw=features.get(name);x=float(raw) if finite(raw) else float(s['medianImpute'][i])
        scale=float(s['scale'][i])
        if scale<=0:raise SystemExit(f'V25_SCALE_INVALID:{name}')
        z+=float(s['coef'][i])*((x-float(s['mean'][i]))/scale)
    mu=math.exp(max(-50,min(50,z)))
    if not finite(mu) or mu<=0:raise SystemExit('V25_MU_INVALID')
    return mu

def canonical(root,seasons,names):
    out={};counts={}
    for season in seasons:
        d=load(os.path.join(root,season,'game-anatomy-feature-table.json'))
        if d.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V25_BASE_SCHEMA:{season}')
        n=0
        for r in d['rows']:
            if not r.get('t5PregameValid'):continue
            pk=int(r['gamePk'])
            if pk in out:raise SystemExit(f'V25_DUP_GAME:{pk}')
            f=r.get('features') or {}
            out[pk]={'season':season,'date':r['officialDate'],'features':{name:f.get(name) for name in names}}
            n+=1
        counts[season]=n
    return out,counts

def base_rows(root,outcomes,snapshot,seasons,lines):
    can,counts=canonical(root,seasons,snapshot['featureNames'])
    baseline_mu=float(snapshot['trainingMeanRuns'])
    dispersion=float(snapshot['nb2Dispersion'])
    baseline_probs={float(k):float(v) for k,v in snapshot['trainingLineOverClimatology'].items()}
    if set(baseline_probs)!=set(lines):raise SystemExit('V25_LINE_DRIFT')
    rows=[]
    for o in outcomes['rows']:
        pk=int(o['gamePk']);b=can.get(pk)
        if not b:continue
        if b['season']!=o['season'] or b['date']!=o['officialDate']:raise SystemExit(f'V25_IDENTITY:{pk}')
        y=int(o['totalRuns']);mu=score_mu(b['features'],snapshot)
        rows.append({'gamePk':pk,'season':b['season'],'date':b['date'],'month':b['date'][:7],'y':y,'uncalMu':mu,'baselineMu':baseline_mu,'dispersion':dispersion,'baselineProbs':baseline_probs})
    return rows,counts

def factor_for(rows,source_season):
    part=[r for r in rows if r['season']==source_season]
    if not part:raise SystemExit(f'V25_FACTOR_SOURCE_EMPTY:{source_season}')
    denom=sum(r['uncalMu'] for r in part);num=sum(r['y'] for r in part)
    if denom<=0 or num<=0:raise SystemExit(f'V25_FACTOR_INVALID:{source_season}')
    factor=num/denom
    if not finite(factor) or factor<=0:raise SystemExit(f'V25_FACTOR_NONFINITE:{source_season}')
    return factor

def enrich(rows,factors,lines):
    out=[]
    for r in rows:
        factor=float(factors[r['season']]);cal_mu=r['uncalMu']*factor
        y=r['y'];disp=r['dispersion']
        line_data={}
        unc_b=[];cal_b=[];base_b=[]
        for line in lines:
            obs=1.0 if y>line else 0.0
            up=over_prob(r['uncalMu'],disp,line);cp=over_prob(cal_mu,disp,line);bp=r['baselineProbs'][line]
            ub=(up-obs)**2;cb=(cp-obs)**2;bb=(bp-obs)**2
            unc_b.append(ub);cal_b.append(cb);base_b.append(bb)
            line_data[str(line)]={'uncalibratedBrier':ub,'calibratedBrier':cb,'baselineBrier':bb,'baselineMinusCalibrated':bb-cb,'uncalibratedMinusCalibrated':ub-cb}
        out.append({**r,'factor':factor,'calMu':cal_mu,
                    'uncDev':deviance_row(y,r['uncalMu']),'calDev':deviance_row(y,cal_mu),'baseDev':deviance_row(y,r['baselineMu']),
                    'uncAvgBrier':float(np.mean(unc_b)),'calAvgBrier':float(np.mean(cal_b)),'baseAvgBrier':float(np.mean(base_b)),'lineData':line_data})
    return out

def metrics(rows,lines):
    if not rows:raise SystemExit('V25_EMPTY_PARTITION')
    obs=float(np.mean([r['y'] for r in rows]));unc=float(np.mean([r['uncalMu'] for r in rows]));cal=float(np.mean([r['calMu'] for r in rows]));base=float(rows[0]['baselineMu'])
    unc_dev=float(np.mean([r['uncDev'] for r in rows]));cal_dev=float(np.mean([r['calDev'] for r in rows]));base_dev=float(np.mean([r['baseDev'] for r in rows]))
    unc_b=float(np.mean([r['uncAvgBrier'] for r in rows]));cal_b=float(np.mean([r['calAvgBrier'] for r in rows]));base_b=float(np.mean([r['baseAvgBrier'] for r in rows]))
    per_line={}
    for line in lines:
        per_line[str(line)]={
            'uncalibratedBrier':float(np.mean([r['lineData'][str(line)]['uncalibratedBrier'] for r in rows])),
            'calibratedBrier':float(np.mean([r['lineData'][str(line)]['calibratedBrier'] for r in rows])),
            'baselineBrier':float(np.mean([r['lineData'][str(line)]['baselineBrier'] for r in rows]))}
        per_line[str(line)]['baselineMinusCalibrated']=per_line[str(line)]['baselineBrier']-per_line[str(line)]['calibratedBrier']
        per_line[str(line)]['uncalibratedMinusCalibrated']=per_line[str(line)]['uncalibratedBrier']-per_line[str(line)]['calibratedBrier']
    return {'rows':len(rows),'calibrationFactor':float(rows[0]['factor']),'observedMeanRuns':obs,'uncalibratedMeanPredictedRuns':unc,'calibratedMeanPredictedRuns':cal,'constantBaselineMeanRuns':base,
            'uncalibratedAbsoluteMeanBias':abs(obs-unc),'calibratedAbsoluteMeanBias':abs(obs-cal),'constantBaselineAbsoluteMeanBias':abs(obs-base),
            'uncalibratedMeanPoissonDeviance':unc_dev,'calibratedMeanPoissonDeviance':cal_dev,'constantBaselineMeanPoissonDeviance':base_dev,
            'baselineMinusCalibratedPoissonDeviance':base_dev-cal_dev,'uncalibratedMinusCalibratedPoissonDeviance':unc_dev-cal_dev,
            'uncalibratedAverageBrier':unc_b,'calibratedAverageBrier':cal_b,'baselineAverageBrier':base_b,
            'baselineMinusCalibratedAverageBrier':base_b-cal_b,'uncalibratedMinusCalibratedAverageBrier':unc_b-cal_b,'fixedLineBrier':per_line}

def bootstrap(rows,reps,seed,confidence):
    by=defaultdict(list)
    for r in rows:by[r['date']].append(r)
    dates=sorted(by);n=len(dates)
    daily_dev=np.array([np.mean([x['baseDev']-x['calDev'] for x in by[d]]) for d in dates],float)
    daily_b=np.array([np.mean([x['baseAvgBrier']-x['calAvgBrier'] for x in by[d]]) for d in dates],float)
    rng=np.random.default_rng(seed);sd=np.empty(reps);sb=np.empty(reps)
    for i in range(reps):
        idx=rng.integers(0,n,size=n);sd[i]=np.mean(daily_dev[idx]);sb[i]=np.mean(daily_b[idx])
    alpha=(1-confidence)/2;lo=100*alpha;hi=100*(1-alpha)
    return {'uniqueDates':n,'replicates':reps,'randomSeed':seed,'confidenceLevel':confidence,
            'devianceImprovement':{'pointEstimate':float(np.mean(daily_dev)),'ciLower':float(np.percentile(sd,lo)),'ciUpper':float(np.percentile(sd,hi))},
            'averageBrierImprovement':{'pointEstimate':float(np.mean(daily_b)),'ciLower':float(np.percentile(sb,lo)),'ciUpper':float(np.percentile(sb,hi))}}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--v23-report',required=True);ap.add_argument('--v23-outcomes',required=True);ap.add_argument('--v24-report',required=True);ap.add_argument('--out',required=True);a=ap.parse_args()
    c=load(a.contract);v23=load(a.v23_report);outcomes=load(a.v23_outcomes);v24=load(a.v24_report)
    if c.get('schemaVersion')!='courtedge-p0-step12v25-f3-total-walkforward-calibration-contract.v1':raise SystemExit('V25_CONTRACT')
    if v23.get('schemaVersion')!=V23_REPORT_SCHEMA or outcomes.get('schemaVersion')!=V23_OUTCOME_SCHEMA or v24.get('schemaVersion')!=V24_SCHEMA:raise SystemExit('V25_PARENT_SCHEMA')
    if v24.get('classification')!=c['parentEvidence']['requiredV24Classification'] or v24.get('robustnessGatePassed') is not False:raise SystemExit('V25_V24_BOUNDARY')
    if v23['total']['candidateRubricPassed'] is not True or v23['marketBoundary']['historicalF3PricesUsed'] is not False:raise SystemExit('V25_V23_BOUNDARY')
    snapshot=v23['total']['modelSnapshot'];lines=tuple(float(x) for x in c['frozenBaseModel']['fixedLines']);seasons=('2023','2024','2025','2026_YTD')
    raw,counts=base_rows(a.root,outcomes,snapshot,seasons,lines)
    factors={'2023':1.0,'2024':factor_for(raw,'2023'),'2025':factor_for(raw,'2024'),'2026_YTD':factor_for(raw,'2025')}
    rows=enrich(raw,factors,lines)
    parts={s:metrics([r for r in rows if r['season']==s],lines) for s in seasons}
    checks={}
    for s in seasons:
        m=parts[s]
        checks[s]={'positivePoissonDevianceImprovementVsBaseline':m['baselineMinusCalibratedPoissonDeviance']>0,
                   'positiveAverageBrierImprovementVsBaseline':m['baselineMinusCalibratedAverageBrier']>0,
                   'calibratedMeanBiasNoWorseThanBaseline':m['calibratedAbsoluteMeanBias']<=m['constantBaselineAbsoluteMeanBias']+1e-15}
        if s!='2023':checks[s]['calibratedMeanBiasNoWorseThanUncalibrated']=m['calibratedAbsoluteMeanBias']<=m['uncalibratedAbsoluteMeanBias']+1e-15
    wf=[r for r in rows if r['season']!='2023'];agg=metrics(wf,lines)
    aggregate_checks={'calibratedPoissonDevianceNoWorseThanUncalibrated':agg['calibratedMeanPoissonDeviance']<=agg['uncalibratedMeanPoissonDeviance']+1e-15,
                      'calibratedAverageBrierNoWorseThanUncalibrated':agg['calibratedAverageBrier']<=agg['uncalibratedAverageBrier']+1e-15}
    bc=c['dateClusterBootstrapGate'];boot=bootstrap(wf,int(bc['replicates']),int(bc['randomSeed']),float(bc['confidenceLevel']))
    boot_checks={'devianceCiLowerGreaterThanZero':boot['devianceImprovement']['ciLower']>0,'averageBrierCiLowerGreaterThanZero':boot['averageBrierImprovement']['ciLower']>0}
    passed=all(v for d in checks.values() for v in d.values()) and all(aggregate_checks.values()) and all(boot_checks.values())
    classification=c['promotionRubric']['passClassification'] if passed else c['promotionRubric']['failClassification']
    report={'schemaVersion':SCHEMA,'classification':classification,'scientificStatus':c['scientificStatus'],'parentCustody':c['parentEvidence'],
            'algorithm':{'type':c['calibrationAlgorithm']['type'],'targetSeasonFactors':factors,'targetSeasonOutcomeUsedToCalibrateSameSeason':False,'futureSeasonDataUsed':False,'factorSearchUsed':False,'factorClippingUsed':False,'baseCoefficientsChanged':False,'baseFeaturesChanged':False,'baseDispersionChanged':False,'lineSetChanged':False},
            'data':{'canonicalSeasonRows':counts,'scoredRows':len(rows)},'partitionMetrics':parts,'partitionChecks':checks,'walkForwardAggregateMetrics':agg,'aggregateChecks':aggregate_checks,
            'dateClusterBootstrap':boot,'bootstrapChecks':boot_checks,'gatePassed':passed,
            'marketBoundary':{'marketKey':v23['total']['marketKey'],'canonicalMarketType':v23['total']['canonicalMarketType'],'historicalF3PricesUsed':False,'positiveEvEstablished':False,'liveFreezeAuthorizedByThisResearch':passed,'shadowPriceCaptureAuthorizedByThisResearch':passed,'productionPromotionAuthorized':False},
            'policy':{'researchOnly':True,'sameSeasonOutcomeCalibrationUsed':False,'futureDataUsed':False,'thresholdSearchUsed':False,'featureSearchUsed':False,'modelSearchUsed':False,'lineSearchUsed':False,'postResultRuleChangeUsed':False,'liveLookupAuthorizationChanged':False,'liveMarketDiscoveryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}}
    dump(a.out,report)
    print(json.dumps({'classification':classification,'gatePassed':passed,'factors':factors,'partitionChecks':checks,'partitionMetrics':{s:{k:parts[s][k] for k in ('calibratedAbsoluteMeanBias','uncalibratedAbsoluteMeanBias','constantBaselineAbsoluteMeanBias','baselineMinusCalibratedPoissonDeviance','baselineMinusCalibratedAverageBrier')} for s in seasons},'aggregateChecks':aggregate_checks,'bootstrap':boot,'bootstrapChecks':boot_checks},indent=2))

if __name__=='__main__':main()

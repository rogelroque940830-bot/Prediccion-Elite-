#!/usr/bin/env python3
import argparse,hashlib,json,math,os
from collections import defaultdict
import numpy as np
from scipy.optimize import minimize

REPORT_SCHEMA='courtedge-p0-step12v58-lineup-winner-incremental-value.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v58-lineup-winner-incremental-value-contract.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
BATTER_SCHEMA='courtedge-mlb-historical-batter-history.v1'
V16_REPORT_SCHEMA='courtedge-p0-step12v16-pure-ml-f5-settlement-probability.v1'
V16_MANIFEST_SCHEMA='courtedge-p0-step12v16-pure-settlement-model-manifest.v1'
EPS=1e-15

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,v):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False

def empty_batter():return {'pa':0.,'h':0.,'tb':0.,'bb':0.,'k':0.,'hr':0.}
def empty_slot():return {'starts':0.,'pa':0.}
def add_line(s,l):
    pa=int(l.get('plateAppearances',0))
    if pa<=0:return
    s['pa']+=pa;s['h']+=int(l.get('hits',0));s['tb']+=int(l.get('totalBases',0));s['bb']+=int(l.get('baseOnBalls',0));s['k']+=int(l.get('strikeOuts',0));s['hr']+=int(l.get('homeRuns',0))
def rates(s):
    if s['pa']<=0:return None
    return {k:s[k]/s['pa'] for k in ('h','tb','bb','k','hr')}
def shrink(n,d,r,w):return (float(n)+float(w)*float(r))/(float(d)+float(w))
def shrink_mean(t,n,m,w):return (float(t)+float(w)*float(m))/(float(n)+float(w))
def lineup(x):
    if not x or not x.get('complete'):return None,None
    try:h=[int(v) for v in x.get('homeBattingOrder',[])];a=[int(v) for v in x.get('awayBattingOrder',[])]
    except:return None,None
    if len(h)!=9 or len(a)!=9 or len(set(h))!=9 or len(set(a))!=9 or min(h+a)<=0:return None,None
    return h,a
def slot_pa(s,g,w):
    if g['starts']<=0:return None
    return shrink_mean(s['pa'],s['starts'],g['pa']/g['starts'],w)
def impact(ids,bst,lp,sst,gst,prior_pa,prior_starts):
    names=('lineup_expected_hits','lineup_expected_total_bases','lineup_expected_walks','lineup_expected_strikeouts','lineup_expected_home_runs')
    if lp is None:return {n:None for n in names}
    out={n:0. for n in names};keys=('h','tb','bb','k','hr')
    for pos,bid in enumerate(ids,1):
        epa=slot_pa(sst[pos],gst,prior_starts)
        if epa is None:return {n:None for n in names}
        s=bst[int(bid)]
        for n,k in zip(names,keys):out[n]+=shrink(s[k],s['pa'],lp[k],prior_pa)*epa
    return out

def build_rows(control_root,lineup_root,batter_root,season,c):
    ct=load(os.path.join(control_root,season,'game-anatomy-feature-table.json'));lt=load(os.path.join(lineup_root,season,'game-anatomy-feature-table.json'))
    ls=load(os.path.join(lineup_root,season,'cohort','pregame-lineup-history.json'));bh=load(os.path.join(batter_root,season,'batter-history.json'))
    if ct.get('schemaVersion')!=BASE_SCHEMA or lt.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V58_BASE_SCHEMA_INVALID:{season}')
    if bh.get('schemaVersion')!=BATTER_SCHEMA:raise SystemExit(f'V58_BATTER_SCHEMA_INVALID:{season}')
    exp=int(c['dataBoundary']['expectedRowsBySeason'][season]);cr=[r for r in ct.get('rows',[]) if r.get('t5PregameValid') is True];lr=[r for r in lt.get('rows',[]) if r.get('t5PregameValid') is True]
    if len(cr)!=exp or len(lr)!=exp:raise SystemExit(f'V58_ROW_COUNT_DRIFT:{season}:{len(cr)}:{len(lr)}:{exp}')
    lid={int(r['gamePk']):str(r['officialDate']) for r in lr}
    if len(lid)!=exp:raise SystemExit(f'V58_LINEAGE_DUPLICATE_GAMEPK:{season}')
    for r in cr:
        if lid.get(int(r['gamePk']))!=str(r['officialDate']):raise SystemExit(f"V58_CROSS_SOURCE_IDENTITY_MISMATCH:{season}:{r['gamePk']}")
    lm={int(r['gamePk']):r for r in ls.get('snapshots',[])};bm={int(r['gamePk']):r for r in bh.get('games',[])}
    missing=[int(r['gamePk']) for r in cr if int(r['gamePk']) not in bm]
    if len(bm)<exp or missing:raise SystemExit(f'V58_BATTER_CUSTODY_INSUFFICIENT:{season}:{len(bm)}:{len(missing)}')
    by=defaultdict(list)
    for r in cr:by[str(r['officialDate'])].append(r)
    bst=defaultdict(empty_batter);league=empty_batter();sst=defaultdict(empty_slot);gst=empty_slot();prior_pa=float(c['playerPriorEngineering']['batterRateShrinkagePriorPlateAppearances']);prior_starts=float(c['playerPriorEngineering']['lineupSlotWorkloadShrinkagePriorStarts'])
    base=tuple(c['control']['featuresExactly']);components=tuple(c['lineupWinnerLayer']['teamLevelComponentsExactly']);diffs=tuple(c['lineupWinnerLayer']['gameLevelFeaturesExactly']);out=[];avail=0
    for d in sorted(by):
        games=sorted(by[d],key=lambda r:int(r['gamePk']));lp=rates(league)
        for r in games:
            pk=int(r['gamePk']);h,a=lineup(lm.get(pk))
            if h is None or a is None:raise SystemExit(f'V58_COMPLETE_T5_LINEUP_REQUIRED:{season}:{pk}')
            hg=impact(h,bst,lp,sst,gst,prior_pa,prior_starts);ag=impact(a,bst,lp,sst,gst,prior_pa,prior_starts)
            if all(finite(v) for v in hg.values()) and all(finite(v) for v in ag.values()):avail+=1
            result=str(r['outcomes']['FULL_GAME']['result'])
            if result not in ('HOME','AWAY'):raise SystemExit(f'V58_FULL_GAME_BINARY_TARGET_INVALID:{season}:{pk}:{result}')
            fv=r.get('features') or {};row={'season':season,'officialDate':d,'gamePk':pk,'homeWin':1. if result=='HOME' else 0.}
            for f in base:row[f]=float(fv[f]) if finite(fv.get(f)) else None
            for comp,dn in zip(components,diffs):row[dn]=float(hg[comp])-float(ag[comp]) if finite(hg[comp]) and finite(ag[comp]) else None
            out.append(row)
        for r in games:
            pk=int(r['gamePk']);h,a=lineup(lm.get(pk));bg=bm.get(pk)
            if h is None or a is None or bg is None:raise SystemExit(f'V58_DATE_UPDATE_INPUT_MISSING:{season}:{pk}')
            for side in ('homeBatters','awayBatters'):
                for line in bg.get(side,[]):
                    if int(line.get('plateAppearances',0))>0:add_line(bst[int(line['batterId'])],line);add_line(league,line)
            for side,ids in (('homeBatters',h),('awayBatters',a)):
                m={int(x['batterId']):x for x in bg.get(side,[])}
                for pos,bid in enumerate(ids,1):
                    l=m.get(int(bid));pa=int(l.get('plateAppearances',0)) if l else 0
                    if pa>0:sst[pos]['starts']+=1;sst[pos]['pa']+=pa;gst['starts']+=1;gst['pa']+=pa
    return out,{'rows':len(out),'completeT5LineupGames':len(out),'frozenStartingSlots':18*len(out),'gamesWithAllFivePregameLineupDifferencesAvailable':avail,'gamesUsingTrainingOnlyMedianImputationForAtLeastOneLineupDifference':len(out)-avail}

def prep(rows,fs):
    med=[];mean=[];scale=[]
    for f in fs:
        vals=[float(r[f]) for r in rows if finite(r.get(f))]
        if not vals:raise SystemExit(f'V58_TRAIN_FEATURE_EMPTY:{f}')
        m=float(np.median(vals));a=np.asarray([float(r[f]) if finite(r.get(f)) else m for r in rows],float);u=float(a.mean());s=float(a.std());s=1. if not finite(s) or s<1e-12 else s;med.append(m);mean.append(u);scale.append(s)
    return {'features':list(fs),'medianImpute':med,'mean':mean,'scale':scale,'fitSeason':'2022'}
def transform(rows,p):
    X=np.empty((len(rows),len(p['features'])),float)
    for j,(f,m,u,s) in enumerate(zip(p['features'],p['medianImpute'],p['mean'],p['scale'])):X[:,j]=[((float(r[f]) if finite(r.get(f)) else m)-u)/s for r in rows]
    return X
def sigmoid(z):z=np.clip(np.asarray(z,float),-50,50);return 1/(1+np.exp(-z))
def fit_bin(X,y,l2):
    def obj(t):
        z=t[0]+X@t[1:];return float(np.mean(np.logaddexp(0,z)-y*z)+.5*l2*(t[1:]@t[1:])/len(y))
    o=minimize(obj,np.zeros(X.shape[1]+1),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-13,'gtol':1e-8})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'V58_BINARY_OPTIMIZER_FAILED:{o.message}')
    return o.x
def cal_bin(raw,y):
    def obj(t):
        z=math.exp(float(t[0]))*raw+float(t[1]);return float(np.mean(np.logaddexp(0,z)-y*z))
    o=minimize(obj,np.zeros(2),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-14,'gtol':1e-9})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'V58_BINARY_CALIBRATION_FAILED:{o.message}')
    return {'slope':math.exp(float(o.x[0])),'intercept':float(o.x[1]),'fitSeason':'2023'}
def fit_challenger(tr,ca,fs,l2):
    p=prep(tr,fs);Xt=transform(tr,p);yt=np.asarray([r['homeWin'] for r in tr]);t=fit_bin(Xt,yt,l2);Xc=transform(ca,p);yc=np.asarray([r['homeWin'] for r in ca]);return {'featureSet':'V16_C4_PLUS_V58_LINEUP_DIFF5','preprocessor':p,'intercept':float(t[0]),'coefficients':[float(x) for x in t[1:]],'calibration':cal_bin(t[0]+Xc@t[1:],yc),'l2Strength':float(l2)}
def predict(m,rows):
    X=transform(rows,m['preprocessor']);raw=float(m['intercept'])+X@np.asarray(m['coefficients']);c=m['calibration'];return sigmoid(float(c['slope'])*raw+float(c['intercept']))
def metrics(p,y):
    p=np.asarray(p,float);y=np.asarray(y,float);ll=-float(np.mean(y*np.log(np.maximum(p,EPS))+(1-y)*np.log(np.maximum(1-p,EPS))));br=float(np.mean((p-y)**2));ece=0.;bins=[]
    for i in range(10):
        lo=i/10;hi=(i+1)/10;mask=(p>=lo)&((p<hi) if i<9 else (p<=hi));n=int(mask.sum())
        if n:mp=float(p[mask].mean());ob=float(y[mask].mean());ece+=n/len(y)*abs(mp-ob);bins.append({'low':lo,'high':hi,'n':n,'meanPredicted':mp,'observedHomeRate':ob})
    mp=float(p.mean());ob=float(y.mean());return {'n':len(y),'logLoss':ll,'brier':br,'ece10':float(ece),'meanPredictedHome':mp,'observedHomeRate':ob,'absoluteMeanHomeProbabilityGap':abs(mp-ob),'accuracyAtHalf':float(np.mean((p>=.5)==(y==1))),'calibrationBins':bins}
def row_ll(p,y):return -(y*np.log(np.maximum(p,EPS))+(1-y)*np.log(np.maximum(1-p,EPS)))
def bootstrap(rows,cp,np_,y,n,seed,conf):
    dates=np.asarray([r['officialDate'] for r in rows],object);uniq=np.unique(dates);cl=row_ll(cp,y)-row_ll(np_,y);cb=(cp-y)**2-(np_-y)**2;clusters=[]
    for d in uniq:
        m=dates==d;clusters.append((int(m.sum()),float(cl[m].sum()),float(cb[m].sum())))
    cnt=np.asarray([x[0] for x in clusters],float);ls=np.asarray([x[1] for x in clusters]);bs=np.asarray([x[2] for x in clusters]);rng=np.random.default_rng(seed);ld=[];bd=[];m=len(uniq)
    for _ in range(n):
        ix=rng.integers(0,m,size=m);den=cnt[ix].sum();ld.append(ls[ix].sum()/den);bd.append(bs[ix].sum()/den)
    a=(1-conf)/2;return {'unit':'OFFICIAL_DATE_CLUSTER','distinctDates':m,'resamples':n,'confidenceLevel':conf,'logLossImprovement':{'pointEstimate':float(cl.mean()),'lower':float(np.quantile(ld,a)),'upper':float(np.quantile(ld,1-a))},'brierImprovement':{'pointEstimate':float(cb.mean()),'lower':float(np.quantile(bd,a)),'upper':float(np.quantile(bd,1-a))}}
def close(label,a,b,tol):
    if abs(float(a)-float(b))>tol:raise SystemExit(f'V58_V16_METRIC_PARITY_FAILED:{label}:{a}:{b}')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--control-root',required=True);ap.add_argument('--lineup-root',required=True);ap.add_argument('--batter-root',required=True);ap.add_argument('--v16-report',required=True);ap.add_argument('--v16-manifest',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);x=ap.parse_args();c=load(x.contract);vr=load(x.v16_report);vm=load(x.v16_manifest)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA:raise SystemExit('V58_CONTRACT_INVALID')
    if vr.get('schemaVersion')!=V16_REPORT_SCHEMA or vm.get('schemaVersion')!=V16_MANIFEST_SCHEMA:raise SystemExit('V58_V16_SCHEMA_INVALID')
    if vr.get('classification')!=c['parentEvidence']['v16RequiredClassification'] or digest(vm)!=c['parentEvidence']['v16ManifestSha256']:raise SystemExit('V58_V16_PARENT_INVALID')
    ctl=vm['fullGame']
    if ctl.get('featureSet')!=c['control']['featureSetRequired'] or ctl['preprocessor']['features']!=c['control']['featuresExactly']:raise SystemExit('V58_V16_CONTROL_INVALID')
    seasons=[c['dataBoundary']['trainingSeason'],c['dataBoundary']['calibrationSeason'],*c['dataBoundary']['retrospectiveEvaluationSeasons']];rows={};custody={}
    for s in seasons:rows[s],custody[s]=build_rows(x.control_root,x.lineup_root,x.batter_root,s,c)
    tr=rows['2022'];ca=rows['2023'];evs=list(c['dataBoundary']['retrospectiveEvaluationSeasons']);ev=[r for s in evs for r in rows[s]];tol=float(c['control']['metricParityAbsoluteTolerance']);c_by={}
    for s in evs:
        y=np.asarray([r['homeWin'] for r in rows[s]]);cm=metrics(predict(ctl,rows[s]),y);c_by[s]=cm;exp=vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):close(f'{s}:{k}',cm[k],exp[k],tol)
    y=np.asarray([r['homeWin'] for r in ev]);cp=predict(ctl,ev);cc=metrics(cp,y);exp=vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):close(f'combined:{k}',cc[k],exp[k],tol)
    fs=tuple(c['control']['featuresExactly']+c['lineupWinnerLayer']['gameLevelFeaturesExactly'])
    if len(fs)!=int(c['challenger']['featureCount']) or len(set(fs))!=len(fs):raise SystemExit('V58_CHALLENGER_FEATURE_COUNT_INVALID')
    ch=fit_challenger(tr,ca,fs,float(c['challenger']['l2Strength']));yc=np.asarray([r['homeWin'] for r in ca]);v={'control':metrics(predict(ctl,ca),yc),'challenger':metrics(predict(ch,ca),yc)};v['improvement']={k:v['control'][k]-v['challenger'][k] for k in ('logLoss','brier','ece10','absoluteMeanHomeProbabilityGap')}
    comps={}
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]]);cm=metrics(predict(ctl,rows[s]),ys);nm=metrics(predict(ch,rows[s]),ys);comps[s]={'rows':len(rows[s]),'control':cm,'challenger':nm,'improvement':{'logLoss':cm['logLoss']-nm['logLoss'],'brier':cm['brier']-nm['brier'],'ece10':cm['ece10']-nm['ece10'],'absoluteMeanHomeProbabilityGap':cm['absoluteMeanHomeProbabilityGap']-nm['absoluteMeanHomeProbabilityGap'],'accuracyAtHalf':nm['accuracyAtHalf']-cm['accuracyAtHalf']}}
    np_=predict(ch,ev);nc=metrics(np_,y);comb={'rows':len(ev),'control':cc,'challenger':nc,'improvement':{'logLoss':cc['logLoss']-nc['logLoss'],'brier':cc['brier']-nc['brier'],'ece10':cc['ece10']-nc['ece10'],'absoluteMeanHomeProbabilityGap':cc['absoluteMeanHomeProbabilityGap']-nc['absoluteMeanHomeProbabilityGap'],'accuracyAtHalf':nc['accuracyAtHalf']-cc['accuracyAtHalf']}}
    bcfg=c['pairedBootstrap'];boot=bootstrap(ev,cp,np_,y,int(bcfg['resamples']),int(bcfg['seed']),float(bcfg['confidenceLevel']));rub=c['candidateRubric'];both=[comps[s]['improvement']['logLoss']>0 and comps[s]['improvement']['brier']>0 for s in evs];worse=[comps[s]['improvement']['logLoss']<0 and comps[s]['improvement']['brier']<0 for s in evs]
    checks={'controlManifestAndMetricParity':True,'combinedLogLossImproved':comb['improvement']['logLoss']>0,'combinedBrierImproved':comb['improvement']['brier']>0,'bootstrapLogLossLowerBoundPositive':boot['logLossImprovement']['lower']>0,'bootstrapBrierLowerBoundPositive':boot['brierImprovement']['lower']>0,'challengerCombinedEce10WithinAbsoluteMax':nc['ece10']<=float(rub['ece10AbsoluteMaximum']),'challengerAbsoluteMeanProbabilityGapNotWorseThanControl':nc['absoluteMeanHomeProbabilityGap']<=cc['absoluteMeanHomeProbabilityGap']+float(rub['meanProbabilityGapComparisonTolerance']),'atLeastTwoOfThreeEvaluationSeasonsImproveBoth':sum(both)>=2,'noEvaluationSeasonWorseOnBoth':not any(worse)};passed=all(checks.values());classification=rub['passingClassification'] if passed else rub['failingClassification']
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,'scientificStatus':c['scientificStatus'],'target':'FULL_GAME_HOME_WIN','data':{'seasonRows':{s:len(rows[s]) for s in seasons},'custody':custody,'pairedControlAndChallengerRows':True,'trainingSeason':'2022','calibrationSeason':'2023','evaluationSeasons':evs},'controlParity':{'modelVersion':vm['modelVersion'],'manifestSha256':digest(vm),'featureSet':ctl['featureSet'],'features':ctl['preprocessor']['features'],'combinedAndBySeasonMetricsReproduced':True},'features':{'controlCount':len(c['control']['featuresExactly']),'lineupDifferenceCount':len(c['lineupWinnerLayer']['gameLevelFeaturesExactly']),'challengerCount':len(fs),'challengerFeatures':list(fs)},'challengerModel':ch,'validation2023':v,'evaluationBySeason':comps,'combinedEvaluation2024_2026Ytd':comb,'pairedDateBootstrap2024_2026Ytd':boot,'candidateRubricChecks':checks,'policy':{'researchOnly':True,'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'subsetMiningUsed':False,'homeAwaySubsetMiningUsed':False,'postResultRuleChangeAllowed':False,'v16ProductionChanged':False,'productionMarketRegistryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'positiveEvEstablished':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'controlParity':report['controlParity'],'validation2023':v,'combinedEvaluation2024_2026Ytd':comb,'pairedDateBootstrap2024_2026Ytd':boot,'evaluationBySeasonImprovement':{s:comps[s]['improvement'] for s in evs},'candidateRubricChecks':checks},indent=2))
if __name__=='__main__':main()

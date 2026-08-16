#!/usr/bin/env python3
import argparse,hashlib,json,math,os
from collections import defaultdict
import numpy as np
from scipy.optimize import minimize

REPORT_SCHEMA='courtedge-p0-step12v60-individual-lineup-platoon-winner.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v60-individual-lineup-platoon-winner-contract.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
BATTER_SCHEMA='courtedge-mlb-historical-batter-history.v1'
HAND_SCHEMA='courtedge-p0-step12v60-pregame-starter-hands.v1'
SPLIT_SCHEMA='courtedge-p0-step12v60-batter-hand-pbp.v1'
V16_REPORT_SCHEMA='courtedge-p0-step12v16-pure-ml-f5-settlement-probability.v1'
V16_MANIFEST_SCHEMA='courtedge-p0-step12v16-pure-settlement-model-manifest.v1'
V58_SCHEMA='courtedge-p0-step12v58-lineup-winner-incremental-value.v1'
V59_SCHEMA='courtedge-p0-step12v59-lineup-starter-interaction.v1'
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
def add_split(s,l):
    pa=int(l.get('pa',0))
    if pa<=0:return
    s['pa']+=pa;s['h']+=int(l.get('h',0));s['tb']+=int(l.get('tb',0));s['bb']+=int(l.get('bb',0));s['k']+=int(l.get('k',0));s['hr']+=int(l.get('hr',0))
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

def team_impacts(ids,opposing_hand,bst,splitst,league,sst,gst,prior_overall,prior_split,prior_starts):
    names=('lineup_expected_hits','lineup_expected_total_bases','lineup_expected_walks','lineup_expected_strikeouts','lineup_expected_home_runs')
    keys=('h','tb','bb','k','hr');lp=rates(league)
    generic={n:None for n in names};adjust={n:None for n in names}
    if lp is None:return generic,adjust,{'minPriorSplitPa':None,'meanPriorSplitPa':None,'hittersGte50':0,'hittersGte100':0}
    g={n:0. for n in names};items=[]
    for pos,bid in enumerate(ids,1):
        epa=slot_pa(sst[pos],gst,prior_starts)
        if epa is None:return generic,adjust,{'minPriorSplitPa':None,'meanPriorSplitPa':None,'hittersGte50':0,'hittersGte100':0}
        overall=bst[int(bid)];gr={}
        for n,k in zip(names,keys):
            gr[k]=shrink(overall[k],overall['pa'],lp[k],prior_overall);g[n]+=gr[k]*epa
        items.append((int(bid),epa,gr))
    if opposing_hand not in ('R','L'):
        return g,adjust,{'minPriorSplitPa':None,'meanPriorSplitPa':None,'hittersGte50':0,'hittersGte100':0}
    a={n:0. for n in names};split_pas=[]
    for bid,epa,gr in items:
        sp=splitst[(bid,opposing_hand)];split_pas.append(float(sp['pa']))
        for n,k in zip(names,keys):
            sr=shrink(sp[k],sp['pa'],gr[k],prior_split);a[n]+=(sr-gr[k])*epa
    return g,a,{'minPriorSplitPa':min(split_pas),'meanPriorSplitPa':float(np.mean(split_pas)),'hittersGte50':sum(x>=50 for x in split_pas),'hittersGte100':sum(x>=100 for x in split_pas)}

def build_rows(control_root,lineup_root,batter_root,custody_root,season,c):
    ct=load(os.path.join(control_root,season,'game-anatomy-feature-table.json'));lt=load(os.path.join(lineup_root,season,'game-anatomy-feature-table.json'));ls=load(os.path.join(lineup_root,season,'cohort','pregame-lineup-history.json'));bh=load(os.path.join(batter_root,season,'batter-history.json'))
    hp=load(os.path.join(custody_root,f'pregame-hands-{season}.json'));sp=load(os.path.join(custody_root,f'batter-hand-{season}.json'))
    if ct.get('schemaVersion')!=BASE_SCHEMA or lt.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V60_BASE_SCHEMA_INVALID:{season}')
    if bh.get('schemaVersion')!=BATTER_SCHEMA:raise SystemExit(f'V60_BATTER_SCHEMA_INVALID:{season}')
    if hp.get('schemaVersion')!=HAND_SCHEMA or sp.get('schemaVersion')!=SPLIT_SCHEMA:raise SystemExit(f'V60_CUSTODY_SCHEMA_INVALID:{season}')
    exp=int(c['dataBoundary']['expectedRowsBySeason'][season]);cr=[r for r in ct.get('rows',[]) if r.get('t5PregameValid') is True];lr=[r for r in lt.get('rows',[]) if r.get('t5PregameValid') is True]
    if len(cr)!=exp or len(lr)!=exp:raise SystemExit(f'V60_ROW_COUNT_DRIFT:{season}:{len(cr)}:{len(lr)}:{exp}')
    if int(hp.get('gamesExpected',-1))!=exp or len(hp.get('snapshots',[]))!=exp:raise SystemExit(f'V60_HAND_PACK_COUNT_DRIFT:{season}')
    if int(sp.get('gamesExpected',-1))!=exp or int(sp.get('gamesFetched',-1))!=exp or sp.get('failures'):raise SystemExit(f'V60_SPLIT_PACK_COUNT_DRIFT:{season}')
    lid={int(r['gamePk']):str(r['officialDate']) for r in lr};lm={int(r['gamePk']):r for r in ls.get('snapshots',[])};bm={int(r['gamePk']):r for r in bh.get('games',[])};hm={int(r['gamePk']):r for r in hp.get('snapshots',[])};sm={int(r['gamePk']):r for r in sp.get('games',[])}
    if min(len(lid),len(lm),len(bm),len(hm),len(sm))<exp:raise SystemExit(f'V60_CROSS_SOURCE_CUSTODY_INSUFFICIENT:{season}')
    for r in cr:
        pk=int(r['gamePk']);d=str(r['officialDate'])
        if lid.get(pk)!=d or str((sm.get(pk) or {}).get('officialDate'))!=d or str((hm.get(pk) or {}).get('officialDate'))!=d:raise SystemExit(f'V60_CROSS_SOURCE_IDENTITY_MISMATCH:{season}:{pk}')
    by=defaultdict(list)
    for r in cr:by[str(r['officialDate'])].append(r)
    bst=defaultdict(empty_batter);league=empty_batter();splitst=defaultdict(empty_batter);sst=defaultdict(empty_slot);gst=empty_slot()
    po=float(c['playerPriorEngineering']['batterOverallRateShrinkagePriorPlateAppearances']);ps=float(c['playerPriorEngineering']['batterVsHandShrinkagePriorPlateAppearances']);pw=float(c['playerPriorEngineering']['lineupSlotWorkloadShrinkagePriorStarts'])
    base=tuple(c['control']['featuresExactly']);components=tuple(c['genericLineupBenchmark']['teamLevelComponentsExactly']);diffs=tuple(c['genericLineupBenchmark']['gameLevelFeaturesExactly']);adj_names=tuple(c['platoonAdjustmentLayer']['featuresExactly'])
    out=[];generic_avail=0;platoon_avail=0;hand_usable=0;game_min_pas=[];game_mean_pas=[];games_all18_gte50=0;games_all18_gte100=0
    for d in sorted(by):
        games=sorted(by[d],key=lambda r:int(r['gamePk']))
        for r in games:
            pk=int(r['gamePk']);h,a=lineup(lm.get(pk))
            if h is None or a is None:raise SystemExit(f'V60_COMPLETE_T5_LINEUP_REQUIRED:{season}:{pk}')
            hs=hm.get(pk) or {};hand_ok=hs.get('usable') is True and hs.get('homeStarterHand') in ('R','L') and hs.get('awayStarterHand') in ('R','L')
            if hand_ok:hand_usable+=1
            home_hand=hs.get('awayStarterHand') if hand_ok else None;away_hand=hs.get('homeStarterHand') if hand_ok else None
            hg,ha,hd=team_impacts(h,home_hand,bst,splitst,league,sst,gst,po,ps,pw);ag,aa,ad=team_impacts(a,away_hand,bst,splitst,league,sst,gst,po,ps,pw)
            result=str(r['outcomes']['FULL_GAME']['result'])
            if result not in ('HOME','AWAY'):raise SystemExit(f'V60_FULL_GAME_BINARY_TARGET_INVALID:{season}:{pk}:{result}')
            fv=r.get('features') or {};row={'season':season,'officialDate':d,'gamePk':pk,'homeWin':1. if result=='HOME' else 0.}
            for f in base:row[f]=float(fv[f]) if finite(fv.get(f)) else None
            all_g=True
            for comp,dn in zip(components,diffs):
                ok=finite(hg[comp]) and finite(ag[comp]);row[dn]=float(hg[comp])-float(ag[comp]) if ok else None;all_g=all_g and ok
            if all_g:generic_avail+=1
            all_a=True
            for comp,an in zip(components,adj_names):
                ok=finite(ha[comp]) and finite(aa[comp]);row[an]=float(ha[comp])-float(aa[comp]) if ok else None;all_a=all_a and ok
            if all_a:
                platoon_avail+=1
                vals=[hd['minPriorSplitPa'],ad['minPriorSplitPa']];means=[hd['meanPriorSplitPa'],ad['meanPriorSplitPa']]
                if all(finite(x) for x in vals):game_min_pas.append(min(float(x) for x in vals))
                if all(finite(x) for x in means):game_mean_pas.append(float(np.mean(means)))
                if int(hd['hittersGte50'])+int(ad['hittersGte50'])==18:games_all18_gte50+=1
                if int(hd['hittersGte100'])+int(ad['hittersGte100'])==18:games_all18_gte100+=1
            out.append(row)
        for r in games:
            pk=int(r['gamePk']);h,a=lineup(lm.get(pk));bg=bm.get(pk);sg=sm.get(pk)
            if h is None or a is None or bg is None or sg is None:raise SystemExit(f'V60_DATE_UPDATE_INPUT_MISSING:{season}:{pk}')
            for side in ('homeBatters','awayBatters'):
                for line in bg.get(side,[]):
                    if int(line.get('plateAppearances',0))>0:add_line(bst[int(line['batterId'])],line);add_line(league,line)
            for line in sg.get('batterHandTotals',[]):
                hand=str(line.get('vsHand') or '').upper();bid=int(line.get('batterId') or 0)
                if bid>0 and hand in ('R','L'):add_split(splitst[(bid,hand)],line)
            for side,ids in (('homeBatters',h),('awayBatters',a)):
                m={int(x['batterId']):x for x in bg.get(side,[])}
                for pos,bid in enumerate(ids,1):
                    l=m.get(int(bid));pa=int(l.get('plateAppearances',0)) if l else 0
                    if pa>0:sst[pos]['starts']+=1;sst[pos]['pa']+=pa;gst['starts']+=1;gst['pa']+=pa
    custody={'rows':len(out),'completeT5LineupGames':len(out),'pregameStarterHandUsableGames':hand_usable,'pregameStarterHandUsableShare':hand_usable/len(out) if out else 0.0,'gamesWithAllFiveGenericLineupFeaturesAvailable':generic_avail,'gamesWithAllFivePlatoonAdjustmentFeaturesAvailable':platoon_avail,'gamesUsingTrainingOnlyMedianImputationForAtLeastOnePlatoonAdjustment':len(out)-platoon_avail,'medianGameMinimumPriorVsHandPa':float(np.median(game_min_pas)) if game_min_pas else None,'medianGameMeanPriorVsHandPa':float(np.median(game_mean_pas)) if game_mean_pas else None,'gamesAll18BattersAtLeast50PriorVsHandPa':games_all18_gte50,'gamesAll18BattersAtLeast100PriorVsHandPa':games_all18_gte100,'unusablePregameHandReasons':hp.get('unusableReasons',{})}
    return out,custody

def prep(rows,fs):
    med=[];mean=[];scale=[]
    for f in fs:
        vals=[float(r[f]) for r in rows if finite(r.get(f))]
        if not vals:raise SystemExit(f'V60_TRAIN_FEATURE_EMPTY:{f}')
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
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'V60_BINARY_OPTIMIZER_FAILED:{o.message}')
    return o.x
def cal_bin(raw,y):
    def obj(t):
        z=math.exp(float(t[0]))*raw+float(t[1]);return float(np.mean(np.logaddexp(0,z)-y*z))
    o=minimize(obj,np.zeros(2),method='L-BFGS-B',options={'maxiter':8000,'ftol':1e-14,'gtol':1e-9})
    if not o.success or not np.all(np.isfinite(o.x)):raise SystemExit(f'V60_BINARY_CALIBRATION_FAILED:{o.message}')
    return {'slope':math.exp(float(o.x[0])),'intercept':float(o.x[1]),'fitSeason':'2023'}
def fit_model(tr,ca,fs,l2,label):
    p=prep(tr,fs);Xt=transform(tr,p);yt=np.asarray([r['homeWin'] for r in tr]);t=fit_bin(Xt,yt,l2);Xc=transform(ca,p);yc=np.asarray([r['homeWin'] for r in ca]);return {'featureSet':label,'preprocessor':p,'intercept':float(t[0]),'coefficients':[float(x) for x in t[1:]],'calibration':cal_bin(t[0]+Xc@t[1:],yc),'l2Strength':float(l2)}
def predict(m,rows):
    X=transform(rows,m['preprocessor']);raw=float(m['intercept'])+X@np.asarray(m['coefficients']);c=m['calibration'];return sigmoid(float(c['slope'])*raw+float(c['intercept']))
def metrics(p,y):
    p=np.asarray(p,float);y=np.asarray(y,float);ll=-float(np.mean(y*np.log(np.maximum(p,EPS))+(1-y)*np.log(np.maximum(1-p,EPS))));br=float(np.mean((p-y)**2));ece=0.;bins=[]
    for i in range(10):
        lo=i/10;hi=(i+1)/10;mask=(p>=lo)&((p<hi) if i<9 else (p<=hi));n=int(mask.sum())
        if n:mp=float(p[mask].mean());ob=float(y[mask].mean());ece+=n/len(y)*abs(mp-ob);bins.append({'low':lo,'high':hi,'n':n,'meanPredicted':mp,'observedHomeRate':ob})
    mp=float(p.mean());ob=float(y.mean());return {'n':len(y),'logLoss':ll,'brier':br,'ece10':float(ece),'meanPredictedHome':mp,'observedHomeRate':ob,'absoluteMeanHomeProbabilityGap':abs(mp-ob),'accuracyAtHalf':float(np.mean((p>=.5)==(y==1))),'calibrationBins':bins}
def row_ll(p,y):return -(y*np.log(np.maximum(p,EPS))+(1-y)*np.log(np.maximum(1-p,EPS)))
def bootstrap(rows,cp,npred,y,n,seed,conf):
    dates=np.asarray([r['officialDate'] for r in rows],object);uniq=np.unique(dates);cl=row_ll(cp,y)-row_ll(npred,y);cb=(cp-y)**2-(npred-y)**2;clusters=[]
    for d in uniq:
        m=dates==d;clusters.append((int(m.sum()),float(cl[m].sum()),float(cb[m].sum())))
    cnt=np.asarray([x[0] for x in clusters],float);ls=np.asarray([x[1] for x in clusters]);bs=np.asarray([x[2] for x in clusters]);rng=np.random.default_rng(seed);ld=[];bd=[];m=len(uniq)
    for _ in range(n):
        ix=rng.integers(0,m,size=m);den=cnt[ix].sum();ld.append(ls[ix].sum()/den);bd.append(bs[ix].sum()/den)
    a=(1-conf)/2;return {'unit':'OFFICIAL_DATE_CLUSTER','distinctDates':m,'resamples':n,'confidenceLevel':conf,'logLossImprovement':{'pointEstimate':float(cl.mean()),'lower':float(np.quantile(ld,a)),'upper':float(np.quantile(ld,1-a))},'brierImprovement':{'pointEstimate':float(cb.mean()),'lower':float(np.quantile(bd,a)),'upper':float(np.quantile(bd,1-a))}}
def close(label,a,b,tol):
    if abs(float(a)-float(b))>tol:raise SystemExit(f'V60_METRIC_PARITY_FAILED:{label}:{a}:{b}')
def compare(control,challenger):
    return {'logLoss':control['logLoss']-challenger['logLoss'],'brier':control['brier']-challenger['brier'],'ece10':control['ece10']-challenger['ece10'],'absoluteMeanHomeProbabilityGap':control['absoluteMeanHomeProbabilityGap']-challenger['absoluteMeanHomeProbabilityGap'],'accuracyAtHalf':challenger['accuracyAtHalf']-control['accuracyAtHalf']}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--control-root',required=True);ap.add_argument('--lineup-root',required=True);ap.add_argument('--batter-root',required=True);ap.add_argument('--custody-root',required=True);ap.add_argument('--v16-report',required=True);ap.add_argument('--v16-manifest',required=True);ap.add_argument('--v58-report',required=True);ap.add_argument('--v59-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);x=ap.parse_args()
    c=load(x.contract);vr=load(x.v16_report);vm=load(x.v16_manifest);v58=load(x.v58_report);v59=load(x.v59_report)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA:raise SystemExit('V60_CONTRACT_INVALID')
    if vr.get('schemaVersion')!=V16_REPORT_SCHEMA or vm.get('schemaVersion')!=V16_MANIFEST_SCHEMA:raise SystemExit('V60_V16_SCHEMA_INVALID')
    if v58.get('schemaVersion')!=V58_SCHEMA or v59.get('schemaVersion')!=V59_SCHEMA:raise SystemExit('V60_PARENT_REPORT_SCHEMA_INVALID')
    if vr.get('classification')!=c['parentEvidence']['v16RequiredClassification'] or digest(vm)!=c['parentEvidence']['v16ManifestSha256']:raise SystemExit('V60_V16_PARENT_INVALID')
    if v58.get('classification')!=c['parentEvidence']['v58FrozenClassification'] or v59.get('classification')!=c['parentEvidence']['v59FrozenClassification']:raise SystemExit('V60_FROZEN_PARENT_CLASSIFICATION_INVALID')
    ctl=vm['fullGame']
    if ctl.get('featureSet')!=c['control']['featureSetRequired'] or ctl['preprocessor']['features']!=c['control']['featuresExactly']:raise SystemExit('V60_V16_CONTROL_INVALID')
    seasons=[c['dataBoundary']['trainingSeason'],c['dataBoundary']['calibrationSeason'],*c['dataBoundary']['retrospectiveEvaluationSeasons']];rows={};custody={}
    for s in seasons:rows[s],custody[s]=build_rows(x.control_root,x.lineup_root,x.batter_root,x.custody_root,s,c)
    min_cov=float(c['coverageGate']['minimumPregameStarterHandPairShareEachSeason']);coverage_ok=all(float(custody[s]['pregameStarterHandUsableShare'])>=min_cov for s in seasons)
    tr=rows['2022'];ca=rows['2023'];evs=list(c['dataBoundary']['retrospectiveEvaluationSeasons']);ev=[r for s in evs for r in rows[s]];tol=float(c['control']['metricParityAbsoluteTolerance'])
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]]);cm=metrics(predict(ctl,rows[s]),ys);exp=vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):close(f'V16:{s}:{k}',cm[k],exp[k],tol)
    y=np.asarray([r['homeWin'] for r in ev]);cp=predict(ctl,ev);cc=metrics(cp,y);exp=vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):close(f'V16:combined:{k}',cc[k],exp[k],tol)
    base=list(c['control']['featuresExactly']);main=list(c['genericLineupBenchmark']['gameLevelFeaturesExactly']);adj=list(c['platoonAdjustmentLayer']['featuresExactly']);add_fs=tuple(base+main);ch_fs=tuple(base+main+adj)
    if len(ch_fs)!=int(c['challenger']['featureCount']) or len(set(ch_fs))!=len(ch_fs):raise SystemExit('V60_CHALLENGER_FEATURE_COUNT_INVALID')
    additive=fit_model(tr,ca,add_fs,float(c['challenger']['l2Strength']),'V16_C4_PLUS_V58_LINEUP_DIFF5_REPRODUCED');challenger=fit_model(tr,ca,ch_fs,float(c['challenger']['l2Strength']),c['challenger']['featureSet'])
    comps={}
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]]);cm=metrics(predict(ctl,rows[s]),ys);am=metrics(predict(additive,rows[s]),ys);nm=metrics(predict(challenger,rows[s]),ys);comps[s]={'rows':len(rows[s]),'control':cm,'additiveBenchmark':am,'challenger':nm,'improvementVsControl':compare(cm,nm),'improvementVsAdditiveBenchmark':compare(am,nm)}
        v58s=v58['evaluationBySeason'][s]['challenger']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):close(f'V58:{s}:{k}',am[k],v58s[k],2e-8)
    apred=predict(additive,ev);npred=predict(challenger,ev);ac=metrics(apred,y);nc=metrics(npred,y)
    v58c=v58['combinedEvaluation2024_2026Ytd']['challenger']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):close(f'V58:combined:{k}',ac[k],v58c[k],2e-8)
    comb={'rows':len(ev),'control':cc,'additiveBenchmark':ac,'challenger':nc,'improvementVsControl':compare(cc,nc),'improvementVsAdditiveBenchmark':compare(ac,nc)}
    bcfg=c['pairedBootstrap'];boot=bootstrap(ev,cp,npred,y,int(bcfg['resamples']),int(bcfg['seed']),float(bcfg['confidenceLevel']));boot_add=bootstrap(ev,apred,npred,y,int(bcfg['resamples']),int(bcfg['seed']),float(bcfg['confidenceLevel']))
    yc=np.asarray([r['homeWin'] for r in ca]);val_control=metrics(predict(ctl,ca),yc);val_add=metrics(predict(additive,ca),yc);val_ch=metrics(predict(challenger,ca),yc)
    rub=c['candidateRubric'];both=[comps[s]['improvementVsControl']['logLoss']>0 and comps[s]['improvementVsControl']['brier']>0 for s in evs];worse=[comps[s]['improvementVsControl']['logLoss']<0 and comps[s]['improvementVsControl']['brier']<0 for s in evs]
    checks={'controlManifestAndMetricParity':True,'v58AdditiveMetricParity':True,'combinedLogLossImproved':comb['improvementVsControl']['logLoss']>0,'combinedBrierImproved':comb['improvementVsControl']['brier']>0,'bootstrapLogLossLowerBoundPositive':boot['logLossImprovement']['lower']>0,'bootstrapBrierLowerBoundPositive':boot['brierImprovement']['lower']>0,'challengerCombinedEce10WithinAbsoluteMax':nc['ece10']<=float(rub['ece10AbsoluteMaximum']),'challengerAbsoluteMeanProbabilityGapNotWorseThanControl':nc['absoluteMeanHomeProbabilityGap']<=cc['absoluteMeanHomeProbabilityGap']+float(rub['meanProbabilityGapComparisonTolerance']),'atLeastTwoOfThreeEvaluationSeasonsImproveBoth':sum(both)>=2,'noEvaluationSeasonWorseOnBoth':not any(worse)}
    passed=coverage_ok and all(checks.values());classification=(rub['passingClassification'] if passed else (rub['failingClassification'] if coverage_ok else c['coverageGate']['belowGateClassification']))
    v59c=v59['combinedEvaluation2024_2026Ytd']['challenger'];vs_v59=compare(v59c,nc)
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage_ok,'scientificStatus':c['scientificStatus'],'target':'FULL_GAME_HOME_WIN','data':{'seasonRows':{s:len(rows[s]) for s in seasons},'custody':custody,'pairedControlAdditiveAndChallengerRows':True,'trainingSeason':'2022','calibrationSeason':'2023','evaluationSeasons':evs},'controlParity':{'modelVersion':vm['modelVersion'],'manifestSha256':digest(vm),'featureSet':ctl['featureSet'],'features':ctl['preprocessor']['features'],'combinedAndBySeasonMetricsReproduced':True},'features':{'controlCount':len(base),'genericLineupCount':len(main),'platoonAdjustmentCount':len(adj),'challengerCount':len(ch_fs),'challengerFeatures':list(ch_fs)},'additiveBenchmarkModel':additive,'challengerModel':challenger,'validation2023':{'control':val_control,'additiveBenchmark':val_add,'challenger':val_ch,'challengerImprovementVsControl':compare(val_control,val_ch),'challengerImprovementVsAdditive':compare(val_add,val_ch)},'evaluationBySeason':comps,'combinedEvaluation2024_2026Ytd':comb,'pairedDateBootstrapVsControl2024_2026Ytd':boot,'pairedDateBootstrapVsV58Additive2024_2026Ytd':boot_add,'candidateRubricChecks':checks,'diagnostics':{'beatsV58AdditiveCombinedLogLoss':comb['improvementVsAdditiveBenchmark']['logLoss']>0,'beatsV58AdditiveCombinedBrier':comb['improvementVsAdditiveBenchmark']['brier']>0,'improvementVsFrozenV59Combined':vs_v59,'beatsFrozenV59CombinedLogLoss':vs_v59['logLoss']>0,'beatsFrozenV59CombinedBrier':vs_v59['brier']>0,'v59FrozenCombined':v59c},'policy':{'researchOnly':True,'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'subsetMiningUsed':False,'homeAwaySubsetMiningUsed':False,'seasonExclusionAfterResultsUsed':False,'postResultRuleChangeAllowed':False,'postResultShrinkageChangeAllowed':False,'v16ProductionChanged':False,'productionMarketRegistryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'positiveEvEstablished':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage_ok,'coverage':{s:custody[s]['pregameStarterHandUsableShare'] for s in seasons},'combined':comb,'bootstrapVsControl':boot,'bootstrapVsV58Additive':boot_add,'bySeason':{s:comps[s]['improvementVsControl'] for s in evs},'vsV59':vs_v59,'checks':checks},indent=2))
if __name__=='__main__':main()

#!/usr/bin/env python3
import argparse, importlib.util, itertools, json, math, os
from collections import defaultdict, deque
from datetime import date, timedelta
import numpy as np

REPORT_SCHEMA='courtedge-p0-step12v63-batter-conditioned-pitch-shape.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v63-batter-conditioned-pitch-shape-contract.v1'
PACK_SCHEMA='courtedge-p0-step12v63-pitch-shape-pbp.v1'
PITCH_FIELDS=('recognizedPitches','shapeCompletePitches','velocitySum','horizontalMovementSum','verticalMovementSum','spinSum')
CELL_FIELDS=('pitches','swings','whiffs','battedBallN','hardHitN','pa','h','tb','k','hr')
METRICS=(
    ('hitsPerPa','h','pa','hitsPa',0.0,1.0),
    ('totalBasesPerPa','tb','pa','totalBasesPa',0.0,4.0),
    ('strikeoutsPerPa','k','pa','strikeoutsPa',0.0,1.0),
    ('homeRunsPerPa','hr','pa','homeRunsPa',0.0,1.0),
    ('whiffPerSwing','whiffs','swings','whiffSwings',0.0,1.0),
    ('hardHitPerBallInPlay','hardHitN','battedBallN','hardHitBallsInPlay',0.0,1.0),
)


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,v):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(v,f,indent=2,sort_keys=True);f.write('\n')
def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def zero(fields):return {k:0.0 for k in fields}
def add_rec(dst,src,fields,sign=1.0):
    for k in fields:dst[k]=float(dst.get(k,0.0))+sign*float(src.get(k,0.0))
def is_zero(rec,fields):return all(abs(float(rec.get(k,0.0)))<1e-9 for k in fields)
def clip(v,lo,hi):return max(float(lo),min(float(hi),float(v)))
def rate(rec,num,den):return float(rec.get(num,0.0))/float(rec.get(den,0.0)) if float(rec.get(den,0.0))>0 else None
def shrink(num,den,anchor,w):return (float(num)+float(w)*float(anchor))/(float(den)+float(w))
def shrink_mean(total,n,anchor,w):return (float(total)+float(w)*float(anchor))/(float(n)+float(w))

def nested_get(d,k1,k2,fields):
    return d.get(k1,{}).get(k2,zero(fields))
def nested_add(d,k1,k2,src,fields,sign):
    m=d.setdefault(k1,{})
    rec=m.setdefault(k2,zero(fields));add_rec(rec,src,fields,sign)
    if sign<0 and is_zero(rec,fields):
        del m[k2]
        if not m:del d[k1]
def cell_add(d,k1,k2,cell,src,sign):
    m=d.setdefault(k1,{});n=m.setdefault(k2,{})
    rec=n.setdefault(cell,zero(CELL_FIELDS));add_rec(rec,src,CELL_FIELDS,sign)
    if sign<0 and is_zero(rec,CELL_FIELDS):
        del n[cell]
        if not n:del m[k2]
        if not m:del d[k1]

def league_cell_add(d,pt,cell,src,sign):
    m=d.setdefault(pt,{});rec=m.setdefault(cell,zero(CELL_FIELDS));add_rec(rec,src,CELL_FIELDS,sign)
    if sign<0 and is_zero(rec,CELL_FIELDS):
        del m[cell]
        if not m:del d[pt]

def make_events(pack):
    return [(date.fromisoformat(str(g['officialDate'])),int(g['gamePk']),g) for g in pack.get('games',[])]

def apply_game(g,sign,ps,bg,bc,lp,lg,lc):
    for r in g.get('pitcherPitchTypeShapeTotals',[]):
        pid=int(r.get('pitcherId') or 0);pt=str(r.get('pitchType') or '')
        if pid<=0 or not pt:continue
        nested_add(ps,pid,pt,r,PITCH_FIELDS,sign)
        rec=lp.setdefault(pt,zero(PITCH_FIELDS));add_rec(rec,r,PITCH_FIELDS,sign)
        if sign<0 and is_zero(rec,PITCH_FIELDS):del lp[pt]
    for r in g.get('batterShapeCellTotals',[]):
        bid=int(r.get('batterId') or 0);pt=str(r.get('pitchType') or '')
        if bid<=0 or not pt:continue
        cell=(int(r['velocityBin']),int(r['horizontalMovementBin']),int(r['verticalMovementBin']),int(r['spinBin']))
        nested_add(bg,bid,pt,r,CELL_FIELDS,sign)
        cell_add(bc,bid,pt,cell,r,sign)
        rec=lg.setdefault(pt,zero(CELL_FIELDS));add_rec(rec,r,CELL_FIELDS,sign)
        if sign<0 and is_zero(rec,CELL_FIELDS):del lg[pt]
        league_cell_add(lc,pt,cell,r,sign)

def starter_shape(starter_id,ps,lp,c):
    sid=int(starter_id or 0);pm=ps.get(sid,{})
    total=sum(float(r.get('recognizedPitches',0.0)) for r in pm.values())
    hard=float(c['starterShapeTargetEngineering']['hardEligibilityMinimumPriorRecognizedPitches'])
    if sid<=0 or total<hard:return None,{'priorRecognizedPitches':total,'priorShapeCompletePitches':0.0,'usableShapeUsageShare':0.0}
    prior=float(c['starterShapeTargetEngineering']['centroidShrinkagePriorShapeCompletePitches']);items=[];usable=0.0;complete=0.0
    for pt,r in pm.items():
        rn=float(r.get('recognizedPitches',0.0));sn=float(r.get('shapeCompletePitches',0.0));complete+=sn
        if rn<=0 or sn<float(c['starterShapeTargetEngineering']['hardEligibilityMinimumPriorShapeCompletePitches']):continue
        lr=lp.get(pt)
        if not lr or float(lr.get('shapeCompletePitches',0.0))<=0:continue
        ln=float(lr['shapeCompletePitches']);anchor={
            'velocityMph':float(lr['velocitySum'])/ln,
            'horizontalMovementInches':float(lr['horizontalMovementSum'])/ln,
            'verticalMovementInches':float(lr['verticalMovementSum'])/ln,
            'spinRpm':float(lr['spinSum'])/ln,
        }
        cent={
            'velocityMph':shrink_mean(r['velocitySum'],sn,anchor['velocityMph'],prior),
            'horizontalMovementInches':shrink_mean(r['horizontalMovementSum'],sn,anchor['horizontalMovementInches'],prior),
            'verticalMovementInches':shrink_mean(r['verticalMovementSum'],sn,anchor['verticalMovementInches'],prior),
            'spinRpm':shrink_mean(r['spinSum'],sn,anchor['spinRpm'],prior),
        }
        u=rn/total;usable+=u;items.append((pt,u,cent))
    if usable<float(c['starterShapeTargetEngineering']['minimumUsableShapeUsageShareForDerivedMatchup']):
        return None,{'priorRecognizedPitches':total,'priorShapeCompletePitches':complete,'usableShapeUsageShare':usable}
    return [(pt,u/usable,cent) for pt,u,cent in items],{'priorRecognizedPitches':total,'priorShapeCompletePitches':complete,'usableShapeUsageShare':usable}

def metric_prior(c,metric,den):
    if den=='pa':return float(c['batterShapeResponseEngineering']['genericShrinkagePrior']['terminalPa'])
    if den=='swings':return float(c['batterShapeResponseEngineering']['genericShrinkagePrior']['swings'])
    return float(c['batterShapeResponseEngineering']['genericShrinkagePrior']['ballsInPlay'])

def shape_context(pt,cent,lg,lc,c):
    lgen=lg.get(pt)
    if not lgen:return None
    league_generic={}
    for name,num,den,_,_,_ in METRICS:
        v=rate(lgen,num,den)
        if v is None:return None
        league_generic[name]=v
    bw=c['shapeCellEngineering']['bucketWidth'];band=c['shapeCellEngineering']['kernelBandwidth'];rad=int(c['shapeCellEngineering']['neighborRadiusCellsEachDimension'])
    vals=(cent['velocityMph'],cent['horizontalMovementInches'],cent['verticalMovementInches'],cent['spinRpm'])
    widths=(float(bw['velocityMph']),float(bw['horizontalMovementInches']),float(bw['verticalMovementInches']),float(bw['spinRpm']))
    bands=(float(band['velocityMph']),float(band['horizontalMovementInches']),float(band['verticalMovementInches']),float(band['spinRpm']))
    base=tuple(int(math.floor(v/w)) for v,w in zip(vals,widths));neighbors=[]
    league_num={m[0]:0.0 for m in METRICS};league_den={m[0]:0.0 for m in METRICS};lmap=lc.get(pt,{})
    for offs in itertools.product(range(-rad,rad+1),repeat=4):
        cell=tuple(b+o for b,o in zip(base,offs));center=tuple((x+0.5)*w for x,w in zip(cell,widths));dist=sum(((x-v)/h)**2 for x,v,h in zip(center,vals,bands));kw=math.exp(-0.5*dist);neighbors.append((cell,kw));lr=lmap.get(cell)
        if lr is None:continue
        for name,num,den,_,_,_ in METRICS:
            league_num[name]+=kw*float(lr.get(num,0.0));league_den[name]+=kw*float(lr.get(den,0.0))
    league_local={name:(league_num[name]/league_den[name] if league_den[name]>0 else league_generic[name]) for name,_,_,_,_,_ in METRICS}
    return {'neighbors':neighbors,'leagueGeneric':league_generic,'leagueLocal':league_local}

def local_shape_rates(bid,pt,ctx,bg,bc,c):
    bgen=nested_get(bg,int(bid),pt,CELL_FIELDS);bmap=bc.get(int(bid),{}).get(pt,{})
    bnum={m[0]:0.0 for m in METRICS};bden={m[0]:0.0 for m in METRICS}
    for cell,kw in ctx['neighbors']:
        br=bmap.get(cell)
        if br is None:continue
        for name,num,den,_,_,_ in METRICS:
            bnum[name]+=kw*float(br.get(num,0.0));bden[name]+=kw*float(br.get(den,0.0))
    values={};exposure=[]
    for met in METRICS:
        name,num,den,prior_key,lo,hi=met;league_generic=ctx['leagueGeneric'][name];gp=metric_prior(c,met,den);batter_generic=shrink(bgen.get(num,0.0),bgen.get(den,0.0),league_generic,gp);anchor=clip(batter_generic+ctx['leagueLocal'][name]-league_generic,lo,hi);sp=float(c['batterShapeResponseEngineering']['shapeSpecificShrinkagePrior'][prior_key]);final=(bnum[name]+sp*anchor)/(bden[name]+sp);values[name]=clip(final,lo,hi);exposure.append(bden[name])
    return values,exposure

def team_shape(ids,epas,starter_id,ps,bg,bc,lp,lg,lc,c):
    if any(x is None for x in epas):return None,{'missingSlotExpectedPa':True}
    shape,diag=starter_shape(starter_id,ps,lp,c)
    if shape is None:return None,diag
    contexts={}
    for pt,u,cent in shape:
        ctx=shape_context(pt,cent,lg,lc,c)
        if ctx is None:return None,{**diag,'missingLeaguePitchTypeAnchor':pt}
        contexts[pt]=(u,ctx)
    totals={m[0]:0.0 for m in METRICS};local_exposure=[];total_epa=sum(float(x) for x in epas)
    if total_epa<=0:return None,{**diag,'missingSlotExpectedPa':True}
    for bid,epa in zip(ids,epas):
        per={m[0]:0.0 for m in METRICS}
        for pt,u,_ in shape:
            vals,locs=local_shape_rates(bid,pt,contexts[pt][1],bg,bc,c);local_exposure.extend(locs)
            for name in per:per[name]+=u*vals[name]
        for name in ('hitsPerPa','totalBasesPerPa','strikeoutsPerPa','homeRunsPerPa'):totals[name]+=per[name]*float(epa)
        for name in ('whiffPerSwing','hardHitPerBallInPlay'):totals[name]+=per[name]*float(epa)/total_epa
    diag={**diag,'meanKernelWeightedBatterLocalDenominator':float(np.mean(local_exposure)) if local_exposure else 0.0}
    return totals,diag

def build_shape_features(v60,v61,rows,lineup_root,batter_root,hands_root,shape_root,seasons,c):
    prior20=float(c['lineupAggregation']['lineupSlotWorkloadShrinkagePriorStarts']);slot={};hands={};packs={};bydate={s:defaultdict(list) for s in seasons}
    for s in seasons:
        slot[s]=v61.precompute_slot_epa(v60,lineup_root,batter_root,s,rows[s],prior20)
        hp=load(os.path.join(hands_root,f'pregame-hands-{s}.json'));hands[s]={int(x['gamePk']):x for x in hp.get('snapshots',[])}
        for r in rows[s]:bydate[s][str(r['officialDate'])].append(r)
    events=defaultdict(list)
    for s in [str(c['dataBoundary']['warmupSeason']),*seasons]:
        p=load(os.path.join(shape_root,f'pitch-shape-{s}.json'))
        if p.get('schemaVersion')!=PACK_SCHEMA:raise SystemExit(f'V63_PACK_SCHEMA_INVALID:{s}')
        packs[s]=p
        for d,pk,g in make_events(p):events[d.isoformat()].append((pk,g))
    ps={};bg={};bc={};lp={};lg={};lc={};active=deque();feature_names=list(c['shapeMatchupLayer']['featuresExactly']);keys=('hitsPerPa','totalBasesPerPa','strikeoutsPerPa','homeRunsPerPa','whiffPerSwing','hardHitPerBallInPlay')
    stat={s:{'derived':0,'starterPrior':[],'starterShapePrior':[],'usableUsage':[],'localExposure':[]} for s in seasons};look=int(c['dataBoundary']['rollingLookbackDays'])
    for ds in sorted(events):
        d=date.fromisoformat(ds);cutoff=d-timedelta(days=look)
        while active and active[0]<cutoff:
            old=active.popleft()
            for _,g in events[old.isoformat()]:apply_game(g,-1,ps,bg,bc,lp,lg,lc)
        for s in seasons:
            for r in bydate[s].get(ds,[]):
                pk=int(r['gamePk']);sl=slot[s].get(pk);hs=hands[s].get(pk) or {};usable=hs.get('usable') is True
                home_starter=int(hs.get('homePitcherId') or 0) if usable else 0;away_starter=int(hs.get('awayPitcherId') or 0) if usable else 0
                he,hd=team_shape(sl['homeIds'],sl['homeEpa'],away_starter,ps,bg,bc,lp,lg,lc,c) if sl else (None,{})
                ae,ad=team_shape(sl['awayIds'],sl['awayEpa'],home_starter,ps,bg,bc,lp,lg,lc,c) if sl else (None,{})
                if he is not None and ae is not None:
                    for n,k in zip(feature_names,keys):r[n]=float(he[k])-float(ae[k])
                    st=stat[s];st['derived']+=1;st['starterPrior'].append(min(hd['priorRecognizedPitches'],ad['priorRecognizedPitches']));st['starterShapePrior'].append(min(hd['priorShapeCompletePitches'],ad['priorShapeCompletePitches']));st['usableUsage'].append(min(hd['usableShapeUsageShare'],ad['usableShapeUsageShare']));st['localExposure'].append(float(np.mean([hd.get('meanKernelWeightedBatterLocalDenominator',0.0),ad.get('meanKernelWeightedBatterLocalDenominator',0.0)])))
                else:
                    for n in feature_names:r[n]=None
        for _,g in events[ds]:apply_game(g,1,ps,bg,bc,lp,lg,lc)
        active.append(d)
    custody={}
    for s in seasons:
        p=packs[s];n=len(rows[s]);hm=hands[s];usable=sum(1 for r in rows[s] if (hm.get(int(r['gamePk'])) or {}).get('usable') is True);st=stat[s]
        custody[s]={'rows':n,'pregameStarterIdentityPairUsableGames':usable,'pregameStarterIdentityPairUsableShare':usable/n if n else 0.0,'pitchPbpGamesExpected':int(p['gamesExpected']),'pitchPbpGamesFetched':int(p['gamesFetched']),'pitchPbpFailureShare':float(p['failureShare']),'recognizedPitchTypeShare':float(p['recognizedPitchTypeShare']),'velocityTelemetryShare':float(p['velocityTelemetryShare']),'horizontalMovementTelemetryShare':float(p['horizontalMovementTelemetryShare']),'verticalMovementTelemetryShare':float(p['verticalMovementTelemetryShare']),'spinTelemetryShare':float(p['spinTelemetryShare']),'shapeCompleteShareOfRecognizedPitches':float(p['shapeCompleteShareOfRecognizedPitches']),'gamesWithAllSixV63FeaturesAvailable':st['derived'],'fullFeatureDerivedShare':st['derived']/n if n else 0.0,'medianMinimumStarterPriorRecognizedPitches':float(np.median(st['starterPrior'])) if st['starterPrior'] else None,'medianMinimumStarterPriorShapeCompletePitches':float(np.median(st['starterShapePrior'])) if st['starterShapePrior'] else None,'medianMinimumUsableStarterShapeUsageShare':float(np.median(st['usableUsage'])) if st['usableUsage'] else None,'medianGameMeanKernelWeightedBatterLocalDenominator':float(np.median(st['localExposure'])) if st['localExposure'] else None}
    return rows,custody

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--control-root',required=True);ap.add_argument('--lineup-root',required=True);ap.add_argument('--batter-root',required=True);ap.add_argument('--hands-root',required=True);ap.add_argument('--shape-root',required=True);ap.add_argument('--v16-report',required=True);ap.add_argument('--v16-manifest',required=True);ap.add_argument('--v62-report',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);x=ap.parse_args()
    c=load(x.contract);v60=module('scripts/p0-step12v60-individual-lineup-platoon-winner.py','v60f');v61=module('scripts/p0-step12v61-individual-pitchmix-winner.py','v61f');vr=load(x.v16_report);vm=load(x.v16_manifest);v62r=load(x.v62_report)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA or c.get('contractRevision')!=3:raise SystemExit('V63_CONTRACT_INVALID')
    if v62r.get('classification')!=c['parentEvidence']['v62FrozenClassification']:raise SystemExit('V63_V62_PARENT_INVALID')
    if vr.get('classification')!=c['parentEvidence']['v16RequiredClassification'] or v60.digest(vm)!=c['parentEvidence']['v16ManifestSha256']:raise SystemExit('V63_V16_PARENT_INVALID')
    ctl=vm['fullGame'];base=list(c['control']['featuresExactly'])
    if ctl.get('featureSet')!=c['control']['featureSetRequired'] or ctl['preprocessor']['features']!=base:raise SystemExit('V63_CONTROL_FEATURE_DRIFT')
    seasons=[c['dataBoundary']['trainingSeason'],c['dataBoundary']['calibrationSeason'],*c['dataBoundary']['retrospectiveEvaluationSeasons']];v60c=load('research/p0-step12v60-individual-lineup-platoon-winner-contract.json');rows={}
    for s in seasons:
        rows[s],_=v60.build_rows(x.control_root,x.lineup_root,x.batter_root,x.hands_root,s,v60c)
        if len(rows[s])!=int(c['dataBoundary']['expectedRowsBySeason'][s]):raise SystemExit(f'V63_ROW_COUNT_DRIFT:{s}')
    rows,custody=build_shape_features(v60,v61,rows,x.lineup_root,x.batter_root,x.hands_root,x.shape_root,seasons,c)
    gate=c['coverageGate'];coverage=True
    for s in seasons:
        z=custody[s];coverage=coverage and z['pregameStarterIdentityPairUsableShare']>=float(gate['minimumPregameStarterIdentityPairShareEachTargetSeason']) and z['recognizedPitchTypeShare']>=float(gate['minimumRecognizedPitchTypeShareEachTargetSeason']) and z['velocityTelemetryShare']>=float(gate['minimumVelocityTelemetryShareEachTargetSeason']) and z['horizontalMovementTelemetryShare']>=float(gate['minimumHorizontalMovementTelemetryShareEachTargetSeason']) and z['verticalMovementTelemetryShare']>=float(gate['minimumVerticalMovementTelemetryShareEachTargetSeason']) and z['spinTelemetryShare']>=float(gate['minimumSpinTelemetryShareEachTargetSeason']) and z['shapeCompleteShareOfRecognizedPitches']>=float(gate['minimumShapeCompleteShareEachTargetSeason']) and z['pitchPbpFailureShare']<=float(gate['maximumTargetGameFetchFailureShareEachSeason'])
        if s in c['dataBoundary']['retrospectiveEvaluationSeasons']:coverage=coverage and z['fullFeatureDerivedShare']>=float(gate['minimumFullFeatureDerivedShareEachEvaluationSeason']) and z['medianMinimumUsableStarterShapeUsageShare'] is not None and z['medianMinimumUsableStarterShapeUsageShare']>=float(gate['minimumMedianUsableStarterShapeUsageShareEachEvaluationSeason'])
    tol=float(c['control']['metricParityAbsoluteTolerance']);evs=list(c['dataBoundary']['retrospectiveEvaluationSeasons'])
    for s in evs:
        y=np.asarray([r['homeWin'] for r in rows[s]]);m=v60.metrics(v60.predict(ctl,rows[s]),y);exp=vr['evaluationBySeason'][s]['fullGame']['model']
        for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V63_V16:{s}:{k}',m[k],exp[k],tol)
    tr=rows['2022'];ca=rows['2023'];ev=[r for s in evs for r in rows[s]];y=np.asarray([r['homeWin'] for r in ev]);cp=v60.predict(ctl,ev);cc=v60.metrics(cp,y);exp=vr['combinedEvaluation']['fullGame']['model']
    for k in ('logLoss','brier','ece10','meanPredictedHome','observedHomeRate','accuracyAtHalf'):v60.close(f'V63_V16:combined:{k}',cc[k],exp[k],tol)
    sf=list(c['shapeMatchupLayer']['featuresExactly']);features=tuple(base+sf)
    if len(features)!=int(c['challenger']['featureCount']) or len(set(features))!=len(features):raise SystemExit('V63_FEATURE_COUNT_INVALID')
    model=v60.fit_model(tr,ca,features,float(c['challenger']['l2Strength']),c['challenger']['featureSet']);comps={}
    for s in evs:
        ys=np.asarray([r['homeWin'] for r in rows[s]]);cm=v60.metrics(v60.predict(ctl,rows[s]),ys);fm=v60.metrics(v60.predict(model,rows[s]),ys);comps[s]={'rows':len(rows[s]),'control':cm,'challenger':fm,'challengerImprovementVsControl':v60.compare(cm,fm)}
    fp=v60.predict(model,ev);fc=v60.metrics(fp,y);combined={'rows':len(ev),'control':cc,'challenger':fc,'challengerImprovementVsControl':v60.compare(cc,fc)}
    b=c['pairedBootstrap'];boot=v60.bootstrap(ev,cp,fp,y,int(b['resamples']),int(b['seed']),float(b['confidenceLevel']));rub=c['candidateRubric'];both=[comps[s]['challengerImprovementVsControl']['logLoss']>0 and comps[s]['challengerImprovementVsControl']['brier']>0 for s in evs];worse=[comps[s]['challengerImprovementVsControl']['logLoss']<0 and comps[s]['challengerImprovementVsControl']['brier']<0 for s in evs]
    checks={'controlManifestAndMetricParity':True,'combinedLogLossImproved':combined['challengerImprovementVsControl']['logLoss']>0,'combinedBrierImproved':combined['challengerImprovementVsControl']['brier']>0,'bootstrapLogLossLowerBoundPositive':boot['logLossImprovement']['lower']>0,'bootstrapBrierLowerBoundPositive':boot['brierImprovement']['lower']>0,'challengerCombinedEce10WithinAbsoluteMax':fc['ece10']<=float(rub['ece10AbsoluteMaximum']),'challengerAbsoluteMeanProbabilityGapNotWorseThanControl':fc['absoluteMeanHomeProbabilityGap']<=cc['absoluteMeanHomeProbabilityGap']+float(rub['meanProbabilityGapComparisonTolerance']),'atLeastTwoOfThreeEvaluationSeasonsImproveBoth':sum(both)>=2,'noEvaluationSeasonWorseOnBoth':not any(worse)}
    passed=coverage and all(checks.values());classification=rub['passingClassification'] if passed else (rub['failingClassification'] if coverage else gate['belowGateClassification']);v62c=v62r['combinedEvaluation2024_2026Ytd']['challenger'];vs62=v60.compare(v62c,fc)
    yc=np.asarray([r['homeWin'] for r in ca]);val={'control':v60.metrics(v60.predict(ctl,ca),yc),'challenger':v60.metrics(v60.predict(model,ca),yc)}
    report={'schemaVersion':REPORT_SCHEMA,'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'scientificStatus':c['scientificStatus'],'target':'FULL_GAME_HOME_WIN','data':{'seasonRows':{s:len(rows[s]) for s in seasons},'warmupSeason':c['dataBoundary']['warmupSeason'],'custody':custody,'trainingSeason':'2022','calibrationSeason':'2023','evaluationSeasons':evs},'controlParity':{'modelVersion':vm['modelVersion'],'manifestSha256':v60.digest(vm),'featureSet':ctl['featureSet'],'features':ctl['preprocessor']['features'],'combinedAndBySeasonMetricsReproduced':True},'features':{'controlCount':len(base),'shapeMatchupCount':len(sf),'challengerCount':len(features),'challengerFeatures':list(features)},'challengerModel':model,'validation2023':val,'evaluationBySeason':comps,'combinedEvaluation2024_2026Ytd':combined,'pairedDateBootstrapVsControl2024_2026Ytd':boot,'candidateRubricChecks':checks,'diagnostics':{'improvementVsFrozenV62Combined':vs62,'beatsFrozenV62CombinedLogLoss':vs62['logLoss']>0,'beatsFrozenV62CombinedBrier':vs62['brier']>0,'frozenV62IsDiagnosticOnlyNotPromotionControl':True},'policy':{'researchOnly':True,'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'historicalPricesUsed':False,'marketOddsUsedAsFeatures':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'subsetMiningUsed':False,'homeAwaySubsetMiningUsed':False,'seasonExclusionAfterResultsUsed':False,'postResultRuleChangeAllowed':False,'postResultShrinkageChangeAllowed':False,'postResultShapeGeometryChangeAllowed':False,'v16ProductionChanged':False,'productionMarketRegistryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'finalRecommendationChanged':False,'automaticBetPlacementAllowed':False,'positiveEvEstablished':False,'realFinancialExposure':0}}
    dump(x.out,report);print(json.dumps({'classification':classification,'candidateRubricPassed':passed,'coverageGatePassed':coverage,'custody':custody,'combined':combined['challengerImprovementVsControl'],'bootstrap':boot,'bySeason':{s:comps[s]['challengerImprovementVsControl'] for s in evs},'vsV62':vs62,'checks':checks},indent=2))
if __name__=='__main__':main()

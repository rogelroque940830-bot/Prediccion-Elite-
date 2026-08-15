#!/usr/bin/env python3
import argparse,json,math,os
from collections import Counter,defaultdict
import numpy as np,pandas as pd
from scipy.stats import nbinom,poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error,mean_poisson_deviance
from sklearn.preprocessing import StandardScaler
REPORT_SCHEMA='courtedge-p0-step12v39-pitcher-outs-baseline.v1';BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'
def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)
def dump(p,x):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(x,f,indent=2,sort_keys=True);f.write('\n')
def finite(v):
    try:return v is not None and math.isfinite(float(v))
    except:return False
def posint(v):
    try:
        x=int(v);return x if x>0 else None
    except:return None
def audit_valid(a):return bool(a and a.get('identityOk') and a.get('sourceHistorical') and a.get('pregame'))
def probable_ids(a):
    if not audit_valid(a) or not a.get('probableBothKnown'):return None,None
    h,w=posint(a.get('homeProbablePitcherId')),posint(a.get('awayProbablePitcherId'));return (h,w) if h and w else (None,None)
def complete_lineup(l,a):
    if not audit_valid(a) or not l or not l.get('complete'):return None,None
    try:h=[int(x) for x in l.get('homeBattingOrder',[])];w=[int(x) for x in l.get('awayBattingOrder',[])]
    except:return None,None
    if len(h)!=9 or len(w)!=9 or len(set(h))!=9 or len(set(w))!=9 or min(h+w)<=0:return None,None
    return h,w
def continuity(cur,prev):return None if cur is None or prev is None else len(set(cur)&set(prev))/9.0
def parse_line(raw):
    if not raw:return None
    pid=posint(raw.get('pitcherId'))
    if pid is None:return None
    mapping={'bf':'battersFaced','outs':'outsRecorded','pitches':'numberOfPitches','k':'strikeOuts','bb':'baseOnBalls','er':'earnedRuns'};o={'pitcherId':pid}
    for k,s in mapping.items():
        v=raw.get(s,0)
        if not finite(v) or float(v)<0:raise SystemExit(f'V39_INVALID_STARTER_LINE:{pid}:{s}:{v}')
        o[k]=float(v)
    return o
def empty_p():return {'starts':0,'bf':0.0,'outs':0.0,'pitches':0.0,'k':0.0,'bb':0.0,'er':0.0,'recent':[]}
def empty_o():return {'games':0,'outs':0.0}
def add_p(s,l,w):
    s['starts']+=1
    for k in ('bf','outs','pitches','k','bb','er'):s[k]+=l[k]
    s['recent'].append({'outs':l['outs'],'pitches':l['pitches']})
    if len(s['recent'])>w:s['recent']=s['recent'][-w:]
def priors(s):
    if s['starts']<=0 or s['bf']<=0:return None
    return {'outsPerStart':s['outs']/s['starts'],'bfPerStart':s['bf']/s['starts'],'pitchesPerStart':s['pitches']/s['starts'],'kbf':s['k']/s['bf'],'bbbf':s['bb']/s['bf'],'erbf':s['er']/s['bf']}
def sr(n,d,r,p):return (float(n)+p*float(r))/(float(d)+p)
def sm(t,n,m,p):return (float(t)+p*float(m))/(float(n)+p)
def pfeat(s,p,rate_prior,work_prior):
    r=s['recent']
    if p is None:return {'pitcher_outs_per_start_shrunk':None,'pitcher_bf_per_start_shrunk':None,'pitcher_pitches_per_start_shrunk':None,'pitcher_kbf_shrunk':None,'pitcher_bbbf_shrunk':None,'pitcher_erbf_shrunk':None,'pitcher_recent5_outs_per_start':None,'pitcher_recent5_pitches_per_start':None,'pitcher_prior_starts':float(s['starts'])}
    return {'pitcher_outs_per_start_shrunk':sm(s['outs'],s['starts'],p['outsPerStart'],work_prior),'pitcher_bf_per_start_shrunk':sm(s['bf'],s['starts'],p['bfPerStart'],work_prior),'pitcher_pitches_per_start_shrunk':sm(s['pitches'],s['starts'],p['pitchesPerStart'],work_prior),'pitcher_kbf_shrunk':sr(s['k'],s['bf'],p['kbf'],rate_prior),'pitcher_bbbf_shrunk':sr(s['bb'],s['bf'],p['bbbf'],rate_prior),'pitcher_erbf_shrunk':sr(s['er'],s['bf'],p['erbf'],rate_prior),'pitcher_recent5_outs_per_start':float(np.mean([x['outs'] for x in r])) if r else None,'pitcher_recent5_pitches_per_start':float(np.mean([x['pitches'] for x in r])) if r else None,'pitcher_prior_starts':float(s['starts'])}
def ofeat(s,p,prior_games):
    return {'opponent_vs_starters_outs_per_game_shrunk':None if p is None else sm(s['outs'],s['games'],p['outsPerStart'],prior_games)}
def opp_rs10(f,side):
    c,d=f.get('combined_team_rs10'),f.get('team_rs10_diff')
    if not finite(c) or not finite(d):return None
    home=(float(c)+float(d))/2;away=(float(c)-float(d))/2;return away if side=='home' else home
def nb2(y,mu):
    den=float(np.sum(mu**2));num=float(np.sum((y-mu)**2-mu))
    if den<=0:raise SystemExit('V39_NB2_DENOMINATOR_INVALID')
    return max(0.0,num/den)
def overp(mu,disp,line):
    c=math.floor(float(line));mu=max(float(mu),1e-9)
    if disp<=1e-12:return float(1-poisson.cdf(c,mu))
    r=1/disp;p=r/(r+mu);return float(1-nbinom.cdf(c,r,p))
def evaluate(df,features,imp,scaler,model,disp,train_mean,line_probs,lines):
    X=scaler.transform(imp.transform(df[list(features)]));model_mu=np.maximum(model.predict(X),1e-9);y=df['outsRecorded'].to_numpy(float);const=np.full(len(df),train_mean,float);pitch=df['pitcherOnlyMuRaw'].to_numpy(float);pitch=np.where(np.isfinite(pitch)&(pitch>0),pitch,train_mean)
    md=float(mean_poisson_deviance(y,model_mu));cd=float(mean_poisson_deviance(y,const));pd=float(mean_poisson_deviance(y,pitch));mb=[];cb=[];pb=[];diag={}
    for line in lines:
        obs=(y>line).astype(float);mp=np.array([overp(x,disp,line) for x in model_mu]);pp=np.array([overp(x,disp,line) for x in pitch]);cp=float(line_probs[line]);m=float(np.mean((mp-obs)**2));c=float(np.mean((cp-obs)**2));p=float(np.mean((pp-obs)**2));mb.append(m);cb.append(c);pb.append(p);diag[str(line)]={'observedOverRate':float(np.mean(obs)),'meanModelOverProbability':float(np.mean(mp)),'meanPitcherOnlyOverProbability':float(np.mean(pp)),'trainingClimatologyOverProbability':cp,'modelBrier':m,'constantBaselineBrier':c,'pitcherOnlyBaselineBrier':p,'modelVsConstantBrierImprovement':c-m,'modelVsPitcherOnlyBrierImprovement':p-m}
    om=float(np.mean(y));mm=float(np.mean(model_mu));pm=float(np.mean(pitch))
    return {'rows':int(len(df)),'observedMeanOutsRecorded':om,'meanModelOutsRecorded':mm,'meanPitcherOnlyOutsRecorded':pm,'trainingConstantMeanOutsRecorded':float(train_mean),'modelAbsoluteMeanCalibrationBias':abs(mm-om),'constantAbsoluteMeanCalibrationBias':abs(float(train_mean)-om),'pitcherOnlyAbsoluteMeanCalibrationBias':abs(pm-om),'modelMeanAbsoluteError':float(mean_absolute_error(y,model_mu)),'constantMeanAbsoluteError':float(mean_absolute_error(y,const)),'pitcherOnlyMeanAbsoluteError':float(mean_absolute_error(y,pitch)),'modelPoissonDeviance':md,'constantPoissonDeviance':cd,'pitcherOnlyPoissonDeviance':pd,'modelVsConstantDevianceImprovement':cd-md,'modelVsPitcherOnlyDevianceImprovement':pd-md,'fixedLineDiagnostics':diag,'modelAverageBrier':float(np.mean(mb)),'constantAverageBrier':float(np.mean(cb)),'pitcherOnlyAverageBrier':float(np.mean(pb)),'modelVsConstantAverageBrierImprovement':float(np.mean(cb)-np.mean(mb)),'modelVsPitcherOnlyAverageBrierImprovement':float(np.mean(pb)-np.mean(mb))}
def build(root,season,c):
    base=os.path.join(root,season);canonical=load(os.path.join(base,'game-anatomy-feature-table.json'));sp=load(os.path.join(base,'cohort','starting-pitcher-history.json'));lu=load(os.path.join(base,'cohort','pregame-lineup-history.json'));au=load(os.path.join(base,'t5-audit','t5-starter-identity-audit.json'))
    if canonical.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V39_BASE_SCHEMA_INVALID:{season}')
    smap={int(x['gamePk']):x for x in sp.get('games',[])};lmap={int(x['gamePk']):x for x in lu.get('snapshots',[])};amap={int(x['gamePk']):x for x in au.get('rows',[])};cr=[x for x in canonical.get('rows',[]) if x.get('t5PregameValid')];by=defaultdict(list)
    for x in cr:by[str(x['officialDate'])].append(x)
    ps=defaultdict(empty_p);os_=defaultdict(empty_o);league=empty_p();prev={};cfg=c['featureEngineering'];rows=[];prob=elig=clp=0
    for date in sorted(by):
        games=sorted(by[date],key=lambda x:int(x['gamePk']));pr=priors(league)
        for raw in games:
            gp=int(raw['gamePk']);ht=int(raw['homeTeamId']);at=int(raw['awayTeamId']);a=amap.get(gp);hp,ap=probable_ids(a)
            if hp and ap:prob+=2
            ch,ca=complete_lineup(lmap.get(gp),a)
            if ch is not None and ca is not None:clp+=1
            sg=smap.get(gp)
            if not sg:continue
            ah=parse_line(sg.get('homeStarter'));aa=parse_line(sg.get('awayStarter'));f=raw.get('features') or {}
            for side,pid,actual,opp,opp_lu in [('home',hp,ah,at,ca),('away',ap,aa,ht,ch)]:
                if pid is None or actual is None or actual['bf']<=0 or pid!=actual['pitcherId']:continue
                elig+=1;p=pfeat(ps[pid],pr,float(cfg['rateShrinkagePriorBattersFaced']),float(cfg['workloadShrinkagePriorStarts']));p.update(ofeat(os_[opp],pr,float(cfg['opponentWorkloadShrinkagePriorGames'])));p['opponent_rs10']=opp_rs10(f,side);p['opponent_lineup_continuity']=continuity(opp_lu,prev.get(opp));rawmu=p['pitcher_outs_per_start_shrunk'] if finite(p['pitcher_outs_per_start_shrunk']) else None
                rows.append({'season':season,'officialDate':date,'gamePk':gp,'side':side,'pitcherId':pid,'opponentTeamId':opp,'outsRecorded':int(actual['outs']),'actualBattersFaced':float(actual['bf']),'pitcherOnlyMuRaw':rawmu,**p})
        for raw in games:
            gp=int(raw['gamePk']);ht=int(raw['homeTeamId']);at=int(raw['awayTeamId']);sg=smap.get(gp)
            if sg:
                hl=parse_line(sg.get('homeStarter'));al=parse_line(sg.get('awayStarter'))
                if hl and hl['bf']>0:
                    add_p(ps[hl['pitcherId']],hl,int(cfg['recentStartsWindow']));add_p(league,hl,int(cfg['recentStartsWindow']));os_[at]['games']+=1;os_[at]['outs']+=hl['outs']
                if al and al['bf']>0:
                    add_p(ps[al['pitcherId']],al,int(cfg['recentStartsWindow']));add_p(league,al,int(cfg['recentStartsWindow']));os_[ht]['games']+=1;os_[ht]['outs']+=al['outs']
            a=amap.get(gp);ch,ca=complete_lineup(lmap.get(gp),a)
            if ch is not None:prev[ht]=ch
            if ca is not None:prev[at]=ca
    slots=2*len(cr);return rows,{'canonicalT5Games':len(cr),'canonicalStarterSlots':slots,'auditValidProbableStarterSlots':prob,'exactProbableRecordedStarterEligibleSlots':elig,'eligibilityShareOfCanonicalStarterSlots':elig/slots if slots else 0.0,'completeAuditValidLineupPairs':clp}
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);args=ap.parse_args();c=load(args.contract)
    if c.get('schemaVersion')!='courtedge-p0-step12v39-pitcher-outs-baseline-contract.v1':raise SystemExit('V39_CONTRACT_SCHEMA_INVALID')
    rec=[];cust={}
    for s in ['2022','2023','2024','2025','2026_YTD']:r,k=build(args.root,s,c);rec+=r;cust[s]=k
    df=pd.DataFrame(rec);features=tuple(c['features']['exactly']);tr=df[df.season=='2022'].copy();va=df[df.season=='2023'].copy();ev=df[df.season.isin(['2024','2025','2026_YTD'])].copy();imp=SimpleImputer(strategy='median');sc=StandardScaler();X=sc.fit_transform(imp.fit_transform(tr[list(features)]));y=tr.outsRecorded.to_numpy(float);cfg=c['model'];model=PoissonRegressor(alpha=float(cfg['poissonAlpha']),max_iter=int(cfg['maxIter']));model.fit(X,y);tmu=np.maximum(model.predict(X),1e-9);disp=nb2(y,tmu);tm=float(np.mean(y));lines=[float(x) for x in cfg['fixedHalfOutLines']];lp={x:float(np.mean(y>x)) for x in lines};v=evaluate(va,features,imp,sc,model,disp,tm,lp,lines);e=evaluate(ev,features,imp,sc,model,disp,tm,lp,lines);bys={s:evaluate(df[df.season==s].copy(),features,imp,sc,model,disp,tm,lp,lines) for s in ['2023','2024','2025','2026_YTD']}
    checks={'validationDevianceBeatsConstant':v['modelVsConstantDevianceImprovement']>0,'validationDevianceBeatsPitcherOnly':v['modelVsPitcherOnlyDevianceImprovement']>0,'validationBrierBeatsConstant':v['modelVsConstantAverageBrierImprovement']>0,'validationBrierBeatsPitcherOnly':v['modelVsPitcherOnlyAverageBrierImprovement']>0,'evaluationDevianceBeatsConstant':e['modelVsConstantDevianceImprovement']>0,'evaluationDevianceBeatsPitcherOnly':e['modelVsPitcherOnlyDevianceImprovement']>0,'evaluationBrierBeatsConstant':e['modelVsConstantAverageBrierImprovement']>0,'evaluationBrierBeatsPitcherOnly':e['modelVsPitcherOnlyAverageBrierImprovement']>0};passed=all(checks.values());clas='PITCHER_OUTS_NO_RETUNE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'PITCHER_OUTS_BASELINE_REJECTED';counts=Counter(df.officialDate);slots=sum(x['canonicalStarterSlots'] for x in cust.values());report={'schemaVersion':REPORT_SCHEMA,'classification':clas,'candidateRubricPassed':passed,'data':{'scoredRows':int(len(df)),'custodyBySeason':cust,'featureCount':len(features),'features':list(features),'sameDateHistoryAllowed':False,'seasonHistoryReset':True},'model':{'providerMarketKey':'pitcher_outs','canonicalResearchMarketType':'PITCHER_OUTS','trainingSeason':'2022','trainingRows':int(len(tr)),'trainingMeanOutsRecorded':tm,'poissonAlpha':1.0,'maxIter':1000,'nb2Dispersion':float(disp),'fixedHalfOutLines':lines,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'coefficientsDescriptiveNotSelectionInput':{features[i]:float(model.coef_[i]) for i in range(len(features))}},'baselines':{'constantMeanOutsRecorded':tm,'pitcherOnlyFormula':c['baselines']['pitcherOnlyMechanistic'],'sharedTrainingOnlyNb2Dispersion':float(disp),'constantFixedLineOverProbabilities':{str(k):x for k,x in lp.items()}},'validation2023':v,'evaluation2024_2026Ytd':e,'bySeasonDescriptiveOnly':bys,'candidateRubricChecks':checks,'volumeDiagnostics':{'eligibleSlateDays':len(counts),'eligiblePitcherStarts':int(len(df)),'canonicalStarterSlots':int(slots),'eligibilityShare':len(df)/slots,'meanEligiblePitcherStartsPerSlateDay':float(np.mean(list(counts.values()))),'medianEligiblePitcherStartsPerSlateDay':float(np.median(list(counts.values()))),'note':'Eligible starts are research observations, not bet candidates.'},'marketBoundary':{'providerMarketKey':'pitcher_outs','repositoryRegistryFamily':'PITCHER_PROP','hardRockFloridaPerEventAvailabilityEstablished':False,'productionRegistryChanged':False,'historicalPitcherOutPricesUsed':False,'positiveEvEstablished':False,'priceCaptureAuthorized':False,'productionPromotionAuthorized':False},'policy':{'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'thresholdSearchUsed':False,'subsetMiningUsed':False,'postResultRuleChangeUsed':False,'productionMarketRegistryChanged':False,'liveLookupAuthorizationChanged':False,'liveMarketDiscoveryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}};dump(args.out,report);print(json.dumps({'classification':clas,'candidateRubricPassed':passed,'validation2023':v,'evaluation2024_2026Ytd':e,'bySeason':bys,'candidateRubricChecks':checks,'volumeDiagnostics':report['volumeDiagnostics']},indent=2))
if __name__=='__main__':main()

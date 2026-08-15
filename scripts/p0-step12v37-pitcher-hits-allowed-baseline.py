#!/usr/bin/env python3
import argparse, json, math, os
from collections import Counter, defaultdict
import numpy as np, pandas as pd
from scipy.stats import nbinom, poisson
from sklearn.impute import SimpleImputer
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler

REPORT_SCHEMA='courtedge-p0-step12v37-pitcher-hits-allowed-baseline.v1'
BASE_SCHEMA='courtedge-p0-step12v-game-anatomy-feature-table.v1'

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
    h,a2=posint(a.get('homeProbablePitcherId')),posint(a.get('awayProbablePitcherId'))
    return (h,a2) if h and a2 else (None,None)
def complete_lineup(l,a):
    if not audit_valid(a) or not l or not l.get('complete'):return None,None
    try:h=[int(v) for v in l.get('homeBattingOrder',[])];w=[int(v) for v in l.get('awayBattingOrder',[])]
    except:return None,None
    if len(h)!=9 or len(w)!=9 or len(set(h))!=9 or len(set(w))!=9 or min(h+w)<=0:return None,None
    return h,w
def continuity(cur,prev):return None if cur is None or prev is None else len(set(cur)&set(prev))/9.0

def parse_line(raw):
    if not raw:return None
    pid=posint(raw.get('pitcherId'))
    if pid is None:return None
    mapping={'bf':'battersFaced','h':'hits','k':'strikeOuts','bb':'baseOnBalls','er':'earnedRuns','hr':'homeRuns'}
    out={'pitcherId':pid}
    for k,s in mapping.items():
        v=raw.get(s,0)
        if not finite(v) or float(v)<0:raise SystemExit(f'V37_INVALID_STARTER_LINE:{pid}:{s}:{v}')
        out[k]=float(v)
    return out

def empty_p():return {'starts':0,'bf':0.0,'h':0.0,'k':0.0,'bb':0.0,'er':0.0,'hr':0.0,'recent':[]}
def empty_o():return {'games':0,'bf':0.0,'h':0.0}
def add_p(s,l,w):
    s['starts']+=1
    for k in ('bf','h','k','bb','er','hr'):s[k]+=l[k]
    s['recent'].append({'bf':l['bf'],'h':l['h']})
    if len(s['recent'])>w:s['recent']=s['recent'][-w:]
def priors(s):
    if s['bf']<=0 or s['starts']<=0:return None
    bf=s['bf']
    return {'hbf':s['h']/bf,'hrbf':s['hr']/bf,'bbbf':s['bb']/bf,'kbf':s['k']/bf,'bfPerStart':bf/s['starts']}
def sr(num,den,rate,n):return (float(num)+n*float(rate))/(float(den)+n)
def sm(total,trials,mean,n):return (float(total)+n*float(mean))/(float(trials)+n)
def pfeat(s,p,rbf,wps):
    r=s['recent']
    if p is None:return {'pitcher_hbf_shrunk':None,'pitcher_hrbf_shrunk':None,'pitcher_bbbf_shrunk':None,'pitcher_kbf_shrunk':None,'pitcher_bf_per_start_shrunk':None,'pitcher_recent5_hits_per_start':None,'pitcher_recent5_bf_per_start':None,'pitcher_prior_bf':float(s['bf'])}
    return {'pitcher_hbf_shrunk':sr(s['h'],s['bf'],p['hbf'],rbf),'pitcher_hrbf_shrunk':sr(s['hr'],s['bf'],p['hrbf'],rbf),'pitcher_bbbf_shrunk':sr(s['bb'],s['bf'],p['bbbf'],rbf),'pitcher_kbf_shrunk':sr(s['k'],s['bf'],p['kbf'],rbf),'pitcher_bf_per_start_shrunk':sm(s['bf'],s['starts'],p['bfPerStart'],wps),'pitcher_recent5_hits_per_start':float(np.mean([x['h'] for x in r])) if r else None,'pitcher_recent5_bf_per_start':float(np.mean([x['bf'] for x in r])) if r else None,'pitcher_prior_bf':float(s['bf'])}
def ofeat(s,p,rbf,wpg):
    if p is None:return {'opponent_vs_starters_hbf_scored_shrunk':None,'opponent_vs_starters_bf_per_game_shrunk':None}
    return {'opponent_vs_starters_hbf_scored_shrunk':sr(s['h'],s['bf'],p['hbf'],rbf),'opponent_vs_starters_bf_per_game_shrunk':sm(s['bf'],s['games'],p['bfPerStart'],wpg)}
def opp_rs10(f,side):
    c,d=f.get('combined_team_rs10'),f.get('team_rs10_diff')
    if not finite(c) or not finite(d):return None
    home=(float(c)+float(d))/2;away=(float(c)-float(d))/2
    return away if side=='home' else home

def nb2(y,mu):
    den=float(np.sum(mu**2));num=float(np.sum((y-mu)**2-mu))
    if den<=0:raise SystemExit('V37_NB2_DENOMINATOR_INVALID')
    return max(0.0,num/den)
def overp(mu,disp,line):
    c=math.floor(float(line));mu=max(float(mu),1e-9)
    if disp<=1e-12:return float(1-poisson.cdf(c,mu))
    r=1/disp;p=r/(r+mu);return float(1-nbinom.cdf(c,r,p))

def evaluate(df,features,imp,scaler,model,disp,train_mean,line_probs,lines):
    X=scaler.transform(imp.transform(df[list(features)]));model_mu=np.maximum(model.predict(X),1e-9);y=df['hitsAllowed'].to_numpy(float)
    const_mu=np.full(len(df),train_mean,float);pitch=df['pitcherOnlyMuRaw'].to_numpy(float);pitch=np.where(np.isfinite(pitch)&(pitch>0),pitch,train_mean)
    md=float(mean_poisson_deviance(y,model_mu));cd=float(mean_poisson_deviance(y,const_mu));pd=float(mean_poisson_deviance(y,pitch))
    mb=[];cb=[];pb=[];diag={}
    for line in lines:
        obs=(y>line).astype(float);mp=np.array([overp(m,disp,line) for m in model_mu]);pp=np.array([overp(m,disp,line) for m in pitch]);cp=float(line_probs[line])
        m=float(np.mean((mp-obs)**2));c=float(np.mean((cp-obs)**2));p=float(np.mean((pp-obs)**2));mb.append(m);cb.append(c);pb.append(p)
        diag[str(line)]={'observedOverRate':float(np.mean(obs)),'meanModelOverProbability':float(np.mean(mp)),'meanPitcherOnlyOverProbability':float(np.mean(pp)),'trainingClimatologyOverProbability':cp,'modelBrier':m,'constantBaselineBrier':c,'pitcherOnlyBaselineBrier':p,'modelVsConstantBrierImprovement':c-m,'modelVsPitcherOnlyBrierImprovement':p-m}
    obsmean=float(np.mean(y));mm=float(np.mean(model_mu));pm=float(np.mean(pitch))
    return {'rows':int(len(df)),'observedMeanHitsAllowed':obsmean,'meanModelHitsAllowed':mm,'meanPitcherOnlyHitsAllowed':pm,'trainingConstantMeanHitsAllowed':float(train_mean),'modelAbsoluteMeanCalibrationBias':abs(mm-obsmean),'constantAbsoluteMeanCalibrationBias':abs(float(train_mean)-obsmean),'pitcherOnlyAbsoluteMeanCalibrationBias':abs(pm-obsmean),'modelMeanAbsoluteError':float(mean_absolute_error(y,model_mu)),'constantMeanAbsoluteError':float(mean_absolute_error(y,const_mu)),'pitcherOnlyMeanAbsoluteError':float(mean_absolute_error(y,pitch)),'modelPoissonDeviance':md,'constantPoissonDeviance':cd,'pitcherOnlyPoissonDeviance':pd,'modelVsConstantDevianceImprovement':cd-md,'modelVsPitcherOnlyDevianceImprovement':pd-md,'fixedLineDiagnostics':diag,'modelAverageBrier':float(np.mean(mb)),'constantAverageBrier':float(np.mean(cb)),'pitcherOnlyAverageBrier':float(np.mean(pb)),'modelVsConstantAverageBrierImprovement':float(np.mean(cb)-np.mean(mb)),'modelVsPitcherOnlyAverageBrierImprovement':float(np.mean(pb)-np.mean(mb))}

def build(root,season,c):
    base=os.path.join(root,season);canonical=load(os.path.join(base,'game-anatomy-feature-table.json'));sp=load(os.path.join(base,'cohort','starting-pitcher-history.json'));lu=load(os.path.join(base,'cohort','pregame-lineup-history.json'));au=load(os.path.join(base,'t5-audit','t5-starter-identity-audit.json'))
    if canonical.get('schemaVersion')!=BASE_SCHEMA:raise SystemExit(f'V37_BASE_SCHEMA_INVALID:{season}')
    smap={int(x['gamePk']):x for x in sp.get('games',[])};lmap={int(x['gamePk']):x for x in lu.get('snapshots',[])};amap={int(x['gamePk']):x for x in au.get('rows',[])}
    cr=[x for x in canonical.get('rows',[]) if x.get('t5PregameValid')];by=defaultdict(list)
    for x in cr:by[str(x['officialDate'])].append(x)
    ps=defaultdict(empty_p);os_=defaultdict(empty_o);league=empty_p();prevlu={};cfg=c['featureEngineering'];rows=[];probslots=elig=clp=0
    for date in sorted(by):
        games=sorted(by[date],key=lambda x:int(x['gamePk']));pr=priors(league)
        for raw in games:
            gp=int(raw['gamePk']);ht=int(raw['homeTeamId']);at=int(raw['awayTeamId']);a=amap.get(gp);hp,ap=probable_ids(a)
            if hp and ap:probslots+=2
            ch,ca=complete_lineup(lmap.get(gp),a)
            if ch is not None and ca is not None:clp+=1
            sg=smap.get(gp)
            if not sg:continue
            ah=parse_line(sg.get('homeStarter'));aa=parse_line(sg.get('awayStarter'));f=raw.get('features') or {}
            for side,pid,actual,opp,opp_lu in [('home',hp,ah,at,ca),('away',ap,aa,ht,ch)]:
                if pid is None or actual is None or actual['bf']<=0 or pid!=actual['pitcherId']:continue
                elig+=1;p=pfeat(ps[pid],pr,float(cfg['rateShrinkagePriorBattersFaced']),float(cfg['workloadShrinkagePriorStarts']));p.update(ofeat(os_[opp],pr,float(cfg['opponentRateShrinkagePriorBattersFaced']),float(cfg['opponentWorkloadShrinkagePriorGames'])));p['opponent_rs10']=opp_rs10(f,side);p['opponent_lineup_continuity']=continuity(opp_lu,prevlu.get(opp))
                rawmu=float(p['pitcher_hbf_shrunk'])*float(p['pitcher_bf_per_start_shrunk']) if finite(p['pitcher_hbf_shrunk']) and finite(p['pitcher_bf_per_start_shrunk']) else None
                rows.append({'season':season,'officialDate':date,'gamePk':gp,'side':side,'pitcherId':pid,'opponentTeamId':opp,'hitsAllowed':int(actual['h']),'actualBattersFaced':float(actual['bf']),'pitcherOnlyMuRaw':rawmu,**p})
        for raw in games:
            gp=int(raw['gamePk']);ht=int(raw['homeTeamId']);at=int(raw['awayTeamId']);sg=smap.get(gp)
            if sg:
                hl=parse_line(sg.get('homeStarter'));al=parse_line(sg.get('awayStarter'))
                if hl and hl['bf']>0:
                    add_p(ps[hl['pitcherId']],hl,int(cfg['recentStartsWindow']));add_p(league,hl,int(cfg['recentStartsWindow']));os_[at]['games']+=1;os_[at]['bf']+=hl['bf'];os_[at]['h']+=hl['h']
                if al and al['bf']>0:
                    add_p(ps[al['pitcherId']],al,int(cfg['recentStartsWindow']));add_p(league,al,int(cfg['recentStartsWindow']));os_[ht]['games']+=1;os_[ht]['bf']+=al['bf'];os_[ht]['h']+=al['h']
            a=amap.get(gp);ch,ca=complete_lineup(lmap.get(gp),a)
            if ch is not None:prevlu[ht]=ch
            if ca is not None:prevlu[at]=ca
    slots=2*len(cr)
    return rows,{'canonicalT5Games':len(cr),'canonicalStarterSlots':slots,'auditValidProbableStarterSlots':probslots,'exactProbableRecordedStarterEligibleSlots':elig,'eligibilityShareOfCanonicalStarterSlots':elig/slots if slots else 0.0,'completeAuditValidLineupPairs':clp}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--contract',required=True);ap.add_argument('--out',required=True);args=ap.parse_args();c=load(args.contract)
    if c.get('schemaVersion')!='courtedge-p0-step12v37-pitcher-hits-allowed-baseline-contract.v1':raise SystemExit('V37_CONTRACT_SCHEMA_INVALID')
    seasons=['2022','2023','2024','2025','2026_YTD'];rec=[];cust={}
    for s in seasons:r,k=build(args.root,s,c);rec+=r;cust[s]=k
    df=pd.DataFrame(rec);feat=tuple(c['features']['exactly']);tr=df[df.season=='2022'].copy();va=df[df.season=='2023'].copy();ev=df[df.season.isin(['2024','2025','2026_YTD'])].copy()
    imp=SimpleImputer(strategy='median');sc=StandardScaler();Xt=sc.fit_transform(imp.fit_transform(tr[list(feat)]));y=tr.hitsAllowed.to_numpy(float);cfg=c['model'];m=PoissonRegressor(alpha=float(cfg['poissonAlpha']),max_iter=int(cfg['maxIter']));m.fit(Xt,y);tmu=np.maximum(m.predict(Xt),1e-9);disp=nb2(y,tmu);tm=float(np.mean(y));lines=[float(x) for x in cfg['fixedHalfRunLines']];lp={x:float(np.mean(y>x)) for x in lines}
    v=evaluate(va,feat,imp,sc,m,disp,tm,lp,lines);e=evaluate(ev,feat,imp,sc,m,disp,tm,lp,lines);bys={s:evaluate(df[df.season==s].copy(),feat,imp,sc,m,disp,tm,lp,lines) for s in ['2023','2024','2025','2026_YTD']}
    checks={'validationDevianceBeatsConstant':v['modelVsConstantDevianceImprovement']>0,'validationDevianceBeatsPitcherOnly':v['modelVsPitcherOnlyDevianceImprovement']>0,'validationBrierBeatsConstant':v['modelVsConstantAverageBrierImprovement']>0,'validationBrierBeatsPitcherOnly':v['modelVsPitcherOnlyAverageBrierImprovement']>0,'evaluationDevianceBeatsConstant':e['modelVsConstantDevianceImprovement']>0,'evaluationDevianceBeatsPitcherOnly':e['modelVsPitcherOnlyDevianceImprovement']>0,'evaluationBrierBeatsConstant':e['modelVsConstantAverageBrierImprovement']>0,'evaluationBrierBeatsPitcherOnly':e['modelVsPitcherOnlyAverageBrierImprovement']>0};passed=all(checks.values());clas='PITCHER_HITS_ALLOWED_NO_RETUNE_ROBUSTNESS_CANDIDATE_ONLY' if passed else 'PITCHER_HITS_ALLOWED_BASELINE_REJECTED';counts=Counter(df.officialDate);slots=sum(x['canonicalStarterSlots'] for x in cust.values())
    report={'schemaVersion':REPORT_SCHEMA,'classification':clas,'candidateRubricPassed':passed,'data':{'scoredRows':int(len(df)),'custodyBySeason':cust,'featureCount':len(feat),'features':list(feat),'sameDateHistoryAllowed':False,'seasonHistoryReset':True},'model':{'providerMarketKey':'pitcher_hits_allowed','canonicalResearchMarketType':'PITCHER_HITS_ALLOWED','trainingSeason':'2022','trainingRows':int(len(tr)),'trainingMeanHitsAllowed':tm,'poissonAlpha':1.0,'maxIter':1000,'nb2Dispersion':float(disp),'fixedHalfRunLines':lines,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'coefficientsDescriptiveNotSelectionInput':{feat[i]:float(m.coef_[i]) for i in range(len(feat))}},'baselines':{'constantMeanHitsAllowed':tm,'pitcherOnlyFormula':c['baselines']['pitcherOnlyMechanistic'],'sharedTrainingOnlyNb2Dispersion':float(disp),'constantFixedLineOverProbabilities':{str(k):x for k,x in lp.items()}},'validation2023':v,'evaluation2024_2026Ytd':e,'bySeasonDescriptiveOnly':bys,'candidateRubricChecks':checks,'volumeDiagnostics':{'eligibleSlateDays':len(counts),'eligiblePitcherStarts':int(len(df)),'canonicalStarterSlots':int(slots),'eligibilityShare':len(df)/slots,'meanEligiblePitcherStartsPerSlateDay':float(np.mean(list(counts.values()))),'medianEligiblePitcherStartsPerSlateDay':float(np.median(list(counts.values()))),'note':'Eligible starts are research observations, not bet candidates.'},'marketBoundary':{'providerMarketKey':'pitcher_hits_allowed','repositoryRegistryFamily':'PITCHER_PROP','hardRockFloridaPerEventAvailabilityEstablished':False,'productionRegistryChanged':False,'historicalPitcherHitsAllowedPricesUsed':False,'positiveEvEstablished':False,'priceCaptureAuthorized':False,'productionPromotionAuthorized':False},'policy':{'sameDateOutcomeLeakageAllowed':False,'futureGameDataAllowed':False,'featureSearchUsed':False,'modelSearchUsed':False,'hyperparameterSearchUsed':False,'lineSearchUsed':False,'thresholdSearchUsed':False,'subsetMiningUsed':False,'postResultRuleChangeUsed':False,'productionMarketRegistryChanged':False,'liveLookupAuthorizationChanged':False,'liveMarketDiscoveryChanged':False,'rankingChanged':False,'stakeChanged':False,'betEliteAllowed':False,'automaticBetPlacementAllowed':False,'realFinancialExposure':0}}
    dump(args.out,report);print(json.dumps({'classification':clas,'candidateRubricPassed':passed,'validation2023':v,'evaluation2024_2026Ytd':e,'bySeason':bys,'candidateRubricChecks':checks,'volumeDiagnostics':report['volumeDiagnostics']},indent=2))
if __name__=='__main__':main()

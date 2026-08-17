#!/usr/bin/env python3
import argparse, datetime as dt, hashlib, importlib.util, json, math, os

SCHEMA='courtedge-p0-step12v76-aug16-retrospective-outcome-blind-total-freeze.v1'
CONTRACT_SCHEMA='courtedge-p0-step12v76-aug16-retrospective-outcome-blind-total-freeze-contract.v1'
TARGET_SCHEMA='courtedge-p0-step12v76-aug16-t5-target-snapshot.v1'
STATE_SCHEMA='courtedge-p0-step12v68-prospective-state.v1'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def dump(p,x):
    os.makedirs(os.path.dirname(p) or '.',exist_ok=True)
    with open(p,'w',encoding='utf-8') as f:json.dump(x,f,indent=2,sort_keys=True);f.write('\n')

def git_blob_sha(path):
    data=open(path,'rb').read();return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()

def module(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    if spec is None or spec.loader is None:raise SystemExit(f'V76_IMPORT_FAILED:{path}')
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--state',required=True)
    ap.add_argument('--target-snapshot',required=True)
    ap.add_argument('--v74-shared-scorer',required=True)
    ap.add_argument('--v68-source-script',required=True)
    ap.add_argument('--v68-source-manifest',required=True)
    ap.add_argument('--v62-contract',required=True)
    ap.add_argument('--v66-totals-report',required=True)
    ap.add_argument('--v66-custody-report',required=True)
    ap.add_argument('--v67-report',required=True)
    ap.add_argument('--contract',required=True)
    ap.add_argument('--out',required=True)
    a=ap.parse_args()

    c=load(a.contract)
    if c.get('schemaVersion')!=CONTRACT_SCHEMA or c.get('scientificStatus')!='FROZEN_BEFORE_ANY_V76_SCORER_AND_BEFORE_READING_AUG16_RUN_OUTCOMES':raise SystemExit('V76_CONTRACT_INVALID')
    if c.get('targetOfficialDate')!='2026-08-16':raise SystemExit('V76_TARGET_DATE_DRIFT')
    if c['statistics']['targetOutcomePeekAllowed'] is not False or c['outcomeEmbargo']['targetScoreFieldsMayBeUsedByScorer'] is not False:raise SystemExit('V76_OUTCOME_EMBARGO_INVALID')
    if git_blob_sha(a.v74_shared_scorer)!=c['frozenParents']['v74SharedScoringImplementationGitBlobSha']:raise SystemExit('V76_V74_SHARED_SCORER_BLOB_DRIFT')

    state=load(a.state);target=load(a.target_snapshot)
    if state.get('schemaVersion')!=STATE_SCHEMA or state.get('targetOfficialDate')!='2026-08-16':raise SystemExit('V76_STATE_INVALID')
    if state.get('chronology',{}).get('latestHistoricalOfficialDate')!='2026-08-15':raise SystemExit(f"V76_STATE_LATEST_DATE_INVALID:{state.get('chronology',{}).get('latestHistoricalOfficialDate')}")
    if state.get('chronology',{}).get('sameDateOutcomesUsed') is not False:raise SystemExit('V76_STATE_SAME_DATE_CONTAMINATED')
    if state.get('policy',{}).get('containsTargetOutcomes') is not False or state.get('policy',{}).get('containsMarketPrices') is not False:raise SystemExit('V76_STATE_CONTAMINATED')
    if target.get('schemaVersion')!=TARGET_SCHEMA or target.get('targetOfficialDate')!='2026-08-16':raise SystemExit('V76_TARGET_SNAPSHOT_INVALID')
    tp=target.get('policy',{})
    if tp.get('finalStarterIdentityRead') is not False or tp.get('targetRunScoresParsedByThisScript') is not False or tp.get('targetRunScoresSerialized') is not False:raise SystemExit('V76_TARGET_SNAPSHOT_OUTCOME_BOUNDARY_INVALID')

    shared=module(a.v74_shared_scorer,'v76_v74_shared')
    srcmod=shared.load_module(a.v68_source_script,'v76_v68_source')
    srcmanifest=load(a.v68_source_manifest);v62contract=load(a.v62_contract)
    v66=load(a.v66_totals_report);cust=load(a.v66_custody_report);v67=load(a.v67_report)
    f5_route=v67['routes']['V67_A_F5_TOTAL_NB2'];fg_route=v67['routes']['V67_B_FULL_GAME_TOTAL_NB2']
    if f5_route['classification']!=c['frozenParents']['v67F5Classification'] or fg_route['classification']!=c['frozenParents']['v67FullGameClassification']:raise SystemExit('V76_V67_CERTIFICATION_DRIFT')
    alpha_f5=float(f5_route['dispersionFit2022']['alpha']);alpha_fg=float(fg_route['dispersionFit2022']['alpha'])
    f5_model=v66['routes']['V66_D_F5_TOTAL']['primaryCandidate']['model'];fg_model=v66['routes']['V66_E_FULL_GAME_TOTAL']['primaryCandidate']['model']
    qparams=cust['qualityTrainingStandardization']['sideLevelComponentParameters']

    hist,bpdiag=shared.build_bullpen_history('2026-08-16')
    if bpdiag['rangeEnd']!='2026-08-15' or bpdiag['boxscoreFailures']:raise SystemExit(f'V76_PRIOR_BULLPEN_HISTORY_INVALID:{bpdiag}')

    rows=[];fail=[]
    for g in target.get('rows',[]):
        if g.get('ready') is not True:continue
        try:
            routes,diag=shared.game_features(g,state,srcmod,srcmanifest,v62contract,qparams,hist)
            mu5=shared.frozen_mu(f5_model,routes['f5']);mufg=shared.frozen_mu(fg_model,routes['fg'])
            pmf5,tail5,med5=shared.count_distribution(mu5,alpha_f5,20);pmfg,tailfg,medfg=shared.count_distribution(mufg,alpha_fg,25)
            rows.append({
                'gamePk':int(g['gamePk']),'officialDate':g['officialDate'],'awayTeam':g['awayTeam'],'homeTeam':g['homeTeam'],'scheduledStart':g['scheduledStart'],
                'awayProbablePitcherId':int(g['awayProbablePitcherId']),'homeProbablePitcherId':int(g['homeProbablePitcherId']),'awayProbablePitcher':g['awayProbablePitcher'],'homeProbablePitcher':g['homeProbablePitcher'],
                'tMinus5RequestedTimecode':g['requestedTimecode'],'tMinus5SourceMetadataTimecode':g['sourceMetadataTimecode'],
                'f5ExpectedRunsMu':mu5,'fullGameExpectedRunsMu':mufg,'f5Nb2Alpha':alpha_f5,'fullGameNb2Alpha':alpha_fg,
                'f5CountPmf0To20':pmf5,'f5TailProbabilityAbove20':tail5,'fullGameCountPmf0To25':pmfg,'fullGameTailProbabilityAbove25':tailfg,'f5MedianCount':med5,'fullGameMedianCount':medfg,
                'featureVectorF5':routes['f5'],'featureVectorFullGame':routes['fg'],'diagnostics':diag
            })
        except Exception as e:fail.append({'gamePk':g.get('gamePk'),'game':f"{g.get('awayTeam')} @ {g.get('homeTeam')}",'error':str(e)[:300]})
    if fail:raise SystemExit(f'V76_TARGET_FEATURE_FAILURES:{fail}')
    if not rows:raise SystemExit('V76_NO_READY_TARGET_ROWS')
    rows.sort(key=lambda r:(r['scheduledStart'],r['gamePk']))
    report={
      'schemaVersion':SCHEMA,'classification':'V76_AUG16_RETROSPECTIVE_PSEUDO_PREGAME_TOTAL_PREDICTIONS_FROZEN_OUTCOME_BLIND','targetOfficialDate':'2026-08-16','generatedAtUtc':dt.datetime.now(dt.timezone.utc).isoformat(),
      'retrospectiveStatus':c['retrospectiveStatus'],
      'slate':{'historicalScheduleGames':int(target.get('scheduleGames',0)),'gamesWithBothTMinus5ProbableStarters':len(target.get('rows',[])),'excludedAtTMinus5':target.get('exclusions',[]),'predictedRows':len(rows)},
      'rows':rows,
      'priorState':{'stateDigest':state.get('stateDigest'),'chronology':state.get('chronology'),'custody':state.get('custody'),'bullpenAcquisition':bpdiag},
      'sourceBoundary':{'targetIdentitySource':'ARCHIVED_MLB_T_MINUS_5_FEED','targetFinalStarterIdentityUsed':False,'targetRunScoresUsed':False,'targetF5RunsUsed':False,'sportsbookLinesRead':False,'sportsbookPricesRead':False},
      'policy':{'researchOnly':True,'retrospectivePseudoPregame':True,'targetOutcomesReadByScorer':False,'marketOddsUsedAsFeatures':False,'predictionMayChangeAfterUserDisclosesResults':False,'productionChanged':False,'prospectiveV68Changed':False,'positiveEvEstablished':False,'realFinancialExposure':0}
    }
    forbidden=('homeFinalRuns','awayFinalRuns','totalRuns','winner','result','score','sportsbookLine','odds','price')
    txt=json.dumps(report)
    for token in forbidden:
        if token in txt:raise SystemExit(f'V76_FORBIDDEN_TARGET_OR_MARKET_TOKEN_EMITTED:{token}')
    dump(a.out,report)
    print(json.dumps({'classification':report['classification'],'predictedRows':len(rows),'predictions':[{'game':r['awayTeam']+' @ '+r['homeTeam'],'F5_mu':round(r['f5ExpectedRunsMu'],4),'FG_mu':round(r['fullGameExpectedRunsMu'],4),'awaySP':r['awayProbablePitcher'],'homeSP':r['homeProbablePitcher']} for r in rows],'targetOutcomesRead':False},indent=2))

if __name__=='__main__':main()

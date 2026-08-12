#!/usr/bin/env python3
import argparse, hashlib, json, math, os

FEATURE_SCHEMA='courtedge-p0-step12i-clean-t5-feature-table.v1'
MANIFEST_SCHEMA='courtedge-p0-step12s-risk-candidate-frozen.v1'
REPORT_SCHEMA='courtedge-p0-step12s-shadow-risk-stability.v1'
SEASONS=('2022','2023','2025','2026_YTD')

STRICT_ATOMS=(
    ('team_win10_diff','GTE',0.09999999999999998),
    ('starter_kbb_adv','GTE',0.02481042579422841),
    ('lineup_exposure_rate_adv','GTE',0.09876543209876554),
)
BROAD_ATOMS=(
    ('team_win10_diff','GTE',0.09999999999999998),
    ('starter_kbb_adv','GTE',0.02481042579422841),
    ('lineup_exposure_rate_adv','GTE',0.06336336336336329),
)

def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def sha256(p):
    h=hashlib.sha256()
    with open(p,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()

def atom_ok(r,a):
    f,op,t=a;v=r.get(f)
    if v is None:return False
    try:v=float(v)
    except:return False
    if not math.isfinite(v):return False
    if op=='GTE':return v>=t
    if op=='LTE':return v<=t
    raise ValueError(op)

def manifest_atom_ok(r,a):
    return atom_ok(r,(a['feature'],a['operator'],float(a['threshold'])))

def metrics(rows,risk_atoms):
    n=len(rows);w=sum(r['fullResult']=='HOME' for r in rows);l=n-w
    risk=[r for r in rows if all(manifest_atom_ok(r,a) for a in risk_atoms)]
    risk_ids={r['gamePk'] for r in risk};keep=[r for r in rows if r['gamePk'] not in risk_ids]
    rw=sum(r['fullResult']=='HOME' for r in risk);rl=len(risk)-rw
    kw=sum(r['fullResult']=='HOME' for r in keep);kl=len(keep)-kw
    bhr=w/n if n else None;rhr=rw/len(risk) if risk else None;khr=kw/len(keep) if keep else None
    lcap=rl/l if l else None;wsac=rw/w if w else None
    return {
        'baseRows':n,'baseWins':w,'baseLosses':l,'baseHitRate':bhr,
        'riskRows':len(risk),'riskWins':rw,'riskLosses':rl,'riskHitRate':rhr,
        'retainedRows':len(keep),'retainedWins':kw,'retainedLosses':kl,'retainedHitRate':khr,
        'retainedVolumePct':100*len(keep)/n if n else None,
        'retainedLift':khr-bhr if khr is not None and bhr is not None else None,
        'lossCaptureRate':lcap,'winSacrificeRate':wsac,
        'removalEfficiency':lcap-wsac if lcap is not None and wsac is not None else None,
    }

def filter_rows(table,atoms,season,matched):
    out=[]
    for r in table['rows']:
        if r.get('fullResult') not in ('HOME','AWAY'):continue
        if matched and season!='2026_YTD' and r['officialDate'][5:]>'08-10':continue
        if all(atom_ok(r,a) for a in atoms):out.append(r)
    return out

def deletion_min(rows,risk_atoms,keyfn):
    vals=[]
    groups=sorted({keyfn(r) for r in rows if keyfn(r) is not None},key=str)
    for g in groups:
        sub=[r for r in rows if keyfn(r)!=g]
        m=metrics(sub,risk_atoms)
        if m['retainedLift'] is not None:vals.append(m['retainedLift'])
    return min(vals) if vals else None

def cmh_by_season(by_season,risk_atoms):
    num=var=0.0;tabs=[]
    for s,rows in by_season.items():
        risk=[r for r in rows if all(manifest_atom_ok(r,a) for a in risk_atoms)]
        ids={r['gamePk'] for r in risk};non=[r for r in rows if r['gamePk'] not in ids]
        a=sum(r['fullResult']=='AWAY' for r in risk);b=sum(r['fullResult']=='HOME' for r in risk)
        c=sum(r['fullResult']=='AWAY' for r in non);d=sum(r['fullResult']=='HOME' for r in non)
        N=a+b+c+d;n1=a+b;n0=c+d;m1=a+c;m0=b+d
        if N>1 and min(n1,n0,m1,m0)>0:
            num+=a-n1*m1/N;var+=n1*n0*m1*m0/(N*N*(N-1))
        tabs.append({'season':s,'riskLoss':a,'riskWin':b,'nonRiskLoss':c,'nonRiskWin':d})
    z=num/math.sqrt(var) if var>0 else 0.0
    p=0.5*math.erfc(z/math.sqrt(2))
    return {'z':z,'oneSidedP':p,'strata':tabs,'confirmatory':False,
            'note':'Descriptive after development search; multiplicity-adjusted confirmation is not claimed.'}

def variant_report(tables,atoms,risk_atoms,matched):
    by={s:filter_rows(tables[s],atoms,s,matched) for s in SEASONS}
    pooled=[r for s in SEASONS for r in by[s]]
    return {
        'pooled':metrics(pooled,risk_atoms),
        'bySeason':{s:metrics(rows,risk_atoms) for s,rows in by.items()},
        'exploratoryCmhRiskVsLoss':cmh_by_season(by,risk_atoms),
        'adversarialDeletion':{
            'minLeaveOneSeasonOutRetainedLift':deletion_min(pooled,risk_atoms,lambda r:r.get('_season')),
            'minLeaveOneMonthOutRetainedLift':deletion_min(pooled,risk_atoms,lambda r:r['officialDate'][:7]),
            'minLeaveOneHomeTeamOutRetainedLift':deletion_min(pooled,risk_atoms,lambda r:r.get('homeTeamId')),
            'minLeaveOneHomeProbablePitcherOutRetainedLift':deletion_min(pooled,risk_atoms,lambda r:r.get('t5HomeProbablePitcherId')),
        }
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--manifest',required=True)
    ap.add_argument('--table-2022',required=True);ap.add_argument('--table-2023',required=True)
    ap.add_argument('--table-2025',required=True);ap.add_argument('--table-2026',required=True)
    ap.add_argument('--out',required=True)
    a=ap.parse_args();m=load(a.manifest)
    if m.get('schemaVersion')!=MANIFEST_SCHEMA:raise SystemExit('STEP12S_MANIFEST_SCHEMA_INVALID')
    paths={'2022':a.table_2022,'2023':a.table_2023,'2025':a.table_2025,'2026_YTD':a.table_2026}
    tables={}
    for s,p in paths.items():
        t=load(p)
        if t.get('schemaVersion')!=FEATURE_SCHEMA:raise SystemExit(f'STEP12S_FEATURE_SCHEMA_INVALID:{s}')
        for r in t['rows']:r['_season']=s
        tables[s]=t
    if m['policy']['use2021ForSearchOrRetuning'] is not False:raise SystemExit('STEP12S_2021_MUST_REMAIN_EXCLUDED')
    risk=m['candidate']['all']
    matched={
        'strict':variant_report(tables,STRICT_ATOMS,risk,True),
        'broad':variant_report(tables,BROAD_ATOMS,risk,True),
    }
    full={
        'strict':variant_report(tables,STRICT_ATOMS,risk,False),
        'broad':variant_report(tables,BROAD_ATOMS,risk,False),
    }
    report={
        'schemaVersion':REPORT_SCHEMA,
        'evidenceStatus':'DEVELOPMENT_CROSS_SEASON_SHADOW_CANDIDATE_NOT_LIVE_VETO',
        'candidate':m['candidate'],'sourceFeatureTableSha256':{s:sha256(p) for s,p in paths.items()},
        'matchedCalendarThroughMonthDay':'08-10','matchedCalendarResults':matched,
        'fullAvailableSeasonDiagnostic':full,
        'policy':m['policy'],'prospectiveGate':m['prospectiveGate']
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'candidate':m['candidate']['id'],
        'strict':matched['strict']['pooled'],'broad':matched['broad']['pooled']},indent=2))

if __name__=='__main__':main()

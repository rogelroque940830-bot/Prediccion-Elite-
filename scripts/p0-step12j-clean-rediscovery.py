#!/usr/bin/env python3
import argparse, hashlib, json, math, os
from collections import defaultdict

SCHEMA='courtedge-p0-step12j-clean-rediscovery.v1'
FEATURES=(
 'team_rd10_diff','team_win10_diff','team_rs10_diff','team_ra10_adv',
 'starter_runrisk_adv','starter_kbb_adv','starter_hr_adv',
 'lineup_exposure_rate_adv','lineup_continuity_rate_adv',
)
QUANTILES=(0.1,0.2,0.3,0.7,0.8,0.9)
TOP_K_PER_HORIZON=10
MIN_DISCOVERY_DECISIVE=50
DISCOVERY_END='2025-07-31'


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def quantile(values,q):
    xs=sorted(float(v) for v in values if v is not None and math.isfinite(float(v)))
    if not xs: raise ValueError('EMPTY_QUANTILE')
    pos=(len(xs)-1)*q; lo=math.floor(pos); hi=math.ceil(pos)
    if lo==hi:return xs[lo]
    frac=pos-lo
    return xs[lo]*(1-frac)+xs[hi]*frac

def wilson_lower(h,n,z=1.96):
    if n<=0:return None
    p=h/n; den=1+z*z/n
    return (p+z*z/(2*n)-z*math.sqrt((p*(1-p)+z*z/(4*n))/n))/den

def atom_ok(row,a):
    v=row.get(a['feature'])
    if v is None or not math.isfinite(float(v)):return False
    return float(v)>=a['threshold'] if a['operator']=='GTE' else float(v)<=a['threshold']

def outcome(row,horizon):
    return row['fullResult'] if horizon=='FULL_GAME' else row['f5Result']

def metrics(rows,atoms,horizon,side):
    sel=[r for r in rows if all(atom_ok(r,a) for a in atoms)]
    decisive=[r for r in sel if outcome(r,horizon)!='PUSH']
    hits=sum(1 for r in decisive if outcome(r,horizon)==side)
    losses=len(decisive)-hits
    pushes=len(sel)-len(decisive)
    all_dec=[r for r in rows if outcome(r,horizon)!='PUSH']
    base_hits=sum(1 for r in all_dec if outcome(r,horizon)==side)
    base=base_hits/len(all_dec) if all_dec else None
    rate=hits/len(decisive) if decisive else None
    dates=len({r['officialDate'] for r in sel})
    dec_dates=len({r['officialDate'] for r in decisive})
    all_dates=len({r['officialDate'] for r in rows})
    return {
      'selectedRows':len(sel),'decisiveRows':len(decisive),'hits':hits,'losses':losses,'pushes':pushes,
      'decisiveHitRate':rate,'sideBaselineHitRate':base,
      'liftVsBaseline':(rate-base) if rate is not None and base is not None else None,
      'selectedUniqueDates':dates,'decisiveUniqueDates':dec_dates,
      'retentionPct':100*len(sel)/len(rows) if rows else 0,
      'noPickDatePct':100*(all_dates-dates)/all_dates if all_dates else 0,
    }

def sig(atoms,side,horizon):
    body='|'.join(sorted(f"{a['feature']}:{a['operator']}:{a['threshold']:.12g}" for a in atoms))
    return f'{horizon}|{side}|{body}'

def search(discovery,horizon):
    atoms=[]
    for feature in FEATURES:
        vals=[r.get(feature) for r in discovery]
        for q in QUANTILES:
            threshold=quantile(vals,q)
            side='AWAY' if q<0.5 else 'HOME'
            atom={'feature':feature,'operator':'LTE' if q<0.5 else 'GTE','threshold':threshold,'discoveryQuantile':q}
            m=metrics(discovery,[atom],horizon,side)
            if m['decisiveRows']>=MIN_DISCOVERY_DECISIVE:
                atoms.append((atom,side))
    candidates=[]; seen=set()
    def add(rule_atoms,side):
        signature=sig(rule_atoms,side,horizon)
        if signature in seen:return
        seen.add(signature)
        m=metrics(discovery,rule_atoms,horizon,side)
        if m['decisiveRows']<MIN_DISCOVERY_DECISIVE:return
        candidates.append({'ruleKey':hashlib.sha256(signature.encode()).hexdigest()[:16],
                           'horizon':horizon,'side':side,'atoms':rule_atoms,'discovery':m,
                           'discoveryWilsonLower95':wilson_lower(m['hits'],m['decisiveRows'])})
    for a,s in atoms:add([a],s)
    for i,(a,s) in enumerate(atoms):
        for j in range(i+1,len(atoms)):
            b,sb=atoms[j]
            if sb!=s or b['feature']==a['feature']:continue
            add([a,b],s)
            for k in range(j+1,len(atoms)):
                c,sc=atoms[k]
                if sc!=s or len({a['feature'],b['feature'],c['feature']})<3:continue
                add([a,b,c],s)
    candidates.sort(key=lambda r:(r['discoveryWilsonLower95'],r['discovery']['decisiveHitRate'],r['discovery']['decisiveRows']),reverse=True)
    return candidates[:TOP_K_PER_HORIZON],len(candidates)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--feature-table',required=True); ap.add_argument('--out',required=True)
    args=ap.parse_args(); table=load(args.feature_table)
    if table.get('schemaVersion')!='courtedge-p0-step12i-clean-t5-feature-table.v1':raise SystemExit('STEP12J_FEATURE_SCHEMA_INVALID')
    rows=table['rows']; discovery=[r for r in rows if r['officialDate']<=DISCOVERY_END]; holdout=[r for r in rows if r['officialDate']>DISCOVERY_END]
    if not discovery or not holdout:raise SystemExit('STEP12J_BOTH_PARTITIONS_REQUIRED')
    family=[]; attempted={}
    for horizon in ('FULL_GAME','FIRST_5'):
        chosen,n=search(discovery,horizon); attempted[horizon]=n
        # IMPORTANT: family is frozen here from discovery only, before holdout metrics are attached.
        for r in chosen:
            r['holdout']=metrics(holdout,r['atoms'],horizon,r['side'])
            hm=r['holdout']
            if hm['decisiveRows']>=80 and hm['decisiveUniqueDates']>=30 and (hm['liftVsBaseline'] or 0)>0:
                cls='CLEAN_HOLDOUT_PROMISING_SUFFICIENT_SAMPLE'
            elif (hm['liftVsBaseline'] or 0)>0:
                cls='CLEAN_HOLDOUT_PROMISING_NEEDS_MORE_SAMPLE'
            else:
                cls='CLEAN_HOLDOUT_NOT_PROMISING'
            r['classification']=cls
            family.append(r)
    report={
      'schemaVersion':SCHEMA,
      'evidenceStatus':'CLEAN_REDISCOVERY_RESEARCH_ONLY_NO_CERTIFICATION_NO_BET_ELITE',
      'split':{'discoveryEndDate':DISCOVERY_END,'discoveryRows':len(discovery),'holdoutRows':len(holdout),
               'discoveryDates':len({r['officialDate'] for r in discovery}),'holdoutDates':len({r['officialDate'] for r in holdout})},
      'searchContract':{'features':list(FEATURES),'quantiles':list(QUANTILES),'maxAtomsPerRule':3,
                        'minimumDiscoveryDecisiveRows':MIN_DISCOVERY_DECISIVE,'topKPerHorizon':TOP_K_PER_HORIZON,
                        'thresholdsLearnedFromDiscoveryOnly':True,'holdoutUsedForCandidateSelection':False,
                        'holdoutUsedForThresholdTuning':False,'holdoutIsCertificationEvidence':False},
      'attemptedRulesAfterDiscoveryFloor':attempted,
      'frozenFamilySize':len(family),'family':family,
      'policy':{'historicalPricesUsed':False,'historicalEvClaimProduced':False,'betEliteProduced':False,
                'automaticPromotionAllowed':False,'livePickFiltersChanged':False,'step11cCapturePopulationChanged':False,
                'stakeCalculated':False,'automaticBetPlacement':False},
    }
    os.makedirs(os.path.dirname(args.out) or '.',exist_ok=True)
    with open(args.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'familySize':len(family),'attempted':attempted,
                      'classifications':{c:sum(1 for r in family if r['classification']==c) for c in sorted({r['classification'] for r in family})}},indent=2))
if __name__=='__main__':main()

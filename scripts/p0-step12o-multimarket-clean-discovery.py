#!/usr/bin/env python3
import argparse, hashlib, json, math, os

SCHEMA='courtedge-p0-step12o-multimarket-clean-discovery.v1'
FEATURES=(
 'team_rd10_diff','team_win10_diff','team_rs10_diff','team_ra10_adv',
 'starter_runrisk_adv','starter_kbb_adv','starter_hr_adv',
 'lineup_exposure_rate_adv','lineup_continuity_rate_adv',
)
QUANTILES=(0.1,0.2,0.3,0.7,0.8,0.9)
DISCOVERY_END='2025-07-31'
MIN_DISCOVERY_DECISIVE=60
TOP_K_PER_TARGET=3


def load(p):
    with open(p,encoding='utf-8') as f:return json.load(f)

def quantile(vals,q):
    xs=sorted(float(v) for v in vals if v is not None and math.isfinite(float(v)))
    if not xs: raise ValueError('EMPTY_QUANTILE')
    pos=(len(xs)-1)*q; lo=math.floor(pos); hi=math.ceil(pos)
    if lo==hi:return xs[lo]
    f=pos-lo; return xs[lo]*(1-f)+xs[hi]*f

def wilson_lower(h,n,z=1.96):
    if n<=0:return None
    p=h/n; den=1+z*z/n
    return (p+z*z/(2*n)-z*math.sqrt((p*(1-p)+z*z/(4*n))/n))/den

def atom_ok(r,a):
    v=r.get(a['feature'])
    if v is None or not math.isfinite(float(v)):return False
    return float(v)>=a['threshold'] if a['operator']=='GTE' else float(v)<=a['threshold']

def target_outcome(r,target):
    t=r['targets']
    if target.endswith(':RESULT:HOME'):
        return 'WIN' if t[target[:-5]]=='HOME' else ('PUSH' if t[target[:-5]]=='TIE' else 'LOSS')
    if target.endswith(':RESULT:AWAY'):
        return 'WIN' if t[target[:-5]]=='AWAY' else ('PUSH' if t[target[:-5]]=='TIE' else 'LOSS')
    return t[target]

def metrics(rows,atoms,target):
    sel=[r for r in rows if all(atom_ok(r,a) for a in atoms)]
    outs=[(r,target_outcome(r,target)) for r in sel]
    dec=[(r,o) for r,o in outs if o!='PUSH']
    hits=sum(1 for _,o in dec if o=='WIN'); losses=sum(1 for _,o in dec if o=='LOSS'); pushes=len(outs)-len(dec)
    base_out=[target_outcome(r,target) for r in rows]
    base_dec=[o for o in base_out if o!='PUSH']
    base=sum(1 for o in base_dec if o=='WIN')/len(base_dec) if base_dec else None
    rate=hits/len(dec) if dec else None
    return {
      'selectedRows':len(sel),'decisiveRows':len(dec),'hits':hits,'losses':losses,'pushes':pushes,
      'decisiveHitRate':rate,'baselineHitRate':base,'liftVsBaseline':(rate-base) if rate is not None and base is not None else None,
      'selectedUniqueDates':len({r['officialDate'] for r in sel}),'decisiveUniqueDates':len({r['officialDate'] for r,_ in dec}),
      'retentionPct':100*len(sel)/len(rows) if rows else 0,
    }

def target_list(sample):
    keys=sorted(sample['targets'])
    targets=[]
    for k in keys:
        if k.endswith(':RESULT'):
            h=k.split(':')[0]
            if h in ('FIRST_3','FIRST_5','FULL_GAME'):
                targets.extend([k+':HOME',k+':AWAY'])
        elif ':TOTAL:' in k and (k.endswith(':OVER') or k.endswith(':UNDER')):
            targets.append(k)
        elif k in ('FIRST_INNING:NRFI','FIRST_INNING:YRFI'):
            targets.append(k)
    return targets

def signature(atoms,target):
    b='|'.join(sorted(f"{a['feature']}:{a['operator']}:{a['threshold']:.12g}" for a in atoms))
    return target+'|'+b

def search(discovery,target):
    atoms=[]
    # Direction of the atom is independent from event type; both low/high tails are searched.
    for feature in FEATURES:
        vals=[r.get(feature) for r in discovery]
        for q in QUANTILES:
            a={'feature':feature,'operator':'LTE' if q<0.5 else 'GTE','threshold':quantile(vals,q),'discoveryQuantile':q}
            m=metrics(discovery,[a],target)
            if m['decisiveRows']>=MIN_DISCOVERY_DECISIVE: atoms.append(a)
    cand=[]; seen=set()
    def add(rule_atoms):
        s=signature(rule_atoms,target)
        if s in seen:return
        seen.add(s);m=metrics(discovery,rule_atoms,target)
        if m['decisiveRows']<MIN_DISCOVERY_DECISIVE:return
        cand.append({'ruleKey':hashlib.sha256(s.encode()).hexdigest()[:16],'target':target,'atoms':rule_atoms,
                     'discovery':m,'discoveryWilsonLower95':wilson_lower(m['hits'],m['decisiveRows'])})
    for i,a in enumerate(atoms):
        add([a])
        for j in range(i+1,len(atoms)):
            b=atoms[j]
            if b['feature']==a['feature']:continue
            add([a,b])
            for k in range(j+1,len(atoms)):
                c=atoms[k]
                if len({a['feature'],b['feature'],c['feature']})<3:continue
                add([a,b,c])
    cand.sort(key=lambda x:(x['discoveryWilsonLower95'],x['discovery']['decisiveHitRate'],x['discovery']['decisiveRows']),reverse=True)
    return cand[:TOP_K_PER_TARGET],len(cand)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--matrix',required=True);ap.add_argument('--out',required=True);a=ap.parse_args();m=load(a.matrix)
    if m.get('schemaVersion')!='courtedge-p0-step12n-multimarket-target-matrix.v1':raise SystemExit('STEP12O_MATRIX_SCHEMA_INVALID')
    rows=m['rows'];dis=[r for r in rows if r['officialDate']<=DISCOVERY_END];hold=[r for r in rows if r['officialDate']>DISCOVERY_END]
    if not dis or not hold:raise SystemExit('STEP12O_PARTITIONS_REQUIRED')
    targets=target_list(rows[0]); family=[];attempted={}
    for t in targets:
        chosen,n=search(dis,t);attempted[t]=n
        # Freeze from discovery before attaching holdout.
        for r in chosen:
            r['holdout']=metrics(hold,r['atoms'],t)
            family.append(r)
    report={
      'schemaVersion':SCHEMA,'evidenceStatus':'MULTIMARKET_CLEAN_DISCOVERY_RESEARCH_ONLY_NO_CERTIFICATION',
      'split':{'discoveryEndDate':DISCOVERY_END,'discoveryRows':len(dis),'holdoutRows':len(hold)},
      'searchContract':{'features':list(FEATURES),'quantiles':list(QUANTILES),'maxAtomsPerRule':3,
                        'minimumDiscoveryDecisiveRows':MIN_DISCOVERY_DECISIVE,'topKPerTarget':TOP_K_PER_TARGET,
                        'targets':targets,'holdoutUsedForSelection':False,'holdoutUsedForThresholdTuning':False},
      'attemptedRulesAfterFloor':attempted,'frozenFamilySize':len(family),'family':family,
      'policy':{'historicalPricesUsed':False,'historicalEvClaimProduced':False,'betEliteProduced':False,
                'livePickFiltersChanged':False,'step11cCapturePopulationChanged':False,'automaticBetPlacement':False},
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f:json.dump(report,f,indent=2,sort_keys=True);f.write('\n')
    print(json.dumps({'ok':True,'targets':len(targets),'familySize':len(family)},indent=2))
if __name__=='__main__':main()

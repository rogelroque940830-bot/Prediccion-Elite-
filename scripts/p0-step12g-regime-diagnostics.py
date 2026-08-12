#!/usr/bin/env python3
import argparse, json, math, os, runpy
from collections import defaultdict

LEADER='FIRST_5:46a7cbb6ff5c2458'

def load(p):
    with open(p, encoding='utf-8') as f: return json.load(f)

def quantile(values, q):
    vals=sorted(v for v in values if isinstance(v,(int,float)) and math.isfinite(v))
    if not vals: return None
    pos=(len(vals)-1)*q; lo=int(math.floor(pos)); hi=int(math.ceil(pos))
    if lo==hi: return vals[lo]
    return vals[lo]*(hi-pos)+vals[hi]*(pos-lo)

def season_summary(label, dataset, starter, lineup, leader, build_features, atom_mask):
    rows=build_features(dataset, starter, lineup)
    selected=[r for r in rows if all(atom_mask(r,a) for a in leader['atoms'])]
    decisive=[r for r in selected if r['f5Result']!='PUSH']
    hits=sum(1 for r in decisive if r['f5Result']=='HOME')
    eligible=[r for r in rows if r['f5Result']!='PUSH']
    baseline=sum(1 for r in eligible if r['f5Result']=='HOME')/len(eligible)
    months=defaultdict(lambda:{'selected':0,'decisive':0,'hits':0,'pushes':0})
    for r in selected:
        m=r['officialDate'][:7]; months[m]['selected']+=1
        if r['f5Result']=='PUSH': months[m]['pushes']+=1
        else:
            months[m]['decisive']+=1
            if r['f5Result']=='HOME': months[m]['hits']+=1
    atoms=[]
    for a in leader['atoms']:
        vals=[r.get(a['feature']) for r in rows if isinstance(r.get(a['feature']),(int,float)) and math.isfinite(r.get(a['feature']))]
        svals=[r.get(a['feature']) for r in selected if isinstance(r.get(a['feature']),(int,float)) and math.isfinite(r.get(a['feature']))]
        passed=sum(1 for r in rows if atom_mask(r,a))
        atoms.append({
            'feature':a['feature'],'operator':a['operator'],'frozenThreshold':a['threshold'],
            'featureCoverageRows':len(vals),'singleAtomPassRows':passed,'singleAtomPassPct':passed/len(rows) if rows else 0,
            'allRowsQuantiles':{str(q):quantile(vals,q) for q in (0.1,0.25,0.5,0.7,0.8,0.9)},
            'selectedRowsQuantiles':{str(q):quantile(svals,q) for q in (0.1,0.25,0.5,0.7,0.8,0.9)},
            'selectedMedianExcessAboveThreshold':(quantile(svals,0.5)-a['threshold']) if svals else None,
        })
    monthly=[]
    for m in sorted(months):
        x=months[m]
        monthly.append({'month':m,**x,'hitRate':x['hits']/x['decisive'] if x['decisive'] else None})
    return {
        'label':label,'featureRows':len(rows),'eligibleF5DecisiveRows':len(eligible),
        'selectedRows':len(selected),'selectionPct':len(selected)/len(rows) if rows else 0,
        'decisiveRows':len(decisive),'hits':hits,'losses':len(decisive)-hits,'pushes':len(selected)-len(decisive),
        'hitRate':hits/len(decisive) if decisive else None,'baselineHomeF5':baseline,
        'liftVsBaseline':(hits/len(decisive)-baseline) if decisive else None,
        'selectedUniqueDates':len({r['officialDate'] for r in selected}),
        'decisiveUniqueDates':len({r['officialDate'] for r in decisive}),
        'atoms':atoms,'monthly':monthly,
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--candidates',required=True)
    for y in ('2024','2026'):
        ap.add_argument(f'--dataset-{y}',required=True); ap.add_argument(f'--starter-{y}',required=True); ap.add_argument(f'--lineup-{y}',required=True)
    ap.add_argument('--out',required=True)
    a=ap.parse_args()
    candidates=load(a.candidates)['frozenFamily']['candidates']
    matches=[x for x in candidates if x['hypothesisKey']==LEADER]
    if len(matches)!=1: raise SystemExit('STEP12G_LEADER_IDENTITY_FAILURE')
    leader=matches[0]
    pilot=runpy.run_path('scripts/p0-step12-pocket-pilot.py',run_name='p0_step12g_feature_library')
    build_features=pilot['build_features']; atom_mask=pilot['atom_mask']
    s24=season_summary('2024',load(getattr(a,'dataset_2024')),load(getattr(a,'starter_2024')),load(getattr(a,'lineup_2024')),leader,build_features,atom_mask)
    s26=season_summary('2026',load(getattr(a,'dataset_2026')),load(getattr(a,'starter_2026')),load(getattr(a,'lineup_2026')),leader,build_features,atom_mask)
    atom_diffs=[]
    for x,y in zip(s24['atoms'],s26['atoms']):
        if x['feature']!=y['feature']: raise SystemExit('STEP12G_ATOM_ORDER_MISMATCH')
        atom_diffs.append({'feature':x['feature'],'singleAtomPassPctDiff2026Minus2024':y['singleAtomPassPct']-x['singleAtomPassPct']})
    report={
        'schemaVersion':'courtedge-p0-step12g-regime-diagnostics.v1',
        'evidenceStatus':'DIAGNOSTIC_ONLY_NO_RETUNING_NO_PROMOTION',
        'leader':{'hypothesisKey':LEADER,'atoms':leader['atoms']},
        'season2024':s24,'season2026':s26,
        'comparison':{
            'selectionPctDiff2026Minus2024':s26['selectionPct']-s24['selectionPct'],
            'hitRateDiff2026Minus2024':s26['hitRate']-s24['hitRate'],
            'liftDiff2026Minus2024':s26['liftVsBaseline']-s24['liftVsBaseline'],
            'baselineDiff2026Minus2024':s26['baselineHomeF5']-s24['baselineHomeF5'],
            'atomPassRateDiffs':atom_diffs,
            'interpretation':{
                'thresholdRetuningAllowed':False,'regimeExclusionAllowed':False,'monthDroppingAllowed':False,
                'canProduceBetElite':False,'canChangeLiveFilters':False,'diagnosticDoesNotCreateIndependentEvidence':True
            }
        }
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f: json.dump(report,f,indent=2,sort_keys=True); f.write('\n')
    print(json.dumps({'ok':True,'out':a.out,'comparison':report['comparison'],'season2024':{k:s24[k] for k in ('selectionPct','hitRate','baselineHomeF5','liftVsBaseline')},'season2026':{k:s26[k] for k in ('selectionPct','hitRate','baselineHomeF5','liftVsBaseline')}},indent=2))
if __name__=='__main__': main()

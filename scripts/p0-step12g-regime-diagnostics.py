#!/usr/bin/env python3
import argparse, itertools, json, math, os, runpy
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

def subset_metrics(rows, atoms, atom_mask, baseline):
    selected=[r for r in rows if all(atom_mask(r,a) for a in atoms)]
    decisive=[r for r in selected if r['f5Result']!='PUSH']
    hits=sum(1 for r in decisive if r['f5Result']=='HOME')
    rate=hits/len(decisive) if decisive else None
    return {'selectedRows':len(selected),'decisiveRows':len(decisive),'hits':hits,'losses':len(decisive)-hits,
            'pushes':len(selected)-len(decisive),'hitRate':rate,'liftVsBaseline':rate-baseline if rate is not None else None}

def season_summary(label, dataset, starter, lineup, leader, build_features, atom_mask):
    rows=build_features(dataset, starter, lineup)
    selected=[r for r in rows if all(atom_mask(r,a) for a in leader['atoms'])]
    decisive=[r for r in selected if r['f5Result']!='PUSH']
    hits=sum(1 for r in decisive if r['f5Result']=='HOME')
    eligible=[r for r in rows if r['f5Result']!='PUSH']
    baseline=sum(1 for r in eligible if r['f5Result']=='HOME')/len(eligible)
    months=sorted({r['officialDate'][:7] for r in rows})
    monthly=[]
    for m in months:
        month_rows=[r for r in rows if r['officialDate'][:7]==m]
        month_sel=[r for r in selected if r['officialDate'][:7]==m]
        month_dec=[r for r in month_sel if r['f5Result']!='PUSH']
        month_elig=[r for r in month_rows if r['f5Result']!='PUSH']
        mh=sum(1 for r in month_dec if r['f5Result']=='HOME')
        mb=sum(1 for r in month_elig if r['f5Result']=='HOME')/len(month_elig) if month_elig else None
        atom_pass={a['feature']:sum(1 for r in month_rows if atom_mask(r,a))/len(month_rows) if month_rows else None for a in leader['atoms']}
        monthly.append({'month':m,'featureRows':len(month_rows),'selectedRows':len(month_sel),'decisiveRows':len(month_dec),
                        'hits':mh,'losses':len(month_dec)-mh,'pushes':len(month_sel)-len(month_dec),
                        'hitRate':mh/len(month_dec) if month_dec else None,'baselineHomeF5':mb,
                        'liftVsBaseline':(mh/len(month_dec)-mb) if month_dec and mb is not None else None,
                        'singleAtomPassPct':atom_pass})
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
    interactions=[]
    for k in range(1,len(leader['atoms'])+1):
        for idxs in itertools.combinations(range(len(leader['atoms'])),k):
            sub=[leader['atoms'][i] for i in idxs]
            interactions.append({'features':[a['feature'] for a in sub],**subset_metrics(rows,sub,atom_mask,baseline)})
    return {
        'label':label,'featureRows':len(rows),'eligibleF5DecisiveRows':len(eligible),
        'selectedRows':len(selected),'selectionPct':len(selected)/len(rows) if rows else 0,
        'decisiveRows':len(decisive),'hits':hits,'losses':len(decisive)-hits,'pushes':len(selected)-len(decisive),
        'hitRate':hits/len(decisive) if decisive else None,'baselineHomeF5':baseline,
        'liftVsBaseline':(hits/len(decisive)-baseline) if decisive else None,
        'selectedUniqueDates':len({r['officialDate'] for r in selected}),
        'decisiveUniqueDates':len({r['officialDate'] for r in decisive}),
        'atoms':atoms,'interactionDiagnostics':interactions,'monthlyDiagnostics':monthly,
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
    ix24={'+'.join(x['features']):x for x in s24['interactionDiagnostics']}; ix26={'+'.join(x['features']):x for x in s26['interactionDiagnostics']}
    interaction_diffs=[]
    for key in sorted(ix24):
        x,y=ix24[key],ix26[key]
        interaction_diffs.append({'features':x['features'],'lift2024':x['liftVsBaseline'],'lift2026':y['liftVsBaseline'],
                                  'liftDiff2026Minus2024':(y['liftVsBaseline']-x['liftVsBaseline']) if x['liftVsBaseline'] is not None and y['liftVsBaseline'] is not None else None})
    report={
        'schemaVersion':'courtedge-p0-step12g-regime-diagnostics.v2',
        'evidenceStatus':'DIAGNOSTIC_ONLY_NO_RETUNING_NO_PROMOTION',
        'leader':{'hypothesisKey':LEADER,'atoms':leader['atoms']},
        'season2024':s24,'season2026':s26,
        'comparison':{
            'selectionPctDiff2026Minus2024':s26['selectionPct']-s24['selectionPct'],
            'hitRateDiff2026Minus2024':s26['hitRate']-s24['hitRate'],
            'liftDiff2026Minus2024':s26['liftVsBaseline']-s24['liftVsBaseline'],
            'baselineDiff2026Minus2024':s26['baselineHomeF5']-s24['baselineHomeF5'],
            'atomPassRateDiffs':atom_diffs,'interactionLiftDiffs':interaction_diffs,
            'interpretation':{
                'thresholdRetuningAllowed':False,'regimeExclusionAllowed':False,'monthDroppingAllowed':False,
                'canProduceBetElite':False,'canChangeLiveFilters':False,'diagnosticDoesNotCreateIndependentEvidence':True,
                'calendarScaleDriftIsDiagnosticOnly':True,'interactionDriftIsDiagnosticOnly':True
            }
        }
    }
    os.makedirs(os.path.dirname(a.out) or '.',exist_ok=True)
    with open(a.out,'w',encoding='utf-8') as f: json.dump(report,f,indent=2,sort_keys=True); f.write('\n')
    print(json.dumps({'ok':True,'out':a.out,'comparison':report['comparison'],'season2024':{k:s24[k] for k in ('selectionPct','hitRate','baselineHomeF5','liftVsBaseline')},'season2026':{k:s26[k] for k in ('selectionPct','hitRate','baselineHomeF5','liftVsBaseline')}},indent=2))
if __name__=='__main__': main()

from pathlib import Path

path = Path("frontend/client/src/pages/mlb-predictor.tsx")
text = path.read_text(encoding="utf-8")
old = '''    baseTotal: number;
    finalTotal: number;
    notes: string[];
'''
new = '''    baseTotal: number;
    finalTotal: number;
    injuryHomeProbabilityDeltaPp?: number;
    injuryTotalRunsDelta?: number;
    injuryDataQuality?: "VERIFIED" | "DEGRADED";
    injuryHasAppliedAdjustment?: boolean;
    notes: string[];
'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"MLBResult factorBreakdown type: expected 1 match, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")

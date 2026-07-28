from pathlib import Path

path = Path("package.json")
text = path.read_text(encoding="utf-8")
old = "server/mlb-ledger-history-view.test.ts server/mlb-injury-outcomes-report.test.ts"
new = "server/mlb-ledger-history-view.test.ts server/mlb-injury-outcomes-report.test.ts server/mlb-injury-decision-report.test.ts"
if text.count(old) != 1:
    raise SystemExit(f"C2C package test anchor: expected 1 match, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")

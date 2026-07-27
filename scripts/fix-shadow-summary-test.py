from pathlib import Path

path = Path("server/mlb-injury-shadow.test.ts")
text = path.read_text(encoding="utf-8")
old = '''    ignored: 1,
    conflicts: 1,
    pending: 0,
    highConfidence: 3,
    officialOnly: 0,
'''
new = '''    ignored: 0,
    conflicts: 1,
    pending: 1,
    highConfidence: 2,
    officialOnly: 0,
'''
if text.count(old) != 1:
    raise SystemExit(f"shadow summary expectation: expected 1 match, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")

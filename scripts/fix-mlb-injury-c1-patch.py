from pathlib import Path

path = Path("scripts/apply-mlb-injury-c1.py")
text = path.read_text(encoding="utf-8")
old = '''text = replace_once(
    text,
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts",\\n',
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts",\\n',
    "ledger test script audit",
)
text = replace_once(
    text,
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts",\\n',
    'server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts",\\n',
    "injury test script audit",
)
text = replace_once(
    text,
    'server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts"\\n',
    'server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts"\\n',
    "shadow test script audit",
)
'''
new = '''text = replace_once(
    text,
    '    "test:mlb-ledger": "tsx --test server/mlb-ledger.test.ts server/mlb-settlement-worker.test.ts server/mlb-scientific-snapshot.test.ts server/mlb-injury-identity.test.ts server/mlb-pitcher-vs-team.test.ts server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts",\\n',
    '    "test:mlb-ledger": "tsx --test server/mlb-ledger.test.ts server/mlb-settlement-worker.test.ts server/mlb-scientific-snapshot.test.ts server/mlb-injury-identity.test.ts server/mlb-pitcher-vs-team.test.ts server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts",\\n',
    "ledger test script audit",
)
text = replace_once(
    text,
    '    "test:mlb-injuries": "tsx --test server/mlb-injury-identity.test.ts server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts",\\n',
    '    "test:mlb-injuries": "tsx --test server/mlb-injury-identity.test.ts server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts",\\n',
    "injury test script audit",
)
text = replace_once(
    text,
    '    "test:mlb-injury-shadow": "tsx --test server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts"\\n',
    '    "test:mlb-injury-shadow": "tsx --test server/mlb-injury-shadow.test.ts server/mlb-injury-phase-b.test.ts server/mlb-injury-phase-b-frontend.test.ts server/mlb-injury-audit.test.ts"\\n',
    "shadow test script audit",
)
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one C1 package patch block, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")

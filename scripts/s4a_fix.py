from pathlib import Path

path = Path('server/operational-routes.ts')
text = path.read_text(encoding='utf-8')
old = 'service.verifyBackup(decodeURIComponent(req.params.id || ""))'
new = 'service.verifyBackup(decodeURIComponent(String(req.params.id || "")))'
if text.count(old) != 1:
    raise SystemExit('S4A route parameter anchor changed')
path.write_text(text.replace(old, new, 1), encoding='utf-8')

from pathlib import Path
import json

path = Path('server/route-contract.snapshot.json')
items = json.loads(path.read_text(encoding='utf-8'))
additions = [
    {'method': 'GET', 'path': '/api/ops/v1/backups', 'registrations': 1},
    {'method': 'GET', 'path': '/api/ops/v1/status', 'registrations': 1},
    {'method': 'POST', 'path': '/api/ops/v1/backups', 'registrations': 1},
    {'method': 'POST', 'path': '/api/ops/v1/backups/:id/verify', 'registrations': 1},
]
existing = {(item['method'], item['path']) for item in items}
for item in additions:
    key = (item['method'], item['path'])
    if key in existing:
        raise SystemExit(f'Operational route already present in contract: {key}')
    items.append(item)
items.sort(key=lambda item: (item['method'], item['path']))
path.write_text(json.dumps(items, indent=2) + '\n', encoding='utf-8')

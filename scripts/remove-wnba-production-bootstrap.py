from pathlib import Path

SOURCE = Path("server/wnba-independent-routes.ts")
text = SOURCE.read_text(encoding="utf-8")

text = text.replace(
    'const DEFAULT_BOOTSTRAP_BASE = "https://web-production-7067b.up.railway.app";\n',
    '',
    1,
)

start = text.find('async function fetchBootstrapSnapshot(req: Request): Promise<LocalSnapshot> {')
end = text.find('async function resolveSnapshot', start)
if start != -1:
    if end == -1:
        raise SystemExit("Could not find end of WNBA bootstrap function")
    text = text[:start] + text[end:]
elif 'fetchBootstrapSnapshot' in text:
    raise SystemExit("Unexpected WNBA bootstrap function shape")

text = text.replace(
    'async function resolveSnapshot(req: Request): Promise<{ snapshot: LocalSnapshot; source: string; stale: boolean }> {',
    'async function resolveSnapshot(): Promise<{ snapshot: LocalSnapshot; source: string; stale: boolean }> {',
    1,
)

old = '''    const bootstrap = await fetchBootstrapSnapshot(req);
    saveLocalSnapshot(bootstrap);
    return { snapshot: bootstrap, source: bootstrap.source, stale: false };
'''
new = '''    throw new Error("WNBA direct source unavailable and integration cache is empty");
'''
if old not in text:
    raise SystemExit("WNBA bootstrap resolution block not found")
text = text.replace(old, new, 1)
text = text.replace('resolveSnapshot(req)', 'resolveSnapshot()')

if 'web-production-7067b.up.railway.app' in text or 'WNBA_BOOTSTRAP_READONLY_BASE' in text:
    raise SystemExit("Production WNBA bootstrap reference still present")

SOURCE.write_text(text, encoding="utf-8")

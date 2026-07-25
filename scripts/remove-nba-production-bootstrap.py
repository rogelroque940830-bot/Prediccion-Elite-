from pathlib import Path

SOURCE = Path("server/nba-independent-routes.ts")
text = SOURCE.read_text(encoding="utf-8")

text = text.replace(
    'const DEFAULT_BOOTSTRAP_BASE = "https://web-production-7067b.up.railway.app";\n',
    '',
    1,
)

start = text.find('async function fetchBootstrapSnapshot(rawDate: string): Promise<NbaSnapshot> {')
end = text.find('async function resolveSnapshot', start)
if start != -1:
    if end == -1:
        raise SystemExit("Could not find end of NBA bootstrap function")
    text = text[:start] + text[end:]
elif 'fetchBootstrapSnapshot' in text:
    raise SystemExit("Unexpected NBA bootstrap function shape")

old_memory = '''  if (memorySnapshot && now - memoryLoadedAt < CACHE_TTL_MS) {
    return { snapshot: memorySnapshot, source: memorySnapshot.source, stale: false };
  }
'''
new_memory = '''  if (memorySnapshot && now - memoryLoadedAt < CACHE_TTL_MS) {
    const source: Source = memorySnapshot.source === "production-bootstrap-cache"
      ? "integration-local-cache"
      : memorySnapshot.source;
    return { snapshot: memorySnapshot, source, stale: false };
  }
'''
if old_memory not in text:
    raise SystemExit("NBA memory cache block not found")
text = text.replace(old_memory, new_memory, 1)

old_bootstrap = '''    const bootstrap = await fetchBootstrapSnapshot(rawDate);
    saveLocalSnapshot(bootstrap);
    return { snapshot: bootstrap, source: "production-bootstrap-cache", stale: false };
'''
new_bootstrap = '''    throw new Error("NBA direct source unavailable and integration cache is empty");
'''
if old_bootstrap not in text:
    raise SystemExit("NBA bootstrap resolution block not found")
text = text.replace(old_bootstrap, new_bootstrap, 1)

if 'web-production-7067b.up.railway.app' in text or 'NBA_BOOTSTRAP_READONLY_BASE' in text:
    raise SystemExit("Production NBA bootstrap reference still present")

SOURCE.write_text(text, encoding="utf-8")

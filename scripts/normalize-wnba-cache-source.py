from pathlib import Path

SOURCE = Path("server/wnba-independent-routes.ts")
text = SOURCE.read_text(encoding="utf-8")

old = '''  if (memorySnapshot && now - memoryLoadedAt < CACHE_TTL_MS) {
    return { snapshot: memorySnapshot, source: memorySnapshot.source, stale: false };
  }
'''
new = '''  if (memorySnapshot && now - memoryLoadedAt < CACHE_TTL_MS) {
    const source = memorySnapshot.source === "production-bootstrap-cache"
      ? "integration-local-cache"
      : memorySnapshot.source;
    return { snapshot: memorySnapshot, source, stale: false };
  }
'''
if old not in text:
    raise SystemExit("WNBA memory cache source block not found")
text = text.replace(old, new, 1)
SOURCE.write_text(text, encoding="utf-8")

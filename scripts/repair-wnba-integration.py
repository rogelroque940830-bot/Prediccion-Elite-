from pathlib import Path

path = Path("server/routes.ts")
text = path.read_text(encoding="utf-8")
count = text.count("wwnbaFetch(")
if count < 1:
    raise SystemExit("Expected duplicated helper calls")
text = text.replace("wwnbaFetch(", "wnbaFetch(")
path.write_text(text, encoding="utf-8")
print(f"Corrected {count} WNBA helper calls")

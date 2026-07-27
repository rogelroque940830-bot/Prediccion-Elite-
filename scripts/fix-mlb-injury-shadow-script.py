from pathlib import Path

path = Path("scripts/apply-mlb-injury-shadow.py")
text = path.read_text(encoding="utf-8")
needle = "    '''                            title={`${t.type}"
count = text.count(needle)
if count != 2:
    raise SystemExit(f"expected 2 tooltip strings, found {count}")
text = text.replace(needle, "    r'''                            title={`${t.type}", 2)
path.write_text(text, encoding="utf-8")

from pathlib import Path
import re

p = Path("scripts/apply-mlb-p0-data-integrity.py")
s = p.read_text(encoding="utf-8")

count = s.count("\ner = replace_once(")
if count < 1:
    raise RuntimeError("expected er = replace_once typo not found")
s = s.replace("\ner = replace_once(", "\nere = replace_once(")

count_regex = s.count("\ner = regex_once(")
s = s.replace("\ner = regex_once(", "\nere = regex_once(")
s = s.replace("\ner_path.write_text(ere", "\nere_path.write_text(ere")

old_subn = "updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)"
new_subn = "updated, count = re.subn(pattern, lambda _match: replacement, text, count=1, flags=flags)"
if old_subn not in s:
    raise RuntimeError("regex_once re.subn line not found")
s = s.replace(old_subn, new_subn, 1)

page_block = re.compile(
    r'for component in \("MlbTesiCard", "MlbEreCard", "MlbEarlyMarketsCard"\):.*?page_path\.write_text\(page, encoding="utf-8"\)',
    re.S,
)
s, page_count = page_block.subn(
    'print("MLB standalone early cards are not mounted directly in mlb-predictor; route derives cutoff from gamePk/date")',
    s,
    count=1,
)
if page_count != 1:
    raise RuntimeError(f"expected page mount rewrite block once, found {page_count}")

p.write_text(s, encoding="utf-8")
print(f"fixed {count} replace assignments, {count_regex} regex assignments, literal regex replacement, and skipped unused page mount rewrite")

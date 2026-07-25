from pathlib import Path

p = Path("scripts/apply-mlb-p0-data-integrity.py")
s = p.read_text(encoding="utf-8")
count = s.count("\ner = replace_once(")
if count < 1:
    raise RuntimeError("expected er = replace_once typo not found")
s = s.replace("\ner = replace_once(", "\nere = replace_once(")
count_regex = s.count("\ner = regex_once(")
s = s.replace("\ner = regex_once(", "\nere = regex_once(")
s = s.replace("\ner_path.write_text(ere", "\nere_path.write_text(ere")
p.write_text(s, encoding="utf-8")
print(f"fixed {count} replace assignments and {count_regex} regex assignments")

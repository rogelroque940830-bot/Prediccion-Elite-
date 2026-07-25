from pathlib import Path

path = Path("frontend/client/src/pages/mlb-predictor.tsx")
text = path.read_text(encoding="utf-8")
old = '''            statcastDataQuality, statcastSignal, injuryProbDelta,
            sharpAgainst: sharpAgainstML, sharpStrong,'''
new = '''            statcastDataQuality, statcastSignal, injuryProbDelta, injuryDataQuality,
            sharpAgainst: sharpAgainstML, sharpStrong,'''
count = text.count(old)
if count != 1:
    raise RuntimeError(f"F5 injury quality propagation: expected one exact match, found {count}")
text = text.replace(old, new, 1)
if text.count("injuryProbDelta, injuryDataQuality") != 4:
    raise RuntimeError("All four MLB PQS markets must receive injuryDataQuality")
path.write_text(text, encoding="utf-8")
print("MLB F5 injuryDataQuality propagated")

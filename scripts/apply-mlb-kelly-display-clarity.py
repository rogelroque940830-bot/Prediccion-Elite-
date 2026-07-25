from pathlib import Path

path = Path("frontend/client/src/pages/mlb-predictor.tsx")
text = path.read_text(encoding="utf-8")
old = '''<div><p className="text-xs text-slate-500">Kelly</p><p className="text-base font-bold text-green-400">${_k.toFixed(2)}</p></div>'''
new = '''<div>
                          <p className="text-xs text-slate-500">Kelly teórico</p>
                          <p className="text-base font-bold text-green-400">{(_k / 10).toFixed(1)}% banca</p>
                          <p className="text-[9px] text-cyan-300">Stake permitido: máx. 1.0u</p>
                        </div>'''
count = text.count(old)
if count != 3:
    raise RuntimeError(f"Kelly display clarification: expected 3 matches, found {count}")
path.write_text(text.replace(old, new), encoding="utf-8")
print("MLB Kelly display clarified in 3 detailed market cards")

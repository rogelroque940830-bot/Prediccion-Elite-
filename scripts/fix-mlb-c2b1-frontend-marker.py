from pathlib import Path

path = Path("frontend/client/src/pages/mlb-history.tsx")
text = path.read_text()
marker = "Duplicado analítico"
if marker not in text:
    needle = '{pick.hasInjuryAudit && <Badge variant="outline" className="text-[10px] border-cyan-500/30 text-cyan-300">C1</Badge>}'
    if text.count(needle) != 1:
        raise SystemExit(f"C1 badge anchor: expected 1 match, found {text.count(needle)}")
    addition = '''{pick.hasInjuryAudit && <Badge variant="outline" className="text-[10px] border-cyan-500/30 text-cyan-300">C1</Badge>}
                  {pick.analyticalDuplicate && (
                    <Badge variant="outline" className="text-[10px] border-amber-500/40 bg-amber-500/10 text-amber-300" title="Visible en el ledger, pero excluido de C2B y C2C por equivaler a una decisión anterior">
                      Duplicado analítico
                    </Badge>
                  )}'''
    text = text.replace(needle, addition, 1)
path.write_text(text)

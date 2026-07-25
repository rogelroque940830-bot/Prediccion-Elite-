from pathlib import Path

path = Path("server/routes.ts")
text = path.read_text(encoding="utf-8")
old = '''            const pos = player.position || "";
            const status = inj.status || "";
            const isPitcher = /pitcher/i.test(pos);'''
new = '''            const pos = player.position || "";
            const status = inj.status || "";
            const normalizedPos = String(pos).trim().toUpperCase();
            const isPitcher = /pitcher/i.test(String(pos)) || ["P", "SP", "RP", "LHP", "RHP"].includes(normalizedPos);'''
count = text.count(old)
if count != 1:
    raise RuntimeError(f"MLB injury pitcher classifier: expected one exact match, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("MLB injury pitcher position classifier fixed")

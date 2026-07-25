from pathlib import Path

PREDICTOR = Path("frontend/client/src/pages/nhl-predictor.tsx")
MODEL = Path("frontend/client/src/lib/nhl-model.ts")

text = PREDICTOR.read_text(encoding="utf-8")
marker = '  const manualTeams: NHLManualTeam[] = manualTeamPayload?.data ?? [];\n'
insert = marker + '  const selectableNhlTeams = manualTeams.length > 0\n    ? manualTeams.map((row) => row.teamName).sort((a, b) => a.localeCompare(b))\n    : NHL_TEAMS;\n'
if 'const selectableNhlTeams =' not in text:
    if marker not in text:
        raise SystemExit("manualTeams marker not found")
    text = text.replace(marker, insert, 1)

old = '''                {NHL_TEAMS.map((t) => (\n                  <SelectItem key={t} value={t}>\n                    {t}\n                  </SelectItem>\n                ))}\n'''
new = '''                {selectableNhlTeams.map((t) => (\n                  <SelectItem key={t} value={t}>\n                    {t}\n                  </SelectItem>\n                ))}\n'''
if old in text:
    text = text.replace(old, new, 1)
elif 'selectableNhlTeams.map' not in text:
    raise SystemExit("NHL team selector block not found")

PREDICTOR.write_text(text, encoding="utf-8")

model = MODEL.read_text(encoding="utf-8")
model = model.replace('"Anaheim Ducks", "Arizona Coyotes", "Boston Bruins",', '"Anaheim Ducks", "Boston Bruins",')
MODEL.write_text(model, encoding="utf-8")

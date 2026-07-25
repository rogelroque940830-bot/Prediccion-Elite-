from pathlib import Path

ROUTES = Path("server/routes.ts")
text = ROUTES.read_text(encoding="utf-8")

import_marker = 'import { registerNhlManualRoutes } from "./nhl-manual-routes";\n'
import_line = 'import { registerIndependentWnbaRoutes } from "./wnba-independent-routes";\n'
if import_line not in text:
    if import_marker not in text:
        raise SystemExit("WNBA independent import marker not found")
    text = text.replace(import_marker, import_marker + import_line, 1)

register_marker = '  registerNhlManualRoutes(app);\n'
register_line = '  registerIndependentWnbaRoutes(app);\n'
if register_line not in text:
    if register_marker not in text:
        raise SystemExit("WNBA independent register marker not found")
    text = text.replace(register_marker, register_marker + register_line, 1)

ROUTES.write_text(text, encoding="utf-8")

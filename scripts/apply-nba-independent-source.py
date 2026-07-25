from pathlib import Path

ROUTES = Path("server/routes.ts")
text = ROUTES.read_text(encoding="utf-8")

import_marker = 'import { registerNbaManualRoutes } from "./nba-manual-routes";\n'
import_line = 'import { registerIndependentNbaRoutes } from "./nba-independent-routes";\n'
if import_line not in text:
    if import_marker not in text:
        raise SystemExit("NBA independent import marker not found")
    text = text.replace(import_marker, import_marker + import_line, 1)

register_marker = '  registerNbaManualRoutes(app);\n'
register_line = '  registerIndependentNbaRoutes(app);\n'
if register_line not in text:
    if register_marker not in text:
        raise SystemExit("NBA independent register marker not found")
    text = text.replace(register_marker, register_line + register_marker, 1)

ROUTES.write_text(text, encoding="utf-8")

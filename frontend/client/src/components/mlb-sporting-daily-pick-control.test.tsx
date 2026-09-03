import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const componentPath = path.resolve(
  process.cwd(),
  "client/src/components/mlb-sporting-daily-pick-control.tsx",
);
const pagePath = path.resolve(
  process.cwd(),
  "client/src/pages/mlb-predictor-v16.tsx",
);

describe("MLB sporting Daily Pick visible authority", () => {
  it("keeps the certified sporting hierarchy as the visible daily pick and price as secondary evidence", () => {
    const component = fs.readFileSync(componentPath, "utf8");
    const page = fs.readFileSync(pagePath, "utf8");

    expect(page).toContain("MlbSportingDailyPickControl");
    expect(page).not.toContain("MlbDailyOpportunityControl");

    expect(component).toContain("/api/mlb/unified-v16/ui-run");
    expect(component).toContain("Autoridad deportiva diaria");
    expect(component).toContain("1 PICK MÁXIMO");
    expect(component).toContain("Validación de cuota / EV");
    expect(component).toContain("NO CAMBIA EL DAILY PICK");
    expect(component).toContain("<MlbDailyBestPickCard value={result.result?.dailyBestPick} />");
    expect(component).toContain("<MlbDailyBestPickPriceCard value={result.result?.dailyBestPickPrice} />");
  });
});

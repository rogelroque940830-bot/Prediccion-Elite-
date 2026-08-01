import fs from "node:fs";

const path = "server/mlb-s6q-fifty-settlement-human-review.ts";
let source = fs.readFileSync(path, "utf8");
const before = '.catch((error) => console.error("[s6q] minimum sample of 20 settlements certification failed", error))';
const after = '.catch((error) => console.error("[s6q] fifty-settlement human review failed", error))';
if (!source.includes(before) && !source.includes(after)) {
  throw new Error("Expected S6Q worker log label not found");
}
source = source.replace(before, after);
fs.writeFileSync(path, source);

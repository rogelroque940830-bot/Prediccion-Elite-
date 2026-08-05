import fs from "node:fs";

const path = "frontend/client/src/components/mlb-daily-slate-panel.tsx";
let source = fs.readFileSync(path, "utf8");
const needle = "  UserRoundCheck,\n  EyeOff,\n";
const replacement = "  UserRoundCheck,\n  Users,\n  EyeOff,\n";
const count = source.split(needle).length - 1;
if (count !== 1) throw new Error(`expected one import marker, found ${count}`);
source = source.replace(needle, replacement);
if (!source.includes("<Users className=")) throw new Error("Users component is not used");
fs.writeFileSync(path, source);
console.log("P1-M2C.2 Users import fixed.");

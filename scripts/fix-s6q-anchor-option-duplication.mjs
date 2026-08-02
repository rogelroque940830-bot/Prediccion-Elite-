import fs from "node:fs";

const path = "server/mlb-s6q-fifty-settlement-human-review.ts";
let source = fs.readFileSync(path, "utf8");
const duplicate = "          anchors: storedAnchors,\n          anchors: storedAnchors,";
if (!source.includes(duplicate)) throw new Error("Expected duplicate anchor options were not found");
source = source.replace(duplicate, "          anchors: storedAnchors,");
fs.writeFileSync(path, source);
console.log("Removed duplicate initial anchor option.");

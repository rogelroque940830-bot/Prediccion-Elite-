import { execFileSync } from "node:child_process";
import fs from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const checks = [
  {
    name: "literal fallback after process.env",
    regex: /process\.env\.(?:BDL_API_KEY|ODDS_API_KEY)\s*\|\|\s*["'][A-Za-z0-9_-]{16,}["']/g,
  },
  {
    name: "hardcoded env assignment",
    regex: /^\s*(?:BDL_API_KEY|ODDS_API_KEY)\s*=\s*(?!your_|<|\$\{)[A-Za-z0-9_-]{20,}\s*$/gm,
  },
  {
    name: "hardcoded JSON or YAML credential",
    regex: /["']?(?:BDL_API_KEY|ODDS_API_KEY)["']?\s*:\s*["'][A-Za-z0-9_-]{20,}["']/g,
  },
  {
    name: "literal Odds API query key",
    regex: /apiKey=[A-Za-z0-9_-]{20,}/g,
  },
];

const findings = [];
for (const file of files) {
  let content;
  try {
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    content = buffer.toString("utf8");
  } catch {
    continue;
  }

  for (const check of checks) {
    check.regex.lastIndex = 0;
    for (const match of content.matchAll(check.regex)) {
      const line = content.slice(0, match.index).split("\n").length;
      findings.push(file + ":" + line + " — " + check.name);
    }
  }
}

if (findings.length > 0) {
  console.error("Se detectaron posibles credenciales hardcodeadas:\n" + findings.join("\n"));
  process.exit(1);
}

console.log("PASS secret-scan — no hay credenciales API literales en archivos rastreados.");

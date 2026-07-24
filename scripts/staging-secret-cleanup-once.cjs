const fs = require("fs");
const { execFileSync } = require("child_process");

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, content) => fs.writeFileSync(file, content, "utf8");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

const marker = ".github/workflows/staging-secret-cleanup-once.yml";
if (!fs.existsSync(marker)) {
  console.log("No one-time cleanup marker found; nothing to do.");
  process.exit(0);
}

// README: safe examples only.
{
  const file = "README.md";
  let text = read(file);
  text = text.replace(/^BDL_API_KEY\s*=\s*[^\r\n]+$/gm, "BDL_API_KEY=your_bdl_api_key");
  text = text.replace(/^ODDS_API_KEY\s*=\s*[^\r\n]+$/gm, "ODDS_API_KEY=your_odds_api_key");
  if (!text.includes("Nunca guardes claves reales en GitHub")) {
    text = text.replace(
      "ODDS_API_KEY=your_odds_api_key\n```",
      "ODDS_API_KEY=your_odds_api_key\n```\n\n> Configura las claves reales solamente en Railway Variables. Nunca guardes claves reales en GitHub.",
    );
  }
  write(file, text);
}

// Source: remove literal fallbacks from both API variables.
{
  const file = "server/routes.ts";
  let text = read(file);
  text = text.replace(
    /process\.env\.(BDL_API_KEY|ODDS_API_KEY)\s*\|\|\s*["'][^"']{16,}["']/g,
    (_match, key) => `process.env.${key}`,
  );

  if (!text.includes("[odds-poll] ODDS_API_KEY no configurada")) {
    text = text.replace(
      /async function pollOddsForSport\(sport: string\) \{\s*try \{/,
      `async function pollOddsForSport(sport: string) {\n    try {\n      if (!ODDS_API_KEY_BG) {\n        console.warn("[odds-poll] ODDS_API_KEY no configurada; consulta omitida.");\n        return 0;\n      }`,
    );
  }

  if (!text.includes("ODDS_API_KEY no configurada en el entorno")) {
    text = text.replace(
      /app\.get\("\/api\/odds\/:sport", async \(req, res\) => \{\s*try \{/,
      `app.get("/api/odds/:sport", async (req, res) => {\n    if (!ODDS_API_KEY) {\n      return res.status(503).json({\n        success: false,\n        error: "ODDS_API_KEY no configurada en el entorno",\n      });\n    }\n    try {`,
    );
  }
  write(file, text);
}

// Startup diagnostics without revealing values.
{
  const file = "server/index.ts";
  let text = read(file);
  if (!text.includes("[config] Variables API faltantes:")) {
    text = text.replace(
      "const httpServer = createServer(app);",
      `const httpServer = createServer(app);\n\nconst missingApiVariables = ["BDL_API_KEY", "ODDS_API_KEY"].filter(\n  (name) => !process.env[name],\n);\nif (missingApiVariables.length > 0) {\n  console.warn(\n    \`[config] Variables API faltantes: \${missingApiVariables.join(", ")}\`,\n  );\n}`,
    );
  }
  write(file, text);
}

write(
  ".gitignore",
  `# Dependencies and builds\nnode_modules/\ndist/\ncoverage/\n.tmp/\n\n# Environment and credentials\n.env\n.env.*\n!.env.example\n*.pem\n*.key\n\n# Runtime data\ndata/picks.json\ndata/*.db\ndata/*.sqlite\ndata/*.sqlite3\n*.db\n*.sqlite\n*.sqlite3\n\n# Logs and OS files\n*.log\nnpm-debug.log*\nyarn-debug.log*\npnpm-debug.log*\n.DS_Store\nThumbs.db\n`,
);

fs.mkdirSync("scripts", { recursive: true });
write(
  "scripts/secret-scan.mjs",
  `import { execFileSync } from "node:child_process";\nimport fs from "node:fs";\n\nconst files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })\n  .split("\\0")\n  .filter(Boolean);\n\nconst checks = [\n  {\n    name: "literal fallback after process.env",\n    regex: /process\\.env\\.(?:BDL_API_KEY|ODDS_API_KEY)\\s*\\|\\|\\s*["'][A-Za-z0-9_-]{16,}["']/g,\n  },\n  {\n    name: "hardcoded env assignment",\n    regex: /^\\s*(?:BDL_API_KEY|ODDS_API_KEY)\\s*=\\s*(?!your_|<|\\$\\{)[A-Za-z0-9_-]{20,}\\s*$/gm,\n  },\n  {\n    name: "hardcoded JSON or YAML credential",\n    regex: /["']?(?:BDL_API_KEY|ODDS_API_KEY)["']?\\s*:\\s*["'][A-Za-z0-9_-]{20,}["']/g,\n  },\n  {\n    name: "literal Odds API query key",\n    regex: /apiKey=[A-Za-z0-9_-]{20,}/g,\n  },\n];\n\nconst findings = [];\nfor (const file of files) {\n  let content;\n  try {\n    const buffer = fs.readFileSync(file);\n    if (buffer.includes(0)) continue;\n    content = buffer.toString("utf8");\n  } catch {\n    continue;\n  }\n\n  for (const check of checks) {\n    check.regex.lastIndex = 0;\n    for (const match of content.matchAll(check.regex)) {\n      const line = content.slice(0, match.index).split("\\n").length;\n      findings.push(file + ":" + line + " — " + check.name);\n    }\n  }\n}\n\nif (findings.length > 0) {\n  console.error("Se detectaron posibles credenciales hardcodeadas:\\n" + findings.join("\\n"));\n  process.exit(1);\n}\n\nconsole.log("PASS secret-scan — no hay credenciales API literales en archivos rastreados.");\n`,
);

// Restore the permanent workflow to read-only permissions and retain the scanner.
write(
  ".github/workflows/staging-mlb-smoke.yml",
  `name: Staging MLB Smoke Tests\n\non:\n  push:\n    branches:\n      - p0-staging\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: staging-mlb-smoke\n  cancel-in-progress: true\n\njobs:\n  smoke:\n    name: Validate Railway p0-staging\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n\n    steps:\n      - name: Checkout p0-staging\n        uses: actions/checkout@v4\n\n      - name: Scan repository for hardcoded API credentials\n        run: node scripts/secret-scan.mjs\n\n      - name: Wait for Railway and run MLB regression suite\n        env:\n          BASE_URL: https://web-p0-staging.up.railway.app\n          EXPECTED_COMMIT: \${{ github.sha }}\n          STARTUP_DELAY_MS: "75000"\n          REQUEST_TIMEOUT_MS: "120000"\n        run: node scripts/staging-smoke.mjs\n`,
);

// Remove temporary automation files before committing.
fs.rmSync(marker, { force: true });
fs.rmSync("scripts/staging-secret-cleanup-once.cjs", { force: true });

// Untrack local runtime state if it was ever committed.
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
for (const file of tracked) {
  if (
    file === "data/picks.json" ||
    /(?:^|\/)data\/.*\.(?:db|sqlite|sqlite3)$/.test(file)
  ) {
    run("git", ["rm", "--cached", "--ignore-unmatch", file]);
  }
}

run("git", ["config", "user.name", "rogelroque940830-bot"]);
run("git", ["config", "user.email", "272644701+rogelroque940830-bot@users.noreply.github.com"]);
run("git", ["add", "-A"]);
run("node", ["scripts/secret-scan.mjs"]);
run("git", ["commit", "-m", "security(staging): remove hardcoded API credentials"]);
run("git", ["push", "origin", "HEAD:p0-staging"]);

console.log("Credential cleanup committed and pushed.");
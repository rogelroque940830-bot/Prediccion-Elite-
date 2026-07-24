const fs = require("fs");
const { execFileSync, spawnSync } = require("child_process");

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, content) => fs.writeFileSync(file, content, "utf8");
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: "inherit", ...options });

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

// Source: remove literal fallbacks from API variables.
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

  const remainingFallbacks = text.match(
    /process\.env\.(BDL_API_KEY|ODDS_API_KEY)\s*\|\|\s*["'][^"']{16,}["']/g,
  );
  if (remainingFallbacks?.length) {
    throw new Error("No se pudieron eliminar todos los fallbacks literales de API.");
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
  [
    "# Dependencies and builds",
    "node_modules/",
    "dist/",
    "coverage/",
    ".tmp/",
    "",
    "# Environment and credentials",
    ".env",
    ".env.*",
    "!.env.example",
    "*.pem",
    "*.key",
    "",
    "# Runtime data",
    "data/picks.json",
    "data/*.db",
    "data/*.sqlite",
    "data/*.sqlite3",
    "*.db",
    "*.sqlite",
    "*.sqlite3",
    "",
    "# Logs and OS files",
    "*.log",
    "npm-debug.log*",
    "yarn-debug.log*",
    "pnpm-debug.log*",
    ".DS_Store",
    "Thumbs.db",
    "",
  ].join("\n"),
);

fs.mkdirSync("scripts", { recursive: true });
write(
  "scripts/secret-scan.mjs",
  [
    'import { execFileSync } from "node:child_process";',
    'import fs from "node:fs";',
    '',
    'const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })',
    '  .split("\\0")',
    '  .filter(Boolean);',
    '',
    'const checks = [',
    '  {',
    '    name: "literal fallback after process.env",',
    '    regex: /process\\.env\\.(?:BDL_API_KEY|ODDS_API_KEY)\\s*\\|\\|\\s*["\'][A-Za-z0-9_-]{16,}["\']/g,',
    '  },',
    '  {',
    '    name: "hardcoded env assignment",',
    '    regex: /^\\s*(?:BDL_API_KEY|ODDS_API_KEY)\\s*=\\s*(?!your_|<|\\$\\{)[A-Za-z0-9_-]{20,}\\s*$/gm,',
    '  },',
    '  {',
    '    name: "hardcoded JSON or YAML credential",',
    '    regex: /["\']?(?:BDL_API_KEY|ODDS_API_KEY)["\']?\\s*:\\s*["\'][A-Za-z0-9_-]{20,}["\']/g,',
    '  },',
    '  {',
    '    name: "literal Odds API query key",',
    '    regex: /apiKey=[A-Za-z0-9_-]{20,}/g,',
    '  },',
    '];',
    '',
    'const findings = [];',
    'for (const file of files) {',
    '  let content;',
    '  try {',
    '    const buffer = fs.readFileSync(file);',
    '    if (buffer.includes(0)) continue;',
    '    content = buffer.toString("utf8");',
    '  } catch {',
    '    continue;',
    '  }',
    '',
    '  for (const check of checks) {',
    '    check.regex.lastIndex = 0;',
    '    for (const match of content.matchAll(check.regex)) {',
    '      const line = content.slice(0, match.index).split("\\n").length;',
    '      findings.push(file + ":" + line + " — " + check.name);',
    '    }',
    '  }',
    '}',
    '',
    'if (findings.length > 0) {',
    '  console.error("Se detectaron posibles credenciales hardcodeadas:\\n" + findings.join("\\n"));',
    '  process.exit(1);',
    '}',
    '',
    'console.log("PASS secret-scan — no hay credenciales API literales en archivos rastreados.");',
    '',
  ].join("\n"),
);

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
run("git", ["add", "README.md", "server/routes.ts", "server/index.ts", ".gitignore", "scripts/secret-scan.mjs"]);
run("node", ["scripts/secret-scan.mjs"]);

const diff = spawnSync("git", ["diff", "--cached", "--quiet"]);
if (diff.status === 0) {
  console.log("Credential cleanup already applied; no commit needed.");
  process.exit(0);
}
if (diff.status !== 1) {
  throw new Error("No se pudo verificar el diff preparado.");
}

run("git", ["commit", "-m", "security(staging): remove hardcoded API credentials"]);
run("git", ["push", "origin", "HEAD:p0-staging"]);
console.log("Credential cleanup committed and pushed.");

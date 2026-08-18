import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const srcRoot = path.join(root, "client", "src");
const errors = [];
const warnings = [];
const standaloneDockerBuild = process.env.COURTEDGE_STANDALONE_DOCKER_BUILD === "true";

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function existsImport(base) {
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.json`, `${base}.css`,
    path.join(base, "index.ts"), path.join(base, "index.tsx"),
    path.join(base, "index.js"), path.join(base, "index.jsx"),
  ];
  return candidates.some((p) => fs.existsSync(p) && fs.statSync(p).isFile());
}

function isNodeTestSource(file) {
  return /\.(?:test|spec)\.(?:ts|tsx)$/.test(file);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
]);

if (lock.name !== pkg.name || lock.version !== pkg.version) {
  errors.push("package-lock.json no coincide con name/version de package.json");
}
const lockRoot = lock.packages?.[""] ?? {};
function sameRecord(a = {}, b = {}) {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (!sameRecord(pkg[group] ?? {}, lockRoot[group] ?? {})) {
    errors.push(`package-lock packages[""].${group} no coincide con package.json`);
  }
}

const requiredFiles = [
  ".env.example",
  ".env.staging.example",
  ".env.production.example",
  "DEPLOYMENT_CHECKLIST.md",
  "SOURCE_PROVENANCE.md",
  "vite.config.ts",
  "client/src/vite-env.d.ts",
];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`Falta archivo requerido: ${file}`);
}

const workflowCandidates = [
  path.join(root, ".github", "workflows", "ci.yml"),
  path.join(root, "..", ".github", "workflows", "integration-p0-frontend.yml"),
];
if (!workflowCandidates.some((file) => fs.existsSync(file))) {
  if (standaloneDockerBuild) {
    warnings.push("La comprobación del workflow CI se delega al repositorio raíz durante el build Docker aislado");
  } else {
    errors.push("No se encontró un workflow de CI válido para el frontend");
  }
}

const sourceFiles = walk(srcRoot).filter((f) => /\.(ts|tsx|css)$/.test(f));
const testFiles = sourceFiles.filter((f) => isNodeTestSource(f));
// Browser dependency verification must inspect only runtime sources. Node test files are
// intentionally kept under client/src for colocated tests but are excluded from tsconfig/build.
const codeFiles = sourceFiles.filter((f) => /\.(ts|tsx)$/.test(f) && !isNodeTestSource(f));
const externalImports = new Set();
const endpoints = new Set();
const forbiddenBackendPatterns = [
  /https?:\/\/[^\s"'`]*\.up\.railway\.app/gi,
  /https?:\/\/[^\s"'`]*pplx\.app/gi,
  /web-production-[a-z0-9-]+/gi,
  /perplexity/gi,
];

for (const file of codeFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of forbiddenBackendPatterns) {
    const matches = text.match(pattern);
    if (matches?.length) errors.push(`${rel(file)} contiene referencia prohibida: ${matches[0]}`);
  }

  const importRegex = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g;
  for (const match of text.matchAll(importRegex)) {
    const spec = match[1];
    if (spec.startsWith("@/")) {
      const target = path.join(srcRoot, spec.slice(2));
      if (!existsImport(target)) errors.push(`${rel(file)} importa local inexistente: ${spec}`);
    } else if (spec.startsWith(".")) {
      const target = path.resolve(path.dirname(file), spec);
      if (!existsImport(target)) errors.push(`${rel(file)} importa local inexistente: ${spec}`);
    } else {
      const packageName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      externalImports.add(packageName);
      if (!declared.has(packageName)) errors.push(`${rel(file)} usa dependencia no declarada: ${packageName}`);
    }
    if (spec.includes("/server/") || spec.startsWith("server/") || spec.includes("/shared/") || spec.startsWith("shared/")) {
      errors.push(`${rel(file)} conserva acoplamiento prohibido al backend: ${spec}`);
    }
  }

  for (const match of text.matchAll(/\/api\/[a-zA-Z0-9_\-/:.?=&${}()]+/g)) {
    endpoints.add(match[0]);
  }

  const rawApiFetch = /fetch\(\s*["'`]\/api\//g.test(text);
  if (rawApiFetch) warnings.push(`${rel(file)} usa fetch('/api/...') directamente; revisar same-origin intencional`);
}

const indexHtml = fs.readFileSync(path.join(root, "client", "index.html"), "utf8");
for (const pattern of forbiddenBackendPatterns) {
  const matches = indexHtml.match(pattern);
  if (matches?.length) errors.push(`client/index.html contiene referencia prohibida: ${matches[0]}`);
}

const queryClient = fs.readFileSync(path.join(srcRoot, "lib", "queryClient.ts"), "utf8");
if (!queryClient.includes("VITE_API_BASE_URL")) errors.push("queryClient.ts no usa VITE_API_BASE_URL");
if (!queryClient.includes("replace(/\\/+$/, \"\")")) warnings.push("queryClient.ts podría no normalizar la barra final del API base");
if (!queryClient.includes('credentials: "include"')) errors.push("queryClient.ts no incluye cookies de sesión en las solicitudes");
if (!queryClient.includes("X-CourtEdge-CSRF")) errors.push("queryClient.ts no aplica el encabezado CSRF a las escrituras");

const picksApi = fs.readFileSync(path.join(srcRoot, "lib", "picks-api.ts"), "utf8");
if (!picksApi.includes("/api/picks/v2")) {
  errors.push("picks-api.ts no contiene el endpoint /api/picks/v2");
}
if (!picksApi.includes("URLSearchParams") || !picksApi.includes("minConfidence")) {
  errors.push("picks-api.ts no conserva los filtros de consulta del API v2");
}
if (picksApi.includes('apiUrl("/api/picks")')) errors.push("picks-api.ts apunta al store legacy en vez de /api/picks/v2");

const contextSource = fs.readFileSync(path.join(srcRoot, "lib", "context.tsx"), "utf8");
if (contextSource.includes("/api/picks/sync")) errors.push("context.tsx conserva la sincronización legacy de estado completo");
if (contextSource.includes('`${API_BASE}/api/picks`')) errors.push("context.tsx conserva lecturas del store legacy");

const summary = {
  sourceFiles: sourceFiles.length,
  codeFiles: codeFiles.length,
  nodeTestFilesExcluded: testFiles.length,
  externalPackagesUsed: externalImports.size,
  endpointReferences: endpoints.size,
  warnings: warnings.length,
  errors: errors.length,
};

console.log("Court Edge frontend static verification");
console.log(JSON.stringify(summary, null, 2));
if (warnings.length) {
  console.log("\nWarnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}
if (errors.length) {
  console.error("\nErrors:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log("\nPASS: frontend separado, sesión protegida, picks v2 canónicos y sin URL backend fija.");

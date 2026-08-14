import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require("typescript");
} catch {
  const globalTs = process.env.GLOBAL_TYPESCRIPT_PATH;
  if (!globalTs) {
    console.error("TypeScript no está instalado. Ejecute npm ci o defina GLOBAL_TYPESCRIPT_PATH.");
    process.exit(2);
  }
  ts = require(globalTs);
}

const root = process.cwd();
const srcRoot = path.join(root, "client", "src");
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
}
walk(srcRoot);

let errors = 0;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      isolatedModules: true,
    },
  });
  for (const diagnostic of result.diagnostics ?? []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    errors += 1;
    const pos = diagnostic.file && diagnostic.start != null
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
    const where = pos ? `${path.relative(root, file)}:${pos.line + 1}:${pos.character + 1}` : path.relative(root, file);
    console.error(`${where} - ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
}

if (errors) {
  console.error(`FAIL: ${errors} errores sintácticos.`);
  process.exit(1);
}
console.log(`PASS: ${files.length} archivos TypeScript/TSX transpilados sin errores sintácticos.`);

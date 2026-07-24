import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

const root = process.cwd();
const dist = path.join(root, "dist");
const errors = [];
const warnings = [];
const budget = { js: 1_600_000, css: 180_000, total: 2_400_000 };

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

if (!fs.existsSync(dist)) {
  console.error("FAIL: dist/ does not exist; run npm run build first");
  process.exit(2);
}

const index = path.join(dist, "index.html");
if (!fs.existsSync(index)) errors.push("dist/index.html missing");
const files = walk(dist);
const rows = files
  .map((file) => ({
    file: path.relative(dist, file).replaceAll(path.sep, "/"),
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  }))
  .sort((a, b) => b.bytes - a.bytes);
const js = rows.filter((row) => row.file.endsWith(".js")).reduce((sum, row) => sum + row.bytes, 0);
const css = rows.filter((row) => row.file.endsWith(".css")).reduce((sum, row) => sum + row.bytes, 0);
const total = rows.reduce((sum, row) => sum + row.bytes, 0);
if (js > budget.js) errors.push(`JS budget exceeded: ${js} > ${budget.js}`);
if (css > budget.css) errors.push(`CSS budget exceeded: ${css} > ${budget.css}`);
if (total > budget.total) errors.push(`total budget exceeded: ${total} > ${budget.total}`);

if (fs.existsSync(index)) {
  const html = fs.readFileSync(index, "utf8");
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const ref = match[1];
    if (/^(https?:|data:|#)/.test(ref)) continue;
    const clean = ref.replace(/^\.\//, "").replace(/^\//, "");
    if (!fs.existsSync(path.join(dist, clean))) errors.push(`missing referenced asset: ${ref}`);
  }
}

for (const row of rows.filter((item) => /\.(js|css|html)$/.test(item.file))) {
  const text = fs.readFileSync(path.join(dist, row.file), "utf8");
  if (text.includes("YOUR-STAGING-BACKEND") || text.includes("YOUR-PRODUCTION-BACKEND")) {
    errors.push(`${row.file} contains placeholder API domain`);
  }
  if (text.includes("pplx.app")) errors.push(`${row.file} retains pplx.app reference`);
}

console.log(JSON.stringify({
  files: rows.length,
  assets: rows.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
  bytes: { js, css, total },
  budget,
  warnings,
  errors,
}, null, 2));
if (errors.length) process.exit(1);
console.log("PASS: static distribution integrity and bundle budgets verified.");

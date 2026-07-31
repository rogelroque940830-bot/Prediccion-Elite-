import fs from "node:fs";

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function write(file, content) {
  fs.writeFileSync(file, content, "utf8");
}

function replaceOnce(content, from, to, label) {
  const first = content.indexOf(from);
  const last = content.lastIndexOf(from);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one source sentinel, found ${first < 0 ? 0 : "multiple"}`);
  }
  return `${content.slice(0, first)}${to}${content.slice(first + from.length)}`;
}

function patchWnbaModel() {
  const file = "frontend/client/src/lib/wnba-model.ts";
  let content = read(file);
  const importLine = `import {\n  captureWnbaModelProbability,\n  captureWnbaModelTotal,\n  captureWnbaPickQuality,\n  completeWnbaEvaluationCapture,\n} from "./wnba-shadow-emission";\n\n`;
  if (!content.includes('from "./wnba-shadow-emission"')) content = `${importLine}${content}`;

  content = replaceOnce(
    content,
    `  return prob;\n}\n\nexport function predictWNBATotal`,
    `  captureWnbaModelProbability({\n    home,\n    away,\n    marketImpliedHomeProbability: marketImpliedHomeProb,\n    homeProbability: prob,\n  });\n  return prob;\n}\n\nexport function predictWNBATotal`,
    "predictWNBA emission",
  );

  content = replaceOnce(
    content,
    `  return Math.round(total * 10) / 10;\n}\n\nexport function wnbaEvaluateSpread`,
    `  const estimatedTotal = Math.round(total * 10) / 10;\n  captureWnbaModelTotal({ estimatedTotal });\n  return estimatedTotal;\n}\n\nexport function wnbaEvaluateSpread`,
    "predictWNBATotal emission",
  );

  const qualityStart = content.indexOf("export function wnbaPickQuality(");
  const qualityEnd = content.indexOf("export interface WNBABestPlay", qualityStart);
  if (qualityStart < 0 || qualityEnd < 0) throw new Error("wnbaPickQuality block not found");
  let qualityBlock = content.slice(qualityStart, qualityEnd);
  const returnStart = qualityBlock.lastIndexOf("  return {");
  const returnEndMarker = "\n  };\n}";
  const returnEnd = qualityBlock.indexOf(returnEndMarker, returnStart);
  if (returnStart < 0 || returnEnd < 0) throw new Error("wnbaPickQuality return object not found");
  const objectLiteral = qualityBlock.slice(
    returnStart + "  return ".length,
    returnEnd + "\n  };".length,
  );
  const instrumentedReturn = `  const result: WNBAPickQuality = ${objectLiteral}\n  captureWnbaPickQuality(result);\n  return result;`;
  qualityBlock = `${qualityBlock.slice(0, returnStart)}${instrumentedReturn}${qualityBlock.slice(returnEnd + "\n  };".length)}`;
  content = `${content.slice(0, qualityStart)}${qualityBlock}${content.slice(qualityEnd)}`;

  const bestStart = content.indexOf("export function wnbaGetBestPlay(");
  const teamsStart = content.indexOf("export const WNBA_TEAMS", bestStart);
  if (bestStart < 0 || teamsStart < 0) throw new Error("wnbaGetBestPlay block not found");
  const bestFunction = `export function wnbaGetBestPlay(plays: WNBABestPlay[]): WNBABestPlay | null {\n  const valid = plays.filter(p => p.signal !== "PASS");\n  if (valid.length === 0) {\n    completeWnbaEvaluationCapture(plays, null);\n    return null;\n  }\n  valid.sort((a, b) => {\n    const sA = a.signal === "BET" ? 3 : 1;\n    const sB = b.signal === "BET" ? 3 : 1;\n    if (sA !== sB) return sB - sA;\n    return b.confidence - a.confidence;\n  });\n  const bestPlay = valid[0];\n  completeWnbaEvaluationCapture(plays, bestPlay);\n  return bestPlay;\n}\n\n`;
  content = `${content.slice(0, bestStart)}${bestFunction}${content.slice(teamsStart)}`;
  write(file, content);
}

function patchSecurity() {
  const file = "server/security.ts";
  let content = read(file);
  const line = `  /^\\/api\\/wnba\\/predictor-shadow(?:\\/|$)/,\n`;
  const protectedBlockStart = content.indexOf("const PROTECTED_WRITE_PATHS = [");
  const protectedBlockEnd = content.indexOf("];", protectedBlockStart);
  if (protectedBlockStart < 0 || protectedBlockEnd < 0) throw new Error("protected write block not found");
  const block = content.slice(protectedBlockStart, protectedBlockEnd);
  if (!block.includes("wnba\\/predictor-shadow")) {
    content = replaceOnce(
      content,
      `  /^\\/api\\/mlb\\/ledger(?:\\/|$)/,\n  /^\\/api\\/auth\\/users`,
      `  /^\\/api\\/mlb\\/ledger(?:\\/|$)/,\n${line}  /^\\/api\\/auth\\/users`,
      "S6E protected write path",
    );
  }
  write(file, content);
}

function patchPackage() {
  const file = "package.json";
  const parsed = JSON.parse(read(file));
  const scripts = parsed.scripts;
  scripts["build:backend"] = scripts["build:backend"].replace("server/s6d-staging-entry.ts", "server/s6e-staging-entry.ts");
  scripts.dev = scripts.dev.replace("server/s6d-staging-entry.ts", "server/s6e-staging-entry.ts");
  const s6eTests = "server/wnba-s6e-evaluation-emission-service.test.ts server/wnba-s6e-security.test.ts";
  if (!scripts["test:s5b-shadow"].includes("wnba-s6e-evaluation-emission")) {
    scripts["test:s5b-shadow"] = `${scripts["test:s5b-shadow"]} ${s6eTests}`;
  }
  scripts["typecheck:s6e-wnba"] = "tsc -p tsconfig.s6e-wnba.json";
  scripts["test:s6e-wnba"] = `tsx --test ${s6eTests}`;
  scripts["check:s6e-frontend"] = "npm --prefix frontend run check";
  write(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

function patchS5bTsconfig() {
  const file = "tsconfig.s5b-shadow.json";
  const parsed = JSON.parse(read(file));
  for (const item of [
    "server/wnba-s6e-evaluation-emission-service.ts",
    "server/wnba-s6e-evaluation-emission-routes.ts",
    "server/wnba-s6e-evaluation-emission-service.test.ts",
    "server/wnba-s6e-security.test.ts",
  ]) {
    if (!parsed.include.includes(item)) parsed.include.push(item);
  }
  write(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

function patchRouteContract() {
  const file = "server/route-contract.extensions.json";
  const parsed = JSON.parse(read(file));
  for (const route of [
    { method: "GET", path: "/api/wnba/predictor-shadow/v1/emission/status", registrations: 1 },
    { method: "GET", path: "/api/wnba/predictor-shadow/v1/emission/evaluations", registrations: 1 },
    { method: "GET", path: "/api/wnba/predictor-shadow/v1/emission/outputs", registrations: 1 },
    { method: "POST", path: "/api/wnba/predictor-shadow/v1/evaluations", registrations: 1 },
  ]) {
    if (!parsed.some((existing) => existing.method === route.method && existing.path === route.path)) parsed.push(route);
  }
  parsed.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  write(file, `${JSON.stringify(parsed, null, 2)}\n`);
}

function patchGitignore() {
  const file = ".gitignore";
  let content = read(file);
  if (!content.includes("data/wnba-evaluation-emission-v1/")) {
    content = content.replace("data/wnba-predictor-shadow-v1/\n", "data/wnba-predictor-shadow-v1/\ndata/wnba-evaluation-emission-v1/\n");
  }
  write(file, content);
}

patchWnbaModel();
patchSecurity();
patchPackage();
patchS5bTsconfig();
patchRouteContract();
patchGitignore();
console.log("S6E deterministic source patches applied");

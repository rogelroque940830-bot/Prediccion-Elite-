#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { auditMlbMarketIntegrity, renderAuditMarkdown } from "./lib/s6h-market-integrity-audit.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(`[s6h-audit] ${message}`);
  process.exitCode = 1;
}

const input = argument("--input");
const jsonOutput = argument("--json", "artifacts/s6h-phase1-market-integrity.json");
const markdownOutput = argument("--markdown", "artifacts/s6h-phase1-market-integrity.md");
const tolerancePp = Number(argument("--tolerance-pp", "0.75"));
const edgeOutlierPp = Number(argument("--edge-outlier-pp", "15"));

if (!input) {
  fail("Missing --input <ledger-history.json>.");
} else {
  try {
    const payload = JSON.parse(fs.readFileSync(input, "utf8"));
    const report = auditMlbMarketIntegrity(payload, { tolerancePp, edgeOutlierPp });
    fs.mkdirSync(path.dirname(jsonOutput), { recursive: true });
    fs.mkdirSync(path.dirname(markdownOutput), { recursive: true });
    fs.writeFileSync(jsonOutput, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(markdownOutput, `${renderAuditMarkdown(report)}\n`, "utf8");
    console.log(JSON.stringify({
      schemaVersion: report.schemaVersion,
      input,
      jsonOutput,
      markdownOutput,
      summary: report.summary,
    }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

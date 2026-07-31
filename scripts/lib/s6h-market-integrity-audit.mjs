const DEFAULT_TOLERANCE_PP = 0.75;
const DEFAULT_EDGE_OUTLIER_PP = 15;

function text(value) {
  return String(value ?? "").trim();
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finite(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function probabilityPct(value) {
  const parsed = finite(value);
  if (parsed == null) return null;
  return Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
}

function extractPicks(payload) {
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.data?.picks,
    payload?.data?.records,
    payload?.picks,
    payload?.records,
    payload?.data,
  ];
  return candidates.find(Array.isArray) ?? [];
}

function normalizeRecord(raw, index) {
  const prediction = raw?.prediction ?? raw?.record?.prediction ?? raw;
  const market = prediction?.market ?? raw?.market ?? {};
  const probabilities = prediction?.probabilities ?? raw?.probabilities ?? {};
  const game = prediction?.game ?? raw?.game ?? {};
  const analysis = prediction?.analysis ?? raw?.analysis ?? {};

  return {
    sourceIndex: index,
    id: text(raw?.id ?? prediction?.id ?? prediction?.predictionId ?? `row-${index + 1}`),
    gamePk: firstFinite(raw?.gamePk, game?.gamePk),
    gameDate: text(raw?.gameDate ?? game?.gameDate),
    awayTeam: text(raw?.awayTeam ?? game?.awayTeam),
    homeTeam: text(raw?.homeTeam ?? game?.homeTeam),
    marketType: text(raw?.marketType ?? raw?.marketLabel ?? market?.type).toUpperCase(),
    selection: text(raw?.selection ?? market?.selection),
    line: firstFinite(raw?.line, market?.line),
    oddsAmerican: firstFinite(raw?.oddsAmerican, market?.oddsAmerican),
    book: text(raw?.book ?? market?.book) || null,
    capturedAt: text(raw?.priceCapturedAt ?? raw?.capturedAt ?? market?.capturedAt) || null,
    modelProbabilityPct: probabilityPct(
      raw?.modelProbabilityPct
      ?? raw?.modelProbability
      ?? probabilities?.model,
    ),
    storedImpliedProbabilityPct: probabilityPct(
      raw?.marketImpliedProbabilityPct
      ?? raw?.marketImpliedProbability
      ?? probabilities?.marketImplied,
    ),
    storedEdgePp: firstFinite(raw?.edgePp, probabilities?.edgePp),
    signal: text(raw?.signal ?? prediction?.decision?.signal),
    analysisStage: text(raw?.analysisStage ?? analysis?.stage),
    raw,
  };
}

export function americanOddsAreStandard(odds) {
  return Number.isFinite(odds) && (odds <= -100 || odds >= 100) && Math.abs(odds) <= 10_000;
}

export function americanToImpliedPctForensic(odds) {
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds < 0
    ? (Math.abs(odds) / (Math.abs(odds) + 100)) * 100
    : (100 / (odds + 100)) * 100;
}

function normalizedMarket(value) {
  return text(value).toUpperCase().replace(/[\s-]+/g, "_");
}

function isTotalMarket(value) {
  const market = normalizedMarket(value);
  return market.includes("TOTAL") || market.includes("O/U") || market.includes("OU");
}

function isMoneylineMarket(value) {
  const market = normalizedMarket(value);
  return market.includes("ML") || market.includes("MONEYLINE");
}

function selectionDirection(value) {
  const selection = text(value).toUpperCase();
  if (/^OVER(?:\s|$)/.test(selection)) return "OVER";
  if (/^UNDER(?:\s|$)/.test(selection)) return "UNDER";
  return "TEAM";
}

function halfPointIncrement(line) {
  return Number.isFinite(line) && Math.abs(line * 2 - Math.round(line * 2)) < 1e-8;
}

function issue(code, severity, detail) {
  return { code, severity, detail };
}

export function auditNormalizedPick(pick, options = {}) {
  const tolerancePp = finite(options.tolerancePp) ?? DEFAULT_TOLERANCE_PP;
  const edgeOutlierPp = finite(options.edgeOutlierPp) ?? DEFAULT_EDGE_OUTLIER_PP;
  const issues = [];
  const odds = pick.oddsAmerican;
  const formulaImpliedPct = americanToImpliedPctForensic(odds);

  if (odds == null) {
    issues.push(issue("MISSING_ODDS", "REJECT", "No American price is present."));
  } else if (!americanOddsAreStandard(odds)) {
    issues.push(issue(
      "INVALID_AMERICAN_ODDS",
      "REJECT",
      `American odds ${odds} are outside the standard domain (<= -100 or >= +100).`,
    ));
  }

  if (pick.modelProbabilityPct == null || pick.modelProbabilityPct <= 0 || pick.modelProbabilityPct >= 100) {
    issues.push(issue("INVALID_MODEL_PROBABILITY", "REJECT", "Model probability is missing or outside (0, 100)."));
  }

  let impliedDeltaPp = null;
  if (formulaImpliedPct != null && pick.storedImpliedProbabilityPct != null) {
    impliedDeltaPp = pick.storedImpliedProbabilityPct - formulaImpliedPct;
    if (Math.abs(impliedDeltaPp) > tolerancePp) {
      issues.push(issue(
        "IMPLIED_PROBABILITY_MISMATCH",
        "REJECT",
        `Stored ${pick.storedImpliedProbabilityPct.toFixed(3)}% vs formula ${formulaImpliedPct.toFixed(3)}% (delta ${impliedDeltaPp.toFixed(3)} pp).`,
      ));
    }
  } else if (pick.storedImpliedProbabilityPct == null) {
    issues.push(issue("MISSING_IMPLIED_PROBABILITY", "REVIEW", "Stored market-implied probability is absent."));
  }

  const recomputedEdgePp = pick.modelProbabilityPct != null && formulaImpliedPct != null
    ? pick.modelProbabilityPct - formulaImpliedPct
    : null;
  let edgeDeltaPp = null;
  if (recomputedEdgePp != null && pick.storedEdgePp != null) {
    edgeDeltaPp = pick.storedEdgePp - recomputedEdgePp;
    if (Math.abs(edgeDeltaPp) > tolerancePp) {
      issues.push(issue(
        "EDGE_ARITHMETIC_MISMATCH",
        "REJECT",
        `Stored ${pick.storedEdgePp.toFixed(3)} pp vs recomputed ${recomputedEdgePp.toFixed(3)} pp (delta ${edgeDeltaPp.toFixed(3)} pp).`,
      ));
    }
  } else if (pick.storedEdgePp == null) {
    issues.push(issue("MISSING_EDGE", "REVIEW", "Stored edge is absent."));
  }

  if (recomputedEdgePp != null && recomputedEdgePp > edgeOutlierPp) {
    issues.push(issue(
      "EDGE_OUTLIER",
      "REVIEW",
      `Recomputed edge ${recomputedEdgePp.toFixed(3)} pp exceeds the audit threshold ${edgeOutlierPp} pp.`,
    ));
  }

  const direction = selectionDirection(pick.selection);
  if (isTotalMarket(pick.marketType)) {
    if (direction === "TEAM") {
      issues.push(issue("MARKET_SELECTION_MISMATCH", "REJECT", "A total market must select OVER or UNDER."));
    }
    if (pick.line == null) {
      issues.push(issue("MISSING_TOTAL_LINE", "REJECT", "A total market must include a ticket line."));
    } else if (!halfPointIncrement(pick.line)) {
      issues.push(issue(
        "NON_STANDARD_LINE_INCREMENT",
        "REVIEW",
        `Total line ${pick.line} is not on a whole/half-run increment and requires source verification.`,
      ));
    }
  }

  if (isMoneylineMarket(pick.marketType) && direction !== "TEAM") {
    issues.push(issue("MARKET_SELECTION_MISMATCH", "REJECT", "A moneyline market cannot select OVER or UNDER."));
  }

  if (!pick.book) {
    issues.push(issue("MISSING_BOOK", "REVIEW", "Price source/book is not identified."));
  }
  if (!pick.capturedAt) {
    issues.push(issue("MISSING_PRICE_CAPTURE_TIME", "REVIEW", "Price capture timestamp is not identified."));
  }

  const classification = issues.some((entry) => entry.severity === "REJECT")
    ? "REJECT"
    : issues.some((entry) => entry.severity === "REVIEW")
      ? "REVIEW"
      : "PASS";

  return {
    ...pick,
    formulaImpliedPct,
    impliedDeltaPp,
    recomputedEdgePp,
    edgeDeltaPp,
    classification,
    issues,
  };
}

export function auditMlbMarketIntegrity(payload, options = {}) {
  const normalized = extractPicks(payload).map(normalizeRecord);
  const records = normalized.map((pick) => auditNormalizedPick(pick, options));
  const counts = { PASS: 0, REVIEW: 0, REJECT: 0 };
  const issueCounts = {};
  for (const record of records) {
    counts[record.classification] += 1;
    for (const entry of record.issues) issueCounts[entry.code] = (issueCounts[entry.code] ?? 0) + 1;
  }
  return {
    schemaVersion: "s6h-market-integrity-audit.v1",
    generatedAt: new Date().toISOString(),
    policy: {
      tolerancePp: finite(options.tolerancePp) ?? DEFAULT_TOLERANCE_PP,
      edgeOutlierPp: finite(options.edgeOutlierPp) ?? DEFAULT_EDGE_OUTLIER_PP,
      readOnly: true,
    },
    summary: {
      total: records.length,
      ...counts,
      issueCounts,
    },
    records,
  };
}

function markdownNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "—";
}

export function renderAuditMarkdown(report) {
  const lines = [
    "# S6H Phase 1 — MLB Market Integrity Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `- Total records: **${report.summary.total}**`,
    `- PASS: **${report.summary.PASS}**`,
    `- REVIEW: **${report.summary.REVIEW}**`,
    `- REJECT: **${report.summary.REJECT}**`,
    "",
    "## Records",
    "",
    "| Class | Game | Market | Selection | Line | Odds | Model | Implied formula | Stored edge | Recomputed edge | Issues |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const record of report.records) {
    const game = [record.awayTeam, record.homeTeam].filter(Boolean).join(" @ ") || record.id;
    const issues = record.issues.map((entry) => entry.code).join(", ") || "—";
    lines.push(`| ${record.classification} | ${game} | ${record.marketType || "—"} | ${record.selection || "—"} | ${markdownNumber(record.line, 1)} | ${markdownNumber(record.oddsAmerican, 0)} | ${markdownNumber(record.modelProbabilityPct)}% | ${markdownNumber(record.formulaImpliedPct)}% | ${markdownNumber(record.storedEdgePp)} pp | ${markdownNumber(record.recomputedEdgePp)} pp | ${issues} |`);
  }
  lines.push("", "## Issue counts", "");
  for (const [code, count] of Object.entries(report.summary.issueCounts).sort()) {
    lines.push(`- \`${code}\`: ${count}`);
  }
  lines.push(
    "",
    "## Safety boundary",
    "",
    "This report is read-only. It does not alter the ledger, settlements, predictor formulas, thresholds, workers, Railway configuration, or persistent volume.",
    "",
  );
  return lines.join("\n");
}

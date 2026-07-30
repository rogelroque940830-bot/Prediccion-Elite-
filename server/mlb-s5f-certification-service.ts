import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import {
  buildMlbShadowEvaluation,
  type MlbShadowEvaluation,
} from "./mlb-shadow-evaluation";
import type {
  MlbS5dGateMonitorEnvelope,
  MlbS5dGateMonitorService,
} from "./mlb-s5d-gate-monitor";
import type {
  MlbS5eAudit,
  MlbS5eConsensusObservation,
  MlbS5eCoverageService,
} from "./mlb-s5e-coverage-service";
import { terminalMlbLedgerRecords } from "./mlb-terminal-ledger-records";

export const MLB_S5F_CERTIFICATION_VERSION = "mlb-s5f-certification.v1" as const;

type S5fOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  deploymentCommit?: string;
  environment?: string;
  now?: () => Date;
};

type S5eEvidenceReader = Pick<MlbS5eCoverageService, "readLatest" | "readObservations" | "status">;
type S5dEvidenceReader = Pick<MlbS5dGateMonitorService, "readLatest" | "status">;

export type S5fAlertSeverity = "INFO" | "WARNING" | "CRITICAL";
export type S5fAlertCode =
  | "FINAL_PENDING_LINEUPS"
  | "FINAL_MISSED_AFTER_START"
  | "CLOSING_PENDING_WINDOW"
  | "CLOSING_DUE_INSIDE_WINDOW"
  | "CLOSING_MISSED_AFTER_START"
  | "CLOSING_SOURCE_SET_CHANGED"
  | "CLOSING_LINE_MOVED"
  | "CLOSING_NO_PRICE"
  | "SETTLEMENT_PENDING"
  | "SETTLEMENT_OVERDUE"
  | "CHAIN_PARENT_MISSING"
  | "CHAIN_CYCLE"
  | "S5E_ODDS_MATCH_ERROR"
  | "S5E_SERVICE_ERROR";

export type S5fQualityAlert = {
  alertId: string;
  code: S5fAlertCode;
  severity: S5fAlertSeverity;
  actionable: boolean;
  predictionId: string | null;
  gamePk: number | null;
  gameDate: string | null;
  message: string;
};

export type S5fChainStage = {
  predictionId: string;
  supersedesId: string | null;
  recordedAt: string;
  analysisStage: string;
  modelCommit: string | null;
  lineupCounts: { home: number; away: number } | null;
  oddsAmerican: number;
  line: number | null;
  book: string | null;
  capturedAt: string | null;
};

export type S5fCertificationRow = {
  terminalPredictionId: string;
  chain: {
    length: number;
    stages: S5fChainStage[];
    parentMissing: string | null;
    cycleDetected: boolean;
  };
  game: {
    gamePk: number | null;
    gameDate: string;
    commenceTime: string | null;
    homeTeam: string;
    awayTeam: string;
  };
  market: {
    type: string;
    selection: string;
    line: number | null;
    signal: string;
    confidenceLabel: string | null;
    modelProbability: number;
  };
  originOpening: {
    predictionId: string;
    oddsAmerican: number;
    line: number | null;
    book: string | null;
    capturedAt: string | null;
  };
  analyticalOpening: {
    predictionId: string;
    oddsAmerican: number;
    line: number | null;
    book: string | null;
    capturedAt: string | null;
  };
  finalization: {
    state: "FINAL_CAPTURED" | "PROVISIONAL_PENDING" | "FINAL_MISSED_AFTER_START";
    lineupCounts: { home: number; away: number } | null;
  };
  closing: {
    state:
      | "COMPARABLE_CAPTURED"
      | "SOURCE_SET_CHANGED"
      | "LINE_MOVED"
      | "NO_PRICE"
      | "PENDING_OUTSIDE_WINDOW"
      | "DUE_INSIDE_WINDOW"
      | "MISSED_AFTER_START";
    observation: MlbS5eConsensusObservation | null;
    clvPp: number | null;
  };
  settlement: {
    state: "SETTLED" | "PENDING_NATURAL" | "OVERDUE";
    result: string | null;
    settledAt: string | null;
    source: string | null;
    closingOddsAmerican: number | null;
    closingLine: number | null;
    clvPp: number | null;
  };
  readiness: "READY" | "PENDING" | "ACTION_REQUIRED";
  alertCodes: S5fAlertCode[];
};

export type S5fReviewPackage = {
  schemaVersion: typeof MLB_S5F_CERTIFICATION_VERSION;
  generatedAt: string;
  partial: boolean;
  gate: MlbShadowEvaluation["decisionGate"];
  summary: MlbShadowEvaluation["summary"];
  breakdowns: MlbShadowEvaluation["breakdowns"];
  dataQuality: MlbShadowEvaluation["dataQuality"];
  deduplication: MlbShadowEvaluation["deduplication"];
  evidenceReadiness: {
    terminalPredictions: number;
    ready: number;
    pending: number;
    actionRequired: number;
    finalCaptured: number;
    comparableClosing: number;
    settled: number;
    actionableAlerts: number;
  };
  s5dConsistency: {
    latestEvaluatedAt: string | null;
    latestSemanticDigest: string | null;
    gateStatusMatches: boolean | null;
  };
  humanReview: {
    required: boolean;
    status: string;
    automaticPromotion: false;
    promotionAuthorized: false;
  };
  warnings: string[];
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    automaticPromotion: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type S5fEnvelope = {
  schemaVersion: typeof MLB_S5F_CERTIFICATION_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  semanticDigest: string;
  changed: boolean;
  snapshotCreated: boolean;
  source: {
    ledgerSchemaVersion: string;
    immutable: boolean;
    predictions: number;
    terminalPredictions: number;
    supersededPredictions: number;
    s5dEvaluatedAt: string | null;
    s5eAuditedAt: string | null;
    s5eObservationCount: number;
  };
  dashboard: {
    rows: S5fCertificationRow[];
    counts: {
      ready: number;
      pending: number;
      actionRequired: number;
      finalCaptured: number;
      comparableClosing: number;
      settled: number;
    };
  };
  reviewPackage: S5fReviewPackage;
  alerts: S5fQualityAlert[];
  safety: S5fReviewPackage["safety"];
};

export type S5fStatus = {
  schemaVersion: typeof MLB_S5F_CERTIFICATION_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  snapshots: number;
  latest: S5fEnvelope | null;
};

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S5F_CERTIFICATION?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S5F_CERTIFICATION_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s5f-certification");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function jsonFileCount(directory: string): number {
  try {
    return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function capturedAt(record: LedgerRecord): string | null {
  const payload = record.prediction.payload as any;
  const raw = payload?.market?.capturedAt
    ?? payload?.analysis?.sources?.[0]?.fetchedAt
    ?? record.prediction.recordedAt;
  const parsed = Date.parse(String(raw ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function lineupCounts(record: LedgerRecord): { home: number; away: number } | null {
  const payload = record.prediction.payload as any;
  const raw = payload?.analysis?.layers?.s5c?.lineupCounts
    ?? payload?.analysis?.rawInputs?.game?.lineupCounts;
  const home = Number(raw?.home);
  const away = Number(raw?.away);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home: Math.max(0, Math.trunc(home)), away: Math.max(0, Math.trunc(away)) };
}

function stableAlertId(code: S5fAlertCode, predictionId: string | null, message: string): string {
  return `s5f-alert-${digest({ code, predictionId, message }).slice(0, 32)}`;
}

function alert(
  code: S5fAlertCode,
  severity: S5fAlertSeverity,
  actionable: boolean,
  record: LedgerRecord | null,
  message: string,
): S5fQualityAlert {
  return {
    alertId: stableAlertId(code, record?.prediction.id ?? null, message),
    code,
    severity,
    actionable,
    predictionId: record?.prediction.id ?? null,
    gamePk: record?.prediction.game.gamePk ?? null,
    gameDate: record?.prediction.game.gameDate ?? null,
    message,
  };
}

function latestObservationByPrediction(
  observations: S5eConsensusObservation[],
): Map<string, S5eConsensusObservation> {
  const latest = new Map<string, S5eConsensusObservation>();
  for (const observation of observations) {
    const previous = latest.get(observation.predictionId);
    if (!previous || previous.capturedAt.localeCompare(observation.capturedAt) <= 0) {
      latest.set(observation.predictionId, observation);
    }
  }
  return latest;
}

function chainFor(
  terminal: LedgerRecord,
  byId: Map<string, LedgerRecord>,
): { records: LedgerRecord[]; parentMissing: string | null; cycleDetected: boolean } {
  const backwards: LedgerRecord[] = [];
  const visited = new Set<string>();
  let current: LedgerRecord | undefined = terminal;
  let parentMissing: string | null = null;
  let cycleDetected = false;
  while (current) {
    if (visited.has(current.prediction.id)) {
      cycleDetected = true;
      break;
    }
    visited.add(current.prediction.id);
    backwards.push(current);
    const parentId = current.prediction.supersedesId;
    if (!parentId) break;
    const parent = byId.get(parentId);
    if (!parent) {
      parentMissing = parentId;
      break;
    }
    current = parent;
  }
  return { records: backwards.reverse(), parentMissing, cycleDetected };
}

function stageFrom(record: LedgerRecord): S5fChainStage {
  return {
    predictionId: record.prediction.id,
    supersedesId: record.prediction.supersedesId ?? null,
    recordedAt: record.prediction.recordedAt,
    analysisStage: record.prediction.analysisStage,
    modelCommit: record.prediction.model.gitCommit ?? null,
    lineupCounts: lineupCounts(record),
    oddsAmerican: record.prediction.market.oddsAmerican,
    line: record.prediction.market.line ?? null,
    book: record.prediction.market.book ?? null,
    capturedAt: capturedAt(record),
  };
}

function rowFor(
  terminal: LedgerRecord,
  chain: ReturnType<typeof chainFor>,
  observation: S5eConsensusObservation | null,
  nowMs: number,
): { row: S5fCertificationRow; alerts: S5fQualityAlert[] } {
  const start = Date.parse(String(terminal.prediction.game.commenceTime ?? ""));
  const started = Number.isFinite(start) && start <= nowMs;
  const minutesUntil = Number.isFinite(start) ? (start - nowMs) / 60_000 : Number.POSITIVE_INFINITY;
  const stageCounts = lineupCounts(terminal);
  const rowAlerts: S5fQualityAlert[] = [];

  let finalState: S5fCertificationRow["finalization"]["state"];
  if (terminal.prediction.analysisStage === "FINAL") {
    finalState = "FINAL_CAPTURED";
  } else if (!started) {
    finalState = "PROVISIONAL_PENDING";
    rowAlerts.push(alert(
      "FINAL_PENDING_LINEUPS",
      "INFO",
      false,
      terminal,
      "Official FINAL snapshot is naturally pending before game start.",
    ));
  } else {
    finalState = "FINAL_MISSED_AFTER_START";
    rowAlerts.push(alert(
      "FINAL_MISSED_AFTER_START",
      "WARNING",
      true,
      terminal,
      "Game started without a terminal FINAL snapshot.",
    ));
  }

  let closingState: S5fCertificationRow["closing"]["state"];
  if (terminal.settlement?.clvPp != null || observation?.comparable) {
    closingState = "COMPARABLE_CAPTURED";
  } else if (observation?.classification === "SOURCE_SET_CHANGED") {
    closingState = "SOURCE_SET_CHANGED";
    rowAlerts.push(alert(
      "CLOSING_SOURCE_SET_CHANGED",
      "WARNING",
      true,
      terminal,
      "Opening and closing F5 consensus source-book sets differ; price CLV is not comparable.",
    ));
  } else if (observation?.classification === "LINE_MOVED") {
    closingState = "LINE_MOVED";
    rowAlerts.push(alert(
      "CLOSING_LINE_MOVED",
      "INFO",
      false,
      terminal,
      "The F5 total line moved; price-only CLV remains intentionally uncomputed.",
    ));
  } else if (observation?.classification === "NO_PRICE") {
    closingState = "NO_PRICE";
    rowAlerts.push(alert(
      "CLOSING_NO_PRICE",
      "WARNING",
      true,
      terminal,
      "No verified closing price was available for the selected F5 market.",
    ));
  } else if (!started && minutesUntil > 20) {
    closingState = "PENDING_OUTSIDE_WINDOW";
    rowAlerts.push(alert(
      "CLOSING_PENDING_WINDOW",
      "INFO",
      false,
      terminal,
      "Closing capture is naturally pending outside the final 20-minute window.",
    ));
  } else if (!started) {
    closingState = "DUE_INSIDE_WINDOW";
    rowAlerts.push(alert(
      "CLOSING_DUE_INSIDE_WINDOW",
      "WARNING",
      true,
      terminal,
      "Decision is inside the closing window without a comparable observation yet.",
    ));
  } else {
    closingState = "MISSED_AFTER_START";
    rowAlerts.push(alert(
      "CLOSING_MISSED_AFTER_START",
      "WARNING",
      true,
      terminal,
      "Game started without comparable closing evidence.",
    ));
  }

  let settlementState: S5fCertificationRow["settlement"]["state"];
  if (terminal.settlement) {
    settlementState = "SETTLED";
  } else if (!started || !Number.isFinite(start) || nowMs - start < 6 * 60 * 60 * 1000) {
    settlementState = "PENDING_NATURAL";
    rowAlerts.push(alert(
      "SETTLEMENT_PENDING",
      "INFO",
      false,
      terminal,
      "Official settlement is naturally pending.",
    ));
  } else {
    settlementState = "OVERDUE";
    rowAlerts.push(alert(
      "SETTLEMENT_OVERDUE",
      "CRITICAL",
      true,
      terminal,
      "Official settlement is overdue more than six hours after game start.",
    ));
  }

  if (chain.parentMissing) {
    rowAlerts.push(alert(
      "CHAIN_PARENT_MISSING",
      "CRITICAL",
      true,
      terminal,
      `Supersedes chain references missing parent ${chain.parentMissing}.`,
    ));
  }
  if (chain.cycleDetected) {
    rowAlerts.push(alert(
      "CHAIN_CYCLE",
      "CRITICAL",
      true,
      terminal,
      "Supersedes chain contains a cycle.",
    ));
  }

  const origin = chain.records[0] ?? terminal;
  const actionable = rowAlerts.some((item) => item.actionable);
  const ready = finalState === "FINAL_CAPTURED"
    && closingState === "COMPARABLE_CAPTURED"
    && settlementState === "SETTLED";
  const readiness: S5fCertificationRow["readiness"] = ready
    ? "READY"
    : actionable ? "ACTION_REQUIRED" : "PENDING";

  return {
    row: {
      terminalPredictionId: terminal.prediction.id,
      chain: {
        length: chain.records.length,
        stages: chain.records.map(stageFrom),
        parentMissing: chain.parentMissing,
        cycleDetected: chain.cycleDetected,
      },
      game: {
        gamePk: terminal.prediction.game.gamePk ?? null,
        gameDate: terminal.prediction.game.gameDate,
        commenceTime: terminal.prediction.game.commenceTime ?? null,
        homeTeam: terminal.prediction.game.homeTeam,
        awayTeam: terminal.prediction.game.awayTeam,
      },
      market: {
        type: terminal.prediction.market.type,
        selection: terminal.prediction.market.selection,
        line: terminal.prediction.market.line ?? null,
        signal: terminal.prediction.decision.signal,
        confidenceLabel: terminal.prediction.decision.confidenceLabel ?? null,
        modelProbability: terminal.prediction.probabilities.model,
      },
      originOpening: {
        predictionId: origin.prediction.id,
        oddsAmerican: origin.prediction.market.oddsAmerican,
        line: origin.prediction.market.line ?? null,
        book: origin.prediction.market.book ?? null,
        capturedAt: capturedAt(origin),
      },
      analyticalOpening: {
        predictionId: terminal.prediction.id,
        oddsAmerican: terminal.prediction.market.oddsAmerican,
        line: terminal.prediction.market.line ?? null,
        book: terminal.prediction.market.book ?? null,
        capturedAt: capturedAt(terminal),
      },
      finalization: { state: finalState, lineupCounts: stageCounts },
      closing: {
        state: closingState,
        observation,
        clvPp: terminal.settlement?.clvPp ?? null,
      },
      settlement: {
        state: settlementState,
        result: terminal.settlement?.result ?? null,
        settledAt: terminal.settlement?.settledAt ?? null,
        source: terminal.settlement?.source ?? null,
        closingOddsAmerican: terminal.settlement?.closingOddsAmerican ?? null,
        closingLine: terminal.settlement?.closingLine ?? null,
        clvPp: terminal.settlement?.clvPp ?? null,
      },
      readiness,
      alertCodes: [...new Set(rowAlerts.map((item) => item.code))],
    },
    alerts: rowAlerts,
  };
}

function dedupeAlerts(values: S5fQualityAlert[]): S5fQualityAlert[] {
  const byId = new Map<string, S5fQualityAlert>();
  for (const value of values) byId.set(value.alertId, value);
  const rank: Record<S5fAlertSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return [...byId.values()].sort((left, right) =>
    rank[left.severity] - rank[right.severity]
    || left.code.localeCompare(right.code)
    || String(left.predictionId).localeCompare(String(right.predictionId)));
}

function globalAlerts(audit: MlbS5eAudit | null): S5fQualityAlert[] {
  if (!audit) return [];
  const values: S5fQualityAlert[] = [];
  if (audit.diagnostics.noOddsMatch > 0) {
    values.push(alert(
      "S5E_ODDS_MATCH_ERROR",
      "WARNING",
      true,
      null,
      `S5E reported ${audit.diagnostics.noOddsMatch} unmatched F5 odds event(s) in its latest audit.`,
    ));
  }
  for (const message of audit.diagnostics.errors) {
    values.push(alert(
      "S5E_SERVICE_ERROR",
      "CRITICAL",
      true,
      null,
      `S5E service error: ${message}`,
    ));
  }
  return values;
}

function warningsFrom(alerts: S5fQualityAlert[]): string[] {
  return [...new Set(alerts
    .filter((item) => item.actionable)
    .map((item) => `${item.code}: ${item.message}`))];
}

export class MlbS5fCertificationService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly ownerUserId: number;
  private readonly root: string;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    private readonly s5e: S5eEvidenceReader,
    private readonly s5d: S5dEvidenceReader,
    options: S5fOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S5F_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S5F_INITIAL_DELAY_MS, 150_000, 10_000);
    this.ownerUserId = options.ownerUserId;
    this.root = options.root ?? defaultRoot();
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.now = options.now ?? (() => new Date());
    this.lastSuccessAt = this.readLatest()?.generatedAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): S5fEnvelope | null { return readJson<S5fEnvelope>(path.join(this.root, "latest.json")); }
  readDashboard(): S5fEnvelope["dashboard"] | null { return this.readLatest()?.dashboard ?? null; }
  readReviewPackage(): S5fReviewPackage | null { return this.readLatest()?.reviewPackage ?? null; }
  readAlerts(): S5fQualityAlert[] { return this.readLatest()?.alerts ?? []; }

  status(): S5fStatus {
    return {
      schemaVersion: MLB_S5F_CERTIFICATION_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      snapshots: jsonFileCount(path.join(this.root, "snapshots")),
      latest: this.readLatest(),
    };
  }

  collect(trigger = "scheduled"): S5fEnvelope {
    const now = this.now();
    const generatedAt = now.toISOString();
    this.lastRunAt = generatedAt;
    try {
      const owned = ownedRecordsForUser(
        this.store,
        this.ownershipStore,
        this.ownerUserId,
        { limit: 10_000 },
      );
      const allRecords: LedgerRecord[] = owned;
      const terminal = terminalMlbLedgerRecords(allRecords);
      const byId = new Map(allRecords.map((record) => [record.prediction.id, record]));
      const observations = this.s5e.readObservations();
      const latestObservation = latestObservationByPrediction(observations);
      const rowResults = terminal.map((record) => rowFor(
        record,
        chainFor(record, byId),
        latestObservation.get(record.prediction.id) ?? null,
        now.getTime(),
      ));
      const rows = rowResults.map((result) => result.row).sort((left, right) =>
        left.game.gameDate.localeCompare(right.game.gameDate)
        || String(left.game.commenceTime).localeCompare(String(right.game.commenceTime))
        || left.terminalPredictionId.localeCompare(right.terminalPredictionId));
      const s5eLatest = this.s5e.readLatest();
      const s5dLatest: MlbS5dGateMonitorEnvelope | null = this.s5d.readLatest();
      const alerts = dedupeAlerts([
        ...rowResults.flatMap((result) => result.alerts),
        ...globalAlerts(s5eLatest),
      ]);
      const evaluation = buildMlbShadowEvaluation(terminal);
      if (evaluation.execution.realFinancialExposure !== 0
        || evaluation.execution.sportsbookIntegration
        || evaluation.execution.automaticBetPlacement
        || evaluation.execution.productionWrites
        || evaluation.decisionGate.automaticPromotion
        || evaluation.decisionGate.formulasChanged
        || evaluation.decisionGate.thresholdsChanged
        || evaluation.decisionGate.stakePolicyChanged) {
        throw new Error("S5F scientific safety invariant violated");
      }
      const counts = {
        ready: rows.filter((row) => row.readiness === "READY").length,
        pending: rows.filter((row) => row.readiness === "PENDING").length,
        actionRequired: rows.filter((row) => row.readiness === "ACTION_REQUIRED").length,
        finalCaptured: rows.filter((row) => row.finalization.state === "FINAL_CAPTURED").length,
        comparableClosing: rows.filter((row) => row.closing.state === "COMPARABLE_CAPTURED").length,
        settled: rows.filter((row) => row.settlement.state === "SETTLED").length,
      };
      const safety: S5fReviewPackage["safety"] = {
        mode: "SHADOW",
        realFinancialExposure: 0,
        sportsbookIntegration: false,
        automaticBetPlacement: false,
        productionWrites: false,
        automaticPromotion: false,
        formulasChanged: false,
        thresholdsChanged: false,
        stakePolicyChanged: false,
      };
      const reviewPackage: S5fReviewPackage = {
        schemaVersion: MLB_S5F_CERTIFICATION_VERSION,
        generatedAt,
        partial: evaluation.decisionGate.status === "EXTEND",
        gate: evaluation.decisionGate,
        summary: evaluation.summary,
        breakdowns: evaluation.breakdowns,
        dataQuality: evaluation.dataQuality,
        deduplication: evaluation.deduplication,
        evidenceReadiness: {
          terminalPredictions: rows.length,
          ...counts,
          actionableAlerts: alerts.filter((item) => item.actionable).length,
        },
        s5dConsistency: {
          latestEvaluatedAt: s5dLatest?.evaluatedAt ?? null,
          latestSemanticDigest: s5dLatest?.semanticDigest ?? null,
          gateStatusMatches: s5dLatest ? s5dLatest.gate.status === evaluation.decisionGate.status : null,
        },
        humanReview: {
          required: evaluation.decisionGate.status !== "EXTEND",
          status: evaluation.decisionGate.status,
          automaticPromotion: false,
          promotionAuthorized: false,
        },
        warnings: warningsFrom(alerts),
        safety,
      };
      const status = this.store.status();
      const semanticBasis = {
        source: {
          predictions: status.predictions,
          terminalPredictions: terminal.length,
          settlementEvents: status.settlementEvents,
          s5dSemanticDigest: s5dLatest?.semanticDigest ?? null,
          s5eAudit: s5eLatest,
          s5eObservationDigests: observations.map((item) => item.semanticDigest).sort(),
        },
        dashboard: { rows, counts },
        reviewPackage: {
          gate: reviewPackage.gate,
          summary: reviewPackage.summary,
          breakdowns: reviewPackage.breakdowns,
          dataQuality: reviewPackage.dataQuality,
          deduplication: reviewPackage.deduplication,
          evidenceReadiness: reviewPackage.evidenceReadiness,
          humanReview: reviewPackage.humanReview,
          warnings: reviewPackage.warnings,
        },
        alerts,
      };
      const semanticDigest = digest(semanticBasis);
      const previous = this.readLatest();
      const changed = previous?.semanticDigest !== semanticDigest;
      const envelope: S5fEnvelope = {
        schemaVersion: MLB_S5F_CERTIFICATION_VERSION,
        generatedAt,
        trigger,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        semanticDigest,
        changed,
        snapshotCreated: changed,
        source: {
          ledgerSchemaVersion: status.schemaVersion,
          immutable: status.immutable,
          predictions: status.predictions,
          terminalPredictions: terminal.length,
          supersededPredictions: Math.max(0, allRecords.length - terminal.length),
          s5dEvaluatedAt: s5dLatest?.evaluatedAt ?? null,
          s5eAuditedAt: s5eLatest?.ranAt ?? null,
          s5eObservationCount: observations.length,
        },
        dashboard: { rows, counts },
        reviewPackage,
        alerts,
        safety,
      };
      if (changed) {
        const stamp = generatedAt.replace(/[:.]/g, "-");
        atomicWriteJson(
          path.join(this.root, "snapshots", `${stamp}-${semanticDigest.slice(0, 12)}.json`),
          envelope,
        );
      }
      atomicWriteJson(path.join(this.root, "latest.json"), envelope);
      this.lastSuccessAt = generatedAt;
      this.lastError = null;
      return envelope;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function startMlbS5fCertificationWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s5e: S5eEvidenceReader,
  s5d: S5dEvidenceReader,
  options: S5fOptions,
): { service: MlbS5fCertificationService; timer: NodeJS.Timeout | null } {
  const service = new MlbS5fCertificationService(store, ownershipStore, s5e, s5d, options);
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    try {
      service.collect("scheduled");
    } catch (error) {
      console.error("[s5f] certification service failed", error);
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}

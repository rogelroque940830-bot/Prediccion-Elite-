export type MlbInjuryAuditDisposition =
  | "AUTO_APPLIED"
  | "BACKEND_ELIGIBLE"
  | "WITHHELD_BULLPEN"
  | "WITHHELD_POLICY"
  | "WITHHELD_MANUAL_OVERRIDE"
  | "MANUAL_SELECTED"
  | "ALREADY_REFLECTED"
  | "IGNORED"
  | "CONFLICT"
  | "PENDING"
  | "DETECTED";

export interface MlbInjuryAuditPlayerSnapshot {
  playerId?: number;
  name: string;
  position?: string;
  isPitcher: boolean;
  detectorSource?: string;
  reportedStatus?: string;
  officialStatusCode?: string | null;
  officialStatus?: string | null;
  officialTransaction?: {
    date?: string | null;
    effectiveDate?: string | null;
    typeCode?: string | null;
    typeDesc?: string | null;
    description?: string | null;
  } | null;
  shadow?: {
    decision: "APPLY_CANDIDATE" | "ALREADY_REFLECTED" | "IGNORE" | "CONFLICT" | "PENDING";
    confidence: "HIGH" | "MEDIUM" | "LOW";
    impact: "HIGH" | "MEDIUM" | "LOW" | "NONE";
    reasonCode: string;
    reason: string;
    daysSinceOfficialTransaction?: number | null;
    shadowOnly?: true;
  };
  disposition: MlbInjuryAuditDisposition;
}

export interface MlbInjuryAuditTeamSnapshot {
  side: "HOME" | "AWAY";
  teamName: string;
  teamId?: number;
  source: {
    detector: string;
    detectorStatus: string;
    detectorFetchedAt?: string;
    detectorStale: boolean;
    validator: string;
    validatorStatus: string;
    validatorFetchedAt?: string;
    rejectedCount: number;
    officialOnly: number;
  };
  phaseB: {
    enabled: boolean;
    mode: "AUTO_CONSERVATIVE";
    coverage: "FULL" | "PARTIAL" | "BLOCKED";
    candidateCount: number;
    eligiblePlayerNames: string[];
    withheldCandidateNames: string[];
    scale: number;
    maxAbsRuns: number;
    autoApplyAllowed: boolean;
    requiresBullpenReconciliation: boolean;
    reason: string;
  };
  reconciliation: {
    bullpenStatusAvailable: boolean;
    bullpenRunsAdjustment?: number;
    blockedReason?: string | null;
    closerAvailable?: boolean;
    bullpenCompromised?: boolean;
    statusText?: string;
  };
  adjustment: {
    rawAutomaticRuns: number;
    scaledAutomaticRuns: number;
    finalRuns: number;
    manualOverride: boolean;
    factorType: string;
    offenseFactor: number;
    defenseFactor: number;
    selectedPlayerNames: string[];
    autoAppliedPlayerNames: string[];
  };
  counts: {
    detected: number;
    candidates: number;
    backendEligible: number;
    autoApplied: number;
    selected: number;
    retained: number;
    rejected: number;
    officialOnly: number;
  };
  players: MlbInjuryAuditPlayerSnapshot[];
}

export interface MlbInjuryAuditSnapshot {
  schemaVersion: "mlb-injury-audit.v1";
  capturedAt: string;
  mode: "PHASE_B_AUTO_CONSERVATIVE";
  home: MlbInjuryAuditTeamSnapshot;
  away: MlbInjuryAuditTeamSnapshot;
}

interface AuditPlayerInput {
  playerId?: number;
  name: string;
  position?: string;
  isPitcher: boolean;
  status?: string;
  source?: string;
  officialStatusCode?: string | null;
  officialStatus?: string | null;
  officialTransaction?: MlbInjuryAuditPlayerSnapshot["officialTransaction"];
  shadow?: MlbInjuryAuditPlayerSnapshot["shadow"];
}

interface AuditFeedInput {
  source?: string;
  validationSource?: string;
  status?: string;
  fetchedAt?: string;
  stale?: boolean;
  officialValidationStatus?: string;
  officialFetchedAt?: string;
  rejectedCount?: number;
  shadowSummary?: { officialOnly?: number };
  autoApplyAllowed?: boolean;
  phaseB?: {
    enabled?: boolean;
    mode?: "AUTO_CONSERVATIVE";
    coverage?: "FULL" | "PARTIAL" | "BLOCKED";
    candidateCount?: number;
    eligiblePlayerNames?: string[];
    withheldCandidateNames?: string[];
    scale?: number;
    maxAbsRuns?: number;
    autoApplyAllowed?: boolean;
    requiresBullpenReconciliation?: boolean;
    reason?: string;
  };
}

export interface BuildMlbInjuryTeamAuditInput {
  side: "HOME" | "AWAY";
  teamName: string;
  teamId?: number;
  feed: AuditFeedInput;
  roster: AuditPlayerInput[];
  selectedPlayerNames: Iterable<string>;
  autoAppliedPlayerNames: Iterable<string>;
  rawAutomaticRuns: number;
  scaledAutomaticRuns: number;
  finalRuns: number;
  manualOverride: boolean;
  factors: { off: number; def: number; type: string };
  bullpenSide?: {
    runsAdjustment?: number | null;
    closerAvailable?: boolean;
    bullpenCompromised?: boolean;
  } | null;
  blockedReason?: string | null;
  statusText?: string;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sortedUnique(values: Iterable<string> | undefined): string[] {
  return Array.from(new Set(Array.from(values ?? []).map((value) => String(value).trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
}

function playerDisposition(
  player: AuditPlayerInput,
  selected: Set<string>,
  autoApplied: Set<string>,
  eligible: Set<string>,
  withheld: Set<string>,
  blockedReason: string | null | undefined,
  manualOverride: boolean,
): MlbInjuryAuditDisposition {
  if (autoApplied.has(player.name)) return "AUTO_APPLIED";
  if (selected.has(player.name)) return "MANUAL_SELECTED";
  if (eligible.has(player.name)) {
    if (manualOverride) return "WITHHELD_MANUAL_OVERRIDE";
    if (blockedReason) return "WITHHELD_BULLPEN";
    return "BACKEND_ELIGIBLE";
  }
  if (withheld.has(player.name)) return "WITHHELD_POLICY";
  if (player.shadow?.decision === "ALREADY_REFLECTED") return "ALREADY_REFLECTED";
  if (player.shadow?.decision === "IGNORE") return "IGNORED";
  if (player.shadow?.decision === "CONFLICT") return "CONFLICT";
  if (player.shadow?.decision === "PENDING") return "PENDING";
  return "DETECTED";
}

export function buildMlbInjuryTeamAudit(input: BuildMlbInjuryTeamAuditInput): MlbInjuryAuditTeamSnapshot {
  const phaseB = input.feed.phaseB;
  const selectedNames = sortedUnique(input.selectedPlayerNames);
  const autoAppliedNames = sortedUnique(input.autoAppliedPlayerNames);
  const eligibleNames = sortedUnique(phaseB?.eligiblePlayerNames);
  const withheldNames = sortedUnique(phaseB?.withheldCandidateNames);
  const selected = new Set(selectedNames);
  const autoApplied = new Set(autoAppliedNames);
  const eligible = new Set(eligibleNames);
  const withheld = new Set(withheldNames);
  const rejectedCount = Math.max(0, Math.trunc(finite(input.feed.rejectedCount)));
  const officialOnly = Math.max(0, Math.trunc(finite(input.feed.shadowSummary?.officialOnly)));

  const players = input.roster
    .map((player): MlbInjuryAuditPlayerSnapshot => ({
      ...(Number.isFinite(player.playerId) ? { playerId: Number(player.playerId) } : {}),
      name: String(player.name || "Unknown").trim() || "Unknown",
      ...(player.position ? { position: String(player.position) } : {}),
      isPitcher: Boolean(player.isPitcher),
      ...(player.source ? { detectorSource: String(player.source) } : {}),
      ...(player.status ? { reportedStatus: String(player.status) } : {}),
      officialStatusCode: player.officialStatusCode ?? null,
      officialStatus: player.officialStatus ?? null,
      officialTransaction: player.officialTransaction ?? null,
      ...(player.shadow ? {
        shadow: {
          decision: player.shadow.decision,
          confidence: player.shadow.confidence,
          impact: player.shadow.impact,
          reasonCode: player.shadow.reasonCode,
          reason: player.shadow.reason,
          ...(player.shadow.daysSinceOfficialTransaction !== undefined
            ? { daysSinceOfficialTransaction: player.shadow.daysSinceOfficialTransaction }
            : {}),
        },
      } : {}),
      disposition: playerDisposition(
        player,
        selected,
        autoApplied,
        eligible,
        withheld,
        input.blockedReason,
        input.manualOverride,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || finite(a.playerId) - finite(b.playerId));

  return {
    side: input.side,
    teamName: input.teamName,
    ...(Number.isFinite(input.teamId) ? { teamId: Number(input.teamId) } : {}),
    source: {
      detector: String(input.feed.source || "BALLDONTLIE"),
      detectorStatus: String(input.feed.status || "UNKNOWN"),
      ...(input.feed.fetchedAt ? { detectorFetchedAt: input.feed.fetchedAt } : {}),
      detectorStale: input.feed.stale === true,
      validator: String(input.feed.validationSource || "MLB_STATS"),
      validatorStatus: String(input.feed.officialValidationStatus || "PARTIAL"),
      ...(input.feed.officialFetchedAt ? { validatorFetchedAt: input.feed.officialFetchedAt } : {}),
      rejectedCount,
      officialOnly,
    },
    phaseB: {
      enabled: phaseB?.enabled === true,
      mode: "AUTO_CONSERVATIVE",
      coverage: phaseB?.coverage || "BLOCKED",
      candidateCount: Math.max(0, Math.trunc(finite(phaseB?.candidateCount))),
      eligiblePlayerNames: eligibleNames,
      withheldCandidateNames: withheldNames,
      scale: finite(phaseB?.scale),
      maxAbsRuns: Math.max(0, finite(phaseB?.maxAbsRuns)),
      autoApplyAllowed: phaseB?.autoApplyAllowed === true && input.feed.autoApplyAllowed === true,
      requiresBullpenReconciliation: phaseB?.requiresBullpenReconciliation !== false,
      reason: String(phaseB?.reason || "Phase B plan unavailable; automatic adjustment withheld."),
    },
    reconciliation: {
      bullpenStatusAvailable: Boolean(input.bullpenSide),
      ...(input.bullpenSide && Number.isFinite(input.bullpenSide.runsAdjustment)
        ? { bullpenRunsAdjustment: Number(input.bullpenSide.runsAdjustment) }
        : {}),
      blockedReason: input.blockedReason ?? null,
      ...(typeof input.bullpenSide?.closerAvailable === "boolean" ? { closerAvailable: input.bullpenSide.closerAvailable } : {}),
      ...(typeof input.bullpenSide?.bullpenCompromised === "boolean" ? { bullpenCompromised: input.bullpenSide.bullpenCompromised } : {}),
      ...(input.statusText ? { statusText: input.statusText } : {}),
    },
    adjustment: {
      rawAutomaticRuns: finite(input.rawAutomaticRuns),
      scaledAutomaticRuns: finite(input.scaledAutomaticRuns),
      finalRuns: finite(input.finalRuns),
      manualOverride: input.manualOverride,
      factorType: String(input.factors.type || "Unknown"),
      offenseFactor: finite(input.factors.off, 1),
      defenseFactor: finite(input.factors.def, 0.5),
      selectedPlayerNames: selectedNames,
      autoAppliedPlayerNames: autoAppliedNames,
    },
    counts: {
      detected: players.length,
      candidates: Math.max(0, Math.trunc(finite(phaseB?.candidateCount))),
      backendEligible: eligibleNames.length,
      autoApplied: autoAppliedNames.length,
      selected: selectedNames.length,
      retained: withheldNames.length,
      rejected: rejectedCount,
      officialOnly,
    },
    players,
  };
}

export function buildMlbInjuryAuditSnapshot(input: {
  capturedAt: string;
  home: BuildMlbInjuryTeamAuditInput;
  away: BuildMlbInjuryTeamAuditInput;
}): MlbInjuryAuditSnapshot {
  return {
    schemaVersion: "mlb-injury-audit.v1",
    capturedAt: input.capturedAt,
    mode: "PHASE_B_AUTO_CONSERVATIVE",
    home: buildMlbInjuryTeamAudit(input.home),
    away: buildMlbInjuryTeamAudit(input.away),
  };
}

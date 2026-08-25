import { NflPregameMaterializer, type NflPregameReferenceData } from "./nfl-pregame-materializer";
import {
  checkpointSemanticDigest,
  NFL_R5H20_CHECKPOINT_SCHEMA,
  NFL_R5H20_SOURCE_REPLAY_DIGEST,
  type NflPregameCheckpoint,
  type NflPregameCheckpointQbState,
  type NflPregameCheckpointTeamState,
} from "./nfl-r5h20-checkpoint";

type InternalTeamState = {
  values: Map<string, number>;
  n: number;
  seasonN: number;
  oaOff: number;
  oaDef: number;
  oaPassOff: number;
  oaPassDef: number;
  lastProxyQb: string | null;
};

type InternalQbState = {
  values: Map<string, number>;
  dropbacks: number;
};

type MaterializerInternals = {
  teamState: Map<string, InternalTeamState>;
  proxyQbState: Map<string, InternalQbState>;
  r5bQbState: Map<string, InternalQbState>;
  lastObservedQb: Map<string, string>;
  currentSeason: number | null;
  processedCompletedGames: number;
  lastAppliedGameId: string | null;
};

function internals(materializer: NflPregameMaterializer): MaterializerInternals {
  return materializer as unknown as MaterializerInternals;
}

function loadTeamState(rows: NflPregameCheckpointTeamState[]): Map<string, InternalTeamState> {
  return new Map(rows.map((row) => [row.team, {
    values: new Map(Object.entries(row.values)),
    n: row.n,
    seasonN: row.seasonN,
    oaOff: row.oaOff,
    oaDef: row.oaDef,
    oaPassOff: row.oaPassOff,
    oaPassDef: row.oaPassDef,
    lastProxyQb: row.lastProxyQb,
  }]));
}

function loadQbState(rows: NflPregameCheckpointQbState[]): Map<string, InternalQbState> {
  return new Map(rows.map((row) => [row.qbId, {
    values: new Map(Object.entries(row.values)),
    dropbacks: row.dropbacks,
  }]));
}

/** Restore the exact certified end-of-2025 sports state; reference data remains independently supplied. */
export function hydrateNflPregameMaterializer(
  checkpoint: NflPregameCheckpoint,
  referenceData: NflPregameReferenceData = {},
): NflPregameMaterializer {
  if (checkpoint.schemaVersion !== NFL_R5H20_CHECKPOINT_SCHEMA) throw new Error("NFL checkpoint restore schema mismatch");
  if (checkpoint.sourceReplayDigest !== NFL_R5H20_SOURCE_REPLAY_DIGEST) throw new Error("NFL checkpoint restore source mismatch");
  const materializer = new NflPregameMaterializer(referenceData);
  const state = internals(materializer);
  state.teamState = loadTeamState(checkpoint.teamState);
  state.proxyQbState = loadQbState(checkpoint.proxyQbState);
  state.r5bQbState = loadQbState(checkpoint.r5bQbState);
  state.lastObservedQb = new Map(checkpoint.lastObservedQb.map((row) => [row.team, row.qbId]));
  state.currentSeason = checkpoint.currentSeason;
  state.processedCompletedGames = checkpoint.processedCompletedGames;
  state.lastAppliedGameId = checkpoint.lastAppliedGameId;
  return materializer;
}

function sortedRecord(values: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...values.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function exportQbState(state: Map<string, InternalQbState>): NflPregameCheckpointQbState[] {
  return [...state.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([qbId, value]) => ({ qbId, values: sortedRecord(value.values), dropbacks: value.dropbacks }));
}

/** CI/audit helper used to prove that the embedded checkpoint equals a full certified replay. */
export function snapshotNflPregameMaterializer(
  materializer: NflPregameMaterializer,
  sourceReplayDigest = NFL_R5H20_SOURCE_REPLAY_DIGEST,
): NflPregameCheckpoint {
  const state = internals(materializer);
  const payload = {
    schemaVersion: NFL_R5H20_CHECKPOINT_SCHEMA,
    sourceReplayDigest: sourceReplayDigest as typeof NFL_R5H20_SOURCE_REPLAY_DIGEST,
    currentSeason: state.currentSeason ?? 0,
    processedCompletedGames: state.processedCompletedGames,
    lastAppliedGameId: state.lastAppliedGameId,
    teamState: [...state.teamState.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([team, value]) => ({
        team,
        values: sortedRecord(value.values),
        n: value.n,
        seasonN: value.seasonN,
        oaOff: value.oaOff,
        oaDef: value.oaDef,
        oaPassOff: value.oaPassOff,
        oaPassDef: value.oaPassDef,
        lastProxyQb: value.lastProxyQb,
      })),
    proxyQbState: exportQbState(state.proxyQbState),
    r5bQbState: exportQbState(state.r5bQbState),
    lastObservedQb: [...state.lastObservedQb.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([team, qbId]) => ({ team, qbId })),
  };
  return { ...payload, semanticDigest: checkpointSemanticDigest(payload) };
}

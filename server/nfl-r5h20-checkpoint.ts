import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { NFL_R5H20_CHECKPOINT_CHUNK_01 } from "./nfl-r5h20-checkpoint-data-01";
import { NFL_R5H20_CHECKPOINT_CHUNK_02 } from "./nfl-r5h20-checkpoint-data-02";
import { NFL_R5H20_CHECKPOINT_CHUNK_03 } from "./nfl-r5h20-checkpoint-data-03";
import { NFL_R5H20_CHECKPOINT_CHUNK_04 } from "./nfl-r5h20-checkpoint-data-04";

export const NFL_R5H20_CHECKPOINT_SCHEMA = "courtedge-nfl-pregame-checkpoint.v1" as const;
export const NFL_R5H20_SOURCE_REPLAY_DIGEST = "d2873a557ed391b7bffaa6d12fb49ead7cc4554538554bdaa5bdf8248a06c5c5" as const;
export const NFL_R5H20_END_2025_CHECKPOINT_DIGEST = "4ddc8b3203e104b4550bee83472870dedce9b93eee54c05c2dab5562152d94d7" as const;

export type NflPregameCheckpointTeamState = {
  team: string;
  values: Record<string, number>;
  n: number;
  seasonN: number;
  oaOff: number;
  oaDef: number;
  oaPassOff: number;
  oaPassDef: number;
  lastProxyQb: string | null;
};

export type NflPregameCheckpointQbState = {
  qbId: string;
  values: Record<string, number>;
  dropbacks: number;
};

export type NflPregameCheckpoint = {
  schemaVersion: typeof NFL_R5H20_CHECKPOINT_SCHEMA;
  sourceReplayDigest: typeof NFL_R5H20_SOURCE_REPLAY_DIGEST;
  currentSeason: number;
  processedCompletedGames: number;
  lastAppliedGameId: string | null;
  teamState: NflPregameCheckpointTeamState[];
  proxyQbState: NflPregameCheckpointQbState[];
  r5bQbState: NflPregameCheckpointQbState[];
  lastObservedQb: Array<{ team: string; qbId: string }>;
  semanticDigest: string;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function digestCheckpointPayload(checkpoint: Omit<NflPregameCheckpoint, "semanticDigest">): string {
  return createHash("sha256").update(canonical(checkpoint)).digest("hex");
}

const EMBEDDED_GZIP_BASE64 = [
  NFL_R5H20_CHECKPOINT_CHUNK_01,
  NFL_R5H20_CHECKPOINT_CHUNK_02,
  NFL_R5H20_CHECKPOINT_CHUNK_03,
  NFL_R5H20_CHECKPOINT_CHUNK_04
].join("");

let cached: NflPregameCheckpoint | null = null;

/** Frozen end-of-2025 sports-state checkpoint reconstructed from the certified R5H20 replay. */
export function getNflR5H20End2025Checkpoint(): NflPregameCheckpoint {
  if (cached) return cached;
  const decoded = gunzipSync(Buffer.from(EMBEDDED_GZIP_BASE64, "base64")).toString("utf8");
  const parsed = JSON.parse(decoded) as NflPregameCheckpoint;
  if (parsed.schemaVersion !== NFL_R5H20_CHECKPOINT_SCHEMA) throw new Error("NFL checkpoint schema mismatch");
  if (parsed.sourceReplayDigest !== NFL_R5H20_SOURCE_REPLAY_DIGEST) throw new Error("NFL checkpoint source replay mismatch");
  if (parsed.currentSeason !== 2025 || parsed.processedCompletedGames !== 3663) {
    throw new Error("NFL checkpoint custody mismatch");
  }
  const { semanticDigest, ...payload } = parsed;
  const actual = digestCheckpointPayload(payload);
  if (semanticDigest !== NFL_R5H20_END_2025_CHECKPOINT_DIGEST || actual !== NFL_R5H20_END_2025_CHECKPOINT_DIGEST) {
    throw new Error("NFL checkpoint semantic digest mismatch");
  }
  cached = parsed;
  return cached;
}

export function checkpointSemanticDigest(checkpoint: Omit<NflPregameCheckpoint, "semanticDigest">): string {
  return digestCheckpointPayload(checkpoint);
}

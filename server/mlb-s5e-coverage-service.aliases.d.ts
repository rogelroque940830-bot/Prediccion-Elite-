import type {
  S5eAudit,
  S5eConsensusObservation as NativeS5eConsensusObservation,
} from "./mlb-s5e-coverage-service";

declare module "./mlb-s5e-coverage-service" {
  export type MlbS5eAudit = S5eAudit;
  export type MlbS5eConsensusObservation = NativeS5eConsensusObservation;
}

declare global {
  type S5eConsensusObservation = NativeS5eConsensusObservation;
}

export {};

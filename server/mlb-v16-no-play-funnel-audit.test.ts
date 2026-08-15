import { describe, expect, it } from "vitest";
import { MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA } from "./mlb-v16-no-play-funnel-audit";

// Structural lock only. Runtime fixture coverage is added after the diagnostic is wired
// to the existing priced-runner fixture so the audit cannot silently change V16 behavior.
describe("V16 no-play funnel audit contract", () => {
  it("keeps a dedicated immutable diagnostic schema", () => {
    expect(MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA).toBe("courtedge-p0-v16-no-play-funnel-audit.v1");
  });
});

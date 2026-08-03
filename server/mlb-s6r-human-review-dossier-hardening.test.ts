import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MlbS6rHumanReviewDossierService,
  createMlbS6rReviewDecision,
  type S6rDossier,
} from "./mlb-s6r-human-review-dossier";

const dossier = {
  dossierDigestSha256: "dossier-digest",
  metrics: {}, marketReviews: [], signalReviews: [], calibrationBuckets: [], concentration: {},
} as unknown as S6rDossier;

test("rejects an unknown review stage before persistence", () => {
  assert.throws(() => createMlbS6rReviewDecision(
    dossier,
    { stage: "UNKNOWN" as any, rationale: "This rationale is long enough to pass the length requirement." },
    1,
    "2026-08-03T16:00:00.000Z",
    null,
  ), /stage must be IN_PROGRESS or FINAL/);
});

test("rejects an unknown final conclusion before persistence", () => {
  assert.throws(() => createMlbS6rReviewDecision(
    dossier,
    { stage: "FINAL", conclusion: "UNKNOWN" as any, rationale: "This rationale is long enough to pass the length requirement." },
    1,
    "2026-08-03T16:00:00.000Z",
    null,
  ), /Unknown S6R review conclusion/);
});

test("turns a semantically malformed latest report into ACTION_REQUIRED", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s6r-hardening-"));
  fs.writeFileSync(path.join(root, "latest.json"), "{}\n");
  const fakeS6q = {
    readLatest: () => null,
    readEvidence: () => null,
  } as any;
  const service = new MlbS6rHumanReviewDossierService(fakeS6q, {
    ownerUserId: 1,
    enabled: false,
    root,
    now: () => new Date("2026-08-03T16:00:00.000Z"),
    deploymentCommit: "test",
    environment: "test",
  });
  const report = await service.run("test");
  assert.equal(report.state, "ACTION_REQUIRED");
  assert.ok(report.issues.some((entry) => entry.code === "PREVIOUS_REPORT_INVALID"));
});

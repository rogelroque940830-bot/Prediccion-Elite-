import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SOURCE_SCHEMA = "courtedge-p0-step12v80-general-strength-live-context.v1";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function cachedJsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function normalizePrepareGapAuditLayout(): void {
  const gapRoot = arg("--gap-root");
  if (!gapRoot) throw new Error("V80_PREPARE_GAP_ROOT_MISSING");

  // The immutable V68 gap ledger stores this audit at the gap root, while the
  // frozen V68 source base stores the same source family under t5-audit/.
  // The V80 core predates that gap-ledger layout. Normalize only the local
  // checkout used by this run; never rewrite or commit the V68 ledger.
  const flatAudit = path.join(gapRoot, "t5-starter-identity-audit.json");
  const nestedAudit = path.join(gapRoot, "t5-audit", "t5-starter-identity-audit.json");

  if (!fs.existsSync(flatAudit) && !fs.existsSync(nestedAudit)) {
    throw new Error(`V80_PREPARE_V68_GAP_AUDIT_MISSING:${flatAudit}`);
  }

  if (fs.existsSync(flatAudit) && fs.existsSync(nestedAudit)) {
    if (sha256File(flatAudit) !== sha256File(nestedAudit)) {
      throw new Error("V80_PREPARE_V68_GAP_AUDIT_LAYOUT_CONFLICT");
    }
    return;
  }

  if (!fs.existsSync(flatAudit)) return;
  fs.mkdirSync(path.dirname(nestedAudit), { recursive: true });
  fs.copyFileSync(flatAudit, nestedAudit);
  if (sha256File(flatAudit) !== sha256File(nestedAudit)) {
    throw new Error("V80_PREPARE_V68_GAP_AUDIT_COPY_DIGEST_MISMATCH");
  }
  console.log("V80_PREPARE_V68_GAP_AUDIT_LAYOUT_NORMALIZED");
}

const mode = arg("--mode");
const gamePkRaw = arg("--game-pk");

if (mode === "prepare") {
  normalizePrepareGapAuditLayout();
}

if (mode === "live" && gamePkRaw !== null) {
  const gamePk = Number(gamePkRaw);
  const targetDate = String(arg("--target-date") ?? "");
  const stateFile = String(arg("--state") ?? "");
  const out = String(arg("--out") ?? "");
  const attemptStage = arg("--attempt-stage");
  const maxLeadMinutes = Number(arg("--max-lead-minutes") ?? "20");
  if (!Number.isInteger(gamePk) || gamePk <= 0 || !targetDate || !stateFile || !out) {
    throw new Error("V80_FINAL_GAME_GUARD_INVALID_ARGS");
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  const feedUrl = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
  const feedResponse = await originalFetch(feedUrl, {
    headers: { "User-Agent": "CourtEdge-V80-Final-Game-Guard/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!feedResponse.ok) throw new Error(`V80_FINAL_GAME_GUARD_FETCH_FAILED:${feedResponse.status}`);
  const feed = await feedResponse.json() as Record<string, any>;
  const gd = feed?.gameData ?? {};
  const status = gd?.status ?? {};
  const coded = String(status.codedGameState ?? "").toUpperCase();
  const abstract = String(status.abstractGameState ?? "").toLowerCase();
  const detailed = String(status.detailedState ?? "").toLowerCase();
  const officialDate = String(gd?.datetime?.officialDate ?? "");
  const startTime = String(gd?.datetime?.dateTime ?? "");
  const blockedTerms = [
    "in progress",
    "final",
    "game over",
    "completed early",
    "postponed",
    "cancelled",
    "canceled",
    "suspended",
    "delay",
  ];
  const blocked = officialDate !== targetDate
    || ["I", "F", "O"].includes(coded)
    || ["live", "final"].includes(abstract)
    || blockedTerms.some((term) => detailed.includes(term));

  if (blocked) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const capturedAt = new Date().toISOString();
    writeJson(out, {
      schemaVersion: SOURCE_SCHEMA,
      targetOfficialDate: targetDate,
      capturedAt,
      stateDigest: state?.stateDigest ?? null,
      rows: [],
      diagnostics: {
        scheduleGames: null,
        inspectedGames: 1,
        requestedGameFound: true,
        targetGamePk: gamePk,
        attemptStage,
        exactReadyGamesInCaptureWindow: 0,
        maxLeadMinutes,
        finalGameStatusGuardBlocked: true,
        officialDate,
        startTime,
        codedGameState: coded,
        abstractGameState: abstract,
        detailedState: detailed,
      },
      policy: {
        researchOnly: true,
        outcomesRead: false,
        pricesRead: false,
        oddsUsedAsFeatures: false,
        realFinancialExposure: 0,
      },
    });
    console.log(JSON.stringify({ rows: 0, finalGameStatusGuardBlocked: true, gamePk, detailedState: detailed }, null, 2));
    process.exit(0);
  }

  const syntheticSchedule = {
    dates: [{
      games: [{ gamePk, officialDate, gameDate: startTime }],
    }],
  };
  const schedulePrefix = "https://statsapi.mlb.com/api/v1/schedule";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(schedulePrefix)) return cachedJsonResponse(syntheticSchedule);
    if (url === feedUrl) return cachedJsonResponse(feed);
    return originalFetch(input as any, init);
  }) as typeof fetch;
}

await import("./p0-step12v80-general-strength-live-context-core.ts");

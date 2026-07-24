const BASE_URL = (process.env.BASE_URL || "https://web-p0-staging.up.railway.app").replace(/\/$/, "");
const EXPECTED_COMMIT = (process.env.EXPECTED_COMMIT || "").trim();
const STARTUP_DELAY_MS = Number(process.env.STARTUP_DELAY_MS || 0);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchJson(path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    let body;

    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${path} devolvió contenido no JSON: ${text.slice(0, 180)}`);
    }

    if (!response.ok) {
      throw new Error(`${path} devolvió HTTP ${response.status}: ${text.slice(0, 180)}`);
    }

    return { body, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

function floridaDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateAnalysisStatus(body, endpointName) {
  const status = body?.analysisStatus;
  assert(status && typeof status === "object", `${endpointName}: falta analysisStatus`);
  assert(
    status.stage === "PROVISIONAL" || status.stage === "FINAL",
    `${endpointName}: stage inválido`,
  );
  assert(
    typeof status.calculationsApplied === "boolean",
    `${endpointName}: calculationsApplied debe ser boolean`,
  );
  assert(
    typeof status.requiresRecalculation === "boolean",
    `${endpointName}: requiresRecalculation debe ser boolean`,
  );
  assert(
    status.stage === "FINAL" ? status.requiresRecalculation === false : true,
    `${endpointName}: incoherencia entre FINAL y requiresRecalculation`,
  );
}

async function waitForExpectedDeployment() {
  if (STARTUP_DELAY_MS > 0) {
    console.log(`Esperando ${Math.round(STARTUP_DELAY_MS / 1000)}s para que Railway inicie el despliegue...`);
    await sleep(STARTUP_DELAY_MS);
  }

  let lastSeenCommit = "unknown";
  let lastError = "sin respuesta";

  for (let attempt = 1; attempt <= 24; attempt += 1) {
    try {
      const { body, headers } = await fetchJson("/health", 20_000);
      assert(body?.status === "healthy", "/health no reporta healthy");
      lastSeenCommit = headers.get("x-staging-commit") || "unknown";

      const commitMatches =
        !EXPECTED_COMMIT ||
        lastSeenCommit === "unknown" ||
        lastSeenCommit === EXPECTED_COMMIT ||
        lastSeenCommit.startsWith(EXPECTED_COMMIT.slice(0, 7));

      if (commitMatches) {
        if (EXPECTED_COMMIT && lastSeenCommit === "unknown") {
          console.warn("ADVERTENCIA: Railway no expuso el SHA; se valida la instancia saludable tras la espera inicial.");
        }
        console.log(`PASS /health — commit desplegado: ${lastSeenCommit}`);
        return;
      }

      lastError = `Railway aún sirve ${lastSeenCommit}; esperado ${EXPECTED_COMMIT}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    console.log(`Intento ${attempt}/24: ${lastError}`);
    await sleep(15_000);
  }

  throw new Error(`No se confirmó el despliegue esperado. Último commit visto: ${lastSeenCommit}. ${lastError}`);
}

async function discoverTestGame() {
  const dateOffsets = [0, 1, -1, 2, -2];

  for (const offset of dateOffsets) {
    const date = floridaDate(offset);
    const { body } = await fetchJson(`/api/mlb/all?date=${date}`);
    assert(body?.success === true, `/api/mlb/all?date=${date}: success no es true`);
    const games = Array.isArray(body.games) ? body.games : [];

    const withPitchers = games.find((game) => {
      const gamePk = game?.gamePk ?? game?.gameId;
      return gamePk && game?.homePitcher?.id && game?.awayPitcher?.id;
    });

    if (withPitchers) {
      const gamePk = withPitchers.gamePk ?? withPitchers.gameId;
      console.log(
        `Partido de prueba: ${withPitchers.awayTeam?.name ?? "Away"} @ ${withPitchers.homeTeam?.name ?? "Home"} (${gamePk}, ${date})`,
      );
      return { gamePk, date, game: withPitchers };
    }
  }

  throw new Error("No se encontró un partido MLB cercano con ambos pitchers probables disponibles.");
}

async function runTest(name, path, validator) {
  const started = Date.now();
  const { body } = await fetchJson(path);
  validator(body);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`PASS ${name} (${elapsed}s)`);
}

async function main() {
  console.log(`Smoke test MLB staging: ${BASE_URL}`);
  await waitForExpectedDeployment();

  const { gamePk, date, game } = await discoverTestGame();
  assert(game?.weather && typeof game.weather === "object", "/api/mlb/all: falta objeto weather");
  console.log("PASS /api/mlb/all — calendario, pitchers y weather presentes");

  await runTest("weather", `/api/mlb/weather/${gamePk}?date=${date}`, (body) => {
    assert(body?.success === true, "weather: success no es true");
    assert(Number(body?.gamePk) === Number(gamePk), "weather: gamePk no coincide");
    assert(body?.weather && typeof body.weather === "object", "weather: falta objeto weather");
    assert(body?.source === "/api/mlb/all", "weather: fuente inesperada");
  });

  await runTest("lineup-matchup", `/api/mlb/lineup-matchup/${gamePk}`, (body) => {
    assert(body?.homeLineup && body?.awayLineup, "lineup-matchup: faltan lineups");
    validateAnalysisStatus(body, "lineup-matchup");
  });

  await runTest("statcast-matchup", `/api/mlb/statcast-matchup/${gamePk}`, (body) => {
    assert(body?.homeLineupVsAwaySP, "statcast-matchup: falta homeLineupVsAwaySP");
    assert(body?.awayLineupVsHomeSP, "statcast-matchup: falta awayLineupVsHomeSP");
    validateAnalysisStatus(body, "statcast-matchup");
    assert(body.analysisStatus.directVsProxy, "statcast-matchup: falta directVsProxy");
  });

  await runTest("pitcher-recent", `/api/mlb/pitcher-recent/${gamePk}`, (body) => {
    assert(body?.home && body?.away, "pitcher-recent: faltan ambos pitchers");
  });

  await runTest("bullpen-status", `/api/mlb/bullpen-status/${gamePk}`, (body) => {
    assert(body?.home && body?.away, "bullpen-status: faltan ambos bullpens");
  });

  await runTest("team-fatigue", `/api/mlb/team-fatigue/${gamePk}`, (body) => {
    assert(body?.home && body?.away, "team-fatigue: faltan ambos equipos");
  });

  await runTest("catcher-framing", `/api/mlb/catcher-framing/${gamePk}`, (body) => {
    assert(body?.homeCatcher && body?.awayCatcher, "catcher-framing: faltan ambos catchers");
    validateAnalysisStatus(body, "catcher-framing");
  });

  console.log("\nTODAS LAS PRUEBAS DE STAGING PASARON.");
}

main().catch((error) => {
  console.error("\nSMOKE TEST FALLÓ:");
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
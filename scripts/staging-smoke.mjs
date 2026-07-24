const BASE_URL = (process.env.BASE_URL || "https://web-p0-staging.up.railway.app").replace(/\/$/, "");
const EXPECTED_COMMIT = (process.env.EXPECTED_COMMIT || "").trim();
const STARTUP_DELAY_MS = Number(process.env.STARTUP_DELAY_MS || 0);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchJson(path, timeoutMs = REQUEST_TIMEOUT_MS, options = {}) {
  const url = `${BASE_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestHeaders = {
    Accept: "application/json",
    ...(options.headers || {}),
  };
  const requestBody =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);

  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: requestHeaders,
      body: requestBody,
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

async function validateAdminAuthObservation() {
  const statusResponse = await fetchJson("/api/staging/admin-auth-status");
  const status = statusResponse.body;
  assert(status?.success === true, "admin-auth-status: success no es true");
  assert(status?.mode === "observe", "admin-auth-status: mode no es observe");
  assert(status?.blocking === false, "admin-auth-status: blocking debe ser false");
  assert(Array.isArray(status?.protectedRoutes), "admin-auth-status: faltan protectedRoutes");
  for (const route of ["/api/picks/sync", "/api/clv/reset", "/api/clv/refresh"]) {
    assert(status.protectedRoutes.includes(route), `admin-auth-status: falta ${route}`);
  }

  const selfTestResponse = await fetchJson("/api/staging/admin-auth-self-test");
  const selfTest = selfTestResponse.body;
  assert(selfTest?.success === true, "admin-auth-self-test: success no es true");
  assert(selfTest?.mode === "observe", "admin-auth-self-test: mode no es observe");
  assert(selfTest?.blocking === false, "admin-auth-self-test: blocking debe ser false");
  assert(selfTest?.tokenConfigured === true, "admin-auth-self-test: token no configurado");
  assert(selfTest?.states?.missing === "missing", "admin-auth-self-test: estado missing incorrecto");
  assert(selfTest?.states?.invalid === "invalid", "admin-auth-self-test: estado invalid incorrecto");
  assert(selfTest?.states?.valid === "valid", "admin-auth-self-test: estado valid incorrecto");
  assert(selfTest?.tokenExposed === false, "admin-auth-self-test: tokenExposed debe ser false");
  assert(selfTest?.mutatedData === false, "admin-auth-self-test: mutatedData debe ser false");

  const probeResponse = await fetchJson(
    "/api/staging/admin-auth-probe",
    REQUEST_TIMEOUT_MS,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { source: "staging-smoke", mutate: false },
    },
  );
  const probe = probeResponse.body;
  const observation = probe?.observation;
  assert(probe?.success === true, "admin-auth-probe: success no es true");
  assert(probe?.mutatedData === false, "admin-auth-probe: mutatedData debe ser false");
  assert(observation?.mode === "observe", "admin-auth-probe: mode no es observe");
  assert(observation?.blocking === false, "admin-auth-probe: blocking debe ser false");
  assert(
    observation?.route === "/api/staging/admin-auth-probe",
    "admin-auth-probe: route inesperada",
  );
  assert(observation?.state === "missing", `admin-auth-probe: state inesperado ${observation?.state}`);
  assert(
    probeResponse.headers.get("x-admin-auth-mode") === "observe",
    "admin-auth-probe: falta X-Admin-Auth-Mode",
  );
  assert(
    probeResponse.headers.get("x-admin-auth-blocking") === "false",
    "admin-auth-probe: X-Admin-Auth-Blocking debe ser false",
  );
  assert(
    probeResponse.headers.get("x-admin-auth-state") === observation.state,
    "admin-auth-probe: encabezado y body no coinciden",
  );

  console.log(
    "PASS admin-auth observation — missing/invalid/valid verificados, blocking=false, tokenExposed=false, mutatedData=false",
  );
}

async function main() {
  console.log(`Smoke test MLB staging: ${BASE_URL}`);
  await waitForExpectedDeployment();
  await validateAdminAuthObservation();

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

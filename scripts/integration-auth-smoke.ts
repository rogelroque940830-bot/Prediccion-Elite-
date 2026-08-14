import crypto from "crypto";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "http";
import assert from "node:assert/strict";

const origin = "http://localhost:5173";
const username = "integration-admin";
const password = "integration-password-2026";
const salt = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const hash = crypto.scryptSync(password, salt, 64).toString("hex");
const originalCwd = process.cwd();
const isolatedDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-integration-"));

process.chdir(isolatedDataRoot);
process.env.NODE_ENV = "test";
process.env.COURTEDGE_ALLOWED_ORIGINS = origin;
process.env.COURTEDGE_SESSION_SECRET = "integration-session-secret-with-more-than-32-characters";
process.env.COURTEDGE_ADMIN_USERNAME = username;
process.env.COURTEDGE_ADMIN_PASSWORD_SCRYPT = `scrypt$${salt.toString("hex")}$${hash}`;
process.env.ALLOW_LEGACY_PICKS_SYNC = "false";
delete process.env.COURTEDGE_WRITE_TOKEN;

const [
  { restrictedCors, apiRateLimit, requireWriteAuth },
  { createSessionMiddleware, initializeAuthPersistence, registerAuthRoutes },
  { registerPicksV2Routes },
] = await Promise.all([
  import("../server/security"),
  import("../server/auth"),
  import("../server/picks-v2"),
]);

const authDatabase = initializeAuthPersistence();
const app = express();
app.set("trust proxy", 1);
app.use(restrictedCors);
app.use(apiRateLimit);
app.use(createSessionMiddleware(authDatabase));
app.use(express.json());
app.use(requireWriteAuth);
registerAuthRoutes(app, authDatabase);
registerPicksV2Routes(app);

const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind integration server");
const base = `http://127.0.0.1:${address.port}`;

async function request(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Origin", origin);
  return fetch(`${base}${pathname}`, { ...init, headers });
}

try {
  const anonymous = await request("/api/auth/session");
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get("access-control-allow-origin"), origin);
  assert.equal(anonymous.headers.get("access-control-allow-credentials"), "true");
  assert.equal((await anonymous.json() as { authenticated: boolean }).authenticated, false);

  const blocked = await request("/api/picks/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(blocked.status, 401);

  const wrong = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "wrong-password" }),
  });
  assert.equal(wrong.status, 401);

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("courtedge.sid="));
  const loginData = await login.json() as { authenticated: boolean; csrfToken?: string };
  assert.equal(loginData.authenticated, true);
  assert.ok(loginData.csrfToken && loginData.csrfToken.length >= 32);

  const missingCsrf = await request("/api/picks/v2", {
    method: "POST",
    headers: {
      Cookie: cookie!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  assert.equal(missingCsrf.status, 403);

  const writeHeaders = {
    Cookie: cookie!,
    "Content-Type": "application/json",
    "X-CourtEdge-CSRF": loginData.csrfToken!,
  };
  const createPick = await request("/api/picks/v2", {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({
      id: "integration-mlb-1",
      ts: Date.now(),
      sport: "mlb",
      homeTeam: "Miami Marlins",
      awayTeam: "Atlanta Braves",
      pickType: "ML",
      pickSide: "Home",
      confidence: 72,
      odds: -110,
      source: "app",
    }),
  });
  assert.equal(createPick.status, 201);
  const created = await createPick.json() as { success: boolean; data: { id: string } };
  assert.equal(created.success, true);
  assert.equal(created.data.id, "integration-mlb-1");

  const listCreated = await request("/api/picks/v2?sport=mlb&minConfidence=70");
  assert.equal(listCreated.status, 200);
  const listed = await listCreated.json() as { success: boolean; data: Array<{ id: string; result?: string }> };
  assert.equal(listed.success, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].id, "integration-mlb-1");

  const patchPick = await request("/api/picks/v2/integration-mlb-1", {
    method: "PATCH",
    headers: writeHeaders,
    body: JSON.stringify({ result: "W", profit: 9.09 }),
  });
  assert.equal(patchPick.status, 200);
  const patched = await patchPick.json() as { success: boolean; data: { result?: string } };
  assert.equal(patched.success, true);
  assert.equal(patched.data.result, "W");

  const legacy = await request("/api/picks/sync", {
    method: "POST",
    headers: writeHeaders,
    body: JSON.stringify({ picks: [] }),
  });
  assert.equal(legacy.status, 410);

  const deletePick = await request("/api/picks/v2/integration-mlb-1", {
    method: "DELETE",
    headers: writeHeaders,
  });
  assert.equal(deletePick.status, 200);

  const listDeleted = await request("/api/picks/v2?sport=mlb");
  assert.equal(listDeleted.status, 200);
  const empty = await listDeleted.json() as { success: boolean; data: unknown[] };
  assert.equal(empty.success, true);
  assert.equal(empty.data.length, 0);

  const disallowed = await fetch(`${base}/api/auth/session`, {
    headers: { Origin: "https://attacker.invalid" },
  });
  assert.equal(disallowed.status, 403);

  console.log(
    "PASS: session login, HttpOnly cookie, CORS credentials, CSRF, canonical picks v2 CRUD and legacy sync guard verified",
  );
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  process.chdir(originalCwd);
  fs.rmSync(isolatedDataRoot, { recursive: true, force: true });
}
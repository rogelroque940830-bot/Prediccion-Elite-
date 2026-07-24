import crypto from "crypto";
import express from "express";
import { createServer } from "http";
import assert from "node:assert/strict";

const origin = "http://localhost:5173";
const username = "integration-admin";
const password = "integration-password-2026";
const salt = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const hash = crypto.scryptSync(password, salt, 64).toString("hex");

process.env.NODE_ENV = "test";
process.env.COURTEDGE_ALLOWED_ORIGINS = origin;
process.env.COURTEDGE_SESSION_SECRET = "integration-session-secret-with-more-than-32-characters";
process.env.COURTEDGE_ADMIN_USERNAME = username;
process.env.COURTEDGE_ADMIN_PASSWORD_SCRYPT = `scrypt$${salt.toString("hex")}$${hash}`;
process.env.ALLOW_LEGACY_PICKS_SYNC = "false";
delete process.env.COURTEDGE_WRITE_TOKEN;

const [{ restrictedCors, apiRateLimit, requireWriteAuth }, { createSessionMiddleware, registerAuthRoutes }] = await Promise.all([
  import("../server/security"),
  import("../server/auth"),
]);

const app = express();
app.set("trust proxy", 1);
app.use(restrictedCors);
app.use(apiRateLimit);
app.use(createSessionMiddleware());
app.use(express.json());
app.use(requireWriteAuth);
registerAuthRoutes(app);
app.post("/api/picks/v2", (_req, res) => res.json({ success: true }));

const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind integration server");
const base = `http://127.0.0.1:${address.port}`;

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Origin", origin);
  return fetch(`${base}${path}`, { ...init, headers });
}

try {
  const anonymous = await request("/api/auth/session");
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get("access-control-allow-origin"), origin);
  assert.equal(anonymous.headers.get("access-control-allow-credentials"), "true");
  assert.equal((await anonymous.json() as { authenticated: boolean }).authenticated, false);

  const blocked = await request("/api/picks/v2", { method: "POST" });
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
    headers: { Cookie: cookie },
  });
  assert.equal(missingCsrf.status, 403);

  const authorized = await request("/api/picks/v2", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-CourtEdge-CSRF": loginData.csrfToken!,
    },
  });
  assert.equal(authorized.status, 200);

  const legacy = await request("/api/picks/sync", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-CourtEdge-CSRF": loginData.csrfToken!,
    },
  });
  assert.equal(legacy.status, 410);

  const disallowed = await fetch(`${base}/api/auth/session`, {
    headers: { Origin: "https://attacker.invalid" },
  });
  assert.equal(disallowed.status, 403);

  console.log("PASS: session login, HttpOnly cookie, CORS credentials, CSRF and legacy sync guard verified");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

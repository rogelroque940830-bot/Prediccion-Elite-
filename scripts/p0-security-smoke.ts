import http from "node:http";
import express from "express";

process.env.NODE_ENV = "production";
process.env.COURTEDGE_ALLOWED_ORIGINS = "https://staging.example";
process.env.COURTEDGE_WRITE_TOKEN = "test-write-token-with-sufficient-length";
process.env.ALLOW_LEGACY_PICKS_SYNC = "false";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.RATE_LIMIT_READ_MAX = "2";
process.env.RATE_LIMIT_WRITE_MAX = "10";

const {
  apiRateLimit,
  requireWriteAuth,
  restrictedCors,
  securityHeaders,
} = await import("../server/security.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const app = express();
app.set("trust proxy", 1);
app.use(securityHeaders);
app.use(restrictedCors);
app.use(apiRateLimit);
app.use(requireWriteAuth);
app.use(express.json());

app.get("/api/read", (_req, res) => res.json({ success: true }));
app.post("/api/picks/v2", (_req, res) => res.json({ success: true }));
app.post("/api/picks/sync", (_req, res) => res.json({ success: true }));

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object", "server did not bind");
const base = `http://127.0.0.1:${address.port}`;

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, init);
}

try {
  const unapproved = await request("/api/read", {
    headers: { Origin: "https://attacker.example" },
  });
  assert(unapproved.status === 403, `unapproved origin expected 403, got ${unapproved.status}`);

  const approved = await request("/api/read", {
    headers: { Origin: "https://staging.example" },
  });
  assert(approved.status === 200, `approved origin expected 200, got ${approved.status}`);
  assert(
    approved.headers.get("access-control-allow-origin") === "https://staging.example",
    "approved origin was not echoed exactly",
  );
  assert(approved.headers.get("x-content-type-options") === "nosniff", "security headers missing");

  const unauthorized = await request("/api/picks/v2", {
    method: "POST",
    headers: { Origin: "https://staging.example", "Content-Type": "application/json" },
    body: "{}",
  });
  assert(unauthorized.status === 401, `unauthorized write expected 401, got ${unauthorized.status}`);

  const legacy = await request("/api/picks/sync", {
    method: "POST",
    headers: {
      Origin: "https://staging.example",
      Authorization: `Bearer ${process.env.COURTEDGE_WRITE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert(legacy.status === 410, `legacy sync expected 410, got ${legacy.status}`);

  const authorized = await request("/api/picks/v2", {
    method: "POST",
    headers: {
      Origin: "https://staging.example",
      "X-CourtEdge-Write-Key": process.env.COURTEDGE_WRITE_TOKEN!,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert(authorized.status === 200, `authorized write expected 200, got ${authorized.status}`);

  const secondRead = await request("/api/read", {
    headers: { Origin: "https://staging.example" },
  });
  assert(secondRead.status === 200, `second read expected 200, got ${secondRead.status}`);

  const limited = await request("/api/read", {
    headers: { Origin: "https://staging.example" },
  });
  assert(limited.status === 429, `third read expected 429, got ${limited.status}`);
  assert(limited.headers.get("retry-after"), "429 response missing Retry-After");

  console.log("PASS: P0 CORS, headers, write auth, legacy guard and rate limit verified");
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

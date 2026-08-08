import process from "node:process";

const args = new Set(process.argv.slice(2));
const extended = args.has("--extended");
const rawBase = process.env.COURTEDGE_API_BASE_URL || process.env.VITE_API_BASE_URL || "";
const base = rawBase.trim().replace(/\/+$/, "");
if (!base) {
  console.error("FAIL: define COURTEDGE_API_BASE_URL or VITE_API_BASE_URL");
  process.exit(2);
}

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 30000);
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, validate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "CourtEdge-Sprint2-Smoke/1.0" },
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; }
    catch { throw new Error(`non-JSON response (${text.slice(0, 120)})`); }
    assert(response.ok, `HTTP ${response.status}`);
    const cors = response.headers.get("access-control-allow-origin");
    assert(cors === "*" || cors === null, `unexpected CORS header: ${cors}`);
    validate?.(body);
    results.push({ path, ok: true, status: response.status, ms: Date.now() - started, bytes: Buffer.byteLength(text) });
  } catch (error) {
    results.push({ path, ok: false, ms: Date.now() - started, error: String(error?.message || error) });
  } finally {
    clearTimeout(timer);
  }
}

await request("/", body => {
  assert(body?.status === "ok", "root.status must equal ok");
  assert(body?.service === "CourtEdge Backend", "root.service mismatch");
});
await request("/health", body => assert(body?.status === "healthy", "health.status must equal healthy"));
await request("/api/picks", body => assert(body?.success === true, "legacy picks envelope invalid"));
await request("/api/picks/v2?days=1&minConfidence=0", body => {
  assert(body?.success === true, "picks v2 envelope invalid");
  assert(Array.isArray(body?.data), "picks v2 data must be an array");
});

if (extended) {
  const date = process.env.SMOKE_DATE || new Date().toISOString().slice(0, 10);
  await request(`/api/mlb/all?date=${encodeURIComponent(date)}`, body => {
    assert(body?.success === true, "MLB all envelope invalid");
    assert(Array.isArray(body?.games), "MLB all games must be an array");
  });
}

console.log(JSON.stringify({ base, extended, results }, null, 2));
if (results.some(r => !r.ok)) process.exit(1);
console.log("PASS: Court Edge backend smoke checks completed.");

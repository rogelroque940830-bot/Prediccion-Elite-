from pathlib import Path

path = Path("server/routes.ts")
text = path.read_text(encoding="utf-8")

start_marker = '  app.get("/api/wnba/all", async (req, res) => {'
end_marker = '  // ── GET /api/wnba/games'
start = text.index(start_marker)
end = text.index(end_marker, start)
section = text[start:end]

old_catch = '''    } catch (e) {
      console.error("wnba error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener datos WNBA" });
    }
  });

'''

new_catch = '''    } catch (e) {
      console.error("wnba direct source error", e);
      try {
        const fallbackUrl = (process.env.WNBA_READONLY_FALLBACK_URL || "https://web-production-7067b.up.railway.app/api/wnba/all").trim();
        const currentHost = (req.get("host") || "").toLowerCase();
        if (currentHost && fallbackUrl.toLowerCase().includes(currentHost)) {
          throw new Error("Refusing recursive WNBA fallback");
        }

        const fallbackData = await withCache("wnba-all-production-fallback-v1", async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            const fallbackRes = await fetch(fallbackUrl, {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            if (!fallbackRes.ok) {
              throw new Error(`WNBA fallback HTTP ${fallbackRes.status}`);
            }
            const payload: any = await fallbackRes.json();
            if (!payload?.success || !Array.isArray(payload.data) || payload.data.length === 0) {
              throw new Error("WNBA fallback returned invalid or empty data");
            }
            return payload.data;
          } finally {
            clearTimeout(timer);
          }
        });

        return res.json({
          success: true,
          data: fallbackData,
          source: "production-readonly-fallback",
        });
      } catch (fallbackError) {
        console.error("wnba production fallback error", fallbackError);
        return res.status(500).json({ success: false, error: "No se pudieron obtener datos WNBA" });
      }
    }
  });

'''

if old_catch not in section:
    if 'source: "production-readonly-fallback"' in section:
        raise SystemExit("WNBA production fallback already applied")
    raise SystemExit("WNBA /all catch block not found")

section = section.replace(old_catch, new_catch, 1)
text = text[:start] + section + text[end:]
path.write_text(text, encoding="utf-8")
print("Added validated read-only production fallback to /api/wnba/all")

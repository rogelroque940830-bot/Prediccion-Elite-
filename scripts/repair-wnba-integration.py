from pathlib import Path

ROUTES = Path("server/routes.ts")
FRONTEND = Path("frontend/client/src/pages/wnba-predictor.tsx")

routes = ROUTES.read_text(encoding="utf-8")

# Add a validated, read-only production fallback to WNBA fatigue so Days Rest,
# B2B and streak can auto-fill exactly as they do in the Perplexity deployment.
fatigue_start_marker = '  app.get("/api/wnba/fatigue", async (req, res) => {'
fatigue_end_marker = '  // ── WNBA Player Stats'
fatigue_start = routes.index(fatigue_start_marker)
fatigue_end = routes.index(fatigue_end_marker, fatigue_start)
fatigue_section = routes[fatigue_start:fatigue_end]

old_fatigue_catch = '''    } catch (e) {
      console.error("wnba fatigue error", e);
      res.status(500).json({ success: false, error: "No se pudo calcular fatigue WNBA" });
    }
  });

'''

new_fatigue_catch = '''    } catch (e) {
      console.error("wnba fatigue direct source error", e);
      try {
        const fallbackUrl = (process.env.WNBA_READONLY_FATIGUE_FALLBACK_URL || "https://web-production-7067b.up.railway.app/api/wnba/fatigue").trim();
        const currentHost = (req.get("host") || "").toLowerCase();
        if (currentHost && fallbackUrl.toLowerCase().includes(currentHost)) {
          throw new Error("Refusing recursive WNBA fatigue fallback");
        }

        const fallbackData = await withCache("wnba-fatigue-production-fallback-v1", async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            const fallbackRes = await fetch(fallbackUrl, {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            if (!fallbackRes.ok) {
              throw new Error(`WNBA fatigue fallback HTTP ${fallbackRes.status}`);
            }
            const payload: any = await fallbackRes.json();
            if (!payload?.success || !Array.isArray(payload.data) || payload.data.length === 0) {
              throw new Error("WNBA fatigue fallback returned invalid or empty data");
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
        console.error("wnba fatigue production fallback error", fallbackError);
        return res.status(500).json({ success: false, error: "No se pudo calcular fatigue WNBA" });
      }
    }
  });

'''

if old_fatigue_catch in fatigue_section:
    fatigue_section = fatigue_section.replace(old_fatigue_catch, new_fatigue_catch, 1)
elif 'source: "production-readonly-fallback"' not in fatigue_section:
    raise SystemExit("WNBA fatigue catch block not found")

routes = routes[:fatigue_start] + fatigue_section + routes[fatigue_end:]
ROUTES.write_text(routes, encoding="utf-8")

frontend = FRONTEND.read_text(encoding="utf-8")

old_validation = '''    const requiredStats = [
      homeNetRtg, homeOffRtg, homeDefRtg, homePace, homeDaysRest, homeWinRate,
      awayNetRtg, awayOffRtg, awayDefRtg, awayPace, awayDaysRest, awayWinRate,
    ];
    const hasInvalidRequiredStats = requiredStats.some((value) =>
      value.trim() === "" || !Number.isFinite(Number(value))
    );
    if (!homeTeam || !awayTeam || homeTeam === awayTeam || hasInvalidRequiredStats) {
      toast({
        title: "Faltan datos WNBA",
        description: homeTeam === awayTeam
          ? "Selecciona dos equipos diferentes."
          : "Selecciona ambos equipos y completa NetRtg, OffRtg, DefRtg, Pace, descanso y Win Rate con datos verificados.",
      });
      return;
    }
'''

new_validation = '''    const requiredStats = [
      { label: "NetRtg Local", value: homeNetRtg },
      { label: "OffRtg Local", value: homeOffRtg },
      { label: "DefRtg Local", value: homeDefRtg },
      { label: "Pace Local", value: homePace },
      { label: "Descanso Local", value: homeDaysRest },
      { label: "Win Rate Local", value: homeWinRate },
      { label: "NetRtg Visitante", value: awayNetRtg },
      { label: "OffRtg Visitante", value: awayOffRtg },
      { label: "DefRtg Visitante", value: awayDefRtg },
      { label: "Pace Visitante", value: awayPace },
      { label: "Descanso Visitante", value: awayDaysRest },
      { label: "Win Rate Visitante", value: awayWinRate },
    ];
    const missingStats = requiredStats
      .filter(({ value }) => value.trim() === "" || !Number.isFinite(Number(value)))
      .map(({ label }) => label);
    if (!homeTeam || !awayTeam || homeTeam === awayTeam || missingStats.length > 0) {
      const description = !homeTeam || !awayTeam
        ? "Selecciona el equipo Local y el Visitante."
        : homeTeam === awayTeam
          ? "Selecciona dos equipos diferentes."
          : `Faltan: ${missingStats.join(", ")}.`;
      toast({ title: "Faltan datos WNBA", description });
      return;
    }
'''

if old_validation in frontend:
    frontend = frontend.replace(old_validation, new_validation, 1)
elif "const missingStats = requiredStats" not in frontend:
    raise SystemExit("WNBA prediction validation block not found")

FRONTEND.write_text(frontend, encoding="utf-8")
print("WNBA fatigue fallback and exact missing-field validation applied")
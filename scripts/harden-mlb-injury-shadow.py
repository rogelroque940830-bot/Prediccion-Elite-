from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

module = Path("server/mlb-injury-shadow.ts")
text = module.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''  highConfidence: number;
  mode: "SHADOW";
''',
    '''  highConfidence: number;
  officialOnly: number;
  mode: "SHADOW";
''',
    "summary official-only field",
)
text = replace_once(
    text,
    '''  if (isLongTermIl(code, description)) {
    return result(
      "IGNORE",
      "HIGH",
      "LOW",
      "LONG_TERM_IL_ALREADY_ADAPTED",
      "MLB confirma una ausencia de larga duración; el roster, las estadísticas y el mercado ya han tenido tiempo de adaptarse.",
    );
  }
''',
    '''  if (isLongTermIl(code, description)) {
    if (daysSinceTransaction !== null && daysSinceTransaction >= 21) {
      return result(
        "IGNORE",
        "HIGH",
        "LOW",
        "LONG_TERM_IL_ALREADY_ADAPTED",
        "MLB confirma una ausencia de larga duración y al menos tres semanas desde la transacción oficial; el entorno ya tuvo tiempo de adaptarse.",
      );
    }
    return result(
      "PENDING",
      "MEDIUM",
      "LOW",
      "LONG_TERM_IL_NEEDS_AGE_CONFIRMATION",
      "La lista de 60 días confirma una ausencia importante, pero la transacción visible es reciente y no basta para medir cuánto tiempo real lleva fuera.",
    );
  }
''',
    "conservative D60 handling",
)
text = replace_once(
    text,
    '''    if (role === "STARTER") {
      return result(
        "ALREADY_REFLECTED",
        "HIGH",
        "HIGH",
        "STARTER_REPLACEMENT_CAPTURED",
        "La ausencia del abridor queda capturada al usar las estadísticas del pitcher sustituto anunciado.",
      );
    }
''',
    '''    if (role === "STARTER") {
      if (input.probablePitcherId) {
        return result(
          "ALREADY_REFLECTED",
          "HIGH",
          "HIGH",
          "STARTER_REPLACEMENT_CAPTURED",
          "La ausencia del abridor queda capturada al usar las estadísticas del pitcher sustituto anunciado.",
        );
      }
      return result(
        "PENDING",
        "HIGH",
        "HIGH",
        "STARTER_REPLACEMENT_UNCONFIRMED",
        "MLB confirma la ausencia del abridor, pero el sustituto todavía no está anunciado; no puede considerarse reflejada.",
      );
    }
''',
    "starter replacement confirmation",
)
text = replace_once(
    text,
    '''    highConfidence: results.filter((item) => item.confidence === "HIGH").length,
    mode: "SHADOW",
''',
    '''    highConfidence: results.filter((item) => item.confidence === "HIGH").length,
    officialOnly: 0,
    mode: "SHADOW",
''',
    "summary default official-only",
)
module.write_text(text, encoding="utf-8")

tests = Path("server/mlb-injury-shadow.test.ts")
test_text = tests.read_text(encoding="utf-8")
test_text = replace_once(
    test_text,
    '''test("60-day IL is ignored in shadow mode because the team has adapted", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "D60",
    rosterStatusDescription: "Injured 60-Day",
  }));
  assert.equal(result.decision, "IGNORE");
  assert.equal(result.reasonCode, "LONG_TERM_IL_ALREADY_ADAPTED");
});
''',
    '''test("recent 60-day IL stays pending until absence age is established", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "D60",
    rosterStatusDescription: "Injured 60-Day",
  }));
  assert.equal(result.decision, "PENDING");
  assert.equal(result.reasonCode, "LONG_TERM_IL_NEEDS_AGE_CONFIRMATION");
});

test("older 60-day IL is ignored after the environment has adapted", () => {
  const result = classifyMlbInjuryShadow(base({
    rosterStatusCode: "D60",
    rosterStatusDescription: "Injured 60-Day",
    latestTransaction: {
      date: "2026-06-01",
      effectiveDate: "2026-06-01",
      typeDesc: "Status Change",
      description: "Placed on the 60-day injured list.",
    },
  }));
  assert.equal(result.decision, "IGNORE");
  assert.equal(result.reasonCode, "LONG_TERM_IL_ALREADY_ADAPTED");
});
''',
    "D60 tests",
)
insert_anchor = '''test("injured pitcher simultaneously listed as probable becomes a conflict", () => {
'''
insert = '''test("starting pitcher remains pending while replacement is unconfirmed", () => {
  const result = classifyMlbInjuryShadow(base({
    playerId: 10,
    isPitcher: true,
    gamesStarted: 18,
    probablePitcherId: null,
  }));
  assert.equal(result.decision, "PENDING");
  assert.equal(result.reasonCode, "STARTER_REPLACEMENT_UNCONFIRMED");
});

'''
if insert_anchor not in test_text:
    raise SystemExit("starter pending test anchor missing")
test_text = test_text.replace(insert_anchor, insert + insert_anchor, 1)
test_text = replace_once(
    test_text,
    '''    highConfidence: 3,
    mode: "SHADOW",
''',
    '''    highConfidence: 3,
    officialOnly: 0,
    mode: "SHADOW",
''',
    "summary test official-only",
)
tests.write_text(test_text, encoding="utf-8")

routes = Path("server/routes.ts")
routes_text = routes.read_text(encoding="utf-8")
routes_text = replace_once(
    routes_text,
    '''          const autoApplyAllowed = teamStatus === "VERIFIED";
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            status: teamStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: injuryFeed.sourceErrors,
            count: rawBdlList.length,
            autoApplyAllowed,
            note: anomalous
              ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
              : teamStatus === "SOURCE_UNAVAILABLE"
                ? "Fuente de lesiones no disponible"
                : teamStatus === "PARTIAL"
                  ? "Datos de lesiones en caché/degradados; revisión manual requerida"
                  : rawBdlList.length === 0
                    ? "Fuente verificada: no hay ausencias activas reportadas"
                    : "Ausencias activas verificadas por la fuente",
          };

          const bdlList = anomalous ? [] : rawBdlList;
          if (bdlList.length === 0) {
            injuryMap[tid] = [];
            return;
          }
''',
    '''          const officialSnapshot = officialInjurySnapshots[tid];
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            validationSource: officialSnapshot?.source ?? "MLB_STATS",
            status: teamStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: [...(injuryFeed.sourceErrors ?? []), ...(officialSnapshot?.errors ?? [])],
            officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
            officialFetchedAt: officialSnapshot?.fetchedAt,
            count: rawBdlList.length,
            autoApplyAllowed: false,
            shadowMode: true,
            note: anomalous
              ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
              : teamStatus === "SOURCE_UNAVAILABLE"
                ? "Fuente de lesiones no disponible"
                : teamStatus === "PARTIAL"
                  ? "Datos de lesiones en caché/degradados; clasificación conservadora"
                  : rawBdlList.length === 0
                    ? "BALLDONTLIE no reporta ausencias; MLB se usa para comprobar cobertura"
                    : "Ausencias detectadas por BALLDONTLIE y enviadas a validación MLB",
          };

          const bdlList = anomalous ? [] : rawBdlList;
          if (bdlList.length === 0) {
            const officialIlEntries = Object.values(officialSnapshot?.rosterByPlayerId ?? {})
              .filter((entry: any) => /^D\\d+$/i.test(String(entry.statusCode || "")) || /injured/i.test(String(entry.statusDescription || "")));
            const officialOnly = anomalous ? 0 : officialIlEntries.length;
            const sourcesVerified = !anomalous
              && injuryFeed.status === "VERIFIED"
              && officialSnapshot?.status === "VERIFIED";
            injuryMap[tid] = [];
            injuryMetaMap[tid] = {
              ...injuryMetaMap[tid],
              status: anomalous ? "ANOMALOUS" : sourcesVerified && officialOnly === 0 ? "VERIFIED" : "PARTIAL",
              shadowSummary: {
                total: 0, applyCandidates: 0, alreadyReflected: 0,
                ignored: 0, conflicts: 0, pending: 0,
                highConfidence: 0, officialOnly, mode: "SHADOW",
              },
              note: anomalous
                ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
                : officialOnly > 0
                  ? `BALLDONTLIE no reportó ${officialOnly} jugador(es) que MLB mantiene en lista de lesionados; cobertura en revisión`
                  : "Ambas fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
            };
            return;
          }
''',
    "initial and empty injury metadata",
)
routes_text = replace_once(
    routes_text,
    '''          const officialSnapshot = officialInjurySnapshots[tid];
          const probablePitcherId = probablePitcherByTeam[tid] ?? null;
''',
    '''          const probablePitcherId = probablePitcherByTeam[tid] ?? null;
''',
    "remove duplicate official snapshot",
)
routes_text = replace_once(
    routes_text,
    '''          const shadowSummary = summarizeMlbInjuryShadow(shadowList.map((player: any) => player.shadow));
          injuryMap[tid] = shadowList;

          // Fase A: decide jugador por jugador, pero no altera proyección ni ledger.
          const identityComplete = injuryFeed.status === "VERIFIED" && rejectedCount === 0;
          const safeStatus = identityComplete && shadowList.length === 0 ? "VERIFIED" : "PARTIAL";
''',
    '''          const bdlPlayerIds = new Set(shadowList.map((player: any) => Number(player.playerId)));
          const officialOnly = Object.values(officialSnapshot?.rosterByPlayerId ?? {})
            .filter((entry: any) => /^D\\d+$/i.test(String(entry.statusCode || "")) || /injured/i.test(String(entry.statusDescription || "")))
            .filter((entry: any) => !bdlPlayerIds.has(Number(entry.playerId)))
            .length;
          const shadowSummary = {
            ...summarizeMlbInjuryShadow(shadowList.map((player: any) => player.shadow)),
            officialOnly,
          };
          injuryMap[tid] = shadowList;

          // Fase A: decide jugador por jugador, pero no altera proyección ni ledger.
          const identityComplete = injuryFeed.status === "VERIFIED"
            && officialSnapshot?.status === "VERIFIED"
            && rejectedCount === 0
            && officialOnly === 0;
          const safeStatus = identityComplete ? "VERIFIED" : "PARTIAL";
''',
    "coverage-aware summary and status",
)
routes.write_text(routes_text, encoding="utf-8")

frontend = Path("frontend/client/src/pages/mlb-predictor.tsx")
ui = frontend.read_text(encoding="utf-8")
ui = replace_once(
    ui,
    '''  highConfidence: number;
  mode: "SHADOW";
''',
    '''  highConfidence: number;
  officialOnly: number;
  mode: "SHADOW";
''',
    "frontend official-only summary type",
)
ui = replace_once(
    ui,
    '''                      <span>Confianza alta: <b>{injuryFeed.shadowSummary.highConfidence}</b></span>
''',
    '''                      <span>Confianza alta: <b>{injuryFeed.shadowSummary.highConfidence}</b></span>
                      <span>Solo en MLB: <b>{injuryFeed.shadowSummary.officialOnly}</b></span>
''',
    "frontend official-only count",
)
ui = ui.replace(
    '''                highConfidence: 0, mode: "SHADOW",
''',
    '''                highConfidence: 0, officialOnly: 0, mode: "SHADOW",
''',
)
frontend.write_text(ui, encoding="utf-8")

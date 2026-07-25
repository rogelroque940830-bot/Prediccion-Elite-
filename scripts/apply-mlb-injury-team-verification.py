from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


path = Path("server/routes.ts")
text = path.read_text(encoding="utf-8")

text = replace_once(
    text,
    '''              const people = lookupJson.people ?? [];
              // Filtrar por equipo correcto
              const match = people.find((p: any) => p.currentTeam?.id === tid) ?? people[0];
              const pid = match?.id;
              const positionAbbr = match?.primaryPosition?.abbreviation || (isPitcher ? "P" : pos.split(" ").map((w: string) => w[0]).join("").toUpperCase());
              if (!pid) {
                return {
                  name, position: positionAbbr, status: fullStatus, isPitcher,
                  returnDate, shortComment,
                  source: "BDL",
                };
              }''',
    '''              const people = lookupJson.people ?? [];
              // Verificación estricta: mismo nombre normalizado Y equipo MLB actual.
              // Nunca usar el primer resultado como fallback: eso mezclaba jugadores de otros clubes.
              const normalizePersonName = (value: string) => String(value || "")
                .normalize("NFD")
                .replace(/[\\u0300-\\u036f]/g, "")
                .replace(/[^a-z0-9]/gi, "")
                .toLowerCase();
              const targetName = normalizePersonName(name);
              const match = people.find((p: any) =>
                p.currentTeam?.id === tid && normalizePersonName(p.fullName) === targetName
              );
              const pid = match?.id;
              const positionAbbr = match?.primaryPosition?.abbreviation || (isPitcher ? "P" : pos.split(" ").map((w: string) => w[0]).join("").toUpperCase());
              if (!pid) return null;''',
    "remove cross-team player fallback",
)

text = text.replace(
    '''                const gamesMissed = Math.max(0, teamGP - playerGP);''',
    '''                // No inferir juegos perdidos con teamGP-playerGP: banca, menores, trades y descansos lo vuelven inválido.
                const gamesMissed = 0;''',
)
if text.count("const gamesMissed = 0;") != 2:
    raise RuntimeError(f"gamesMissed safety reset: expected 2 replacements, found {text.count('const gamesMissed = 0;')}")

text = replace_once(
    text,
    '''            } catch {
              return { name, position: pos, status: fullStatus, isPitcher, returnDate, shortComment, source: "BDL" };
            }
          }));
          injuryMap[tid] = list;''',
    '''            } catch {
              // Una búsqueda o enriquecimiento fallido no puede convertirse en una ausencia verificada.
              return null;
            }
          }));
          const verifiedList = list.filter(Boolean) as any[];
          const rejectedCount = rawBdlList.length - verifiedList.length;
          injuryMap[tid] = verifiedList;

          // Con ausencias presentes todavía no tenemos duración oficial verificable.
          // Se muestran para revisión, pero jamás se aplican automáticamente al modelo.
          const identityComplete = injuryFeed.status === "VERIFIED" && rejectedCount === 0;
          const safeStatus = identityComplete && verifiedList.length === 0 ? "VERIFIED" : "PARTIAL";
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            status: safeStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: injuryFeed.sourceErrors,
            count: verifiedList.length,
            rejectedCount,
            autoApplyAllowed: false,
            note: rejectedCount > 0
              ? `${rejectedCount} registro(s) descartado(s) por no coincidir con el equipo MLB actual; ajuste automático bloqueado`
              : verifiedList.length > 0
                ? "Jugador y equipo verificados; duración real de la ausencia no verificada. Selección manual requerida"
                : "Fuente verificada: no hay ausencias activas confirmadas para este equipo",
          };''',
    "filter and downgrade unverifiable injury records",
)

path.write_text(text, encoding="utf-8")
print("Strict MLB injury team verification applied")

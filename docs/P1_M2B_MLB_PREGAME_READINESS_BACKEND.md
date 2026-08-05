# P1-M2B — Agregador backend de readiness pregame MLB

## Objetivo

Implementar el contrato P1-M2A como una evaluación runtime por `gamePk` y mercado, sin modificar el motor predictivo.

## Endpoint

`GET /api/mlb/p1/v1/pregame-readiness?gamePk=<id>&market=<market>&date=YYYY-MM-DD`

Mercados válidos:

- `ML`
- `F5_ML`
- `RUN_LINE`
- `TOTAL`
- `F5_TOTAL`

La fecha es opcional. Si no se proporciona, el servidor resuelve la fecha oficial desde MLB `feed/live`.

## Captura manual de cuotas

El endpoint admite una captura manual explícita mediante:

- `oddsMode=manual`
- `manualBook`
- `manualCapturedAt`
- `manualLine`, cuando el mercado tiene línea
- `manualHomeOdds` y `manualAwayOdds` para mercados laterales
- `manualOverOdds` y `manualUnderOdds` para totales

La captura manual se valida por mercado y queda identificada como `USER_VERIFIED_MARKET_SNAPSHOT`. Una captura con más de cinco minutos bloquea el análisis.

## Fuentes

El agregador reutiliza:

- P1-M1 authoritative daily slate para identidad, estado, pitchers y lineups;
- `/api/mlb/all` para lesiones y códigos de equipos;
- `/api/odds/mlb` o `/api/odds/mlb/f5` para el mercado seleccionado;
- únicamente los endpoints derivados requeridos por el mercado.

## Envelope de evidencia

Cada campo devuelve:

- estado `FRESH`, `STALE`, `DEGRADED`, `MISSING`, `CONFLICT` o `UNKNOWN`;
- fuente y endpoint;
- `fetchedAt` y `observedAt`;
- edad y ventana máxima;
- calidad, estado de fuente, detalles y errores.

Los endpoints derivados que responden correctamente pero no incluyen timestamp explícito se marcan `DEGRADED`. No se interpretan silenciosamente como impacto cero ni se presentan como frescos.

## Decisión

La respuesta aplica directamente el contrato P1-M2A:

- `READY_FINAL`
- `READY_PROVISIONAL`
- `BLOCKED`

Identidad, pitchers y cuotas son bloqueos duros. Lineups, lesiones y requisitos específicos del mercado determinan FINAL frente a PROVISIONAL.

## Identidad y doubleheaders

Las cuotas se vinculan por equipos y hora de comienzo. Cuando hay más de un partido entre los mismos equipos, se selecciona la hora más cercana. Una identidad ambigua o una diferencia mayor de seis horas produce `CONFLICT` y bloquea el mercado.

## Seguridad

- `SHADOW_DECISION_SUPPORT`
- exposición financiera 0
- sin apuestas automáticas
- sin cambios automáticos de modelo
- sin promoción automática
- sin cambios en fórmulas, probabilidades, thresholds, stakes, ledger o settlement

## Límite de P1-M2B

Esta fase crea el backend autoritativo. No modifica todavía la pantalla del predictor. P1-M2C deberá consumir este endpoint, mostrar la matriz de evidencia y controlar visualmente `Generar Predicción`.

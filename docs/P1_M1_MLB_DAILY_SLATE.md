# P1-M1 — Jornada MLB y selección del partido

## Objetivo

Crear una entrada diaria ligera y verificable para el flujo del predictor. La jornada debe indicar qué juegos existen, cuándo comienzan, qué pitchers probables están identificados, si los lineups oficiales están publicados y si corresponde abrir un análisis FINAL, PROVISIONAL o bloquearlo.

## Endpoint

`GET /api/mlb/p1/v1/slate?date=YYYY-MM-DD`

## Fuente

- MLB Stats API schedule para enumerar la jornada.
- MLB Stats API `feed/live` por `gamePk` para evitar errores de identidad de pitchers en doubleheaders y verificar estado, pitchers y batting orders.

## Readiness

- `READY_TO_ANALYZE`: ambos pitchers y dos lineups oficiales de nueve jugadores; análisis FINAL permitido.
- `PROVISIONAL_WAITING_FOR_LINEUPS`: ambos pitchers, pero lineups no confirmados; análisis PROVISIONAL permitido.
- `WAITING_FOR_PITCHERS`: falta uno o ambos pitchers; análisis bloqueado.
- `GAME_ALREADY_STARTED`: el juego comenzó; nueva predicción pregame bloqueada.
- `GAME_CLOSED`: final, pospuesto, cancelado o suspendido.
- `DATA_INSUFFICIENT`: la fuente por juego no pudo verificarse completamente.

## Límites de M1

M1 no calcula probabilidades, edges, cuotas justas ni recomendaciones. Tampoco carga lesiones, clima avanzado, bullpen, Statcast ni mercados. Esos datos continúan en el flujo de análisis completo y se abordarán en P1-M2/P1-M3.

## Seguridad

- `SHADOW_DECISION_SUPPORT`
- exposición financiera 0
- sin integración con sportsbook
- sin apuesta automática
- sin cambios de modelo
- sin promoción automática
- sin cambios en fórmulas, probabilidades, señales, mercados, umbrales o stakes

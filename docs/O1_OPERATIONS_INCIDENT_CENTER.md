# O1 — Centro de Operaciones e Incidencias

## Objetivo

O1 crea una vista operativa unificada para distinguir partidos legítimamente pendientes de fallas reales de procesamiento. No modifica el predictor, no fabrica resultados y no reescribe historiales.

## Endpoint

`GET /api/ops/v1/incident-center`

Parámetros opcionales:

- `limit`: máximo de incidencias devueltas, entre 1 y 1000;
- `includeResolved=true`: incluye ciclos ya resueltos para auditoría.

La ruta está protegida por la autenticación privada global existente y devuelve únicamente datos del usuario autenticado para el ledger MLB y los historiales manuales.

## Estados normalizados

- `WAITING_FOR_PREGAME_DATA`
- `WAITING_FOR_FINAL_CAPTURE`
- `GAME_IN_PROGRESS`
- `WAITING_FOR_OFFICIAL_FINAL`
- `READY_FOR_SETTLEMENT`
- `SETTLEMENT_OVERDUE`
- `DATA_QUALITY_REVIEW`
- `CORRECTION_REQUIRED`
- `RESOLVED`

Cada incidencia incluye liga, juego, fecha, equipos, worker responsable, fuente, nivel de evidencia, motivo, antigüedad y siguiente acción permitida.

## Cobertura por liga

### MLB

Fuente autoritativa: ledger científico inmutable y eventos append-only de settlement. Los registros se agrupan por juego para evitar que varios mercados aparezcan como partidos duplicados.

### WNBA

Fuente autoritativa: registros y settlement events del pipeline shadow S6C. Los juegos activos se mantienen separados de los settlements vencidos.

### NBA y NHL

Fuente limitada: historial manual del usuario. Como todavía no existe un feed operativo oficial de estado y settlement para estas ligas, O1 lo declara expresamente y no presenta las estimaciones temporales como evidencia autoritativa.

## Salud de workers

O1 muestra estados normalizados:

- `HEALTHY`
- `STARTING`
- `STALE`
- `ERROR`
- `DISABLED`
- `UNINSTRUMENTED`
- `MANUAL_ONLY`

WNBA usa su heartbeat real. MLB identifica honestamente que el worker automático todavía no publica un heartbeat estructurado, aunque sus casos sí se reconstruyen desde el ledger. NBA y NHL aparecen como flujos manuales, no como workers fallidos.

## Compuertas de seguridad

O1 es exclusivamente de lectura:

- modo `OBSERVE_ONLY`;
- exposición financiera 0;
- sin apuestas automáticas;
- sin reintentos automáticos de settlement;
- sin mutación histórica;
- sin cambios automáticos del modelo;
- sin promoción automática.

Las acciones de reprocesamiento seguro pertenecen a O3 y no se implementan en esta fase.

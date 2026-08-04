# O3 — Reprocesamiento seguro y controlado

## Objetivo

O3 permite resolver manualmente una incidencia operativa MLB cuando el ciclo normal de settlement no la completó. No es un worker de reintento y no ejecuta acciones automáticamente.

## Flujo obligatorio

1. El operador selecciona una sola incidencia O1.
2. O3 crea una vista previa inmutable.
3. La vista previa reconstruye únicamente registros propiedad del usuario.
4. Se consulta nuevamente la fuente oficial MLB.
5. Se calcula el resultado con las reglas existentes de `gradeMlbPrediction`.
6. Se sellan las identidades, propuestas, evidencia oficial y precondiciones con SHA-256.
7. La ejecución exige administrador, plan vigente, digest exacto, idempotency key, motivo y frase literal `REPROCESS_ONE_MLB_GAME`.
8. Antes de escribir se vuelve a consultar la fuente oficial y se comprueba que no exista drift.
9. Cada resultado se agrega como un nuevo evento de settlement y se verifica inmediatamente después de la escritura.
10. Todo el ciclo queda registrado en un journal append-only encadenado por digest.

## Alcance inicial

O3 admite únicamente MLB porque dispone de:

- evidencia oficial autoritativa;
- reglas de settlement existentes y probadas;
- ledger inmutable;
- eventos idempotentes;
- ownership por usuario.

WNBA, NBA y NHL fallan cerrados hasta que exista un ejecutor equivalente con evidencia autoritativa y pruebas propias.

## Incidencias elegibles

- `READY_FOR_SETTLEMENT`
- `SETTLEMENT_OVERDUE`

Se bloquean:

- evidencia `LIMITED`;
- ligas no soportadas;
- registros no FINAL;
- datos incompletos;
- mercado ambiguo o no soportado;
- final oficial ausente;
- más de 50 registros en un solo partido;
- cambios en identidad, settlement o evidencia después de la vista previa;
- plan expirado;
- digest, confirmación o idempotency key inválidos.

## Rutas privadas

- `GET /api/ops/v1/reprocessing/status`
- `GET /api/ops/v1/reprocessing/audit`
- `GET /api/ops/v1/reprocessing/plans/:planId`
- `POST /api/ops/v1/reprocessing/preview`
- `POST /api/ops/v1/reprocessing/execute`

La vista previa requiere rol admin o analyst. La ejecución requiere administrador.

## Persistencia

Los planes y ejecuciones se escriben con creación exclusiva. El journal contiene:

- `PREVIEW_CREATED`
- `PREVIEW_BLOCKED`
- `EXECUTION_STARTED`
- `SETTLEMENT_APPENDED`
- `SETTLEMENT_IDEMPOTENT`
- `EXECUTION_COMPLETED`
- `EXECUTION_BLOCKED`
- `EXECUTION_FAILED`

Los eventos de auditoría incluyen `previousDigest` y `eventDigest` para detectar alteraciones.

## Seguridad

- `SHADOW_CONTROLLED_REPROCESSING`;
- exposición financiera 0;
- un partido por plan;
- sin ejecución automática;
- sin reintentos programados;
- sin apuestas;
- sin cambios de fórmulas, probabilidades, señales, mercados o stakes;
- sin UPDATE o DELETE del ledger;
- solo nuevos eventos append-only;
- sin promoción automática.

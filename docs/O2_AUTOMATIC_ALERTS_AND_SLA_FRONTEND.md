# O2 — Consola de alertas automáticas y SLA

## Objetivo

La vista privada `#/operations` amplía O1 con el ciclo operativo de O2. Presenta alertas activas, historial append-only, mediciones de SLA y estado del worker automático sin ejecutar ninguna acción de settlement.

## Vistas

### Alertas SLA

Es la vista inicial y muestra:

- alertas activas o historial completo;
- severidad WARNING o CRITICAL;
- evento `OPENED`, `ESCALATED`, `REMINDER` o `RESOLVED`;
- liga, juego o worker afectado;
- política y deadline del SLA;
- tiempo observado y tiempo excedido;
- siguiente acción segura;
- entrega por webhook cuando esté configurada.

### Incidencias O1

Conserva la cola unificada por partido y sus filtros de liga, estado y severidad.

### Workers

Mantiene la salud de workers y diferencia heartbeat real, worker no instrumentado y flujo manual.

### Cobertura

Explica qué ligas tienen evidencia autoritativa. Para NBA y NHL, la consola indica que O2 suprime alertas temporales basadas únicamente en evidencia limitada.

## Estado del worker O2

El panel superior muestra:

- último ciclo y último éxito;
- candidatos detectados;
- eventos emitidos;
- alertas activas, críticas y WARNING;
- alertas temporales suprimidas por evidencia limitada;
- estado del webhook;
- último error, si existe.

## Comportamiento fail-closed

La consola consulta:

- `GET /api/ops/v1/incident-center?limit=500`
- `GET /api/ops/v1/sla-alerts?limit=500`

Si la API de O2 no está desplegada o falla, el frontend presenta el error y no genera alertas localmente. La interfaz no llama al endpoint administrativo de evaluación.

## Seguridad

La interfaz verifica las compuertas O1 y O2:

- `OBSERVE_ONLY`;
- solo lectura;
- exposición financiera 0;
- sin apuestas automáticas;
- sin reintentos automáticos de settlement;
- sin mutación histórica;
- sin cambios automáticos del modelo;
- sin promoción automática.

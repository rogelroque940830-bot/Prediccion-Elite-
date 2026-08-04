# O2 — Alertas automáticas y SLA

## Objetivo

O2 convierte los estados normalizados de O1 en alertas operativas accionables. Su función es detectar vencimientos, escalar condiciones persistentes, recordar alertas abiertas y registrar cuándo una condición queda resuelta.

O2 no liquida partidos, no reintenta settlements, no modifica el ledger y no cambia el predictor.

## Fuente de verdad

O2 consume exclusivamente el reporte de O1:

- MLB: ledger científico inmutable y settlement events append-only;
- WNBA: registros y settlements del pipeline shadow;
- NBA/NHL: historial manual con evidencia limitada.

Las alertas temporales de settlement se suprimen para evidencia `LIMITED`. Los bloqueos de calidad de datos sí se alertan, porque requieren revisión aunque la fuente sea manual.

## Ciclo append-only

Cada alerta usa una clave estable y genera eventos inmutables:

- `OPENED`: aparece una condición nueva;
- `ESCALATED`: la misma condición aumenta de WARNING a CRITICAL;
- `REMINDER`: la condición continúa abierta después del intervalo configurado;
- `RESOLVED`: la condición ya no aparece en O1.

Los eventos se guardan por usuario en archivos JSONL separados. O2 nunca actualiza ni elimina eventos anteriores.

## Políticas iniciales

### Captura FINAL

Para evidencia autoritativa, se abre WARNING cuando falta la captura FINAL dentro de los 45 minutos previos al inicio. Escala a CRITICAL dentro de los 10 minutos previos.

### Settlement vencido

O1 considera vencido un settlement después de su ventana normal. O2 abre WARNING y escala a CRITICAL cuando la violación supera seis horas adicionales.

### Final oficial listo

Cuando O1 exponga `READY_FOR_SETTLEMENT`, O2 abre WARNING y escala a CRITICAL después de 60 minutos sin resolución.

### Calidad y correcciones

`DATA_QUALITY_REVIEW` y `CORRECTION_REQUIRED` generan CRITICAL inmediatamente.

### Workers

- `ERROR`: CRITICAL inmediato;
- `STALE`: WARNING, con escalamiento si el atraso es extremo;
- `DISABLED`: alerta únicamente cuando existen incidencias abiertas relacionadas;
- `UNINSTRUMENTED`: no se presenta como fallo;
- `MANUAL_ONLY`: no se presenta como fallo.

## Rutas privadas

- `GET /api/ops/v1/sla-alerts`
- `GET /api/ops/v1/sla-status`
- `POST /api/ops/v1/sla-alerts/evaluate` — solo administrador o servicio autorizado.

Parámetros de lectura:

- `limit`: entre 1 y 1000;
- `activeOnly=true`: devuelve solamente ciclos de alerta activos.

## Worker automático

El worker evalúa cada cinco minutos por defecto y comienza después de dos minutos. Se puede deshabilitar con:

`COURTEDGE_O2_SLA_ALERTS_ENABLED=false`

Variables configurables:

- `COURTEDGE_O2_SLA_ALERT_INTERVAL_MS`
- `COURTEDGE_O2_SLA_ALERT_INITIAL_DELAY_MS`
- `COURTEDGE_O2_WARNING_REMINDER_MS`
- `COURTEDGE_O2_CRITICAL_REMINDER_MS`
- `COURTEDGE_O2_FINAL_CAPTURE_WARNING_MINUTES`
- `COURTEDGE_O2_FINAL_CAPTURE_CRITICAL_MINUTES`
- `COURTEDGE_O2_SETTLEMENT_CRITICAL_AFTER_MINUTES`
- `COURTEDGE_O2_READY_CRITICAL_AFTER_MINUTES`
- `COURTEDGE_O2_ALERT_WEBHOOK_URL`

Si no existe un webhook específico de O2, se reutiliza `COURTEDGE_ALERT_WEBHOOK_URL`.

## Seguridad

O2 permanece en `OBSERVE_ONLY`:

- exposición financiera 0;
- sin apuestas automáticas;
- sin reintentos automáticos de settlement;
- sin mutación histórica;
- sin cambios automáticos del modelo;
- sin promoción automática.

Las acciones de reprocesamiento seguro pertenecen a O3 y no forman parte de esta etapa.

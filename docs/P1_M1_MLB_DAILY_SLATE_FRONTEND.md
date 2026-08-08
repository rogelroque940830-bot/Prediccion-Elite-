# P1-M1 — Jornada MLB accionable

## Objetivo

Convertir la entrada de MLB Predictor en un flujo de selección diario. La jornada se carga automáticamente y presenta primero los juegos que pueden analizarse con datos oficiales suficientes.

## Flujo visible

1. Cargar automáticamente la fecha de Florida.
2. Mostrar resumen: total, FINAL, provisional y sin pitchers.
3. Priorizar `READY_TO_ANALYZE`.
4. Mostrar equipos, hora ET, estadio, pitchers y estado de lineups.
5. Permitir `Analizar partido` cuando el análisis puede ser FINAL.
6. Permitir `Analizar provisional` cuando existen pitchers pero faltan lineups completos.
7. Bloquear juegos iniciados, cerrados, sin pitchers o con fuente degradada.
8. Reutilizar el auto-llenado y el motor MLB existentes para cargar el análisis completo del juego seleccionado.

## Integridad

La pantalla consume `GET /api/mlb/p1/v1/slate` y falla cerrada cuando el esquema o las compuertas SHADOW no son válidas. No calcula probabilidades en la tarjeta de jornada y no crea predicciones al cargar o refrescar.

## Seguridad

- `SHADOW_DECISION_SUPPORT`
- exposición financiera 0
- sin apuestas automáticas
- sin cambios automáticos de modelo
- sin cambios de fórmulas, probabilidades, señales, mercados, umbrales o stakes

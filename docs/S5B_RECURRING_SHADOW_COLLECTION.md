# S5B — Recolección recurrente en modo sombra

## Objetivo

Recolectar evidencia acumulada del ledger MLB en `p0-integration` sin crear apuestas, sin integrar una casa deportiva y sin cambiar fórmulas, filtros, umbrales ni política de stake.

## Activación

El worker se activa automáticamente únicamente cuando:

- `RAILWAY_ENVIRONMENT_NAME=p0-integration`, o
- `MLB_SHADOW_COLLECTION_ENABLED=true`.

Se desactiva explícitamente con `MLB_SHADOW_COLLECTION_ENABLED=false`.

## Frecuencia y almacenamiento

- Frecuencia predeterminada: cada 6 horas.
- Primera ejecución: 45 segundos después del arranque.
- Directorio predeterminado: `/app/data/mlb-shadow-collection` en Railway.
- `latest.json` se actualiza en cada ejecución.
- Se crea un snapshot nuevo solo cuando cambia el estado semántico: decisiones, liquidaciones, closing line, cobertura o gate.
- Retención predeterminada: 90 días.
- Máximo predeterminado: 500 snapshots.

Variables opcionales:

- `MLB_SHADOW_COLLECTION_INTERVAL_MS`
- `MLB_SHADOW_COLLECTION_RETENTION_DAYS`
- `MLB_SHADOW_COLLECTION_MAX_SNAPSHOTS`
- `MLB_SHADOW_COLLECTION_DIR`

El intervalo nunca puede ser menor de 15 minutos.

## Endpoints privados

Requieren sesión autenticada o token de servicio:

- `GET /api/mlb/ledger/v1/shadow-collection/status`
- `GET /api/mlb/ledger/v1/shadow-collection/latest`

El endpoint `latest` devuelve `404` hasta completar la primera recolección.

## Invariantes de seguridad

Cada snapshot confirma:

- modo `SHADOW`;
- exposición financiera real `0`;
- sin sportsbook integration;
- sin colocación automática de apuestas;
- sin escrituras en producción;
- sin cambios de fórmulas;
- sin cambios de thresholds;
- sin cambios de stake policy.

Si cualquiera de estas condiciones cambia, la ejecución falla y no se considera válida.

## Criterio operativo

La recolección no promociona automáticamente mercados ni categorías. El gate solo puede producir `EXTEND`, `NO_GO` o `GO_REVIEW`; cualquier promoción requiere revisión humana y una fase posterior explícita.

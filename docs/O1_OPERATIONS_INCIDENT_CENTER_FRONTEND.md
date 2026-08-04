# O1 — Consola privada de Operaciones e Incidencias

## Objetivo

La pantalla `#/operations` consume la API privada de O1 y convierte los registros operativos en una cola comprensible por partido. Su propósito es explicar por qué un juego continúa pendiente y qué acción segura corresponde, sin modificar el predictor ni el historial.

## Acceso

- La opción **Operaciones** aparece únicamente durante una sesión autenticada.
- La página mantiene una compuerta de autenticación propia.
- Las solicitudes usan el cliente compartido con cookies de sesión.
- El backend aplica el aislamiento de datos por usuario.

## Vistas

### Incidencias

- resumen de abiertas, críticas y advertencias;
- búsqueda por equipo, juego, worker o motivo;
- filtros por liga, estado y severidad;
- una tarjeta por partido, no una tarjeta por cada mercado;
- motivo, fuente, antigüedad, worker y siguiente acción segura.

### Workers

Muestra el heartbeat disponible y diferencia entre:

- saludable;
- iniciando;
- atrasado;
- error;
- deshabilitado;
- sin instrumentación;
- flujo manual.

La ausencia de un heartbeat no se presenta falsamente como worker saludable.

### Cobertura

Explica qué ligas tienen evidencia autoritativa de settlement y cuáles dependen todavía de un historial manual con alcance limitado.

## Comportamiento fail-closed

Si la API O1 todavía no está desplegada, la pantalla muestra el error real y no inventa estados. La verificación de seguridad exige:

- `OBSERVE_ONLY`;
- solo lectura;
- exposición financiera 0;
- sin apuestas automáticas;
- sin cambios automáticos del modelo;
- sin promoción automática;
- sin mutación histórica;
- sin reintentos automáticos de settlement.

## Límites de esta fase

O1 permite observar y diagnosticar. La reejecución segura por partido, la emisión de correcciones y las acciones administrativas pertenecen a fases posteriores y no están disponibles en esta consola.

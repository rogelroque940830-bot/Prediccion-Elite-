# Fase 5C-8 / S6S — Consola privada de revisión humana MLB

## Objetivo

S6S presenta en el frontend privado la evidencia científica ya producida por S6Q y S6R. La consola no recalcula ni altera el predictor; únicamente lee artefactos certificados y registra decisiones humanas mediante el endpoint append-only existente de S6R.

## Acceso

- La navegación `Revisión MLB` solo aparece durante una sesión autenticada.
- La ruta `#/mlb-human-review` mantiene una compuerta de autenticación propia.
- Las lecturas y escrituras usan cookies de sesión y CSRF a través del cliente compartido.
- El backend conserva la autorización definitiva: solo el owner configurado puede registrar decisiones.

## Contenido

- progreso de S6Q hacia las primeras 50 decisiones elegibles;
- número de decisiones certificadas independientemente;
- estados S6Q y S6R;
- récord, win rate, Wilson 95%, Brier Score y Log Loss;
- ECE, MCE, ROI plano informativo y CLV;
- bandas de calibración;
- comparación `PROVISIONAL` frente a `FINAL`;
- desgloses descriptivos por mercado y señal;
- concentración de la muestra;
- advertencias y exclusiones;
- digests del expediente, evidencia, certificado y manifiesto;
- estado de las anclas append-only y del diario de revisión.

## Decisiones humanas

La consola permite registrar únicamente las conclusiones soportadas por S6R:

- `NO_CHANGE`
- `COLLECT_MORE_DATA`
- `DESIGN_SHADOW_CANDIDATE`
- `INVESTIGATE_DATA_QUALITY`
- `ACTION_REQUIRED`

Una entrada `IN_PROGRESS` no puede publicar una conclusión. Una entrada `FINAL` exige conclusión. `DESIGN_SHADOW_CANDIDATE` exige un nombre de versión separado.

## Compuerta fail-closed

La escritura queda bloqueada cuando falta cualquiera de estos requisitos:

- sesión autenticada;
- expediente S6R listo y verificado;
- cero problemas críticos;
- diario append-only válido;
- cambios automáticos del modelo deshabilitados;
- promoción automática deshabilitada;
- exposición financiera igual a cero.

## Seguridad

S6S conserva:

- modo `SHADOW`;
- exposición financiera 0;
- integración con sportsbooks deshabilitada;
- apuestas automáticas deshabilitadas;
- escrituras de producción deshabilitadas;
- promoción automática deshabilitada;
- cambios automáticos del modelo deshabilitados.

No modifica fórmulas, probabilidades, señales, mercados, thresholds, reglas de settlement ni stake policy.

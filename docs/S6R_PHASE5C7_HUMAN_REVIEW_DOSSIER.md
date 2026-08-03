# Fase 5C-7 / S6R — Expediente de revisión humana MLB

## Objetivo

S6R crea un expediente científico inmutable únicamente después de que S6Q alcance `READY_FOR_HUMAN_REVIEW` con evidencia válida de las primeras 50 decisiones binarias elegibles.

Mientras S6Q siga acumulando la muestra, S6R permanece correctamente en `LOCKED_WAITING_FOR_S6Q` y no crea evidencia anticipada.

## Estados

- `LOCKED_WAITING_FOR_S6Q`
- `HUMAN_REVIEW_DOSSIER_READY`
- `HUMAN_REVIEW_IN_PROGRESS`
- `HUMAN_REVIEW_COMPLETED`
- `CANDIDATE_SHADOW_STUDY_PROPOSED`
- `ACTION_REQUIRED`

## Contenido del expediente

- manifiesto sellado de las 50 decisiones;
- Brier Score, Log Loss, ECE, MCE, win rate e intervalo Wilson;
- ROI plano informativo y cobertura/mediana/media de CLV;
- desgloses por mercado y señal;
- comparación `PROVISIONAL` frente a `FINAL`;
- concentración de muestra;
- advertencias y exclusiones comunicadas por S6Q;
- clasificación conservadora de subgrupos.

## Clasificación de subgrupos

- `INSUFFICIENT_SUBGROUP_SAMPLE`: menos de 5 observaciones;
- `DESCRIPTIVE_ONLY`: entre 5 y 9 observaciones;
- `POTENTIAL_CALIBRATION_CONCERN`: 10 o más observaciones con brecha descriptiva de calibración de al menos 10 puntos porcentuales;
- `CANDIDATE_FOR_FURTHER_STUDY`: 10 o más observaciones sin esa señal, siempre sujeto a estudio posterior.

Ninguna clasificación establece rentabilidad ni autoriza cambios del modelo.

## Decisiones humanas append-only

El revisor autorizado puede registrar:

- `NO_CHANGE`
- `COLLECT_MORE_DATA`
- `DESIGN_SHADOW_CANDIDATE`
- `INVESTIGATE_DATA_QUALITY`
- `ACTION_REQUIRED`

Las decisiones forman una cadena de hashes. Una propuesta `DESIGN_SHADOW_CANDIDATE` exige un nombre de versión separado y conserva:

- ejecución exclusivamente `SHADOW`;
- exposición financiera 0;
- promoción automática deshabilitada;
- cambios automáticos del modelo deshabilitados.

## Persistencia

- `dossier.json`: append-only;
- `dossier-anchor.json`: ancla append-only;
- `review-decisions/*.json`: diario append-only encadenado;
- `latest.json`: estado operativo actual;
- `snapshots/*.json`: cambios de estado y diagnóstico.

## Seguridad

S6R no modifica probabilidades, fórmulas, señales, mercados, thresholds, reglas de settlement ni stake policy. No coloca apuestas, no escribe en sportsbooks y no promueve candidatos automáticamente.

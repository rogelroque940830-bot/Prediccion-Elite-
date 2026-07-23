# Court Edge Frontend — Staging Sprint 2

Esta rama es un entorno aislado para validar el frontend independiente antes de cualquier cambio público.

## Producción

La rama `main`, Railway y la interfaz publicada permanecen sin cambios.

## Artefacto requerido

Subir en esta carpeta, sin cambiar el nombre:

`CourtEdge_Phase3_Sprint2_Staging_Candidate_v1.0.zip`

SHA-256 esperado:

`391405e7179df3a48d00d9ef64883e0f6525670305ba20195bd15400d58d2346`

## CI

El workflow `.github/workflows/frontend-staging-sprint2.yml` ejecuta:

1. Verificación SHA-256.
2. Extracción en un directorio temporal.
3. Node.js 20.
4. `npm ci`.
5. `npm run verify`.
6. `npm run build` con `VITE_API_BASE_URL`.
7. Smoke test del build.
8. Smoke test de solo lectura contra el backend cuando existe `STAGING_API_BASE_URL`.
9. Generación del manifiesto de release.
10. Publicación de `dist` y evidencia QA como artefactos de GitHub Actions.

## Variable de repositorio

Configurar únicamente en esta rama/entorno de staging:

`STAGING_API_BASE_URL`

Debe contener la URL HTTPS del backend de Railway, sin slash final.

## Criterio de aprobación

No se promoverá nada a producción hasta que CI, smoke tests y revisión visual estén aprobados. Un fallo mantiene el estado `HOLD` y no exige rollback porque producción no se modifica.

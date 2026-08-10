# Phase 3 - Sprint 1 Status

## Objetivo

Convertir la interfaz recuperada en un frontend independiente, configurable y listo para una verificación reproducible, sin tocar la aplicación pública ni el backend productivo.

## Cambios ejecutados

1. Se creó un paquete `courtedge-web` exclusivamente para el frontend.
2. Se retiraron `server/`, `shared/`, scripts de base de datos y artefactos históricos del paquete ejecutable.
3. La URL productiva incrustada fue sustituida por `VITE_API_BASE_URL`.
4. Se mantuvo `base: "./"` y el router hash para compatibilidad con hosting estático.
5. Se creó CI con Node 20, `npm ci`, type-check y build.
6. Se añadió auditoría estática reproducible.
7. Se añadió verificación sintáctica de 80 archivos TS/TSX.
8. Se corrigió el cliente manual de picks para utilizar `/api/picks/v2`.
9. Se documentaron los dos sistemas de persistencia de picks para impedir una fusión accidental.

## Evidencia local

- Archivos fuente revisados: 82.
- Archivos TypeScript/TSX de código: 80 transpilados sin error sintáctico.
- Paquetes externos importados: 43, todos declarados en el manifest.
- Referencias de endpoints detectadas: 57 expresiones, agrupadas en 46 familias de rutas.
- Imports locales sin resolver: 0.
- Imports desde `server/` o `shared/`: 0.
- URLs fijas de Railway/Perplexity dentro del código cliente: 0.
- Secretos evidentes dentro del código cliente: 0.

## Verificación no certificada todavía

El entorno de auditoría no pudo descargar paquetes de npm. En consecuencia, estas dos afirmaciones todavía no se hacen:

- "El type-check completo pasó".
- "El build de producción pasó".

Ambas quedarán determinadas por `npm run verify` en una máquina o CI con acceso al registro de npm.

## Impacto en producción

Ninguno. No se realizaron escrituras en GitHub, Railway ni en la aplicación publicada.

## Gate para Sprint 2

Sprint 2 comienza únicamente después de:

1. `npm ci` exitoso.
2. `npm run verify` exitoso.
3. Carga visual del dashboard y cuatro predictores en staging.
4. Comparación del historial y CLV con la aplicación actual.
5. Confirmación de rollback.

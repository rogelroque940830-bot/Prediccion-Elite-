# Contrato de integración Frontend - Backend

## Frontera arquitectónica

El frontend solo consume HTTP. No importa archivos de `server/` ni `shared/`, no abre bases de datos y no contiene credenciales de proveedores.

La URL del backend se resuelve en `client/src/lib/queryClient.ts` mediante:

```text
VITE_API_BASE_URL + /api/...
```

## Endpoints principales consumidos

### Estado e historial

- `GET /api/picks`
- `POST /api/picks/sync`
- `POST /api/picks/v2`
- `GET /api/picks/v2`
- `DELETE /api/picks/v2/:id`
- `POST /api/clv/refresh`

### MLB

- `GET /api/mlb/all`
- `POST /api/mlb/early-markets`
- `GET /api/mlb/ere/:teamId`
- `GET /api/mlb/tesi/:teamId`
- `GET /api/mlb/lineup-matchup/:gamePk`
- `GET /api/mlb/archetype-matchup/:gamePk`
- `GET /api/mlb/bullpen-status/:gamePk`
- `GET /api/mlb/park-pitcher/:gamePk`
- `GET /api/mlb/quality/:gamePk`
- `GET /api/mlb/sos/:gamePk`
- `GET /api/mlb/discipline-speed/:gamePk`
- `GET /api/mlb/pitcher-vs-team/:gamePk`
- `GET /api/mlb/wind-park/:gamePk`
- `GET /api/mlb/catcher-framing/:gamePk`
- `GET /api/mlb/rookie-pitcher/:gamePk`
- `GET /api/mlb/pitcher-form/:gamePk`
- `GET /api/mlb/team-fatigue/:gamePk`
- `GET /api/mlb/statcast-matchup/:gamePk`
- `GET /api/mlb/pitcher-recent/:gamePk`
- `GET /api/mlb/umpire/:gamePk`
- `GET /api/mlb/advanced/:gamePk`
- `GET /api/mlb/context`

### NBA

- `GET /api/nba/all`
- `GET /api/nba/refs/:gameId`
- `GET /api/nba/context`

### WNBA

- `GET /api/wnba/all`
- `GET /api/wnba/games`
- `GET /api/wnba/players`
- `GET /api/wnba/injuries`
- `GET /api/wnba/fatigue`
- `GET /api/wnba/sos`
- `GET /api/wnba/h2h`
- `GET /api/wnba/shot-profile/:teamId`

### NHL

- `GET /api/nhl/all`
- `GET /api/nhl/goalies/:gameId`

### Mercado y señales

- `GET /api/odds/mlb`
- `GET /api/odds/mlb/f5`
- `GET /api/odds/nba`
- `GET /api/odds/nhl`
- `GET /api/sharp/:sport/:gameKey`

## Compatibilidad comprobada

La comparación estática encontró 46 familias de rutas usadas por el frontend. Las rutas históricas se contrastaron con el servidor exportado, y las rutas agregadas posteriormente (`early-markets`, `ere`, `tesi` y `picks/v2`) se contrastaron con el backend vigente en GitHub.

## Riesgo que permanece

El contrato no está versionado formalmente mediante OpenAPI. Un cambio de respuesta en Railway puede romper la UI aunque la ruta continúe existiendo. La siguiente mejora recomendada es publicar esquemas Zod/OpenAPI compartidos como paquete de contratos, sin compartir lógica del servidor.

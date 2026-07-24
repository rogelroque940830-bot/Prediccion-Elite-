# CourtEdge Backend — Deploy a Railway

Backend Express + Node.js para el predictor CourtEdge (MLB / WNBA / NHL / NBA).

## Pasos para deployar en Railway

### 1. Crear cuenta en Railway
- Ve a [https://railway.app](https://railway.app)
- Sign up con GitHub (recomendado) o email
- Plan: Hobby o superior, según consumo.

### 2. Subir el código a GitHub
```bash
cd courtedge-backend-deploy
git init
git add .
git commit -m "Initial CourtEdge backend"
# Crear repo nuevo en github.com (preferiblemente privado)
git remote add origin https://github.com/TU_USUARIO/courtedge-backend.git
git branch -M main
git push -u origin main
```

### 3. Conectar Railway al repo
- En Railway → **New Project** → **Deploy from GitHub repo**
- Selecciona el repositorio del backend
- Railway detecta Node y el script `build:backend`

### 4. Configurar variables de entorno
En Railway → **Variables**, crea las variables sin pegar sus valores en GitHub:

```text
NODE_ENV=production
PORT=5000
BDL_API_KEY=<guardar únicamente en Railway>
ODDS_API_KEY=<guardar únicamente en Railway>
COURTEDGE_ALLOWED_ORIGINS=https://<dominio-del-frontend>
COURTEDGE_WRITE_TOKEN=<secreto-aleatorio-largo>
ALLOW_LEGACY_PICKS_SYNC=false
```

Las credenciales reales nunca deben aparecer en archivos, commits, capturas, issues ni documentación. Consulta `docs/P0_SECURITY_RUNBOOK.md` antes de desplegar cambios de seguridad.

### 5. Generar el dominio público
- Railway → **Settings** → **Networking** → **Generate Domain**
- Copia la URL, por ejemplo: `courtedge-backend.up.railway.app`

### 6. Configurar el frontend
El frontend independiente utiliza `VITE_API_BASE_URL`. Define esa variable con la URL HTTPS del backend y genera un build nuevo. No incrustes la URL directamente en componentes o utilidades.

## Endpoints disponibles

### MLB
- `/api/mlb/all` — schedule + team stats
- `/api/mlb/park-pitcher/:gamePk`
- `/api/mlb/quality/:gamePk`
- `/api/mlb/sos/:gamePk`
- `/api/mlb/discipline-speed/:gamePk`
- `/api/mlb/bullpen-status/:gamePk`
- `/api/mlb/lineup-matchup/:gamePk`
- `/api/mlb/pitcher-vs-team/:gamePk`
- `/api/mlb/pitcher-form/:gamePk`
- `/api/mlb/team-fatigue/:gamePk`
- `/api/mlb/weather/:gamePk`
- `/api/mlb/park-factors/:gamePk`
- `/api/mlb/umpire/:gamePk`
- `/api/mlb/pitcher-recent/:gamePk`
- `/api/mlb/rookie-pitcher/:gamePk`
- `/api/mlb/catcher-framing/:gamePk`
- `/api/mlb/archetype-matchup/:gamePk`
- `/api/mlb/statcast-matchup/:gamePk`

### WNBA
- `/api/wnba/all`
- `/api/wnba/games`
- `/api/wnba/sos`
- `/api/wnba/fatigue`
- `/api/wnba/players`
- `/api/wnba/injuries`
- `/api/wnba/shot-profile/:espnTeamId`
- `/api/wnba/h2h?home=X&away=Y`

### NHL y NBA
- `/api/nhl/all`, `/api/nba/all`, entre otros.

## Comandos locales

```bash
npm ci
npm run build:backend
npm start
```

El servidor escucha en `process.env.PORT` (default 5000).

## Health check

`GET /` → `{ status: "ok" }`

`GET /health` → `{ status: "healthy" }`

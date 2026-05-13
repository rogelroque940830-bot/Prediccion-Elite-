# CourtEdge Backend — Deploy a Railway

Backend Express + Node.js para el predictor CourtEdge (MLB / WNBA / NHL / NBA).

## Pasos para deployar en Railway (15 min)

### 1. Crear cuenta en Railway
- Ve a [https://railway.app](https://railway.app)
- Sign up con GitHub (recomendado) o email
- Plan: Hobby ($5/mes incluye $5 de uso. CourtEdge backend usa ~$3-5/mes).

### 2. Subir el código a GitHub
```bash
cd courtedge-backend-deploy
git init
git add .
git commit -m "Initial CourtEdge backend"
# Crear repo nuevo en github.com (privado) llamado "courtedge-backend"
git remote add origin https://github.com/TU_USUARIO/courtedge-backend.git
git branch -M main
git push -u origin main
```

### 3. Conectar Railway al repo
- En Railway → **New Project** → **Deploy from GitHub repo**
- Selecciona `courtedge-backend`
- Railway detecta automáticamente Node + el script `build:backend`

### 4. Configurar variables de entorno
En el proyecto Railway → **Variables**:
```
NODE_ENV=production
PORT=5000
BDL_API_KEY=d94f53fd-aedc-4da1-952c-5975f51cf732
ODDS_API_KEY=b6bab898f7a8879e95adf2290aac4184
```

### 5. Generar el dominio público
- Railway → **Settings** → **Networking** → **Generate Domain**
- Copia la URL, por ejemplo: `courtedge-backend.up.railway.app`

### 6. Actualizar el frontend para usar la URL pública
Manda esa URL al chat con CourtEdge. Yo actualizaré el placeholder
`__PORT_5000__` en `client/src/lib/queryClient.ts` por:
```
https://courtedge-backend.up.railway.app
```

Rebuild + redeploy del frontend → conectado al backend persistente.

## Endpoints disponibles

### MLB (18)
- `/api/mlb/all` — schedule + team stats hoy
- `/api/mlb/park-pitcher/:gamePk`
- `/api/mlb/quality/:gamePk` — Tier A xwOBA+HardHit
- `/api/mlb/sos/:gamePk` — SOS bateo reciente
- `/api/mlb/discipline-speed/:gamePk` — Tier B strikePct+Sprint
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

### WNBA (8)
- `/api/wnba/all` — schedule + team stats
- `/api/wnba/games`
- `/api/wnba/sos`
- `/api/wnba/fatigue`
- `/api/wnba/players`
- `/api/wnba/injuries` — auto-fill ESPN + decay
- `/api/wnba/shot-profile/:espnTeamId` — 3PA + FTA + eFG
- `/api/wnba/h2h?home=X&away=Y` — H2H 2 años

### NHL, NBA
- `/api/nhl/all`, `/api/nba/all`, etc.

## Comandos locales

```bash
npm install
npm run build:backend
npm start
```

Server escucha en `process.env.PORT` (default 5000).

## Health check

`GET /` → `{ status: "ok" }`
`GET /health` → `{ status: "healthy" }`

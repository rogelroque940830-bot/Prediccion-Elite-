# P1-M2A — Inventario autoritativo y contrato de frescura/suficiencia pregame MLB

## Estado de la fase

P1-M2A es una fase de auditoría y contrato. No añade un endpoint runtime, no modifica el predictor y no cambia probabilidades, fórmulas, señales, mercados, thresholds, settlement ni stake.

El objetivo es cerrar la ambigüedad entre la compuerta ligera de P1-M1 y el formulario avanzado existente antes de implementar P1-M2B.

## Baseline verificado

P1-M1 ya proporciona jornada oficial por fecha, identidad por `gamePk`, estado oficial, pitchers probables resueltos desde MLB `feed/live`, conteo de batting orders oficiales, clasificación FINAL/PROVISIONAL/BLOCKED, timestamps explícitos y seguridad SHADOW con exposición 0.

El formulario avanzado ya consume `/api/mlb/all`, lesiones, bullpen, forma reciente, matchups, Statcast, SOS, clima/parque, fatiga, umpire, factores avanzados y cuotas full-game/F5 mediante endpoints separados.

## Hallazgos de auditoría

### 1. No existe un contrato único de readiness

P1-M1 decide readiness con identidad, pitchers y lineups. El formulario avanzado carga después el resto de fuentes de forma independiente. No existe una respuesta única que explique qué dato está fresco, degradado, ausente o en conflicto.

### 2. El cache agregado no es compatible con todas las ventanas pregame

`/api/mlb/all` usa el helper global `withCache`, cuyo TTL actual es 30 minutos. El feed interno de lesiones usa una ventana de 5 minutos, pero al entrar dentro del payload agregado puede permanecer detrás del cache general durante más tiempo del deseado.

### 3. Los endpoints de factores no tienen un envelope temporal uniforme

La mayoría no comparte campos obligatorios como `observedAt`, `source`, `status`, `stale`, `quality` y `errors`. Sin esos campos no se puede certificar FINAL de forma reproducible.

### 4. Las cuotas siguen siendo una acción explícita separada

El formulario carga full-game y F5 por rutas distintas. La futura compuerta debe comprobar partido, mercado, lado, línea, precio americano, sportsbook o método de consenso, tiempo de captura y override manual.

Una cuota ausente o stale bloquea la generación del mercado seleccionado.

### 5. Los fallos parciales quedan ocultos como `null`

El autollenado tolera fallos individuales para no romper la pantalla. P1-M2 debe mostrar esa degradación: un factor fallido no puede parecer equivalente a un factor verificado con impacto cero.

## Contrato formal

Contrato ejecutable:

`server/mlb-p1-pregame-readiness-contract.ts`

Schema:

`courtedge-p1-m2a-pregame-readiness-contract.v1`

### Estados de evidencia

- `FRESH`: disponible y dentro de la ventana.
- `STALE`: disponible, pero vencido.
- `DEGRADED`: evidencia parcial o fallback identificado.
- `MISSING`: no existe evidencia.
- `CONFLICT`: fuentes o identidades no concuerdan.
- `UNKNOWN`: no puede demostrarse frescura o integridad.

### Estados de compuerta

- `READY_FINAL`: toda la evidencia central y específica del mercado está fresca.
- `READY_PROVISIONAL`: no hay bloqueo duro, pero falta evidencia necesaria para FINAL.
- `BLOCKED`: no se permite generar una predicción nueva.

## Reglas de bloqueo

Los bloqueos duros son:

- `GAME_IDENTITY`;
- `PITCHERS`;
- `MARKET_ODDS`;
- juego iniciado, finalizado, cerrado o estado desconocido.

FINAL requiere además:

- `LINEUPS` frescos y oficiales;
- `INJURIES` frescas y verificadas;
- requisitos específicos del mercado.

## Requisitos por mercado

| Mercado | Evidencia específica para FINAL |
|---|---|
| ML | Bullpen y factores avanzados |
| F5 ML | Forma reciente del pitcher y lineup matchup |
| Run Line | Bullpen y factores avanzados |
| Total | Bullpen, ambiente, umpire y factores avanzados |
| F5 Total | Forma reciente, ambiente y umpire |

El bullpen no bloquea F5 porque el mercado termina después de cinco entradas. Sí es material para mercados full-game.

## Ventanas objetivo para P1-M2B

Estas ventanas son contrato objetivo, no garantía uniforme del runtime actual.

| Dominio | Máxima edad |
|---|---:|
| Identidad y estado oficial | 10 min |
| Pitchers probables | 10 min |
| Lineups oficiales | 5 min |
| Lesiones | 10 min |
| Cuotas seleccionadas | 5 min |
| Bullpen | 30 min |
| Clima, parque, fatiga y contexto | 30 min |
| Umpire | 30 min |
| Forma reciente y factores históricos | 6 h |

## Inventario principal

- `/api/mlb/p1/v1/slate`;
- `/api/mlb/all`;
- `/api/odds/mlb`;
- `/api/odds/mlb/f5`;
- `/api/mlb/bullpen-status/:gamePk`;
- `/api/mlb/pitcher-form/:gamePk`;
- `/api/mlb/pitcher-recent/:gamePk`;
- `/api/mlb/lineup-matchup/:gamePk`;
- `/api/mlb/wind-park/:gamePk`;
- `/api/mlb/team-fatigue/:gamePk`;
- `/api/mlb/context`;
- `/api/mlb/umpire/:gamePk`;
- `/api/mlb/quality/:gamePk`;
- `/api/mlb/statcast-matchup/:gamePk`;
- `/api/mlb/discipline-speed/:gamePk`;
- `/api/mlb/sos/:gamePk`;
- `/api/mlb/archetype-matchup/:gamePk`;
- `/api/mlb/pitcher-vs-team/:gamePk`;
- `/api/mlb/park-pitcher/:gamePk`;
- `/api/mlb/catcher-framing/:gamePk`;
- `/api/mlb/rookie-pitcher/:gamePk`;
- `/api/mlb/advanced/:gamePk`.

## Decisiones para P1-M2B

P1-M2B debe implementar un agregador por `gamePk` y mercado, normalizar cada fuente a un envelope común, mantener al servidor como autoridad temporal, conservar compatibilidad con P1-M1, exponer blockers/warnings y tratar los fallos silenciosos actuales como degradación visible.

## Fuera de alcance

P1-M2A no crea predicciones, guarda picks, coloca apuestas, cambia modelos, pesos, calibración, mercados, thresholds, settlement, ledger ni promoción automática.

## Criterio de cierre

La fase se cierra cuando el inventario compila, los IDs son únicos, todos los campos tienen cobertura, las reglas de frescura son deterministas, los bloqueos fallan cerrados y FINAL/PROVISIONAL están probados por mercado.

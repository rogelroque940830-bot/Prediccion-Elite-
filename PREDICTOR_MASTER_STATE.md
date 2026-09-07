# PREDICTOR DEPORTIVO — MASTER STATE

Última actualización: 2026-09-07
Repositorio: rogelroque940830-bot/Prediccion-Elite-

## 0. REGLA MAESTRA DE CONTINUIDAD

NO SE EMPIEZA DE CERO.

La arquitectura multideporte se construye alrededor de motores, contratos,
artefactos y validaciones ya existentes. Un deporte o frente nuevo no reemplaza
el trabajo previo: se incorpora solo cuando alcanza su gate científico.

Orden de autoridad para retomar trabajo:
1. Estado real del repositorio / PRs / commits / workflows.
2. Contratos y artefactos científicos congelados.
3. Este MASTER STATE.
4. Conversaciones previas.

Si existe conflicto, prevalece el estado verificable del repositorio.

## 1. OBJETIVO GLOBAL

Construir un único Predictor Deportivo capaz de:
- recorrer todos los deportes soportados;
- conservar la lógica específica validada de cada deporte;
- producir candidatos mediante motores especializados;
- exigir evidencia y probabilidad científicamente calificadas;
- aplicar gates deportivos y económicos;
- comparar únicamente candidatos cross-sport autorizados;
- terminar con UNA recomendación final diaria: BEST BET / WAIT / NO BET.

Arquitectura global:

SPORT-SPECIFIC ENGINES
        |
        v
SPORT ELITE / SCIENTIFIC GATES
        |
        v
QUALIFIED p_win_selected_side
        |
        v
CROSS-SPORT CALIBRATION / CUSTODY
        |
        v
ECONOMIC / MARKET EVALUATION
        |
        v
GLOBAL ELIGIBILITY
        |
        v
GLOBAL RANKER / PARETO DECISION
        |
        v
BEST BET / WAIT / NO BET

La capa global NO sustituye MLB, NFL, WNBA, NBA, NHL, etc. Se coloca encima.

## 2. CHECKPOINT ACTUAL — PRIORIDAD #1

### MLB R1 — PR #695

PR: `MLB R1: freeze matchup-relative unified sporting authority`
Estado: OPEN / DRAFT / FAIL-CLOSED
Rama: `research/mlb-unified-sporting-authority-r1`
HEAD verificado: `5cc4f0e5d94e8abd349ed098da07e04a8f6cc9fe`

Últimos commits materiales:
- `43d2c058...` — run aggregate wOBA historical-vintage probe.
- `19a6017d...` — broaden primary Savant historical wOBA custody discovery.
- `52b51b80...` — inspect archived Savant hidden fields and export routes.
- `5cc4f0e5...` — run archived Savant hidden-field route probe.

### R1B1 — estado autoritativo actual

PARITY_CERTIFIED (4/9):
- V16_BASELINE
- HAND_SPLIT_SLG_MATCHUP
- PITCHMIX_MATCHUP
- BULLPEN_FULL_GAME

PARTIAL_PARITY (1/9):
- STATCAST_QUALITY

BLOCKED (4/9):
- FROZEN_ROUTE_EVIDENCE
- DISCIPLINE_SPEED
- SOS
- ADVANCED_CONTEXT

Autorización:
- R1B historical rowset authorization = FALSE.
- R1B2 = UNAUTHORIZED.
- No avanzar a R1B2 hasta 9/9 PARITY_CERTIFIED.

## 3. STATCAST_QUALITY — ESTADO CIENTÍFICO ACTUAL

### 3.1 Raw BBE / contact-quality bridge

El problema de filtro raw BBE fue corregido usando el flag Savant correcto y
particionando las consultas para evitar el límite CSV.

Workflow histórico ya verificado:
- run `33911300212`
- 124,888 identidades canónicas terminal-pitch únicas
- 873 pitchers del leaderboard emparejados
- paridad exacta:
  - attempts: 873/873
  - ev95plus: 873/873
  - barrels: 873/873
- quedan 5 edge cases de display en `ev95percent`

Esto NO autoriza todavía STATCAST_QUALITY completo.

### 3.2 xERA directo / custom leaderboard

Se verificó que:
- la ruta aggregate tiene semántica target-date para campos soportados,
  pero no expone xERA/ERA solicitados;
- el custom leaderboard sí expone xERA y p_era y puede emparejar filas actuales,
  pero las variantes de frontera temporal probadas fueron byte-identical,
  por lo que NO demuestran custodia as-of histórica.

### 3.3 Mecanismo xwOBA -> xERA

La evidencia MLB/Tango apoya conceptualmente una relación de escala basada en
xwOBA y una transformación aproximadamente cuadrática, pero NO publica por sí
sola la serie exacta de parámetros de producción de Savant.

Los probes exactos realizados rechazaron como autoridad suficiente:
- `xERA = k * xwOBA^2`
- `xERA = a + b * xwOBA^2`
- variantes normalizadas con hipótesis ordinarias de rounding/truncation

No se permite sustituir esto por regresión o fitting empírico.

### 3.4 Negative control de estabilidad

Un mirror timestamped de terceros mostró que aplicar un mapping de fin de
temporada retroactivamente no es estable. Se usa solo como negative control,
NUNCA como autoridad histórica primaria.

## 4. BLOQUEO ACTUAL — HISTORICAL wOBA / xwOBA CUSTODY

### Exact wOBA Bridge Probe

Workflow:
- run `34139052632`
- conclusión técnica del workflow: SUCCESS

Resultado científico:
- anchors solicitados: 2
- anchors parseados: 2
- ambos anchors quedaron alineados de forma única
- hidden xwOBA recuperado sobre estados elegidos: 547 filas
- display matches exactos de hidden xwOBA: 26/547
- consistency rate: 0.0475319927 (~4.75%)

Por tanto:
- unique anchor alignment = SÍ
- exact hidden xwOBA bridge = NO
- exact Savant production conversion = NO
- family promotion = NO

Conclusión:
la reconstrucción desde raw actual wOBA / diff NO conserva la semántica
histórica exacta necesaria.

### Aggregate Historical-Vintage wOBA Probe

Workflow:
- run `34148761091`
- conclusión técnica del workflow: SUCCESS

Resultado científico:
- everyAnchorUniquelyAligned = true
- everyArchivePaExactlyMatchedByAggregate = false
- everyArchiveDisplayedWobaExactlyMatchedByAggregate = false
- aggregateWobaExposesMoreThanThreeDecimalDigits = false
- exactHistoricalActualWobaRecoveredAtSufficientPrecision = false
- exactHiddenXwobaRecovered = false
- exactSavantProductionConversionProven = false
- familyPromotionAuthorized = false

Caso especialmente informativo:
- anchor 2022-05-23
- cutoff 2022-05-22
- PA match = 282/282
- exact displayed wOBA match = 4/282

Interpretación:
la ruta aggregate actual puede reproducir alineación temporal/PA en algunos
casos, pero su wOBA es current-vintage/recomputed y NO constituye custodia
histórica exacta del valor archivado. Además expone como máximo 3 decimales.

## 5. ÚLTIMO PROBE EJECUTADO — PENDIENTE DE REVISIÓN CIENTÍFICA

Workflow:
`MLB R1B Statcast xERA Wayback HTML Hidden-Field Route Probe`

Run:
- `34150788890`
- HEAD: `5cc4f0e5d94e8abd349ed098da07e04a8f6cc9fe`
- status: completed
- conclusion técnica: SUCCESS

IMPORTANTE:
GREEN CI NO EQUIVALE A PARIDAD.

El artifact/result científico de este probe todavía debe ser inspeccionado antes
de cambiar cualquier gate. Hasta esa revisión:

STATCAST_QUALITY = PARTIAL_PARITY
R1B1 = 4/9
R1B2 = UNAUTHORIZED

## 6. NEXT EXACTO

1. Inspeccionar el artifact completo del run `34150788890`.
2. Determinar si alguna ruta primaria archivada de Baseball Savant expone:
   - actual wOBA histórico con precisión suficiente; o
   - hidden xwOBA directo; o
   - xERA as-of directo;
   con semántica target-date y custodia inmutable verificables.
3. Contrastar con los probes previos de:
   - historical-vintage custody discovery;
   - Wayback primary custody;
   - Wayback wOBA custody search;
   para evitar repetir rutas ya falsadas.
4. SOLO si se obtiene custodia primaria exacta:
   - probar el bridge xwOBA -> xERA sin fitting empírico;
   - probar target-date ERA y `era_minus_xera_diff`;
   - probar `min=q` as-of 2022-2026_YTD;
   - resolver los 5 edge cases de `ev95percent` si afectan runsDelta;
   - ejecutar full-universe replay + independent verification.
5. Si el hidden-field probe NO prueba custodia suficiente:
   - ampliar la búsqueda únicamente dentro de rutas/exports primarios archivados
     de Savant;
   - mantener FAIL-CLOSED;
   - NO promover STATCAST_QUALITY.

## 7. CONTRATO DE SEGURIDAD — NO NEGOCIABLE

Durante R1:
- NO empirical fit.
- NO interpolation.
- NO final-season mapping shortcut.
- NO fitted square-law coefficient.
- NO third-party mirror como autoridad.
- NO unsupported Savant params.
- NO assumed display quantization.
- NO target outcome / market price modeling.
- NO producción changes.
- NO cambios a pesos.
- NO cambios de routing.
- NO cambios de staking.
- NO cambios a BET_ELITE/autobet.
- Real financial exposure = 0.
- R1B2 = false.

Un workflow verde solamente prueba que el experimento ejecutó correctamente;
NO prueba que la hipótesis científica sea verdadera.

## 8. MLB — TRABAJO PRESERVADO, NO REINICIAR

### V80
- Captura per-game T-10 -> T-7 -> T-4 preservada.
- Primera captura válida gana.

### V68
- PR #692 MERGED.
- Adoptó lógica de reloj/captura tipo V80 sin reescribir su modelo.
- Prospective embargo permanece.

### Daily Opportunity / whole-slate
- Trabajo #684-#689 preservado.
- Whole-slate sporting analysis + shortlist price consults.
- PLAY / WAIT / NO_PLAY.
- Sporting layer separada de economic/price layer.

### EARLY / ERE
El milestone Early/ERE end-to-end NO se elimina ni se reinicia.
Actualmente queda APARCADO mientras la prioridad elegida es cerrar R1B1.

Trabajo preservado:
- ERE
- F5 Unified
- F5 ML / F5 Total
- NRFI/YRFI
- Inning 1
- Team Totals F5
- UI Early
- ledger MLB / scientific snapshot / settlement base

Pendiente cuando se retome:
- congelar exactamente el resultado ERE/Early dentro del scientificSnapshot F5;
- History;
- settlement/ROI/CLV/export end-to-end;
- candidate pool FG + Early;
- MLB Best Play.

## 9. NFL — TRABAJO PRESERVADO

NFL Elite V1 NO se reinicia.

Preservado:
- PR #667 MERGED
- PR #669 MERGED
- PR #673 MERGED
- PR #674 MERGED
- `p_win_selected_side = reference_confidence` como mapping zero-parameter
  certificado bajo su contrato
- PR #670 y #671 permanecen como integración/calibración cross-sport fail-closed

No retocar reglas/pesos/thresholds NFL certificados sin nueva investigación
preregistrada.

## 10. WNBA — TRABAJO PRESERVADO

WNBA NO se reinicia.

Preservado:
- PR #693 OPEN/DRAFT
- candidate full-game Moneyline
- `SPORTS_ONLY_V1` primary
- CURRENT_65_35_V1 control/diagnóstico
- WNBA-R3B2 cerrado sobre 957 juegos OOS 2022-2025
- ninguna familia superó los gates
- BASE_R2 sigue referencia
- WNBA permanece fuera del Global Ranker
- próximo frente documentado: R4A custody prospectiva Availability/Star Power,
  luego R4B

## 11. REGLAS CIENTÍFICAS GENERALES

- No retuning después de ver outcomes del conjunto objetivo.
- No target-season ranking/cap salvo contrato previo explícito.
- No usar historical hit rate como probabilidad por juego.
- No usar same-game/post-event information como pregame.
- No rellenar missing data silenciosamente con cero/current/future values.
- No promover una familia sin paridad/custodia certificada.
- No comparar cross-sport probabilidades no calificadas.
- FAIL CLOSED ante ausencia de evidencia.
- Resultado fuerte en muestra pequeña no reemplaza validación temporal,
  calibración, proper scores y custody.

## 12. PUNTO DE REANUDACIÓN ENTRE CHATS

Frase:
`Retoma Predictor desde MASTER y verifica el repositorio antes de continuar.`

Acción inicial obligatoria:
1. verificar PR #695, branch y HEAD;
2. revisar si el run `34150788890` ya fue científicamente clasificado;
3. mantener 4/9 salvo evidencia exacta;
4. continuar desde historical primary Savant wOBA/xwOBA/xERA custody;
5. nunca reconstruir MLB/NFL/WNBA desde cero.

PUNTO EXACTO ACTUAL:
Estamos en MLB R1B1 -> STATCAST_QUALITY.
El agregado current-vintage NO reproduce wOBA histórico exacto.
El exact wOBA bridge NO recupera hidden xwOBA con consistencia suficiente.
El hidden-field route probe terminó GREEN, pero su artifact aún debe revisarse.
Ese artifact es el siguiente objeto de análisis.

FIN DEL MASTER STATE — 2026-09-07

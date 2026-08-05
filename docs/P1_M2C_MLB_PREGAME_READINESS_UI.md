# P1-M2C — Compuerta visual MLB pregame

## Objetivo

Consumir el contrato runtime de P1-M2B dentro de MLB Predictor y convertir su decisión en una compuerta visible antes de ejecutar el modelo.

## Flujo

1. El usuario selecciona y prepara un partido desde la jornada P1-M1.
2. La compuerta consulta `GET /api/mlb/p1/v1/pregame-readiness` con `gamePk`, fecha y mercado.
3. La pantalla muestra las 11 evidencias con estado, fuente, calidad, edad y ventana máxima.
4. El backend conserva autoridad sobre `READY_FINAL`, `READY_PROVISIONAL` y `BLOCKED`.
5. La UI compara `MARKET_ODDS.details.quote` con la línea y los precios que usará el modelo.
6. Una discrepancia de cuota mantiene el botón bloqueado aunque el backend haya respondido READY.
7. `BLOCKED` deshabilita `Generar Predicción`.
8. `READY_PROVISIONAL` permite ejecutar el cálculo, pero lo rotula como PROVISIONAL.
9. `READY_FINAL` permite ejecutar el cálculo y guardar el snapshot como FINAL.
10. Cuando cambia de manera material la decisión certificada, se invalida cualquier resultado anterior y se exige recalcular.
11. La recomendación única queda restringida al mercado certificado; los demás resultados permanecen informativos.
12. Un pick solo puede guardarse si corresponde al mercado actualmente certificado.

## Mercados y procedencia de cuotas

Mercados habilitados en la compuerta visual:

- Moneyline
- F5 Moneyline
- Run Line
- Total O/U

Los campos full-game existentes contienen valores iniciales y todavía no registran una transición uniforme `source/observedAt`. Para no fabricar frescura, P1-M2C verifica ML, Run Line y Total mediante la fuente automática de P1-M2B y exige que la cuota retornada coincida con el formulario antes de permitir el cálculo.

F5 Moneyline puede usar una captura manual únicamente después de que el formulario la identifique expresamente como edición manual bilateral. Un consenso F5 conserva la procedencia y los timestamps del backend, y también debe coincidir con los valores usados por el modelo.

F5 Total permanece fuera del selector de ejecución porque la pantalla todavía no recoge un par separado de precios Over/Under F5 y el comportamiento histórico reutiliza precios full-game. La UI no certificará ni permitirá guardar F5 Total hasta que existan precios propios de ese mercado.

## Integridad

- schema runtime: `courtedge-p1-m2b-pregame-readiness.v1`
- contrato: `courtedge-p1-m2a-pregame-readiness-contract.v1`
- modo exigido: `SHADOW_DECISION_SUPPORT`
- exposición financiera exigida: `0`
- apuestas automáticas: `false`
- cambios automáticos de modelo: `false`
- promoción automática: `false`
- igualdad exigida entre cuota certificada y cuota del modelo: `true`

Una respuesta con schema o límites de seguridad diferentes se considera inválida y mantiene la predicción bloqueada.

## Verificación

La integración del predictor fue aplicada mediante un reemplazo determinista que exigió coincidencias únicas y permitió modificar exclusivamente `frontend/client/src/pages/mlb-predictor.tsx`. El commit resultante es `e625bda20ccd1a489d7adca2cae8139f54ba11f7`.

La validación permanente comprueba contrato frontend, regresiones P1-M1, build productivo, marcadores del bundle, estados de la compuerta, igualdad de cuotas y límites SHADOW/exposición 0.

## Alcance

P1-M2C no modifica fórmulas, probabilidades, señales, calibración, thresholds, stakes, ledger, settlement ni integración con sportsbooks. Solo controla la etapa visible y la autorización de ejecución según P1-M2B.

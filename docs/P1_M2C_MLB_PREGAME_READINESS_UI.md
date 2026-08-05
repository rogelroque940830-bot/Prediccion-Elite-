# P1-M2C — Compuerta visual MLB pregame

## Objetivo

Consumir el contrato runtime de P1-M2B dentro de MLB Predictor y convertir su decisión en una compuerta visible antes de ejecutar el modelo.

## Flujo

1. El usuario selecciona y prepara un partido desde la jornada P1-M1.
2. La compuerta consulta `GET /api/mlb/p1/v1/pregame-readiness` con `gamePk`, fecha y mercado.
3. Cuando el formulario contiene un snapshot bilateral válido, la consulta lo identifica como captura manual del mercado.
4. La pantalla muestra las 11 evidencias con estado, fuente, calidad, edad y ventana máxima.
5. El backend conserva autoridad sobre `READY_FINAL`, `READY_PROVISIONAL` y `BLOCKED`.
6. `BLOCKED` deshabilita `Generar Predicción`.
7. `READY_PROVISIONAL` permite ejecutar el cálculo, pero lo rotula como PROVISIONAL.
8. `READY_FINAL` permite ejecutar el cálculo y guardar el snapshot como FINAL.
9. La recomendación única queda restringida al mercado certificado por la compuerta; los demás resultados permanecen informativos.
10. Un pick solo puede guardarse si corresponde al mercado actualmente certificado.

## Mercados

- Moneyline
- F5 Moneyline
- Run Line
- Total O/U
- F5 Total

La UI nunca reutiliza cuotas del total completo como si fueran cuotas de F5 Total. Cuando el formulario no contiene el precio exacto requerido, P1-M2C solicita la fuente automática del backend. Un consenso F5 conserva la procedencia y los timestamps del backend; solo una edición explícita del usuario se presenta como captura manual.

## Integridad

- schema runtime: `courtedge-p1-m2b-pregame-readiness.v1`
- contrato: `courtedge-p1-m2a-pregame-readiness-contract.v1`
- modo exigido: `SHADOW_DECISION_SUPPORT`
- exposición financiera exigida: `0`
- apuestas automáticas: `false`
- cambios automáticos de modelo: `false`
- promoción automática: `false`

Una respuesta con schema o límites de seguridad diferentes se considera inválida y mantiene la predicción bloqueada.

## Verificación

La integración del predictor fue aplicada mediante un reemplazo determinista que exigió coincidencias únicas y permitió modificar exclusivamente `frontend/client/src/pages/mlb-predictor.tsx`. El commit resultante es `e625bda20ccd1a489d7adca2cae8139f54ba11f7`.

La validación permanente comprueba contrato frontend, regresiones P1-M1, build productivo, marcadores del bundle, estados de la compuerta y límites SHADOW/exposición 0.

## Alcance

P1-M2C no modifica fórmulas, probabilidades, señales, calibración, thresholds, stakes, ledger, settlement ni integración con sportsbooks. Solo controla la etapa visible y la autorización de ejecución según P1-M2B.

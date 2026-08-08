# P1-M1 — Jornada MLB diaria y preparación del partido

## Decisión de arquitectura

P1-M1 no reemplaza el predictor MLB existente. La auditoría confirmó que ya existen la jornada, autollenado, lineups, pitchers, bullpen, lesiones, factores avanzados, cuotas, modelos, calibración, Pick Quality Score, recomendación única, snapshot científico e historial.

La brecha de P1-M1 era operativa: la jornada requería carga manual, la selección dependía de un desplegable y no existía una compuerta visible de preparación.

## Flujo implementado

1. La jornada de la fecha seleccionada se consulta automáticamente.
2. Todos los juegos se muestran como tarjetas con hora, equipos y abridores.
3. Cada juego se clasifica como:
   - `LISTO PARA PREPARAR`: juego futuro con ambos abridores identificados.
   - `ESPERAR PITCHERS`: juego futuro con al menos un abridor pendiente.
   - `JUEGO CERRADO`: juego iniciado o identidad insuficiente.
4. `Preparar análisis` selecciona el partido y reutiliza el `handleMLBAutoFill` existente.
5. Antes de cargar el nuevo partido se limpian resultados y factores derivados del partido anterior.
6. Una compuerta visible resume datos base, estado de lineups y disponibilidad del precio F5.
7. El usuario conserva el control explícito para verificar cuotas y pulsar `Generar Predicción`.

## Lo que permanece sin cambios

- Fórmulas y pesos del modelo.
- Probabilidades, regresión y calibración.
- Señales, vetos y thresholds.
- Mercados disponibles.
- Política de stake.
- Snapshot científico y reglas de guardado.
- Settlement, ledger y auditoría.

## Límite de automatización

Preparar un partido no genera una predicción, no guarda un pick, no coloca apuestas y no crea exposición financiera. La finalidad es reducir pasos manuales y evitar contaminación de estado entre partidos sin alterar la decisión matemática.

## Siguiente hito

P1-M2 debe convertir la compuerta visible en una evaluación pregame explícita de frescura y suficiencia para pitchers, lineups, lesiones, factores y cuotas, reutilizando las fuentes ya disponibles.

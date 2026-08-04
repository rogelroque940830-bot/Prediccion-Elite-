# O3 — Consola de reprocesamiento seguro y controlado

## Ruta privada

La consola está disponible en:

- `#/operations/reprocessing`

Solo aparece en la navegación cuando la sesión está autenticada.

## Flujo visual

### 1. Selección

La interfaz lee O1 y muestra únicamente incidencias:

- MLB;
- evidencia `AUTHORITATIVE`;
- estado `READY_FOR_SETTLEMENT` o `SETTLEMENT_OVERDUE`.

No existe selección multijuego.

### 2. Vista previa

El botón **Crear vista previa** realiza una solicitud explícita a:

- `POST /api/ops/v1/reprocessing/preview`

La respuesta presenta:

- final oficial;
- targets y resultados propuestos;
- blockers y warnings;
- digest del plan;
- digest de precondiciones;
- expiración;
- identidad de cada predicción.

Crear la vista previa no agrega settlements.

### 3. Ejecución

La interfaz mantiene el botón bloqueado hasta que coinciden todos los controles:

- plan `READY` y vigente;
- seguridad O3 válida;
- frase literal `REPROCESS_ONE_MLB_GAME`;
- motivo de 10 a 500 caracteres;
- idempotency key válida y estable para ese plan;
- confirmación manual de que se revisaron marcador y targets.

La solicitud de ejecución se emite únicamente al presionar el botón:

- `POST /api/ops/v1/reprocessing/execute`

El servidor exige administrador y vuelve a comprobar evidencia, digest, identidad, settlement previo e idempotencia.

## Auditoría

La página consulta:

- `GET /api/ops/v1/reprocessing/status`
- `GET /api/ops/v1/reprocessing/audit?limit=250`

Cada evento muestra `eventDigest` y `previousDigest`. La consola no modifica ni reconstruye el journal localmente.

## Comportamiento fail-closed

- No crea vistas previas al cargar o refrescar.
- No ejecuta planes al cargar, refrescar o seleccionar una incidencia.
- No llama a execute sin interacción explícita.
- No inventa planes cuando una API falla.
- Un usuario no administrador puede revisar, pero el servidor rechazará la ejecución.
- Un plan expirado permanece visible y no ejecutable.
- Un resultado rechazado permanece visible junto con el motivo del servidor.

## Seguridad

La consola valida:

- `SHADOW_CONTROLLED_REPROCESSING`;
- shadow-only;
- exposición financiera 0;
- ejecución automática deshabilitada;
- preview, digest, administrador y frase obligatorios;
- un partido por plan;
- settlement append-only;
- sin mutación histórica;
- sin reintentos automáticos;
- sin apuestas;
- sin cambios automáticos del modelo;
- sin promoción automática;
- alcance exclusivo MLB.

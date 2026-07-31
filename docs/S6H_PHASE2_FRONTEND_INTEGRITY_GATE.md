# S6H Phase 2 — Frontend Market Integrity Gate

## Objective

Protect `MLB · En foco` immediately without changing the immutable ledger, predictor formulas, backend workers, settlement, Railway, or the persistent volume.

The gate is applied only to pending pregame records before they can enter `Prioridad` or `Esperando`.

## Evidence basis

The authenticated live-ledger audit contained 336 records and confirmed:

- 34 invalid American prices, all in `F5_TOTAL`;
- zero implied-probability arithmetic mismatches above 0.75 pp;
- zero edge arithmetic mismatches above 0.75 pp;
- 111 edges above 15 pp;
- no non-standard total lines in the ledger;
- the apparent `4.4` and `6.6` values were duplicated display text, not ledger values.

## Gate policy

A pending pregame record receives one of three statuses:

### PASS

Eligible for the existing Priority/Waiting ranking when all structural checks pass.

### REVIEW

Excluded from Priority and Waiting and shown under `Verificar datos` when:

- recomputed edge exceeds 15 pp;
- a total line is not on a whole/half-run increment;
- the book/source is missing.

### REJECT

Excluded from Priority and Waiting and shown as `NO UTILIZAR` when:

- American odds are outside `<= -100` or `>= +100`;
- model probability is invalid;
- stored implied probability differs from the odds formula by more than 0.75 pp;
- stored edge differs from the recomputed edge by more than 0.75 pp;
- market and selection are incompatible;
- a total lacks a valid line.

## Arithmetic

The frontend independently recalculates:

- implied probability from American odds;
- edge as model probability minus recomputed implied probability.

Stored values remain visible for comparison. No value is written back to the ledger.

## User-interface changes

`MLB · En foco` now contains four operational tabs:

1. `Prioridad` — only structurally approved records;
2. `Esperando` — only structurally approved records awaiting stronger readiness;
3. `Verificar datos` — REVIEW and REJECT records with explicit reasons;
4. `Resultados` — recent settled history, unchanged.

The summary includes a separate `Verificar datos` count. At most 12 urgent integrity records are rendered in the focused view; all remaining records stay available in the complete audit.

## Total-line display repair

The card no longer appends `line` when `selection` already contains that line. For example:

- stored selection: `OVER 4`;
- stored line: `4`;
- displayed: `F5 O/U · OVER 4`;
- not displayed: `F5 O/U · OVER 4 4`.

## Price freshness boundary

The history API exposes `recordedAt` but not the original market `capturedAt` timestamp. Phase 2 therefore:

- displays the ledger recording time;
- warns that exact price freshness is not certified;
- does not invent a capture timestamp.

Adding original source capture time remains a backend provenance task for the next phase.

## Local fallback behavior

When the ledger is unavailable, local records do not have an identified book. They are classified as REVIEW and cannot become Priority recommendations.

## Tests

Automated tests cover:

- valid and invalid American-odds domains;
- deterministic implied probability;
- a valid Pittsburgh `-145` F5 moneyline;
- a synthetic `-5` F5 total;
- a valid-price 22.85 pp edge outlier;
- implied/edge arithmetic mismatch;
- exclusion of REVIEW and REJECT from Priority and Waiting;
- safe handling of local fallback without a book.

CI also performs TypeScript checking, a production build, and static bundle assertions for the new integrity UI.

## Safety boundary

This phase does not change:

- Railway configuration;
- backend routes or workers;
- odds-provider calls;
- S5C ingestion;
- consensus calculation;
- model probabilities;
- signal thresholds;
- stake policy;
- ledger rows;
- settlements;
- persistent volume contents.

# Court Edge Web - Phase 3 Sprint 2

Independent React/Vite frontend staging candidate. It does not replace the Railway backend or the currently published Perplexity interface.

## Verification
```bash
npm ci
npm run verify
```

`verify` performs source independence checks, TypeScript syntax and type checks, a production Vite build, static distribution validation and a cryptographic release manifest.

## Backend smoke
```bash
COURTEDGE_API_BASE_URL=https://web-production-7067b.up.railway.app npm run check:backend
```
The default smoke is read-only. Add `--extended` through `npm run check:backend:extended` to test the daily MLB aggregate endpoint.

## Staging
See `docs/STAGING_RUNBOOK.md` and `docs/VISUAL_QA_MATRIX.md`.

## Safety
- No secrets belong in `VITE_*` variables.
- Do not point staging write tests at production.
- The public app remains unchanged until every promotion gate passes.

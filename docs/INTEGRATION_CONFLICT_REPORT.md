# Integration Conflict Report

- Base branch: `integration/p0-staging-secure`
- Base SHA: `378fb5fe4776087933614df83d67fa7079fc8692`
- Head branch: `integration/p0-frontend-session`
- Head SHA: `33698e3ee1e3581b1f957254269471e83730d077`
- Merge exit code: `1`

## Merge output

```text
Auto-merging README.md
CONFLICT (content): Merge conflict in README.md
Auto-merging server/index.ts
CONFLICT (content): Merge conflict in server/index.ts
Auto-merging server/routes.ts
CONFLICT (content): Merge conflict in server/routes.ts
Automatic merge failed; fix conflicts and then commit the result.
```

## Unmerged files

- `README.md`
- `server/index.ts`
- `server/routes.ts`

## Git status snapshot

```text
A  .env.example
A  .github/workflows/import-sprint2-frontend.yml
A  .github/workflows/integration-p0-frontend.yml
A  .github/workflows/p0-security-remediation.yml
UU README.md
A  docs/P0_SECURITY_RUNBOOK.md
A  frontend/.dockerignore
A  frontend/.env.example
A  frontend/.env.production.example
A  frontend/.env.staging.example
A  frontend/.gitignore
A  frontend/CHANGELOG_PHASE3.md
A  frontend/DEPLOYMENT_CHECKLIST.md
A  frontend/Dockerfile
A  frontend/README.md
A  frontend/SOURCE_PACKAGE_MANIFEST.json
A  frontend/SOURCE_PROVENANCE.md
A  frontend/client/index.html
A  frontend/client/src/App.tsx
A  frontend/client/src/components/app-sidebar.tsx
A  frontend/client/src/components/clv-tracker.tsx
A  frontend/client/src/components/date-picker-fl.tsx
A  frontend/client/src/components/elite-factors.tsx
A  frontend/client/src/components/mlb-early-markets-card.tsx
A  frontend/client/src/components/mlb-ere-card.tsx
A  frontend/client/src/components/mlb-tesi-card.tsx
A  frontend/client/src/components/print-fab.tsx
A  frontend/client/src/components/session-control.tsx
A  frontend/client/src/components/ui/accordion.tsx
A  frontend/client/src/components/ui/alert-dialog.tsx
A  frontend/client/src/components/ui/alert.tsx
A  frontend/client/src/components/ui/aspect-ratio.tsx
A  frontend/client/src/components/ui/avatar.tsx
A  frontend/client/src/components/ui/badge.tsx
A  frontend/client/src/components/ui/breadcrumb.tsx
A  frontend/client/src/components/ui/button.tsx
A  frontend/client/src/components/ui/calendar.tsx
A  frontend/client/src/components/ui/card.tsx
A  frontend/client/src/components/ui/carousel.tsx
A  frontend/client/src/components/ui/chart.tsx
A  frontend/client/src/components/ui/checkbox.tsx
A  frontend/client/src/components/ui/collapsible.tsx
A  frontend/client/src/components/ui/command.tsx
A  frontend/client/src/components/ui/context-menu.tsx
A  frontend/client/src/components/ui/dialog.tsx
A  frontend/client/src/components/ui/drawer.tsx
A  frontend/client/src/components/ui/dropdown-menu.tsx
A  frontend/client/src/components/ui/form.tsx
A  frontend/client/src/components/ui/hover-card.tsx
A  frontend/client/src/components/ui/input-otp.tsx
A  frontend/client/src/components/ui/input.tsx
A  frontend/client/src/components/ui/label.tsx
A  frontend/client/src/components/ui/menubar.tsx
A  frontend/client/src/components/ui/navigation-menu.tsx
A  frontend/client/src/components/ui/pagination.tsx
A  frontend/client/src/components/ui/popover.tsx
A  frontend/client/src/components/ui/progress.tsx
A  frontend/client/src/components/ui/radio-group.tsx
A  frontend/client/src/components/ui/resizable.tsx
A  frontend/client/src/components/ui/scroll-area.tsx
A  frontend/client/src/components/ui/select.tsx
A  frontend/client/src/components/ui/separator.tsx
A  frontend/client/src/components/ui/sheet.tsx
A  frontend/client/src/components/ui/sidebar.tsx
A  frontend/client/src/components/ui/skeleton.tsx
A  frontend/client/src/components/ui/slider.tsx
A  frontend/client/src/components/ui/switch.tsx
A  frontend/client/src/components/ui/table.tsx
A  frontend/client/src/components/ui/tabs.tsx
A  frontend/client/src/components/ui/textarea.tsx
A  frontend/client/src/components/ui/toast.tsx
A  frontend/client/src/components/ui/toaster.tsx
A  frontend/client/src/components/ui/toggle-group.tsx
A  frontend/client/src/components/ui/toggle.tsx
A  frontend/client/src/components/ui/tooltip.tsx
A  frontend/client/src/hooks/use-mobile.tsx
A  frontend/client/src/hooks/use-toast.ts
A  frontend/client/src/index.css
A  frontend/client/src/lib/auth-context.tsx
A  frontend/client/src/lib/context.tsx
A  frontend/client/src/lib/mlb-model.ts
A  frontend/client/src/lib/model.ts
A  frontend/client/src/lib/nhl-model.ts
A  frontend/client/src/lib/picks-api.ts
A  frontend/client/src/lib/queryClient.ts
A  frontend/client/src/lib/travel.ts
A  frontend/client/src/lib/utils.ts
A  frontend/client/src/lib/wnba-model.ts
A  frontend/client/src/main.tsx
A  frontend/client/src/pages/calculator.tsx
A  frontend/client/src/pages/dashboard.tsx
A  frontend/client/src/pages/history.tsx
A  frontend/client/src/pages/mlb-history.tsx
A  frontend/client/src/pages/mlb-predictor.tsx
A  frontend/client/src/pages/nhl-history.tsx
A  frontend/client/src/pages/nhl-predictor.tsx
A  frontend/client/src/pages/not-found.tsx
A  frontend/client/src/pages/picks.tsx
A  frontend/client/src/pages/predictor.tsx
A  frontend/client/src/pages/wnba-history.tsx
A  frontend/client/src/pages/wnba-predictor.tsx
A  frontend/client/src/vite-env.d.ts
A  frontend/components.json
A  frontend/docs/API_CONTRACT.md
A  frontend/docs/PHASE3_SPRINT1_STATUS.md
A  frontend/docs/SPRINT2_STATUS.md
A  frontend/docs/STAGING_RUNBOOK.md
A  frontend/docs/VISUAL_QA_MATRIX.md
A  frontend/nginx.conf
A  frontend/package-lock.json
A  frontend/package.json
A  frontend/postcss.config.js
A  frontend/qa/EXECUTION_EVIDENCE.json
A  frontend/qa/REFERENCE_RELEASE_MANIFEST.json
A  frontend/qa/STATIC_INVENTORY.json
A  frontend/qa/mock-backend-smoke-core.txt
A  frontend/qa/mock-backend-smoke-extended.txt
A  frontend/qa/reference-dist-smoke.txt
A  frontend/scripts/backend-smoke.mjs
A  frontend/scripts/dist-smoke.mjs
A  frontend/scripts/release-manifest.mjs
A  frontend/scripts/syntax-check.mjs
A  frontend/scripts/verify-frontend.mjs
A  frontend/tailwind.config.ts
A  frontend/tsconfig.json
A  frontend/vite.config.ts
A  package-lock.json
A  scripts/fix-integration-frontend-types.py
A  scripts/generate-courtedge-password-hash.mjs
A  scripts/integration-auth-smoke.ts
A  scripts/p0-sanitize-routes.py
A  scripts/p0-secret-scan.py
A  scripts/p0-security-smoke.ts
A  server/auth.ts
UU server/index.ts
A  server/picks-v2.ts
UU server/routes.ts
A  server/security.ts
```

The merge was aborted. No source changes from the head branch were committed.

# Visual QA Matrix

Run at 1440x1000 and 390x844. Compare against the existing Court Edge interface, not against a redesigned mockup.

| Route | Critical checks |
|---|---|
| `#/` | Sidebar, KPI cards, bankroll widgets, no horizontal overflow |
| `#/predictor` | NBA form fields, action buttons, result panel |
| `#/mlb` | MLB game selector, pitcher panels, ERE/F5 sections, loading/error states |
| `#/wnba` | WNBA inputs and results, responsive cards |
| `#/nhl` | Goalie selectors, team metrics and recommendation panel |
| `#/calculator` | Odds fields, stake calculations and numeric validation |
| `#/history` | NBA history rows and filters |
| `#/mlb-history` | MLB history rows, result badges and totals |
| `#/wnba-history` | WNBA history rows and filters |
| `#/nhl-history` | NHL history rows and filters |
| `#/picks` | Manual picks uses `/api/picks/v2`; list, filters and empty state |

## Pass criteria
- No clipped labels, invisible text or overlapping controls.
- Sidebar works at both viewport widths.
- Every route loads without a blank screen.
- API failures produce an explicit state rather than an infinite spinner.
- No request is sent to `pplx.app`.
- `/picks` does not read or overwrite the legacy global store.

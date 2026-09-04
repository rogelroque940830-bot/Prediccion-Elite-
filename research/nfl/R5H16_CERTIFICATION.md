# NFL R5H16 — Late-Down Final Certification

## Status

Research-only historical robustness certification for the frozen `LATE_DOWN_CONVERSION` route discovered in R5H15.

- Production changed: **NO**
- Market data used: **NO**
- R5H8 protected core changed: **NO**
- Target-season retuning in R5H16: **NO**
- Frozen R5H15 selections altered using outcomes: **NO**

## Definitive CI evidence

- Workflow: `NFL R5H16 Late Down Final Certification`
- Run: `32685952549`
- Job: `97310926827`
- Result: **SUCCESS**
- Artifact: `nfl-r5h16-late-down-final-certification-evidence`
- Artifact ID: `9505840623`
- Artifact SHA-256: `303b8c268985936614dd31fff48134a3c14cd5228508af14bfdce79e15eab8d5`
- Head SHA tested: `dc97512b44d3eeba2552f7879ba16894a565a4a9`

## Frozen historical results

### Protected R5H8 core

- Games: **158**
- Record: **125-33**
- Accuracy: **79.1139%**

### R5H15 late-down marginal route

- Games: **46**
- Record: **40-6**
- Accuracy: **86.9565%**
- Wilson 95% lower bound: **74.3339%**
- Active seasons: **2024, 2025**

By season:

- 2024: **19 games, 18-1, 94.7368%**
- 2025: **27 games, 22-5, 81.4815%**

### Exact confidence control

R5H16 added an outcome-free 1:1 nearest-confidence control within each target season.

- Control games: **46**
- Control accuracy: **73.9130%**
- Late-down delta vs exact confidence control: **+13.0435 percentage points**
- Cluster-bootstrap mean delta: **+13.0141 percentage points**
- Cluster-bootstrap 95% interval: **[-6.00, +33.25] percentage points**
- `better95`: **false**

### Combined route

Protected R5H8 core plus frozen late-down marginal selections:

- Games: **204**
- Record: **165-39**
- Accuracy: **80.8824%**
- Coverage: **9.6363%** of the 2,117-game OOS card

This exceeds the R5H12 benchmark on both historical accuracy and coverage:

- R5H12: **167 games, 133-34, 79.6407%, 7.8885% coverage**
- R5H16 combined: **204 games, 165-39, 80.8824%, 9.6363% coverage**

## Robustness gates

All predeclared R5H16 operational gates passed:

- Marginal volume: PASS
- Marginal accuracy: PASS
- Multi-season activity: PASS
- Minimum volume in each active season: PASS
- Minimum accuracy in each active season: PASS
- Positive delta vs exact-confidence control: PASS
- Combined accuracy >= R5H12: PASS
- Combined coverage >= R5H12: PASS
- Threshold sensitivity: PASS
- Team concentration: PASS

Threshold sensitivity around the frozen H15 cutoff:

- `0.95 × threshold`: **49 games, 42-7, 85.7143%**
- `1.00 × threshold`: **46 games, 40-6, 86.9565%**
- `1.05 × threshold`: **43 games, 37-6, 86.0465%**

Maximum single team/side concentration: **8.6957%**.

## Statistical interpretation

R5H16 passed the predefined **operational robustness** gate. It did **not** establish conventional 95% statistical superiority over the exact-confidence control:

- Bootstrap lower bound remains below zero.
- One-sided exact test versus the historical R5H8 core rate: `p = 0.1270527`.

Therefore the correct statement is:

> R5H16 certifies the frozen late-down route as a strong historical operational candidate, not as a guaranteed 86.96% future win-rate rule.

## Research custody

- Same-game PBP is not used as a pregame feature.
- Pregame state is snapshotted before the game and updated only after the completed game.
- R5H16 does not retune R5H15 thresholds.
- R5H16 does not remove or retune the R5H8 core.
- No odds, spread, moneyline, total, vig, ROI, CLV, staking or market optimization is used.
- No production integration is performed by this certification.

## Decision checkpoint

R5H16 is the current strongest historical combined route in this NFL research branch: **204 selections at 80.88% accuracy** with the protected R5H8 core plus the frozen late-down marginal family.

A subsequent production decision must use a separately declared validation/integration gate; it must not retroactively alter the R5H16 evidence.

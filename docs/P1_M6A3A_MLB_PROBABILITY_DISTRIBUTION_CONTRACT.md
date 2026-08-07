# P1-M6A3A — MLB Probability Distribution and Calibration Contract

## Purpose

P1-M6A3A replaces the idea of extending existing fixed heuristics to new MLB markets with a falsifiable probability-distribution contract. This phase is **shadow only**: it defines and tests how horizon-specific run distributions produce exact market probabilities, but it cannot make any market actionable.

## Statistical baseline

The initial numerical baseline is an independent team-run Negative Binomial (NB2) process with optional zero inflation. For team mean `mu` and dispersion `k`, variance is `mu + mu^2/k`. P1-M6A3A does not fit `mu`, `k`, or zero inflation. P1-M6A3B must estimate and validate those quantities out of sample.

The Negative Binomial is chosen as an explicitly testable baseline rather than a claim of final truth. Published work on MLB scoring shows that run-count processes are more complex than a single Poisson model, and comparative work has found meaningful overdispersion in MLB where Negative Binomial models can outperform Poisson. Sources used for this design include:

- Albert, J. (1996), *Modeling Pitcher Performance and the Distribution of Runs per Inning in Major League Baseball*, The American Statistician.
- Bayesian comparison of Poisson, Negative Binomial and Normal point models across North American sports: https://pmc.ncbi.nlm.nih.gov/articles/PMC8282683/
- Probability calibration guidance and reliability diagrams: https://scikit-learn.org/stable/modules/calibration.html

## Finite-support numerical safety

The run-count distribution is infinite, so numerical market evaluation requires finite support. A3A treats the caller's `maxRunsPerTeam` as a **minimum requested support**, not as permission to discard a material tail.

The engine expands that support automatically until the omitted probability for each team is at most `1e-6`, subject to a hard ceiling of 60 runs per team. The effective support, requested support, tail target, actual home/away tail mass and whether expansion occurred are all returned in diagnostics.

If the hard ceiling is reached and either omitted tail remains above `1e-6`, the full horizon distribution throws `P1_M6A3A_TAIL_MASS_TARGET_NOT_MET`. It does **not** silently renormalize a materially truncated distribution. Renormalization of the joint finite grid is allowed only after both team tails satisfy the strict target, and the residual omitted masses remain visible in diagnostics.

## Horizon separation

Separate distributions are required for:

- first inning;
- first 3 innings;
- first 5 innings;
- full game.

A distribution can only price a canonical market whose period matches its horizon. F3 probabilities cannot price F5 markets, and F5 probabilities cannot price full-game markets.

## Derived exact-market probabilities

The joint run distribution is used directly to calculate `WIN / PUSH / LOSS` for:

- ML by exact horizon;
- Run Line at the exact supplied line;
- Total at the exact supplied line;
- Team Total at the exact supplied line and selected team;
- NRFI/YRFI from the first-inning zero-run event.

Discrete push mass is preserved. Integer totals and integer run lines therefore retain explicit push probability instead of using a continuous Normal approximation that forces push probability to zero.

## Full-game ties

An independent score-count baseline assigns positive probability to equal final scores even though MLB games are normally resolved through extra innings. A3A makes that modeling mismatch explicit: for `FULL_GAME`, equal-score mass is removed and the remaining joint distribution is conditioned on non-tie. The removed mass is reported in diagnostics. A3B must test whether this approximation is acceptable or replace it with an explicit extra-innings component.

## Dependence assumption

Home and away run counts are independent in this baseline. That assumption is recorded as a diagnostic, not hidden. Shared weather, park, umpire, game-state and bullpen effects can induce dependence. A3B must compare this baseline against richer alternatives rather than assuming independence is final.

## Calibration

A3A evaluates full `WIN / PUSH / LOSS` probability vectors with:

- multiclass Brier loss;
- multiclass log loss;
- one-vs-rest reliability bins;
- macro expected calibration error (ECE);
- Wilson 95% intervals for empirical bin frequencies;
- sample count and observed push rate.

Brier and log loss are proper scoring rules, but Brier alone does not isolate calibration from resolution. Reliability bins are therefore mandatory evidence alongside aggregate scores. Reported summary rates are rounded for stable transport, so verification uses explicit numerical tolerances rather than binary floating-point equality for non-terminating fractions such as `1/3`.

## Certification boundary

A3A has only one model status: `EXPERIMENTAL_SHADOW`.

Every distribution and every exact-market probability returns `actionabilityAllowed: false`.

A calibration report without a versioned A3B policy returns `POLICY_UNSET`. Even when an explicitly supplied test policy is met, the strongest possible A3A state is `CALIBRATION_PASS_CANDIDATE`; it still returns `actionabilityAllowed: false` and requires out-of-sample A3B certification.

A3A therefore cannot create `BET`, `ACTIONABLE_FINAL`, units, sportsbook execution, ledger writes, production exposure or automatic model changes.

## Next phase

P1-M6A3B must build a historical dataset, fit horizon-specific run means/dispersion and relevant covariates, compare candidate distribution families, perform time-aware out-of-sample validation and establish a versioned calibration policy. Only after that evidence exists can P1-M6A3C integrate live inference into the scientific capture/readiness path.

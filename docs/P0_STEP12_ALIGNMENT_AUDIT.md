# P0 Step 12 — Alignment Audit of Prior Predictor Work

## Audit question

Has the P0 MLB pipeline been built in a way that supports the current strategy:

> discover useful sporting signals, validate them out of sample, preserve opportunity volume, then use current executable odds to determine whether the signal is economically actionable?

## Executive finding

Overall alignment is **GOOD**, with one known scientific bottleneck in Step 10.

The prior pipeline generally separates sporting evidence from market price, avoids arbitrary live probability/EV cutoffs, preserves overflow candidates where possible, and explicitly blocks automatic betting. Step 11B/11C further protect against the exact failure mode we are concerned about: improving apparent quality by eliminating nearly all picks.

The historical research spine also used chronological rolling-origin validation and pregame/as-of evidence. However, earlier historical experiments mostly asked whether individual feature families improved probabilistic count models. Step 12 adds a new but compatible question: whether combinations of already-certified pregame signals define stable high-hit-rate pockets, including but not limited to 70–80% and exceptional 80–90%+ pockets.

## Step-by-step alignment

### Step 5 — Cheap screening

**Alignment: GOOD.**

Role: remove games that are operationally unsuitable while preserving provisional games rather than requiring all final inputs immediately.

Why aligned:
- screening is not a betting recommendation;
- it does not use sportsbook price to manufacture sporting strength;
- provisional evidence can continue downstream rather than being discarded merely because final inputs are not yet available.

Risk to monitor:
- any future new DROP reason must demonstrate that it is an operational/data-validity necessity, not an unvalidated performance filter.

### Step 6 — Shortlist

**Alignment: GOOD WITH A CAP TO MONITOR.**

Current contract:
- market agnostic;
- no odds required;
- no weighted score;
- no forced quota;
- qualification requires at least one nonzero native run signal from a certified component;
- maximum selected shortlist is 8.

Why aligned:
- certified sporting evidence is identified before price;
- no arbitrary probability or EV threshold is used;
- a fixed winner is not predicted here.

Potential volume concern:
- the selected list is capped at 8, but this was later mitigated by Step 7B because the upstream selected cap does not define the full intrinsic population.

### Step 7 / 7B — Intrinsic edge

**Alignment: VERY GOOD.**

Current contract explicitly states:
- market odds are not used;
- odds do not affect intrinsic rank;
- no weighted score;
- no numeric Elite score;
- no double-counting of same underlying evidence;
- final-input status does not affect intrinsic rank;
- the Step 6 selected cap does not affect the intrinsic population;
- research candidates are not outcome-certified and cannot auto-promote.

Why aligned:
- this is the pipeline layer closest to Step 12 sporting-signal discovery;
- it preserves the distinction between an intrinsic baseball thesis and a priced betting opportunity;
- overflow recovery prevents the shortlist cap from silently destroying potentially strong sporting cases.

Step 12 implication:
- historical pocket discovery should map its feature families back to these intrinsic components/theses wherever deterministic equivalence is possible.

### Step 8 — Market discovery / selective odds acquisition

**Alignment: GOOD.**

Current selective acquisition contract:
- only requests markets supported by scoped intrinsic thesis evidence;
- one paid request per game maximum;
- requests proceed by intrinsic rank;
- execution/reference prices are acquired together;
- does not calculate Market Edge;
- does not recommend a bet;
- does not place bets.

Why aligned:
- price acquisition occurs only after the sporting thesis exists;
- the market does not create the sporting signal;
- quota controls are operational constraints rather than performance thresholds.

Risk to monitor:
- provider budget exhaustion can prevent price acquisition for lower-ranked games. This is not a sporting filter, but daily volume reporting should distinguish `candidate existed` from `price could not be acquired`.

### Step 9 — Market Edge

**Alignment: VERY GOOD.**

Role: compare model probability against executable market price and express economic evidence.

Why aligned:
- Positive EV is economic evidence, not automatic BET_ELITE;
- no arbitrary high EV threshold is required simply to preserve a candidate;
- this is exactly where current odds belong under the Step 12 philosophy.

Step 12 implication:
- historical sporting discovery does not need Step 9-equivalent historical prices;
- when a discovered/OOS-supported signal appears prospectively, Step 9 remains the correct place to ask whether today's price gives positive EV.

### Step 10 — Market model adapters

**Alignment: SCIENTIFICALLY GOOD, CURRENTLY THE MAIN MARKET-COVERAGE BOTTLENECK.**

Role: permit only model probabilities that can be defended without market contamination.

Current practical limitation:
- READY support is narrower than the full desired market repertoire, especially compared with ML/F5 ML/Run Line opportunities.

Why still aligned:
- refusing to manufacture probabilities is scientifically preferable to opening more markets with contaminated evidence.

Risk:
- a genuine historical sporting signal may map naturally to a market Step 10 cannot yet price with a certified probability adapter. Step 12 should record such cases as `SPORTING_SIGNAL_SUPPORTED_BUT_PRICE_ADAPTER_UNAVAILABLE`, not reinterpret them as failed signals.

### Step 11A — Operating Envelope

**Alignment: GOOD.**

Current contract requires intact Positive EV evidence and upstream eligibility but explicitly applies:
- no fixed EV threshold;
- no fixed probability threshold;
- no numeric Elite score;
- no outcome-profitability certification;
- no final bet recommendation;
- no BET_ELITE;
- no stake.

Why aligned:
- this is an evidence-eligibility boundary, not a high-hit-rate filter.

### Step 11B — Volume-aware calibration

**Alignment: EXCELLENT.**

Current contract reports quality and opportunity volume together:
- retention percentage;
- active-date coverage;
- no-pick dates;
- average picks per active date;
- calibration and proper scoring;
- flat-stake ROI when price-aware settlements exist.

It also preserves 80 decisive observations / 30 decisive dates as a research-sufficiency requirement rather than a live-pick filter.

Why aligned:
- a 90% pocket with tiny sample/near-zero frequency cannot silently beat a stable 72% signal with broad coverage;
- both can remain research candidates and be evaluated in context.

### Step 11C — Prospective Elite evidence ledger

**Alignment: EXCELLENT.**

Current contract:
- captures 100% of Step 11A Elite evidence candidates;
- no additional eligibility filter;
- silent candidate drop forbidden;
- immutable pregame identity;
- price/economics/settlement consistency validated fail-closed;
- no BET_ELITE/stake/automatic wagering.

Why aligned:
- Step 12 can discover historical hypotheses without altering the prospective baseline;
- every hypothesis can later be tested against the same complete prospectively captured population.

## Historical research alignment

The earlier 2025 historical work is methodologically aligned but answered a narrower question.

Strong alignment already present:
- official MLB outcomes rather than selected betting-ledger outcomes;
- stable sporting outcome digest;
- chronological rolling-origin validation;
- training dates strictly before validation dates;
- explicit as-of evidence for starting pitchers and official T-5 batting orders;
- no automatic model promotion/actionability.

Earlier question:
- does feature family X improve held-out run-distribution/probabilistic fit?

Step 12 additional question:
- do combinations of certified pregame signals define reproducible outcome pockets with unusually high hit rates and acceptable frequency?

These questions are complementary, not contradictory.

## Step 12 operating rule after audit

We will not require a signal to be 80–90% to remain useful.

Research will keep multiple strata visible, for example:
- stable/moderate edge pockets;
- strong edge pockets;
- exceptional high-hit-rate pockets.

No stratum becomes a live filter from hit rate alone. Historical discovery must survive chronological OOS, and prospective occurrences must still pass the current price/EV check in the appropriate market.

## Changes required by this audit

No rollback of Steps 5–11 is justified.

Required forward actions:
1. keep Step 10 market coverage as an explicit scientific limitation, not evidence that a sporting signal failed;
2. audit historical feature compatibility before pocket mining;
3. discover simple signal combinations without outcome leakage;
4. report hit rate together with sample and frequency;
5. preserve an untouched chronological OOS/holdout;
6. use Step 11C for prospective confirmation;
7. use current Step 9/10 market economics to decide whether a present-day occurrence offers positive EV.

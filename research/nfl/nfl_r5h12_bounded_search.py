#!/usr/bin/env python3
"""Bounded-search launcher for R5H12.

Keeps the R5H12 design unchanged while constraining the predeclared hyperparameter
family to a computationally efficient grid. No target-season information is used.
"""
from __future__ import annotations

import nfl_r5h12_prototype_specific_acceptance as h12

# Predeclared bounded search grid: retains prototype count, local-distance,
# marginal-band, redundancy, reliability, and prototype-specific calibration
# variation while avoiding an unnecessarily large Cartesian product.
h12.WIN_PROTOTYPES = (2, 3)
h12.LOSS_PROTOTYPES = (1, 2)
h12.DISTANCE_ALPHA = (0.0, 0.30)
h12.BAND_LOW = (0.60, 0.70, 0.80)
h12.AGREEMENT_FLOOR = (0.70, 0.80)
h12.SYNERGY_FLOOR = (0.00,)
h12.REDUNDANCY_CAP = (0.15, 0.25, 0.35)
h12.BASE_QUANTILE = (0.35, 0.55, 0.75)
h12.RELIABILITY_BETA = (0.75, 1.25)
h12.SHRINK_TAU = (8.0,)
h12.MIN_PROTO_RELIABILITY = (0.66, 0.70)

if __name__ == "__main__":
    h12.main()

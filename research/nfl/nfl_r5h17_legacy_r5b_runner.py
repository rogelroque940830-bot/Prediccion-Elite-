#!/usr/bin/env python3
from __future__ import annotations

import pandas as pd

import nfl_r5b_qb_identity_availability as r5b

# nflverse injury reports begin in 2009. H17 deliberately reconstructs a
# pre-discovery 2001-2011 training/history window and evaluates 2009-2011.
# For 2001-2008 the R5B pipeline keeps the injury fields structurally missing
# rather than inventing data; depth charts and PBP remain available.
_original_load_injuries = r5b.load_injuries


def _load_injuries_available_era(cache, seasons):
    eligible = [int(y) for y in seasons if int(y) >= 2009]
    if not eligible:
        return pd.DataFrame(), []
    return _original_load_injuries(cache, eligible)


r5b.load_injuries = _load_injuries_available_era

if __name__ == "__main__":
    r5b.main()

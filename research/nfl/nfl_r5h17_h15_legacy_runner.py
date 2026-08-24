#!/usr/bin/env python3
from __future__ import annotations

import numpy as np
import pandas as pd

import nfl_r5_leakage_safe as base
import nfl_r5h_contextual_rule_weighting as r5h
import nfl_r5h4_elite_selection_gate as r5h4
import nfl_r5h15_independent_signal_family_discovery as h15


def expert_oos_source_available(x: pd.DataFrame, start: int, end: int):
    """R5H expert OOS with explicit source-availability custody.

    If an entire rule block has no observed training value in an early historical
    season, the block is unavailable rather than negative/positive evidence. It
    therefore contributes a neutral probability of 0.50 until actual observations
    exist. No values are synthesized and no target outcome is consulted.
    """
    blocks = r5h.rule_blocks()
    rows = []
    tuning = []
    for y in range(start, end + 1):
        tr = x[x.season < y]
        te = x[x.season == y]
        if tr.empty or te.empty:
            continue
        q = te[[
            "game_id", "season", "week", "home_win", "home_uncertainty", "away_uncertainty",
            "home_r5b2_hi_uncertainty", "away_r5b2_hi_uncertainty",
            "home_r5b2_hi_switch", "away_r5b2_hi_switch",
        ]].copy().rename(columns={"home_win": "y"})

        for name, cols in blocks.items():
            observed = bool(tr[cols].notna().any(axis=0).any())
            if not observed:
                q[f"p__{name}"] = 0.5
                tuning.append({
                    "expert": name,
                    "test_season": int(y),
                    "C": np.nan,
                    "training_through": int(tr.season.max()),
                    "source_available": False,
                    "neutralized_unavailable_block": True,
                })
                print("R5H17_NEUTRAL_UNAVAILABLE", y, name)
                continue

            c = base.tune_logit(tr, cols)
            m = base.pipe("logit", c)
            m.fit(tr[cols], tr.home_win.astype(int))
            p = np.clip(m.predict_proba(te[cols])[:, 1], 1e-6, 1 - 1e-6)
            q[f"p__{name}"] = p
            tuning.append({
                "expert": name,
                "test_season": int(y),
                "C": float(c),
                "training_through": int(tr.season.max()),
                "source_available": True,
                "neutralized_unavailable_block": False,
            })
        rows.append(q)

    if not rows:
        raise RuntimeError("R5H17 could not create source-available expert OOS predictions")
    return pd.concat(rows, ignore_index=True), pd.DataFrame(tuning)


# Compatibility injections only. H15 target custody, scoring, threshold search,
# family definitions and protected-core logic remain unchanged.
r5h.expert_oos = expert_oos_source_available
h15.r5h4 = r5h4

if __name__ == "__main__":
    h15.main()

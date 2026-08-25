#!/usr/bin/env python3
from __future__ import annotations

import pandas as pd

import nfl_r5h16_late_down_final_certification as h16
import nfl_r5h18_prospective_deployability_audit as h18


def team_concentration_from_game_id(df: pd.DataFrame, selected, source: pd.DataFrame) -> pd.DataFrame:
    # The leakage-safe hybrid matrix intentionally omits raw team labels. nflverse REG
    # game_id is canonical YYYY_WEEK_AWAY_HOME, so recover labels deterministically
    # without adding a data source or changing any H18 selection/outcome logic.
    z = df.loc[selected, ["game_id", "season", "week"]].copy()
    parts = z.game_id.astype(str).str.rsplit("_", n=2, expand=True)
    if parts.shape[1] != 3 or parts[1].isna().any() or parts[2].isna().any():
        raise RuntimeError("R5H18 could not recover team labels from canonical nflverse game_id")
    z["away_team"] = parts[1].astype(str)
    z["home_team"] = parts[2].astype(str)

    rows = []
    n = len(z)
    for side in ("home_team", "away_team"):
        for team, g in z.groupby(side, dropna=True):
            rows.append({
                "team": str(team),
                "side": side,
                "games": int(len(g)),
                "share_of_marginal_games": float(len(g) / n) if n else 0.0,
            })
    if not rows:
        return pd.DataFrame(columns=["team", "side", "games", "share_of_marginal_games"])
    return pd.DataFrame(rows).sort_values(["games", "team"], ascending=[False, True]).reset_index(drop=True)


h16.team_concentration = team_concentration_from_game_id
h18.r5h16.team_concentration = team_concentration_from_game_id

if __name__ == "__main__":
    h18.main()

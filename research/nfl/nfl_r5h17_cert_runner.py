#!/usr/bin/env python3
from __future__ import annotations

import pandas as pd

import nfl_r5h17_pre_discovery_temporal_backtest as h17


def team_concentration_from_game_id(df: pd.DataFrame, selected, source: pd.DataFrame) -> pd.DataFrame:
    """Compute concentration from canonical nflverse game_id when team columns are absent.

    nflverse game ids use SEASON_WEEK_AWAY_HOME. The legacy hybrid artifact keeps
    game_id but not home_team/away_team. Parsing the identifiers restores only team
    labels for this diagnostic and does not affect selection, score, thresholds or outcomes.
    """
    z = df.loc[selected, ["game_id", "season", "week"]].copy()
    if {"home_team", "away_team"}.issubset(source.columns):
        z = z.merge(
            source[["game_id", "home_team", "away_team"]],
            on="game_id",
            how="left",
            validate="one_to_one",
        )
    else:
        parts = z.game_id.astype(str).str.rsplit("_", n=2, expand=True)
        if parts.shape[1] != 3:
            raise RuntimeError("R5H17 cannot parse canonical nflverse game_id for team concentration")
        z["away_team"] = parts.iloc[:, 1]
        z["home_team"] = parts.iloc[:, 2]

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
    return pd.DataFrame(rows).sort_values(["games", "team"], ascending=[False, True])


h17.team_concentration = team_concentration_from_game_id

if __name__ == "__main__":
    h17.main()

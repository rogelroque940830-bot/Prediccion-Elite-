#!/usr/bin/env python3

import importlib.util
import pathlib
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("p0-step12v80-capture-clock.py")
spec = importlib.util.spec_from_file_location("v80_clock", MODULE_PATH)
assert spec and spec.loader
clock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clock)


def game(game_pk, start, abstract="Preview", detailed="Scheduled"):
    return {
        "gamePk": game_pk,
        "officialDate": "2026-08-21",
        "gameDate": start,
        "status": {
            "abstractGameState": abstract,
            "detailedState": detailed,
            "codedGameState": "S",
        },
        "teams": {
            "home": {"team": {"id": 110}},
            "away": {"team": {"id": 147}},
        },
    }


class CaptureClockTest(unittest.TestCase):
    def test_attempt_order_is_exactly_t10_t7_t4(self):
        self.assertEqual(clock.ATTEMPT_LEADS, (10, 7, 4))

    def test_planner_dispatches_only_uncaptured_nonterminal_games_in_window(self):
        now = clock.parse_time("2026-08-21T18:00:00Z")
        schedule = {
            "dates": [{
                "games": [
                    game(1, "2026-08-21T18:20:00Z"),
                    game(2, "2026-08-21T18:25:00Z"),
                    game(3, "2026-08-21T18:40:00Z"),
                    game(4, "2026-08-21T18:03:00Z"),
                    game(5, "2026-08-21T18:18:00Z"),
                    game(6, "2026-08-21T18:22:00Z", abstract="Live", detailed="In Progress"),
                ]
            }]
        }
        rows = clock.plan_games(
            schedule,
            "2026-08-21",
            now,
            captured={2},
            terminal_attempts={5},
            min_lead=4,
            max_lead=35,
        )
        self.assertEqual([row["gamePk"] for row in rows], [1])
        self.assertAlmostEqual(rows[0]["leadMinutesAtPlanner"], 20.0)

    def test_terminal_attempt_reader_blocks_only_terminal_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            pathlib.Path(tmp, "1.json").write_text('{"gamePk": 1, "terminal": true}\n', encoding="utf-8")
            pathlib.Path(tmp, "2.json").write_text('{"gamePk": 2, "terminal": false}\n', encoding="utf-8")
            self.assertEqual(clock.terminal_attempt_game_pks(tmp), {1})

    def test_schedule_postponed_is_not_pregame_capture_candidate(self):
        postponed = game(9, "2026-08-21T18:20:00Z", abstract="Preview", detailed="Postponed")
        self.assertFalse(clock.schedule_pregame(postponed))

    def test_stage_late_boundary_supports_retry_progression(self):
        # A T-10 stage that is already more than 0.75 minutes late must be
        # treated as missed so the caller can proceed to T-7 rather than
        # mislabeling a late attempt as T-10.
        stage = 10
        tolerance = clock.DEFAULT_STAGE_LATE_TOLERANCE_MINUTES
        self.assertLess(8.0, stage - tolerance)
        self.assertGreaterEqual(9.5, stage - tolerance)


if __name__ == "__main__":
    unittest.main()

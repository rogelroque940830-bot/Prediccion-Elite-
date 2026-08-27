#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("p0-step12v68-capture-supervisor.py")
spec = importlib.util.spec_from_file_location("v68_supervisor", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(mod)


class SupervisorTests(unittest.TestCase):
    def test_merge_first_preserves_first_snapshot(self):
        rows = {}
        p1 = {"rows": [{"gamePk": 1, "officialDate": "2026-08-26", "capturedAt": "2026-08-26T20:00:00Z"}]}
        p2 = {"rows": [
            {"gamePk": 1, "officialDate": "2026-08-26", "capturedAt": "2026-08-26T20:01:00Z"},
            {"gamePk": 2, "officialDate": "2026-08-26", "capturedAt": "2026-08-26T20:01:00Z"},
        ]}
        self.assertEqual(mod.merge_first(rows, p1), 1)
        self.assertEqual(mod.merge_first(rows, p2), 1)
        self.assertEqual(rows[1]["capturedAt"], "2026-08-26T20:00:00Z")
        self.assertEqual(sorted(rows), [1, 2])

    def test_preflight_detects_upcoming_games(self):
        now = mod.dt.datetime(2026, 8, 26, 20, 0, tzinfo=mod.dt.timezone.utc)
        schedule = {"dates": [{"games": [
            {"gamePk": 1, "gameDate": "2026-08-26T20:30:00Z"},
            {"gamePk": 2, "gameDate": "2026-08-26T22:00:00Z"},
        ]}]}
        with mock.patch.object(mod, "fetch_schedule", return_value=schedule):
            result = mod.preflight("2026-08-26", now, 45)
        self.assertTrue(result["nearCaptureWindow"])
        self.assertEqual(result["upcomingGamePksWithinPreflightHorizon"], [1])
        self.assertAlmostEqual(result["nearestPositiveLeadMinutes"], 30.0)

    def test_preflight_skips_when_no_game_near(self):
        now = mod.dt.datetime(2026, 8, 26, 20, 0, tzinfo=mod.dt.timezone.utc)
        schedule = {"dates": [{"games": [{"gamePk": 2, "gameDate": "2026-08-26T22:00:00Z"}]}]}
        with mock.patch.object(mod, "fetch_schedule", return_value=schedule):
            result = mod.preflight("2026-08-26", now, 45)
        self.assertFalse(result["nearCaptureWindow"])

    def test_early_preflight_waits_until_strict_window_before_spending_dense_polls(self):
        pre = {
            "nearCaptureWindow": True,
            "nearestPositiveLeadMinutes": 24.868452416666667,
        }
        wait = mod.planned_window_entry_wait_seconds(pre, 20)
        # 4.86845 minutes to the strict boundary plus a 15-second inside-window guard.
        self.assertAlmostEqual(wait, 307.107145, places=3)
        resulting_lead = pre["nearestPositiveLeadMinutes"] - wait / 60.0
        self.assertLess(resulting_lead, 20.0)
        self.assertGreater(resulting_lead, 19.0)

    def test_observed_28_7_minute_case_is_aligned_inside_strict_window(self):
        pre = {
            "nearCaptureWindow": True,
            "nearestPositiveLeadMinutes": 28.7274212,
        }
        wait = mod.planned_window_entry_wait_seconds(pre, 20)
        resulting_lead = pre["nearestPositiveLeadMinutes"] - wait / 60.0
        self.assertAlmostEqual(resulting_lead, 19.75, places=6)

    def test_no_window_entry_wait_when_already_inside_strict_window(self):
        pre = {
            "nearCaptureWindow": True,
            "nearestPositiveLeadMinutes": 19.5,
        }
        self.assertEqual(mod.planned_window_entry_wait_seconds(pre, 20), 0.0)

    def test_no_window_entry_wait_without_near_game(self):
        pre = {
            "nearCaptureWindow": False,
            "nearestPositiveLeadMinutes": 30.0,
        }
        self.assertEqual(mod.planned_window_entry_wait_seconds(pre, 20), 0.0)

    def test_source_window_cannot_exceed_twenty_minutes(self):
        parser_source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("V68_SUPERVISOR_CAPTURE_WINDOW_WIDENING_FORBIDDEN", parser_source)
        self.assertIn("args.max_lead_minutes <= 20", parser_source)
        self.assertIn('"scientificWindowChanged": False', parser_source)

    def test_supervisor_schema_is_outcome_blind(self):
        text = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn('"outcomesRead": False', text)
        self.assertIn('"marketPricesRead": False', text)
        self.assertIn('"scientificModelChanged": False', text)
        self.assertIn('"windowEntryAlignment": window_entry_alignment', text)


if __name__ == "__main__":
    unittest.main()

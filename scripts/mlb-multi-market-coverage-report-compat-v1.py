#!/usr/bin/env python3
"""Reporting-only compatibility adapter for the immutable multi-market scorer.

This module re-exports the parent scorer exactly and adds one alias to the
streak-summary dictionary. No model, threshold, candidate, settlement, ranking,
or scientific decision rule is changed.
"""
import importlib.util
import os

_PARENT_PATH = os.path.join(os.path.dirname(__file__), "mlb-multi-market-coverage-expansion-v1.py")
_spec = importlib.util.spec_from_file_location("mlb_multi_market_parent_report_compat", _PARENT_PATH)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"REPORT_COMPAT_PARENT_IMPORT_FAILED:{_PARENT_PATH}")
_parent = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_parent)

for _name in dir(_parent):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_parent, _name)


def streak_summary(active_dates, eligible_dates):
    """Return the immutable parent streak summary plus a reporting alias only."""
    out = dict(_parent.streak_summary(active_dates, eligible_dates))
    out["maximum"] = out["maximumNoPlayEligibleDateStreak"]
    return out

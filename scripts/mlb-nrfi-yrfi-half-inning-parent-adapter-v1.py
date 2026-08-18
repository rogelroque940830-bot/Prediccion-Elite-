#!/usr/bin/env python3
"""Narrow adapter for the half-inning study's frozen parent-route reconstruction.

The V28 scorer intentionally does not own the parent A+/Premium reconstruction. It imports
this adapter instead. The adapter delegates to the already-merged multi-market research
helper while replacing only the placeholder custody path with the immutable V66 custody
path supplied by CI. No scoring rule, threshold, market, or result is changed here.
"""
import importlib.util
import os


def _load_real_parent():
    path = os.environ.get("MLB_PARENT_MULTI_MARKET_SCORER_PATH")
    if not path:
        raise RuntimeError("NRFI_HALF_PARENT_SCORER_PATH_MISSING")
    spec = importlib.util.spec_from_file_location("nrfi_half_real_parent", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"NRFI_HALF_PARENT_IMPORT_FAILED:{path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_REAL_PARENT = _load_real_parent()
wilson = _REAL_PARENT.wilson
streak_summary = _REAL_PARENT.streak_summary


def reconstruct_parent_active_dates(args, eligible_dates):
    custody = os.environ.get("MLB_V66_CUSTODY_PATH")
    if not custody:
        raise RuntimeError("NRFI_HALF_V66_CUSTODY_PATH_MISSING")
    if not os.path.isfile(custody):
        raise RuntimeError(f"NRFI_HALF_V66_CUSTODY_NOT_FOUND:{custody}")
    args.custody = custody
    return _REAL_PARENT.reconstruct_parent_active_dates(args, eligible_dates)

#!/usr/bin/env python3
"""Test-only pinned loader for the exact immutable multi-market parent scorer.

The Full Modular reporting-compat module resolves its parent by sibling path.
This shim verifies that the checkout's authoritative parent source has the exact
Git blob used by #641, then re-exports that source without changing any rule.
"""
import importlib.util
import pathlib
import subprocess

_EXPECTED_BLOB = "5c67ba71975eb2c851f1c48feeb93605ed39b209"
_REPO = pathlib.Path(__file__).resolve().parents[3]
_REAL_REL = pathlib.Path("scripts/mlb-multi-market-coverage-expansion-v1.py")
_REAL = _REPO / _REAL_REL

_actual_blob = subprocess.check_output(
    ["git", "-C", str(_REPO), "rev-parse", f"HEAD:{_REAL_REL.as_posix()}"],
    text=True,
).strip()
if _actual_blob != _EXPECTED_BLOB:
    raise RuntimeError(f"FULL_MODULAR_PARENT_MULTI_MARKET_BLOB_DRIFT:{_actual_blob}:{_EXPECTED_BLOB}")

_spec = importlib.util.spec_from_file_location("mlb_multi_market_exact_parent_pinned", _REAL)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"FULL_MODULAR_PARENT_MULTI_MARKET_IMPORT_FAILED:{_REAL}")
_parent = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_parent)
for _name in dir(_parent):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_parent, _name)

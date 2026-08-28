#!/usr/bin/env python3
"""Operational V2 binding for the frozen R3B0 auditor.

The scientific audit logic remains byte-for-byte sourced from the V1 auditor. This wrapper
changes only the contract path and evidence version label after the upstream mutable schedule
release deleted the V1 asset id before any rows were read.
"""
from pathlib import Path

SOURCE = Path("scripts/wnba-r3b0-h2h-support-custody.py")
text = SOURCE.read_text()
replacements = {
    'CONTRACT_PATH = Path("research/wnba/WNBA_R3B0_H2H_SUPPORT_CUSTODY_CONTRACT.json")':
        'CONTRACT_PATH = Path("research/wnba/WNBA_R3B0_H2H_SUPPORT_CUSTODY_CONTRACT_V2.json")',
    '"name": "WNBA_R3B0_H2H_SUPPORT_CUSTODY_EVIDENCE_V1"':
        '"name": "WNBA_R3B0_H2H_SUPPORT_CUSTODY_EVIDENCE_V2"',
}
for old, new in replacements.items():
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one frozen binding occurrence: {old}")
    text = text.replace(old, new)

exec(compile(text, str(SOURCE), "exec"), {"__name__": "__main__", "__file__": str(SOURCE)})

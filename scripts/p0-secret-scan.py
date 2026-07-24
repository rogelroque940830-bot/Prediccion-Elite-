#!/usr/bin/env python3
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

SENSITIVE_ASSIGNMENT = re.compile(
    r'(?i)(?:api[_-]?key|secret|token|password)[A-Za-z0-9_-]*\s*[:=]\s*["\']([^"\']{20,})["\']'
)
QUERY_LITERAL = re.compile(r'(?i)(?:apiKey|token|key)=([A-Za-z0-9_-]{20,})')
SAFE_PREFIXES = (
    "replace-",
    "your-",
    "example-",
    "placeholder-",
    "${",
)
SKIP_SUFFIXES = {".lock", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".docx"}
SKIP_NAMES = {"package-lock.json"}
SKIP_PATHS = {
    Path("scripts/p0-secret-scan.py"),
    Path("scripts/p0-sanitize-routes.py"),
    Path(".github/workflows/p0-security-remediation.yml"),
}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files"], check=True, text=True, capture_output=True
    )
    return [Path(line) for line in result.stdout.splitlines() if line]


findings: list[str] = []
for path in tracked_files():
    if path in SKIP_PATHS or path.name in SKIP_NAMES or path.suffix.lower() in SKIP_SUFFIXES:
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        continue

    for line_number, line in enumerate(text.splitlines(), start=1):
        for match in SENSITIVE_ASSIGNMENT.finditer(line):
            value = match.group(1).strip().lower()
            if value.startswith(SAFE_PREFIXES):
                continue
            if value in {"application/json", "courtedge backend"}:
                continue
            findings.append(f"{path}:{line_number}: suspicious credential assignment")

        if QUERY_LITERAL.search(line):
            findings.append(f"{path}:{line_number}: credential-like query literal")

if findings:
    print("FAIL: potential committed credentials detected", file=sys.stderr)
    for finding in findings:
        print(f"- {finding}", file=sys.stderr)
    sys.exit(1)

print("PASS: no credential-like literals detected in tracked text files")

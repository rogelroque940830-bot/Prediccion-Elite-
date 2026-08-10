from pathlib import Path

PATH = Path("frontend/client/src/components/mlb-pregame-readiness-gate.tsx")
text = PATH.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global text
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    text = text.replace(old, new, 1)


replace_once(
    '''  const manualCaptureCurrent = useMemo(
    () => isMlbManualQuoteCaptureCurrent(manualCapture, market, lines),
    [manualCapture, market, lines],
  );
''',
    '''  const manualCaptureCurrent = useMemo(
    () => isMlbManualQuoteCaptureCurrent(manualCapture, { gamePk, date, market, lines }),
    [manualCapture, gamePk, date, market, lines],
  );
''',
    "manual capture exact game/date currentness",
)

replace_once(
    '''  const captureManualQuote = () => {
    const capture = createMlbManualQuoteCapture(market, lines, new Date().toISOString());
    if (!capture) return;
''',
    '''  const captureManualQuote = () => {
    const capture = createMlbManualQuoteCapture({
      gamePk,
      date,
      market,
      lines,
      capturedAt: new Date().toISOString(),
    });
    if (!capture) return;
''',
    "manual capture exact game/date creation",
)

PATH.write_text(text)

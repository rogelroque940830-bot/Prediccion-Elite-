export const MLB_CLOSING_LINE_CAPTURE_ENV = "MLB_CLOSING_LINE_CAPTURE" as const;

export function explicitOptInEnabled(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

export function isMlbClosingLineCaptureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return explicitOptInEnabled(env[MLB_CLOSING_LINE_CAPTURE_ENV]);
}

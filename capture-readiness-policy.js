export function captureRequiresVisualHydration({
  source,
  acquisitionRound = 1,
  targetUrl = "",
  foregroundAuthorized = false,
} = {}) {
  const feedCapture = !String(targetUrl ?? "").trim();
  const foregroundTargetCapture = !feedCapture && foregroundAuthorized === true;
  if (!feedCapture && !foregroundTargetCapture) return false;

  const round = Number.isFinite(Number(acquisitionRound))
    ? Math.max(1, Math.trunc(Number(acquisitionRound)))
    : 1;
  if (source === "x" && round === 2 && feedCapture) return false;
  return true;
}

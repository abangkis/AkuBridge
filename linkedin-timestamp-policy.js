(() => {
  const precisionByUnit = Object.freeze({
    s: "second",
    m: "minute",
    h: "hour",
    d: "day",
    w: "week",
    mo: "month",
    yr: "year",
  });

  function estimateFromRelativeText(value, capturedAt) {
    const match = String(value ?? "").trim().match(/^(\d{1,4})\s*(mo|yr|s|m|h|d|w)\b/i);
    const capturedMs = Date.parse(capturedAt);
    if (!match || !Number.isFinite(capturedMs)) return null;

    const amount = Number.parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (!Number.isInteger(amount) || amount < 1 || !precisionByUnit[unit]) return null;

    const estimate = new Date(capturedMs);
    if (unit === "s") {
      estimate.setUTCMilliseconds(0);
      estimate.setUTCSeconds(estimate.getUTCSeconds() - amount);
    } else if (unit === "m") {
      estimate.setUTCSeconds(0, 0);
      estimate.setUTCMinutes(estimate.getUTCMinutes() - amount);
    } else if (unit === "h") {
      estimate.setUTCMinutes(0, 0, 0);
      estimate.setUTCHours(estimate.getUTCHours() - amount);
    } else if (unit === "d") {
      estimate.setUTCHours(0, 0, 0, 0);
      estimate.setUTCDate(estimate.getUTCDate() - amount);
    } else if (unit === "w") {
      estimate.setUTCHours(0, 0, 0, 0);
      const daysSinceMonday = (estimate.getUTCDay() + 6) % 7;
      estimate.setUTCDate(estimate.getUTCDate() - daysSinceMonday - amount * 7);
    } else if (unit === "mo") {
      estimate.setUTCHours(0, 0, 0, 0);
      estimate.setUTCDate(1);
      estimate.setUTCMonth(estimate.getUTCMonth() - amount);
    } else if (unit === "yr") {
      estimate.setTime(Date.UTC(estimate.getUTCFullYear() - amount, 0, 1));
    }

    return Number.isFinite(estimate.getTime())
      ? Object.freeze({
          publishedAt: estimate.toISOString(),
          amount,
          unit,
          precision: precisionByUnit[unit],
          estimated: true,
        })
      : null;
  }

  globalThis.AkuLinkedInTimestampPolicy = Object.freeze({
    estimateFromRelativeText,
  });
})();

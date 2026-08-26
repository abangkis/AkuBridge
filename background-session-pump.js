export function createSingleFlightSessionPump(run) {
  if (typeof run !== "function") throw new TypeError("Session pump requires a runner.");

  let active = null;
  return (...args) => {
    if (active) return active;
    active = Promise.resolve()
      .then(() => run(...args))
      .finally(() => {
        active = null;
      });
    return active;
  };
}

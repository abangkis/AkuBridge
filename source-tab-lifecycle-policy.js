const OWNERSHIP = new Set(["shared", "managed"]);
const OPENED_DISPOSITIONS = new Set(["preserve", "close_after_capture"]);

export function normalizeSourceTabLifecycle(value = {}) {
  return {
    ownership: OWNERSHIP.has(value.ownership) ? value.ownership : "shared",
    openedTabDisposition: OPENED_DISPOSITIONS.has(value.openedTabDisposition)
      ? value.openedTabDisposition
      : "preserve",
  };
}

export function shouldCloseOpenedSourceTab({ opened, lifecycle, captureCompleted }) {
  return opened === true && captureCompleted === true &&
    normalizeSourceTabLifecycle(lifecycle).openedTabDisposition === "close_after_capture";
}

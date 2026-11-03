import { readFileSync } from "node:fs";
import vm from "node:vm";
import { sourceIds } from "../../source-catalog.js";
export { createCaptureSurfaceReporter as createReporterFixture } from "../../capture-surface-reporting.js";

// These operation owners are retained during the reporting-only extraction.
export function createRetainedOperationFixture(ports) {
  const worker = readFileSync(new URL("../../service-worker.js", import.meta.url), "utf8");
  const dispatchStart = worker.indexOf("async function dispatchRun(");
  const dispatchEnd = worker.indexOf("async function observeNativeRuntime(", dispatchStart);
  const releaseStart = worker.indexOf("async function releaseCaptureSurfaceWithTelemetry(");
  const marker = "\n  return outcome;\n}";
  const normalized = worker.replaceAll("\r\n", "\n");
  const releaseNormalizedStart = normalized.indexOf("async function releaseCaptureSurfaceWithTelemetry(");
  const releaseEnd = normalized.indexOf(marker, releaseNormalizedStart);
  if (dispatchStart < 0 || dispatchEnd <= dispatchStart || releaseStart < 0 || releaseEnd < releaseNormalizedStart) {
    throw new Error("Retained operation declarations are missing.");
  }
  const context = vm.createContext({ ...ports, sourceIds, BACKGROUND_DISPATCH_CONFIG_KEY: "akuBridgeBackgroundDispatch" });
  vm.runInContext(worker.slice(dispatchStart, dispatchEnd) + "\n" + normalized.slice(releaseNormalizedStart, releaseEnd + marker.length), context);
  return { dispatchRun: context.dispatchRun, releaseCaptureSurfaceWithTelemetry: context.releaseCaptureSurfaceWithTelemetry };
}

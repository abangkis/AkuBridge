import { readFile, writeFile } from "node:fs/promises";

const manifestUrl = new URL("../manifest.json", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const lockUrl = new URL("../package-lock.json", import.meta.url);

const [manifest, packageJson, packageLock] = await Promise.all([
  readJson(manifestUrl),
  readJson(packageUrl),
  readJson(lockUrl),
]);

if (manifest.version !== packageJson.version || packageJson.version !== packageLock.version) {
  throw new Error("Refusing to bump divergent manifest, package, and lockfile versions.");
}

const parts = manifest.version.split(".").map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
  throw new Error(`Unsupported extension version: ${manifest.version}`);
}
parts[2] += 1;
const version = parts.join(".");

manifest.version = version;
packageJson.version = version;
packageLock.version = version;
packageLock.packages[""].version = version;

await Promise.all([
  writeJson(manifestUrl, manifest),
  writeJson(packageUrl, packageJson),
  writeJson(lockUrl, packageLock),
]);

console.log(`AkuBridge version bumped to ${version}`);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function writeJson(url, value) {
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

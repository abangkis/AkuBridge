import { readFile, writeFile } from "node:fs/promises";

const manifestUrl = new URL("../manifest.json", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const lockUrl = new URL("../package-lock.json", import.meta.url);

const [manifest, packageJson, packageLock] = await Promise.all([
  readJson(manifestUrl),
  readJson(packageUrl),
  readJson(lockUrl),
]);

if (manifest.version_name !== packageJson.version || packageJson.version !== packageLock.version) {
  throw new Error("Refusing to bump divergent manifest, package, and lockfile versions.");
}

const preview = /^(\d+)\.(\d+)\.(\d+)-preview\.(\d+)$/.exec(packageJson.version);
if (!preview) {
  throw new Error(`Unsupported preview extension version: ${packageJson.version}`);
}
const [, major, minor, patch, build] = preview;
const nextBuild = Number(build) + 1;
const version = `${major}.${minor}.${patch}-preview.${nextBuild}`;

manifest.version = `${major}.${minor}.${patch}.${nextBuild}`;
manifest.version_name = version;
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

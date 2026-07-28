import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { registeredScriptsForSources } from "../source-access-policy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");

if (manifest.manifest_version !== 3) throw new Error("AkuBrowser package must use Manifest V3");
if (manifest.name !== "AkuBrowser") throw new Error(`unexpected public extension name: ${manifest.name}`);
if (manifest.version_name !== packageJson.version) {
  throw new Error(`manifest version name ${manifest.version_name} differs from package ${packageJson.version}`);
}

const pending = [];
const referenced = new Set();
addReference("manifest.json");
addReference(manifest.background?.service_worker);
addReference(manifest.options_ui?.page);
for (const file of Object.values(manifest.icons ?? {})) addReference(file);
for (const file of Object.values(manifest.action?.default_icon ?? {})) addReference(file);
for (const entry of manifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) addReference(file);
  for (const file of entry.css ?? []) addReference(file);
}
for (const entry of registeredScriptsForSources(["x", "linkedin", "facebook"])) {
  for (const file of entry.js ?? []) addReference(file);
  for (const file of entry.css ?? []) addReference(file);
}

while (pending.length > 0) {
  const file = pending.shift();
  const absolute = path.join(projectRoot, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`missing extension file: ${file}`);
  }
  const source = fs.readFileSync(absolute, "utf8");
  assertNoRemoteCode(file, source);
  if (file.endsWith(".html")) {
    for (const match of source.matchAll(/(?:src|href)=["'](.+?)["']/g)) {
      if (!/^(?:https?:|data:|#)/.test(match[1])) addRelative(file, match[1]);
    }
  }
  if (file.endsWith(".js")) {
    for (const match of source.matchAll(/(?:from\s+|import\s*)["'](.+?)["']/g)) {
      if (match[1].startsWith(".")) addRelative(file, match[1]);
    }
  }
}

const forbidden = /(^|\/)(?:test|tests|native-host|node_modules|coverage|dist|build)(\/|$)|\.(?:exe|dll|pdb|map|pem|key|crx)$/i;
for (const file of referenced) {
  if (forbidden.test(file)) throw new Error(`forbidden packaged file: ${file}`);
}

const files = [...referenced].sort().map((file) => ({
  path: file,
  sha256: createHash("sha256").update(fs.readFileSync(path.join(projectRoot, file))).digest("hex"),
}));
const fingerprint = createHash("sha256").update(JSON.stringify(files)).digest("hex");
console.log(JSON.stringify({
  name: manifest.name,
  version: manifest.version_name,
  chromeVersion: manifest.version,
  manifestVersion: manifest.manifest_version,
  files,
  fingerprint,
  writesArtifact: false,
}, null, 2));

function addReference(file) {
  if (!file) return;
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`package reference escapes extension root: ${file}`);
  }
  if (referenced.has(normalized)) return;
  referenced.add(normalized);
  pending.push(normalized);
}

function addRelative(owner, reference) {
  addReference(path.posix.normalize(path.posix.join(path.posix.dirname(owner), reference)));
}

function assertNoRemoteCode(file, source) {
  const checks = [
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\s*\(/, "new Function"],
    [/(?:from\s+|import\s*)["']https?:\/\//, "remote JavaScript import"],
    [/<script[^>]+src=["']https?:\/\//i, "remote script element"],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(source)) throw new Error(`${label} is forbidden in ${file}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, file), "utf8"));
}

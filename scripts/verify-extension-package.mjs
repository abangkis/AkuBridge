import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
if (manifest.manifest_version !== 3) throw new Error("AkuBridge package must use Manifest V3");
if (manifest.version_name !== packageJson.version) {
  throw new Error(`manifest version name ${manifest.version_name} differs from package ${packageJson.version}`);
}

const referenced = new Set(["manifest.json"]);
referenced.add(manifest.background.service_worker);
if (manifest.options_ui?.page) referenced.add(manifest.options_ui.page);
for (const entry of manifest.content_scripts ?? []) {
  for (const file of entry.js ?? []) referenced.add(file);
}
for (const file of [...referenced]) {
  if (!fs.existsSync(path.join(projectRoot, file))) throw new Error(`missing extension file: ${file}`);
  if (file.endsWith(".html")) {
    const html = fs.readFileSync(path.join(projectRoot, file), "utf8");
    for (const match of html.matchAll(/(?:src|href)=["'](.+?)["']/g)) {
      if (!/^(?:https?:|data:|#)/.test(match[1])) referenced.add(match[1]);
    }
  }
  if (!file.endsWith(".js")) continue;
  const source = fs.readFileSync(path.join(projectRoot, file), "utf8");
  for (const match of source.matchAll(/from\s+["']\.\/(.+?)["']/g)) referenced.add(match[1]);
}
for (const file of referenced) {
  if (!fs.existsSync(path.join(projectRoot, file))) throw new Error(`missing imported file: ${file}`);
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, file), "utf8"));
}

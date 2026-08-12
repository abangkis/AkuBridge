import test from "node:test";
import assert from "node:assert/strict";

import {
  companionInstallerVersion,
  runtimeInstallerDownload,
  runtimePortableFallbackURL,
} from "../setup-runtime-installer.js";

test("Windows bootstrap stays pinned to the packaged Sidecar companion release", () => {
  assert.deepEqual(runtimeInstallerDownload({
    platform: "windows",
    sidecarBootstrapVersion: "0.7.9",
  }), {
    name: "AkuBrowserRuntimeSetup-0.7.9.exe",
    url: "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.9/AkuBrowserRuntimeSetup-0.7.9.exe",
  });
  assert.equal(runtimePortableFallbackURL({
    platform: "windows",
    sidecarBootstrapVersion: "0.7.9",
  }), "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.9/AkuBrowser-0.7.9-windows-x64.zip");
});

test("macOS bootstrap stays pinned to the packaged Sidecar companion release", () => {
  assert.deepEqual(runtimeInstallerDownload({
    platform: "macos",
    sidecarBootstrapVersion: "0.7.9",
  }), {
    name: "AkuBrowserRuntimeSetup-0.7.9-macos-universal.pkg",
    url: "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.9/AkuBrowserRuntimeSetup-0.7.9-macos-universal.pkg",
  });
  assert.equal(runtimePortableFallbackURL({
    platform: "macos",
    sidecarBootstrapVersion: "0.7.9",
  }), "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.9/AkuBrowser-0.7.9-macos-universal.zip");
});

test("Bridge and Sidecar versions remain independent and every repair stays pinned", () => {
  assert.deepEqual(runtimeInstallerDownload({
    platform: "windows",
    sidecarBootstrapVersion: "0.7.9",
    hostUpgradeRequired: true,
  }), {
    name: "AkuBrowserRuntimeSetup-0.7.9.exe",
    url: "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.9/AkuBrowserRuntimeSetup-0.7.9.exe",
  });
  assert.equal(runtimePortableFallbackURL({
    platform: "windows",
    sidecarBootstrapVersion: "0.7.9",
    hostUpgradeRequired: true,
  }), "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.9/AkuBrowser-0.7.9-windows-x64.zip");
});

test("installer resolver fails closed for unsupported platform or version", () => {
  assert.deepEqual(runtimeInstallerDownload({
    platform: "linux",
    sidecarBootstrapVersion: "0.7.9",
  }), { name: "", url: "" });
  assert.equal(runtimePortableFallbackURL({
    platform: "windows",
    sidecarBootstrapVersion: "latest",
  }), "");
});

test("only an authenticated v2 host-upgrade target can override the packaged companion", () => {
  assert.equal(companionInstallerVersion({
    sidecarBootstrapVersion: "0.7.9",
    outcome: {
      schemaVersion: 2,
      hostUpgradeRequired: true,
      errorCode: "host_upgrade_required",
      update: { targetVersion: "0.8.1" },
    },
  }), "0.8.1");
  assert.deepEqual(runtimeInstallerDownload({
    platform: "windows",
    sidecarBootstrapVersion: "0.8.1",
  }), {
    name: "AkuBrowserRuntimeSetup-0.8.1.exe",
    url: "https://github.com/abangkis/AkuBrowser/releases/download/v0.8.1/AkuBrowserRuntimeSetup-0.8.1.exe",
  });
  for (const outcome of [
    { schemaVersion: 1, hostUpgradeRequired: true, update: { targetVersion: "9.9.9" } },
    { schemaVersion: 2, hostUpgradeRequired: true, errorCode: "runtime_incompatible", update: { targetVersion: "9.9.9" } },
    { schemaVersion: 2, hostUpgradeRequired: true, errorCode: "host_upgrade_required", update: { targetVersion: "latest" } },
  ]) {
    assert.equal(companionInstallerVersion({
      sidecarBootstrapVersion: "0.7.9",
      outcome,
    }), "0.7.9");
  }
});

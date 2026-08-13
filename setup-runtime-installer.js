const RELEASES_ROOT = "https://github.com/abangkis/AkuBrowser/releases";
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

const PLATFORM_ASSETS = Object.freeze({
  windows: Object.freeze({
    pinnedInstaller: (version) => `AkuBrowserRuntimeSetup-${version}.exe`,
    localAcceptanceInstaller: (version) => `AkuBrowserRuntimeSetup-${version}-unsigned-local.exe`,
    portable: (version) => `AkuBrowser-${version}-windows-x64.zip`,
  }),
  macos: Object.freeze({
    pinnedInstaller: (version) => `AkuBrowserRuntimeSetup-${version}-macos-universal.pkg`,
    localAcceptanceInstaller: (version) => `AkuBrowserRuntimeSetup-${version}-macos-universal-unsigned-local.pkg`,
    portable: (version) => `AkuBrowser-${version}-macos-universal.zip`,
  }),
});

export function companionInstallerVersion({
  sidecarBootstrapVersion,
  outcome,
} = {}) {
  if (!VERSION_PATTERN.test(sidecarBootstrapVersion ?? "")) return "";
  const authenticatedTarget = outcome?.schemaVersion === 2
    && outcome?.hostUpgradeRequired === true
    && outcome?.errorCode === "host_upgrade_required"
    && VERSION_PATTERN.test(outcome?.update?.targetVersion ?? "")
    ? outcome.update.targetVersion
    : "";
  return authenticatedTarget || sidecarBootstrapVersion;
}

export function runtimeInstallerDownload({
  platform,
  sidecarBootstrapVersion,
} = {}) {
  const assets = PLATFORM_ASSETS[platform];
  if (!assets || !VERSION_PATTERN.test(sidecarBootstrapVersion ?? "")) {
    return Object.freeze({ name: "", url: "" });
  }
  const name = assets.pinnedInstaller(sidecarBootstrapVersion);
  return Object.freeze({
    name,
    url: `${RELEASES_ROOT}/download/v${sidecarBootstrapVersion}/${name}`,
  });
}

export function runtimeLocalAcceptanceInstaller({
  platform,
  sidecarBootstrapVersion,
} = {}) {
  const assets = PLATFORM_ASSETS[platform];
  if (!assets || !VERSION_PATTERN.test(sidecarBootstrapVersion ?? "")) return "";
  return assets.localAcceptanceInstaller(sidecarBootstrapVersion);
}

export function runtimePortableFallbackURL({
  platform,
  sidecarBootstrapVersion,
} = {}) {
  const assets = PLATFORM_ASSETS[platform];
  if (!assets || !VERSION_PATTERN.test(sidecarBootstrapVersion ?? "")) return "";
  const name = assets.portable(sidecarBootstrapVersion);
  return `${RELEASES_ROOT}/download/v${sidecarBootstrapVersion}/${name}`;
}

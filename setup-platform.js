export const SETUP_PLATFORMS = Object.freeze({
  WINDOWS: "windows",
  MACOS: "macos",
  LINUX: "linux",
  UNKNOWN: "unknown",
});

export function detectSetupPlatform(environment = {}) {
  const platform = [
    environment.userAgentData?.platform,
    environment.platform,
    environment.userAgent,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/windows|win32|win64/.test(platform)) return SETUP_PLATFORMS.WINDOWS;
  if (/macintosh|macintel|mac os|macos/.test(platform)) return SETUP_PLATFORMS.MACOS;
  if (/linux|x11|cros/.test(platform)) return SETUP_PLATFORMS.LINUX;
  return SETUP_PLATFORMS.UNKNOWN;
}

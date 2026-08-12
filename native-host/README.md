# AkuBrowser Runtime Host

This directory contains the cross-platform Native Messaging host. It is a
separate Go executable and is not part of the Chrome extension package.

The Windows development build target is:

```powershell
go build -trimpath -o AkuBrowserRuntimeHost.exe .
```

The companion installer owns the executable, the adjacent
`com.akubrowser.runtime.json` manifest, and
`..\runtime\current.json`. The Store extension cannot provide executable
paths, arguments, channels, or download URLs.

`current.json` selects only an installer-owned version and compatibility tuple.
The host derives these fixed paths:

- `runtime\versions\<version>\AkuSidecar.exe`
- `runtime\versions\<version>\config\sidecar.json`
- `%LOCALAPPDATA%\AkuBrowser\data\aku-browser.db`

The native host writes only framed protocol JSON to stdout. Structured
diagnostics are emitted as JSON Lines on stderr.

macOS production builds a universal `AkuBrowserRuntimeHost` containing x86_64
and arm64 slices. It resolves `AkuSidecar`, `current.json`, and product data
beneath `~/Library/Application Support/AkuBrowser`. Linux resolves data beneath
`${XDG_DATA_HOME:-~/.local/share}/AkuBrowser`, but its packaging remains
disabled until the 0.7.10 release gate.

Update URLs, artifact architecture, and runtime executable names come only from
the compiled platform profile. Current hosts prefer `AkuSidecarUpdate.json` on
Windows and `AkuSidecarUpdate-macos-universal.json` on macOS. The frozen
`AkuBrowserRuntimeUpdate*.json` names remain only as the exact v1 migration
fallback for deployed legacy hosts.

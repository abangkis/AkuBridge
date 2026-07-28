# AkuBrowser Runtime Host

This directory contains the Stage 3 Windows Native Messaging host. It is a
separate Go executable and is not part of the Chrome extension package.

The production build target is:

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

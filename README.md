# AkuBridge

AkuBridge is the read-only Chrome extension used by AkuBrowser to collect a bounded set of visible observations from X or LinkedIn.

## Development

```powershell
npm install
npm run check
```

Load this directory as an unpacked extension from `chrome://extensions` with Developer mode enabled.

AkuBridge does not like, reply, follow, message, or silently open a source tab during Gate 0. Catch Up requires an already-open canonical feed. Manual Live may use the active page for the selected source. Gate 0B.1 permits at most two native scrolls, captures at most three viewports, and restores the starting scroll position. Computer Use is not part of this native path.

Source adapters detect visible `New posts`/`Show posts` controls and report them as pending coverage. Gate 0B.1 does not activate those controls; reveal is a separate future read-only navigation action.

## Boundary

AkuBridge communicates only with AkuSidecar at `http://127.0.0.1:47821` through the versioned local bridge contract. It does not import AkuSidecar source code.

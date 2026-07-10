# AkuBridge

AkuBridge is the read-only Chrome extension used by AkuBrowser to collect one bounded, visible observation from X or LinkedIn.

## Development

```powershell
npm install
npm run check
```

Load this directory as an unpacked extension from `chrome://extensions` with Developer mode enabled.

AkuBridge does not like, reply, follow, message, or silently open a source tab during Gate 0. Catch Up requires an already-open canonical feed. Manual Live may use the active page for the selected source.

## Boundary

AkuBridge communicates only with AkuSidecar at `http://127.0.0.1:47821` through the versioned local bridge contract. It does not import AkuSidecar source code.

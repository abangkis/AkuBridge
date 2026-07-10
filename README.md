# AkuBridge

AkuBridge is the read-only Chrome extension used by AkuBrowser to collect a bounded set of visible observations from X or LinkedIn.

## Development

```powershell
npm install
npm run check
```

Load this directory as an unpacked extension from `chrome://extensions` with Developer mode enabled.

AkuBridge does not like, reply, follow, message, post, or silently open a source tab during Gate 0. Catch Up requires an already-open canonical feed. Manual Live may use the active page for the selected source. Gate 0B permits at most two native scrolls and three viewports. Computer Use is not part of this native path.

Gate 0B.2 may activate one allowlisted visible `New posts`/`Show posts` control in the same development source tab. The revealed latest feed becomes the new scroll-restoration baseline, and coverage records that the former feed view was changed.

## Boundary

AkuBridge communicates only with AkuSidecar at `http://127.0.0.1:47821` through the versioned local bridge contract. It does not import AkuSidecar source code.

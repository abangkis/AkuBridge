# AkuBridge

AkuBridge is the read-only Chrome extension used by AkuBrowser to collect a bounded set of visible observations from X or LinkedIn.

## Development

```powershell
npm install
npm run check
```

Load this directory as an unpacked extension from `chrome://extensions` with Developer mode enabled.

AkuBridge does not like, reply, follow, message, or post. For an initial capture, it follows the command's `openIfMissing` policy: the default AkuSidecar configuration may open one inactive canonical X or LinkedIn feed tab, while `fail_fast` requires an already-open eligible tab. Manual Live may use the active page for the selected source. A follow-up round never opens a replacement tab. Gate 0B permits at most two native scrolls and three viewports. Computer Use is not part of this native path.

Gate 0B.2 may activate one allowlisted visible `New posts`/`Show posts` control in the same development source tab. The revealed latest feed becomes the new scroll-restoration baseline, and coverage records that the former feed view was changed.

Gate 0B.3 may perform one additional one-scroll capture from a round-one frontier supplied by AkuSidecar. The first follow-up snapshot must match a prior permalink or normalized-text anchor; fresh-content activation is disabled and the pre-follow-up position is restored.

## Boundary

AkuBridge communicates only with AkuSidecar at `http://127.0.0.1:47821` through the versioned local bridge contract. It does not import AkuSidecar source code.

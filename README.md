# AkuBridge

AkuBridge is the read-only Chrome extension used by AkuBrowser to collect a bounded set of visible observations from X or LinkedIn.

## Development

```powershell
npm install
npm run check
```

Load this directory as an unpacked extension from `chrome://extensions` with Developer mode enabled.

AkuBridge does not like, reply, follow, message, or post. For an initial capture, it follows the command's `openIfMissing` policy: the default AkuSidecar configuration may open one inactive canonical X or LinkedIn feed tab, while `fail_fast` requires an already-open eligible tab. Manual Live may use the active page for the selected source. A follow-up round never opens a replacement tab. Gate 0B permits at most two native scrolls and three viewports. Computer Use is not part of this native path.

Each captured evidence block may include up to four rendered content images or video posters for Source layout. AkuBridge excludes small images and LinkedIn actor avatars, accepts only the allowlisted X/LinkedIn media CDNs, and never downloads or transforms media itself.

Gate 0B.2 may activate one allowlisted visible `New posts`/`Show posts` control in the same development source tab. The revealed latest feed becomes the new scroll-restoration baseline, and coverage records that the former feed view was changed.

Gate 0B.3 may perform one additional one-scroll capture from a round-one frontier supplied by AkuSidecar. The first follow-up snapshot must match a prior permalink or normalized-text anchor; fresh-content activation is disabled and the pre-follow-up position is restored.

LinkedIn capture uses a bounded feed-readiness probe because a completed page shell may still contain no rendered feed. A background tab that is not ready may be activated temporarily and the prior active tab is restored afterward. LinkedIn temporarily uses detect-only pending-content behavior for reliability; X retains its validated reveal path. Zero evidence permits one same-tab readiness retry and then fails as source readiness without invoking reasoning.

If Chrome invalidates a tab between discovery and initial capture, AkuBridge may discard that stale reference and perform exactly one fresh source-tab discovery. The normal `openIfMissing` policy still applies, and coverage records the recovery. Provider-directed follow-up never rebinds because its evidence frontier belongs to the original tab.

## Boundary

AkuBridge communicates only with AkuSidecar at `http://127.0.0.1:47821` through the versioned local bridge contract. It does not import AkuSidecar source code.

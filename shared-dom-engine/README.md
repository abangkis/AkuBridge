# SharedDOMEngine

SharedDOMEngine evaluates normalized DOM evidence using a caller-supplied
policy. Source adapters gather the evidence. Controllers own navigation,
sampling, visibility, recovery, and storage.

Run `npm test` and `npm run build` in this directory. The dependency-free build
writes `dist/core.mjs`, `dist/browser-runtime.js`, and `dist/artifact-manifest.json`.
The browser script exposes `globalThis.AkuSharedDOMEngine`. The manifest records
the contract version and SHA-256 of both artifacts from the same source.

```js
import { assessDOM, SCHEMA_VERSION } from './dist/core.mjs';

const result = assessDOM({
  schemaVersion: SCHEMA_VERSION,
  policy: {
    version: 'ledger-v1',
    layouts: ['ledger-card'],
    postMarkers: ['bound-entry'],
    requiredPrimaryFields: ['author'],
    modalities: [{ field: 'text', owner: 'primary' }],
  },
  current: {
    scope: 'capture-document-1', sampleSequence: 1,
    access: 'available', complete: true, settled: true,
    structure: {
      feedRoot: true, loading: false, empty: false,
      visibleStructuralCount: 1, offscreenStructuralCount: 0,
      markers: [{ name: 'bound-entry', count: 1 }],
    },
    candidates: [{
      ref: 'row-1', visible: true, layout: 'ledger-card',
      identityClaims: [{ key: 'entry:opaque-17', owner: 'primary', provenance: 'entry-binding' }],
      fields: [
        { name: 'author', owner: 'primary', availability: 'present' },
        { name: 'text', owner: 'primary', availability: 'present' },
      ],
    }],
  },
});
```

The caller can pass a `previous` sample and an `expectedPrimaryKey`. It must
change `scope` when the document, route, measurement context, policy, or
adapter changes. Use a monotonically increasing `sampleSequence` inside that
scope. A sample can mark `probeFailed` to report document-level failure. Use
the same flag on a candidate to reject only that candidate. Supply plain data
from trusted probes within the bounds enforced by the evaluator.

Identity claims can carry a canonical `locator`. Fields can carry an
`identityKey` to bind their evidence to a claim. A quote modality requires an
explicit binding to a quote claim. Candidate decisions contain identity keys
for the caller. Persist or transmit only `result.diagnostic` as engine
telemetry, since it contains closed codes and counts without raw identities.
Use `resolveDOMIdentity(claims)` for an identity decision when the caller
already owns content and visibility checks. It accepts the same bounded
claims and applies the same primary identity rules as `assessDOM`.

Windowed and Headless X load the generated `browser-runtime.js` from this
directory. Run `npm run build -- --stage-browser` after changing the core to
refresh that packaged artifact. The test suite verifies its SHA-256 against the
standalone build. The X evidence binding lives in `adapters/x-dom-shadow.js`
at the AkuBridge root. It gathers identity claims and emits the bounded
diagnostic for both controllers.

# Internal JavaScript diagnostics

These local modules align with AI4UDiagnostics and AkuSidecar's internal recorder
semantics. They are not an external JavaScript package or an addition to the Go
library. Capture, cancellation, deadlines and resource ownership remain with the
controllers.

- `recorder.js` contains generic operation/phase, explicit knownness, sequence,
  first observed failure, independent cleanup/delivery and completeness values.
  The caller supplies elapsed observations. Snapshots have independent nested
  values; the core reads no clock, DOM, storage or network.
- `bridge-contract.js` owns the Bridge stage/field vocabulary and privacy limits.
  Its projection retains the existing `runtimeRevision`, `adapterRuntimeRevision`,
  `stage`, allowed detail fields and `updatedAt` response. Unknown is not zero.
- `chrome-transport.js` owns best-effort sampling, bounded push delivery and a
  volatile receiver cache. It has no capture, retry, navigation or cleanup API.

The same classic-script files load in isolated content worlds and are imported
for their initialization by the MV3 worker. Source registration and dynamic
injection use one script list. No extra build generator or duplicate package is
required. `source-adapters-v130` is the coherent source candidate; runtime
activation and live qualification are separate.

## Attempt and document correlation

The worker generates a random attempt identifier for each content capture. A
read-only scripting result supplies the expected top-frame Chrome `documentId`.
Missing proof leaves diagnostics unavailable and does not stop capture. Pushed
messages must match the extension, attempt, tab, source, top frame and document.
Sequence numbers reject duplicate/older updates. Pull fallback also targets the
proved document and requires the same attempt. The legacy uncorrelated diagnostic
request remains available for compatible callers.

Each producer sends at most 64 messages, with one request in flight and at most
one coalesced pending update. Each content world retains at most eight active
correlated recorders. The worker retains at most 32 attempts for 120 seconds,
disposes them at controller settlement and loses the cache on worker replacement.
It never emits raw DOM, text, URLs, tokens or ownership capabilities. Correlation
identifiers remain private transport metadata, outside the legacy projection.

The receiver starts with unknown delivery completeness. Gaps cannot establish a
complete stream, even if a terminal stage arrives. A cached stage means **last
observed progress**, not a proven failure cause or successful capture. Producer
recording completeness and receiver delivery completeness are distinct.

The controller's timer rejects independently of silent diagnostics. Optional
sampling cannot extend that deadline. The reload activity guard continues to
track the underlying content promise after the controller stops waiting.

## Reload boundary

`reload-coordinator.js` provides one fence for direct and split reload. Source
dispatch, source/reader opening, underlying content work and managed ownership
operations enter before asynchronous work. A reload reserves the fence before
awaiting inventory and rejects active or unproved work. It never auto-closes a
surface. Journal inspection only retires records after successful absence proof;
live bindings, pending records and inventory failure reject reload.

The fence lasts through result acknowledgment and `runtime.reload()`. A known
pre-reload failure cancels only its matching preparation. Interrupted worker
operations/preparations remain uncertain in session storage and fail closed;
they are not silently considered settled. An extension lifecycle reset establishes
a new incarnation, and old surface ownership still requires reconciliation.
This increment does not recover an already mismatched surface or persist an old
generation as new authority.

Offline tests cover both reload callers, admission races, failed acknowledgment,
worker restart, unverified cleanup, missing diagnostics, correlation, bounds,
late progress and preservation of the capture response deadline. The Instagram
DOM fixture runner separately verifies real content entry points and sanitized
push progress without authenticated browsing or live capture.

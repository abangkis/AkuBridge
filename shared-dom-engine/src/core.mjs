const SCHEMA_VERSION = 1;
const limits = Object.freeze({ candidates: 64, claims: 8, fields: 32, markers: 32, count: 10_000 });
const accessStates = new Set(['available', 'unknown', 'wrong_route', 'login_required',
  'challenge_required', 'unavailable', 'navigation_failed']);
const owners = new Set(['primary', 'quote', 'other', 'unknown']);
const availability = new Set(['present', 'absent', 'unknown']);
const driftReasons = new Set(['unknown_layout', 'missing_identity', 'missing_required_field', 'missing_content']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isToken(value) {
  return typeof value === 'string' && /^[\w.-]{1,64}$/.test(value);
}

function isBoundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= limits.count;
}

function validList(value, max, valid) {
  if (!Array.isArray(value) || value.length > max) return false;
  for (const item of value) {
    if (!valid(item)) return false;
  }
  return true;
}

function validPolicy(policy) {
  return isRecord(policy) && isToken(policy.version) &&
    validList(policy.layouts, limits.markers, isToken) &&
    validList(policy.postMarkers, limits.markers, isToken) &&
    validList(policy.requiredPrimaryFields, limits.fields, isToken) &&
    validList(policy.modalities, limits.fields, item => isRecord(item) &&
      isToken(item.field) && ['primary', 'quote'].includes(item.owner)) && policy.modalities.length > 0;
}

function validClaim(claim) {
  return isRecord(claim) && isBoundedString(claim.key, 256) && owners.has(claim.owner) &&
    isToken(claim.provenance) && (claim.locator === undefined || isBoundedString(claim.locator, 2_048));
}

function validField(field) {
  return isRecord(field) && isToken(field.name) && owners.has(field.owner) &&
    availability.has(field.availability) &&
    (field.identityKey === undefined || isBoundedString(field.identityKey, 256));
}

function validCandidate(candidate) {
  return isRecord(candidate) && isBoundedString(candidate.ref, 128) &&
    typeof candidate.visible === 'boolean' && (candidate.layout === null || isToken(candidate.layout)) &&
    (candidate.probeFailed === undefined || typeof candidate.probeFailed === 'boolean') &&
    validList(candidate.identityClaims, limits.claims, validClaim) &&
    validList(candidate.fields, limits.fields, validField);
}

function validSample(sample) {
  if (!isRecord(sample) || !isBoundedString(sample.scope, 128) ||
      !Number.isSafeInteger(sample.sampleSequence) || sample.sampleSequence < 0 ||
      typeof sample.complete !== 'boolean' || typeof sample.settled !== 'boolean' ||
      !accessStates.has(sample.access) ||
      (sample.probeFailed !== undefined && typeof sample.probeFailed !== 'boolean')) return false;
  const structure = sample.structure;
  if (!isRecord(structure) || typeof structure.feedRoot !== 'boolean' ||
      typeof structure.loading !== 'boolean' || typeof structure.empty !== 'boolean' ||
      !isCount(structure.visibleStructuralCount) || !isCount(structure.offscreenStructuralCount) ||
      !validList(structure.markers, limits.markers, marker =>
        isRecord(marker) && isToken(marker.name) && isCount(marker.count)) ||
      !validList(sample.candidates, limits.candidates, validCandidate)) return false;
  const visible = sample.candidates.filter(candidate => candidate.visible).length;
  return visible <= structure.visibleStructuralCount &&
    sample.candidates.length - visible <= structure.offscreenStructuralCount &&
    new Set(sample.candidates.map(candidate => candidate.ref)).size === sample.candidates.length;
}

function resolvePrimary(claims, expectedKey) {
  const primary = claims.filter(claim => claim.owner === 'primary');
  if (!primary.length) return { reason: 'missing_identity' };
  const key = primary[0].key;
  const locators = new Set(primary.map(claim => claim.locator).filter(Boolean));
  if (primary.some(claim => claim.key !== key) || locators.size > 1) return { reason: 'identity_conflict' };
  if (expectedKey !== undefined && key !== expectedKey) return { reason: 'unexpected_identity' };
  return { key, locator: locators.values().next().value ?? null,
    provenance: [...new Set(primary.map(claim => claim.provenance))].sort() };
}

function evaluateCandidate(candidate, policy, expectedKey) {
  const { ref } = candidate;
  const reject = reason => ({ ref, decision: 'rejected', reason });
  if (candidate.probeFailed) return reject('candidate_probe_failed');
  if (!candidate.visible) return { ref, decision: 'offscreen' };
  const identity = resolvePrimary(candidate.identityClaims, expectedKey);
  if (identity.reason) return reject(identity.reason);
  const quotes = new Set(candidate.identityClaims.filter(claim => claim.owner === 'quote').map(claim => claim.key));
  const present = candidate.fields.filter(field => field.availability === 'present');
  if (quotes.has(identity.key) || present.some(field => field.owner === 'primary' &&
      field.identityKey !== undefined && field.identityKey !== identity.key) ||
      present.some(field => field.owner === 'quote' && field.identityKey !== undefined &&
      !quotes.has(field.identityKey))) return reject('ownership_conflict');
  if (!policy.layouts.includes(candidate.layout)) return reject('unknown_layout');
  const primaryFields = new Set(present.filter(field => field.owner === 'primary').map(field => field.name));
  if (policy.requiredPrimaryFields.some(field => !primaryFields.has(field))) return reject('missing_required_field');
  const hasContent = policy.modalities.some(({ field, owner }) => owner === 'primary' ? primaryFields.has(field) :
    present.some(item => item.name === field && item.owner === 'quote' && quotes.has(item.identityKey)));
  if (!hasContent) return reject('missing_content');
  return { ref, decision: 'accepted', identity, quoteKeys: [...quotes].sort() };
}

function evaluateCandidates(sample, policy, expectedKey) {
  return sample.candidates.map(candidate => evaluateCandidate(candidate, policy, expectedKey));
}

function summarize(sample, decisions) {
  const counts = { candidates: sample?.candidates.length ?? 0, visibleStructural: sample?.structure.visibleStructuralCount ?? 0,
    accepted: 0, rejected: 0, offscreen: 0 };
  const rejections = {};
  for (const decision of decisions) {
    counts[decision.decision] += 1;
    if (decision.reason) rejections[decision.reason] = (rejections[decision.reason] ?? 0) + 1;
  }
  return { counts, rejections };
}

function layoutState(sample, policy) {
  const layouts = new Set(sample.candidates.filter(candidate => candidate.visible).map(candidate => candidate.layout));
  const known = [...layouts].filter(layout => policy.layouts.includes(layout)).length;
  if (!known) return layouts.size ? 'unrecognized' : 'unobserved';
  return layouts.size > 1 ? 'mixed' : 'known';
}

function driftEvidence(sample, policy, decisions) {
  if (!sample.complete || !sample.settled || !sample.structure.feedRoot ||
      sample.structure.loading || sample.structure.empty) return null;
  const markers = sample.structure.markers.filter(marker => marker.count > 0 && policy.postMarkers.includes(marker.name));
  const visible = sample.candidates.filter(candidate => candidate.visible);
  // A partial or contradictory rejection set cannot characterize the entire visible sample.
  if (!markers.length || !visible.length || visible.length !== sample.structure.visibleStructuralCount) return null;
  const reasons = decisions.filter(decision => decision.decision !== 'offscreen').map(decision => decision.reason);
  if (!reasons.every(reason => driftReasons.has(reason))) return null;
  return { markers: new Set(markers.map(marker => marker.name)), reasons: new Set(reasons) };
}

function hasProgress(previous, current, policy, expectedKey) {
  const relevant = new Set([...policy.requiredPrimaryFields,
    ...policy.modalities.filter(item => item.owner === 'primary').map(item => item.field)]);
  const present = (candidate, key) => new Set(candidate.fields.filter(field =>
    field.availability === 'present' && field.owner === 'primary' && relevant.has(field.name) &&
    (field.identityKey === undefined || field.identityKey === key)).map(field => field.name));
  const before = new Map();
  for (const candidate of previous.candidates) {
    if (!candidate.visible || candidate.probeFailed || !policy.layouts.includes(candidate.layout)) continue;
    const key = resolvePrimary(candidate.identityClaims, expectedKey).key;
    if (!key) continue;
    const fields = before.get(key) ?? new Set();
    for (const field of present(candidate, key)) fields.add(field);
    before.set(key, fields);
  }
  return current.candidates.some(candidate => {
    if (!candidate.visible || candidate.probeFailed || !policy.layouts.includes(candidate.layout)) return false;
    const key = resolvePrimary(candidate.identityClaims, expectedKey).key;
    const earlier = before.get(key);
    return earlier && [...present(candidate, key)].some(field => !earlier.has(field));
  });
}

function renderingState(current, previous, policy, expectedKey, decisions, counts) {
  if (counts.accepted > 0) return 'ready';
  if (current.structure.loading || (previous && hasProgress(previous, current, policy, expectedKey))) return 'hydrating';
  if (current.complete && current.structure.empty && current.structure.visibleStructuralCount === 0 &&
      current.structure.offscreenStructuralCount === 0) return 'empty_observed';
  const possibleDrift = driftEvidence(current, policy, decisions);
  if (previous && possibleDrift) {
    const earlier = driftEvidence(previous, policy, evaluateCandidates(previous, policy, expectedKey));
    if (earlier && [...possibleDrift.markers].some(marker => earlier.markers.has(marker)) &&
        [...possibleDrift.reasons].some(reason => earlier.reasons.has(reason))) return 'dom_contract_suspected';
  }
  if (possibleDrift) return 'inconclusive';
  if (!current.complete) return 'incomplete_sample';
  if (current.structure.visibleStructuralCount === 0 && current.structure.offscreenStructuralCount > 0) return 'offscreen';
  return current.structure.visibleStructuralCount > 0 ? 'no_valid_candidates' : 'empty_unverified';
}

function unavailable(reason, access = 'unknown', sample) {
  return { access, rendering: 'unavailable', layout: 'unobserved', integrity: 'unassessed', candidates: [],
    diagnostic: { code: reason, ...summarize(sample, []) } };
}

function assessDOM(input) {
  if (!isRecord(input)) return unavailable('invalid_evidence');
  if (input.schemaVersion !== SCHEMA_VERSION) return unavailable('unsupported_schema');
  const { current, previous, policy, expectedPrimaryKey } = input;
  if (!validPolicy(policy) || !validSample(current) ||
      (expectedPrimaryKey !== undefined && !isBoundedString(expectedPrimaryKey, 256)) ||
      (previous !== undefined && !validSample(previous))) return unavailable('invalid_evidence');
  if (current.probeFailed) return unavailable('probe_failed', current.access, current);
  if (current.access !== 'available') return unavailable(current.access, current.access, current);
  const prior = previous?.scope === current.scope && previous.sampleSequence < current.sampleSequence
    ? previous : undefined;
  const decisions = evaluateCandidates(current, policy, expectedPrimaryKey);
  const { counts, rejections } = summarize(current, decisions);
  const comparable = prior?.access === 'available' && !prior.probeFailed ? prior : undefined;
  const rendering = renderingState(current, comparable, policy, expectedPrimaryKey, decisions, counts);
  const integrity = rejections.identity_conflict || rejections.ownership_conflict || rejections.unexpected_identity
    ? 'conflict' : counts.rejected ? 'rejections_observed' : counts.accepted ? 'validated' : 'unassessed';
  return { access: current.access, rendering, layout: layoutState(current, policy), integrity, candidates: decisions,
    diagnostic: { code: rendering, counts, rejections } };
}

export { assessDOM, SCHEMA_VERSION };

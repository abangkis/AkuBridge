(() => {
  const runtimeRevision = "capture-quality-v3";
  if (globalThis.AkuCaptureQualityPolicy?.runtimeRevision === runtimeRevision) return;

  const profiles = Object.freeze({
    "social-post-v2": Object.freeze({
      requiredFields: Object.freeze(["author"]),
      identityFields: Object.freeze(["platformId", "permalink", "stableTextIdentity"]),
      conditionalFields: Object.freeze([
        Object.freeze({
          field: "avatarUrl",
          fact: "primaryAvatarRootDetected",
          severity: "low",
          recoverable: false,
          impact: "presentation",
        }),
        Object.freeze({
          field: "media",
          fact: "mediaRootDetected",
          severity: "high",
          recoverable: true,
          impact: "evidence",
        }),
      ]),
      optionalDetectedFields: Object.freeze([
        Object.freeze({ field: "publishedAt", fact: "timestampSignalDetected" }),
      ]),
    }),
  });

  function evaluateCandidate({
    candidate,
    facts = {},
    profileId,
    evidenceProfile,
    candidateKey = null,
    attempt = 0,
    retriesRemaining = 0,
  }) {
    const profile = profiles[profileId];
    if (!profile) throw new Error(`Unknown capture quality profile: ${profileId}.`);
    if (!evidenceProfile?.contentFamily || !Array.isArray(evidenceProfile.modalities)) {
      throw new Error(`Capture quality profile ${profileId} requires adapter evidence semantics.`);
    }
    const issues = [];
    const evidenceModalities = detectEvidenceModalities(candidate)
      .filter((modality) => evidenceProfile.modalities.includes(modality));

    if (evidenceModalities.length === 0) {
      const detected = facts.contentRootDetected === true || facts.mediaRootDetected === true;
      issues.push(issue({
        field: "evidence",
        code: detected ? "detected_empty" : "required_evidence_missing",
        observedState: detected ? "detected_empty" : "missing",
        severity: "critical",
        recoverable: detected,
        impact: "evidence",
        attempt,
      }));
    }

    for (const field of profile.requiredFields) {
      if (hasValue(candidate?.[field])) continue;
      const detected = field === "text"
        ? facts.contentRootDetected === true
        : field === "author"
          ? facts.authorRootDetected === true
          : false;
      issues.push(issue({
        field,
        code: detected ? "detected_empty" : "required_missing",
        observedState: detected ? "detected_empty" : "missing",
        severity: "critical",
        recoverable: detected,
        impact: "identity",
        attempt,
      }));
    }

    const identityPresent = profile.identityFields.some((field) => (
      field === "stableTextIdentity"
        ? facts.stableTextIdentity === true
        : hasValue(candidate?.[field])
    ));
    if (!identityPresent) {
      issues.push(issue({
        field: "identity",
        code: "required_identity_missing",
        observedState: "missing",
        severity: "critical",
        recoverable: false,
        impact: "identity",
        attempt,
      }));
    }

    for (const expectation of profile.conditionalFields) {
      if (facts[expectation.fact] !== true || hasValue(candidate?.[expectation.field])) continue;
      issues.push(issue({
        field: expectation.field,
        code: "pending_hydration",
        observedState: "pending_hydration",
        severity: expectation.severity ?? "high",
        recoverable: expectation.recoverable !== false,
        impact: expectation.impact ?? "evidence",
        attempt,
      }));
    }

    for (const expectation of profile.optionalDetectedFields) {
      if (
        facts[expectation.fact] !== true ||
        facts[`${expectation.field}NotExposed`] === true ||
        hasValue(candidate?.[expectation.field])
      ) continue;
      issues.push(issue({
        field: expectation.field,
        code: "detected_empty",
        observedState: "detected_empty",
        severity: "low",
        recoverable: false,
        impact: "evidence",
        attempt,
      }));
    }

    const decisionIssues = issues.filter((entry) => entry.impact !== "presentation");
    const critical = decisionIssues.some((entry) => entry.severity === "critical");
    const recoverable = decisionIssues.some((entry) => entry.recoverable);
    const verdict = critical
      ? recoverable && retriesRemaining > 0 ? "retryable" : "invalid"
      : recoverable && retriesRemaining > 0
        ? "retryable"
        : decisionIssues.length > 0
          ? "usable_degraded"
          : "complete";
    return Object.freeze({
      profile: profileId,
      contentFamily: evidenceProfile.contentFamily,
      evidenceModalities: Object.freeze(evidenceModalities),
      identitySource: identitySource(candidate, facts),
      candidateKey: normalizeCandidateKey(candidateKey),
      verdict,
      score: qualityScore(issues),
      attempt,
      issues: Object.freeze(issues),
    });
  }

  function detectEvidenceModalities(candidate) {
    const result = [];
    if (hasValue(candidate?.text)) result.push("text");
    const media = Array.isArray(candidate?.media) ? candidate.media : [];
    if (media.some((entry) => entry?.kind === "image")) result.push("image");
    if (media.some((entry) => entry?.kind === "video")) result.push("video");
    if (hasValue(candidate?.attachments)) result.push("attachment");
    const quoted = candidate?.quotedPost;
    if (quoted && typeof quoted === "object" && (
      hasValue(quoted.text) || hasValue(quoted.media) || hasValue(quoted.links)
    )) result.push("quoted_post");
    return result;
  }

  function identitySource(candidate, facts) {
    if (hasValue(candidate?.platformId)) return "platform_id";
    if (hasValue(candidate?.permalink)) return "permalink";
    if (facts.stableTextIdentity === true) return "stable_text";
    return "missing";
  }

  function summarize(reports, { retryBudget = 0 } = {}) {
    const normalized = Array.isArray(reports) ? reports.filter(Boolean) : [];
    const verdictCounts = Object.fromEntries(
      ["complete", "usable_degraded", "retryable", "invalid"].map((verdict) => [
        verdict,
        normalized.filter((report) => report.verdict === verdict).length,
      ]),
    );
    const issueCounts = {};
    for (const report of normalized) {
      for (const entry of report.issues ?? []) {
        const key = `${entry.field}:${entry.code}`;
        issueCounts[key] = (issueCounts[key] ?? 0) + 1;
      }
    }
    const retryAttempts = normalized.reduce(
      (sum, report) => sum + Math.max(0, Number(report.attempt) || 0),
      0,
    );
    const verdict = verdictCounts.invalid > 0
      ? "invalid"
      : verdictCounts.retryable > 0
        ? "retryable"
        : verdictCounts.usable_degraded > 0
          ? "usable_degraded"
          : "complete";
    return Object.freeze({
      profile: normalized[0]?.profile ?? "unknown",
      verdict,
      candidateReportCount: normalized.length,
      verdictCounts: Object.freeze(verdictCounts),
      issueCounts: Object.freeze(issueCounts),
      retryBudget,
      retryAttempts,
    });
  }

  function hasValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim().length > 0;
    return value !== null && value !== undefined;
  }

  function issue(value) {
    return Object.freeze(value);
  }

  function normalizeCandidateKey(value) {
    return typeof value === "string" && value.trim()
      ? value.trim().slice(0, 500)
      : null;
  }

  function qualityScore(issues) {
    const penalty = issues.reduce((sum, entry) => sum + (
      entry.impact === "presentation"
        ? 0.01
        : entry.severity === "critical" ? 0.5 : entry.severity === "high" ? 0.2 : 0.05
    ), 0);
    return Math.max(0, Math.round((1 - penalty) * 100) / 100);
  }

  globalThis.AkuCaptureQualityPolicy = Object.freeze({
    runtimeRevision,
    profiles,
    evaluateCandidate,
    summarize,
  });
})();

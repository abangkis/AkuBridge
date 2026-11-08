(() => {
  const expansionContexts = new WeakMap();

  // Shared classification only: readiness is never account or admission proof.
  // Callers retain their own visibility measurements and adapter assessment.
  function sourceReadinessState({ availability, loginRequired = false,
    visibleCandidateCount = 0, visibleStructuralCandidateCount = 0,
    loading = false, documentReady = false, candidateCount = 0,
    structuralCandidateCount = 0, feedRootPresent = false } = {}) {
    return availability?.state ?? (loginRequired ? "login_required"
      : visibleCandidateCount > 0 ? "feed_ready"
      : visibleStructuralCandidateCount > 0 ? "feed_empty"
      : loading || !documentReady ? "loading"
      : candidateCount > 0 || structuralCandidateCount > 0 ? "feed_not_visible"
      : feedRootPresent ? "selector_mismatch" : "page_shell");
  }

  function structuredText(value) {
    if (typeof value === "string") return normalizeStructuredWhitespace(value);
    if (!value || typeof value !== "object") return "";
    if (!value.childNodes || value.childNodes.length === 0) {
      return normalizeStructuredWhitespace(value.innerText || value.textContent || "");
    }
    return normalizeStructuredWhitespace(readStructuredNode(value));
  }

  function readStructuredNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "img") return node.getAttribute?.("alt") || "";
    if (tag === "br") return "\n";
    const body = [...(node.childNodes || [])].map(readStructuredNode).join("");
    return ["div", "p", "li", "section", "article"].includes(tag) ? `${body}\n` : body;
  }

  function normalizeStructuredWhitespace(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t\f\v\u00a0 ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const X_ACCESS_CHALLENGE_MESSAGES = Object.freeze({
    cloudflare: "Cloudflare is asking for human verification in the source browser. Complete the check there, then start capture again.",
    x_human_verification: "X is asking for access verification in the source browser. Complete the check there, then start capture again.",
  });
  const X_CLOUDFLARE_CHALLENGE_SELECTORS = Object.freeze([
    "#challenge-running",
    "#challenge-stage",
    "#challenge-form",
    ".cf-browser-verification",
    "[data-cf-challenge]",
    'iframe[src*="challenges.cloudflare.com"]',
  ]);
  const X_PLATFORM_CHALLENGE_SELECTORS = Object.freeze([
    'iframe[src*="captcha"]',
    'iframe[src*="arkoselabs"]',
  ]);
  const X_POST_TEXT_SELECTORS = Object.freeze([
    'article[data-testid="tweet"]',
    '[data-testid="tweetText"]',
    '[data-testid="quoteTweet"]',
  ]);

  function detectXAccessChallenge(document = globalThis.document, location = globalThis.location) {
    if (String(location?.hostname ?? "").toLowerCase() !== "x.com" || !document?.body) return null;
    if (X_CLOUDFLARE_CHALLENGE_SELECTORS.some((selector) => {
      try { return Boolean(document.querySelector?.(selector)); } catch { return false; }
    })) return xAccessChallenge("cloudflare");
    if (X_PLATFORM_CHALLENGE_SELECTORS.some((selector) => {
      try { return Boolean(document.querySelector?.(selector)); } catch { return false; }
    })) return xAccessChallenge("x_human_verification");

    const pageText = pageTextOutsideXPosts(document.body).replace(/[‘’]/g, "'").toLowerCase();
    if (pageText.includes("performing security verification") && pageText.includes("verify you are human")) {
      return xAccessChallenge("cloudflare");
    }
    if (pageText.includes("let's confirm you are a human") &&
        pageText.includes("open the x app on your phone to continue")) {
      return xAccessChallenge("x_human_verification");
    }
    return null;
  }

  function xAccessChallenge(category) {
    return Object.freeze({
      code: "challenge_required",
      category,
      message: X_ACCESS_CHALLENGE_MESSAGES[category],
    });
  }

  function pageTextOutsideXPosts(root) {
    const text = [];
    let length = 0;
    const maxCharacters = 96_000;
    const visit = (node) => {
      if (!node || length >= maxCharacters) return;
      if (node.nodeType === 3) {
        const value = String(node.nodeValue ?? "");
        if (length + value.length > maxCharacters) {
          text.push(value.slice(0, maxCharacters - length));
          length = maxCharacters;
        } else {
          text.push(value);
          length += value.length;
        }
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      if (node.nodeType === 1) {
        const tag = String(node.tagName ?? "").toLowerCase();
        if (["script", "style", "noscript", "template"].includes(tag) || node.hidden === true ||
            String(node.getAttribute?.("aria-hidden") ?? "").toLowerCase() === "true") return;
        try {
          if (X_POST_TEXT_SELECTORS.some((selector) => node.matches?.(selector))) return;
        } catch { /* A nonstandard DOM fixture may not support every selector. */ }
      }
      for (const child of Array.from(node.childNodes ?? [])) visit(child);
    };
    visit(root);
    return text.join(" ");
  }

  function canonicalizeXPermalink(value) {
    try {
      const raw = String(value ?? "");
      const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
      if (!authority || authority.toLowerCase() !== "x.com") return null;
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.hostname !== "x.com" ||
          url.username || url.password || url.port) return null;
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/.*)?$/);
      if (!match) return null;
      return `https://x.com/${match[1]}/status/${match[2]}`;
    } catch {
      return null;
    }
  }

  function mergeXReplyDirectContext(post, incomingRelations) {
    const incoming = (Array.isArray(incomingRelations) ? incomingRelations : [])
      .filter(relation => relation?.kind === 'replies_to');
    if (!incoming.length || post?.presentation?.directContextStatus === 'ambiguous') return post;
    const ownerId = xReplyOwnerId(post);
    if (!ownerId) return post;
    const directContext = Array.isArray(post.directContext) ? post.directContext : [];
    const existing = directContext.filter(relation => relation?.kind === 'replies_to');
    const retained = directContext.filter(relation => relation?.kind !== 'replies_to');
    if (incoming.length !== 1) {
      const validIncomingIds = incoming.map(relation => exactReplyIdentity(relation, ownerId)).filter(Boolean);
      const existingId = existing.length === 1 ? exactReplyIdentity(existing[0], ownerId) : null;
      const hasMalformed = validIncomingIds.length < incoming.length;
      if (existingId && (!validIncomingIds.length
          || (hasMalformed && validIncomingIds.length === 1 && validIncomingIds[0] === existingId))) return post;
      return markReplyContextAmbiguous(post, retained);
    }
    const incomingId = exactReplyIdentity(incoming[0], ownerId);
    if (!incomingId) {
      const existingId = existing.length === 1 ? exactReplyIdentity(existing[0], ownerId) : null;
      return existingId ? post : markReplyContextAmbiguous(post, retained);
    }
    if (conflictingReplyParentPermalink(post, incomingId)) return markReplyContextAmbiguous(post, retained);
    if (existing.length > 1) return markReplyContextAmbiguous(post, retained);
    if (existing.length === 1) {
      const existingId = exactReplyIdentity(existing[0], ownerId);
      if (existingId === incomingId) return withResolvedReplySemantics(post, incoming[0]);
      if (!existingId && isUnresolvedDomReply(existing[0])) {
        const relation = {...incoming[0],
          ...(typeof existing[0].observedText === 'string' && existing[0].observedText.length <= 500
            ? {observedText: existing[0].observedText} : {}),
        };
        return withResolvedReplySemantics({...post, directContext: [...retained, relation]}, relation);
      }
      if (existingId) return markReplyContextAmbiguous(post, retained);
      return withResolvedReplySemantics({...post, directContext: [...retained, incoming[0]]}, incoming[0]);
    }
    if (directContext.length >= 8) return post;
    return withResolvedReplySemantics({...post, directContext: [...directContext, incoming[0]]}, incoming[0]);
  }

  function markXReplyContextAmbiguous(post) {
    const directContext = Array.isArray(post?.directContext) ? post.directContext : [];
    return markReplyContextAmbiguous(post, directContext.filter(relation => relation?.kind !== 'replies_to'));
  }

  function mergeXResponseReply(post, replyToId) {
    const ownerId = xReplyOwnerId(post);
    if (!ownerId || typeof replyToId !== 'string' || !/^\d{5,30}$/.test(replyToId) || replyToId === ownerId) return post;
    const relation = {kind: 'replies_to', provenance: 'observed_response', capturedAt: new Date().toISOString(),
      target: {kind: 'post', id: replyToId, permalink: 'https://x.com/i/status/' + replyToId,
        text: '', author: '', availability: 'reference_only'}};
    return mergeXReplyDirectContext(post, [relation]);
  }

  function markReplyContextAmbiguous(post, retained) {
    const clearReplyParent = post?.relationshipType === 'reply' && !isQuotePost(post);
    return {...post, directContext: retained,
      presentation: {...(post.presentation && typeof post.presentation === 'object' ? post.presentation : {}),
        directContextStatus: 'ambiguous'},
      ...(clearReplyParent ? {parentPermalink: ''} : {})};
  }

  function withResolvedReplySemantics(post, relation) {
    if (isQuotePost(post) || (post.relationshipType === 'reply' && post.parentPermalink === relation.target.permalink)) return post;
    return {...post, relationshipType: 'reply', parentPermalink: relation.target.permalink};
  }

  function isQuotePost(post) {
    return post?.relationshipType === 'quote' || post?.quotedPostObserved === true
      || Boolean(post?.quotedPost) || (Array.isArray(post?.directContext)
        && post.directContext.some(relation => relation?.kind === 'quotes'));
  }

  function xReplyPermalinkId(value) {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const canonical = canonicalizeXPermalink(value.trim());
    return canonical?.match(/\/status\/(\d{5,30})$/)?.[1] ?? null;
  }

  function xReplyOwnerId(post) {
    const nativeId = post?.platformId ?? post?.id;
    if (typeof nativeId !== 'string') return null;
    const id = /^(?:x:status:)?(\d{5,30})$/.exec(nativeId)?.[1];
    if (!id || id !== xReplyPermalinkId(post.permalink)) return null;
    const primary = post.presentation?.primaryIdentity;
    if (primary && (primary.status !== 'identified' || xReplyPermalinkId(primary.permalink) !== id)) return null;
    if (post.platformId != null && post.id != null && post.id !== id && post.id !== 'x:status:' + id) return null;
    return id;
  }

  // Duplicate owners within a viewport are ambiguous. A later viewport may
  // independently contain the same post, so each snapshot has its own index.
  function xReplySnapshotOwners(posts) {
    const indices = new Map();
    for (const [index, post] of posts.entries()) {
      const id = xReplyOwnerId(post);
      if (id) indices.set(id, indices.has(id) ? null : index);
    }
    for (const [id, index] of indices) if (index === null) indices.delete(id);
    return indices;
  }

  function conflictingReplyParentPermalink(post, replyToId) {
    if (post?.relationshipType !== 'reply' || !post.parentPermalink) return false;
    return xReplyPermalinkId(post.parentPermalink) !== replyToId;
  }

  function exactReplyIdentity(relation, ownerId) {
    if (!relation || relation.kind !== 'replies_to'
        || !['observed_dom', 'observed_response'].includes(relation.provenance)
        || !isCanonicalCaptureTime(relation.capturedAt)) return null;
    const target = relation.target;
    if (!target || target.kind !== 'post' || typeof target.id !== 'string'
        || !/^\d{5,30}$/.test(target.id) || target.id === ownerId
        || typeof target.permalink !== 'string') return null;
    const permalinkId = xReplyPermalinkId(target.permalink);
    if (!permalinkId || permalinkId !== target.id) return null;
    if (!['captured', 'reference_only'].includes(target.availability)
        || typeof target.text !== 'string' || target.text.length > 4000
        || typeof target.author !== 'string' || target.author.length > 300) return null;
    const hasMedia = target.hasMedia === true;
    if (target.availability === 'reference_only' && (target.text || hasMedia)) return null;
    // The adapter can know the exact reply edge from a response while getting the
    // bounded parent body from the one matching DOM article. Response-created
    // relations themselves stay reference-only with an empty body.
    if (target.availability === 'captured' && (!target.text && !hasMedia)) return null;
    if (typeof relation.observedText === 'string' && relation.observedText.length > 500) return null;
    return target.id;
  }

  function isUnresolvedDomReply(relation) {
    const target = relation?.target;
    return relation?.kind === 'replies_to' && relation.provenance === 'observed_dom'
      && isCanonicalCaptureTime(relation.capturedAt) && target?.kind === 'post'
      && target.id === '' && target.permalink === '' && target.availability === 'reference_only'
      && typeof target.text === 'string' && !target.text && typeof target.author === 'string' && !target.author
      && (!relation.observedText || typeof relation.observedText === 'string' && relation.observedText.length <= 500);
  }

  function isCanonicalCaptureTime(value) {
    if (typeof value !== 'string') return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function expansionLabel(value, direction) {
    const text = String(value ?? "")
      .replace(/^(?:(?:…|\.{3})\s*)+/, "")
      .replace(/[\t\f\v\u00a0 ]+/g, " ")
      .trim()
      .toLowerCase();
    const choices = direction === "less"
      ? ["less", "show less", "see less"]
      : direction === "more"
        ? ["more", "show more", "see more"]
        : [];
    return choices.includes(text);
  }

  async function expandContent({
    container,
    adapter,
    readText = structuredText,
    route = defaultRoute,
    canExpand = () => true,
    deadlineAt = Infinity,
    wait = defaultWait,
  } = {}) {
    const policy = adapter?.contentExpansion;
    if (!policy || !container) return { state: "not_applicable", expanded: false, button: null, contentRoot: null, before: "" };
    const getContainer = () => adapter.resolveContainer?.(container) ?? container;
    const startRoute = readRoute(route);
    const attempts = clampInteger(policy.attempts, 10, 0, 50);
    const intervalMs = clampInteger(policy.intervalMs, 40, 0, 1_000);
    const state = (name, details = {}) => ({
      state: name,
      expanded: false,
      button: details.button ?? null,
      contentRoot: details.contentRoot ?? null,
      before: details.before ?? "",
      capturedRoute: startRoute,
    });
    if (routeChanged(route, startRoute)) return state("route_changed");
    if (Date.now() >= deadlineAt) return state("deadline_expired");

    const initialContainer = getContainer();
    const initialRoot = findContentRoot(initialContainer, adapter);
    const before = readText(initialRoot) || "";
    let button = findExpansionButton(initialContainer, adapter, "more");
    if (!button) return state("no_collapse_observed", { contentRoot: initialRoot, before });
    if (!canExpandSafely(canExpand, button, { container: initialContainer, contentRoot: initialRoot, route: startRoute })) {
      return state("not_allowed", { button, contentRoot: initialRoot, before });
    }

    try {
      button.click();
    } catch {
      return state("expand_failed", { button, contentRoot: initialRoot, before });
    }

    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      if (routeChanged(route, startRoute)) return state("route_changed", { button, contentRoot: findContentRoot(getContainer(), adapter), before });
      if (Date.now() >= deadlineAt) return state("deadline_expired", { button, contentRoot: findContentRoot(getContainer(), adapter), before });
      const currentContainer = getContainer();
      const contentRoot = findContentRoot(currentContainer, adapter);
      const currentText = readText(contentRoot) || "";
      button = findExpansionButton(currentContainer, adapter, "less")
        ?? findExpansionButton(currentContainer, adapter, "more")
        ?? button;
      if (!canExpandSafely(canExpand, button, { container: currentContainer, contentRoot, route: startRoute })) {
        return state("not_allowed", { button, contentRoot, before });
      }
      if (codePointLength(currentText) > codePointLength(before) ||
          policy.restorable === true && findExpansionButton(currentContainer, adapter, "less")) {
        const expansion = {
          state: policy.restorable === true ? "expanded" : "expanded_no_restore_control",
          expanded: true,
          button: policy.restorable === true ? findExpansionButton(currentContainer, adapter, "less") : null,
          contentRoot,
          before,
          capturedRoute: startRoute,
        };
        expansionContexts.set(expansion, { container, adapter, readText, route, wait, intervalMs, attempts });
        return expansion;
      }
      if (attempt === attempts) break;
      await waitWithinDeadline(wait, intervalMs, deadlineAt);
    }
    return state("expand_failed", { button, contentRoot: findContentRoot(getContainer(), adapter), before });
  }

  async function restoreContent(expansion, {
    route = null,
    wait = null,
    deadlineAt = Infinity,
  } = {}) {
    const context = expansionContexts.get(expansion);
    if (!expansion?.expanded) return expansion?.state ?? "not_applicable";
    const selectedRoute = route ?? context?.route ?? defaultRoute;
    const selectedWait = wait ?? context?.wait ?? defaultWait;
    if (routeChanged(selectedRoute, expansion.capturedRoute)) {
      expansion.state = "expanded_route_changed";
      return expansion.state;
    }
    const adapter = context?.adapter;
    const policy = adapter?.contentExpansion;
    if (!context || policy?.restorable !== true) {
      expansion.state = "expanded_no_restore_control";
      return expansion.state;
    }
    const intervalMs = context.intervalMs ?? clampInteger(policy.intervalMs, 40, 0, 1_000);
    const attempts = Math.min(20, context.attempts ?? 8);
    const getContainer = () => adapter.resolveContainer?.(context.container) ?? context.container;
    if (Date.now() >= deadlineAt) {
      expansion.state = "expanded_restore_failed";
      return expansion.state;
    }
    let container = getContainer();
    let contentRoot = findContentRoot(container, adapter);
    let button = findExpansionButton(container, adapter, "less");
    if (!button) {
      expansion.state = "expanded_no_restore_control";
      expansion.contentRoot = contentRoot;
      expansion.button = null;
      return expansion.state;
    }
    try {
      button.click();
    } catch {
      expansion.state = "expanded_restore_failed";
      return expansion.state;
    }
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      if (routeChanged(selectedRoute, expansion.capturedRoute)) {
        expansion.state = "expanded_route_changed";
        return expansion.state;
      }
      container = getContainer();
      contentRoot = findContentRoot(container, adapter);
      const currentText = context.readText(contentRoot) || "";
      button = findExpansionButton(container, adapter, "more") ?? findExpansionButton(container, adapter, "less");
      if (codePointLength(currentText) <= codePointLength(expansion.before) ||
          button && expansionLabel(button.innerText || button.textContent, "more")) {
        expansion.state = "expanded_restored";
        expansion.contentRoot = contentRoot;
        expansion.button = button;
        return expansion.state;
      }
      if (attempt === attempts || Date.now() >= deadlineAt) break;
      await waitWithinDeadline(selectedWait, intervalMs, deadlineAt);
    }
    expansion.state = "expanded_restore_failed";
    expansion.contentRoot = findContentRoot(getContainer(), adapter);
    expansion.button = findExpansionButton(getContainer(), adapter, "less");
    return expansion.state;
  }

  function textCompleteness({
    textStatus = "unknown",
    expansionState = "unknown",
    collapsed = false,
    truncated = false,
    recoveryVerified = false,
  } = {}) {
    if (truncated === true || textStatus === "truncated") return "truncated";
    if (recoveryVerified === true || textStatus === "recovery_verified" || textStatus === "permalink_text_verified") {
      return "recovery_verified";
    }
    if (collapsed === true || [
      "partial",
      "requires_permalink_capture",
      "visible_text_may_be_collapsed",
      "expand_failed",
      "route_changed",
      "not_allowed",
      "deadline_expired",
      "navigation_changed",
    ].includes(textStatus) || ["expand_failed", "route_changed", "not_allowed", "deadline_expired"].includes(expansionState)) {
      return "partial";
    }
    if (expansionState === "expanded" || textStatus === "expanded" ||
        typeof expansionState === "string" && expansionState.startsWith("expanded")) return "expanded";
    if (expansionState === "no_collapse_observed" || textStatus === "visible_text_no_collapse_control") {
      return "no_collapse_observed";
    }
    return "unknown";
  }

  function evaluateTextReplacement({ originalText = "", recoveredText = "", identityMatches = false, resolved = false } = {}) {
    return identityMatches === true && resolved === true &&
      codePointLength(recoveredText) > codePointLength(originalText);
  }

  function resolvePrimaryIdentity({ permalinks = [], expectedPermalink = null } = {}) {
    const observed = [...new Set((Array.isArray(permalinks) ? permalinks : [])
      .map(canonicalizeXPermalink).filter(Boolean))];
    const expectedProvided = expectedPermalink !== null && expectedPermalink !== undefined && expectedPermalink !== "";
    const expected = expectedProvided ? canonicalizeXPermalink(expectedPermalink) : null;
    let status;
    let permalink = null;
    if (expectedProvided && !expected) status = "conflicting";
    else if (observed.length === 0) status = "missing";
    else if (observed.length > 1) status = expectedProvided ? "conflicting" : "ambiguous";
    else if (expectedProvided && observed[0] !== expected) status = "conflicting";
    else {
      status = "identified";
      permalink = observed[0];
    }
    return Object.freeze({ status, permalink, candidates: Object.freeze(observed), expectedPermalink: expected });
  }

  function resolveQuoteIdentity({
    primaryId = null,
    domPermalink = null,
    explicitQuoteIds = [],
    bounded = false,
  } = {}) {
    const primary = numericId(primaryId);
    const explicit = [...new Set((Array.isArray(explicitQuoteIds) ? explicitQuoteIds : [])
      .map(numericId).filter(Boolean))];
    const domCanonical = canonicalizeXPermalink(domPermalink);
    const dom = statusId(domCanonical);
    let conflictReason = null;
    if (explicit.length > 1) conflictReason = "multiple_explicit_ids";
    else if (dom && explicit.some((id) => id !== dom)) conflictReason = "dom_explicit_mismatch";
    else if (dom && primary && dom === primary) conflictReason = "primary_self_reference";
    else if (!dom && explicit.some((id) => primary && id === primary)) conflictReason = "primary_self_reference";
    if (conflictReason) {
      return Object.freeze({ status: "conflicting_identity", id: null, permalink: null, source: null, conflictReason });
    }
    if (dom) return Object.freeze({ status: "identified", id: dom, permalink: domCanonical, source: "dom_permalink", conflictReason: null });
    if (explicit.length === 1 && bounded !== true) {
      return Object.freeze({ status: "identified", id: explicit[0], permalink: `https://x.com/i/status/${explicit[0]}`, source: "main_structured_quote_relation", conflictReason: null });
    }
    return Object.freeze({ status: bounded === true ? "bounded_unresolved" : "unknown", id: null, permalink: null, source: null, conflictReason: null });
  }

  function findContentRoot(container, adapter) {
    const quotedRoot = adapter.findQuotedRoot?.(container) ?? null;
    if (adapter.resolveContentRoot) {
      const resolved = adapter.resolveContentRoot(container);
      if (resolved && !quotedRoot?.contains?.(resolved)) return resolved;
    }
    if (adapter.contentRootSelector) {
      const roots = [...(container?.querySelectorAll?.(adapter.contentRootSelector) ?? [])];
      const selected = roots.find((root) => !quotedRoot?.contains?.(root));
      if (selected) return selected;
    }
    return container;
  }

  function findExpansionButton(container, adapter, direction) {
    const selector = adapter.contentExpansion?.buttonSelector;
    if (!selector) return null;
    const quotedRoot = adapter.findQuotedRoot?.(container) ?? null;
    return [...(container?.querySelectorAll?.(selector) ?? [])]
      .find((candidate) => !quotedRoot?.contains?.(candidate) &&
        expansionLabel(candidate?.innerText || candidate?.textContent, direction)) ?? null;
  }

  function canExpandSafely(canExpand, button, context) {
    try { return canExpand(button, context) !== false; } catch { return false; }
  }

  async function waitWithinDeadline(wait, milliseconds, deadlineAt) {
    const remaining = Math.max(0, deadlineAt - Date.now());
    await wait(Math.max(0, Math.min(milliseconds, remaining)));
  }

  function routeChanged(route, expected) {
    return readRoute(route) !== expected;
  }

  function readRoute(route) {
    try { return String((typeof route === "function" ? route() : route) ?? ""); } catch { return ""; }
  }

  function defaultRoute() {
    return globalThis.location?.href ?? "";
  }

  function defaultWait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function clampInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
  }

  function codePointLength(value) {
    return Array.from(String(value ?? "")).length;
  }

  function numericId(value) {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
    }
    if (typeof value !== "string") return "";
    const text = value.trim();
    return text.length <= 39 && /^(?:x:status:)?\d+$/.test(text)
      ? text.replace(/^x:status:/, "")
      : "";
  }

  function statusId(value) {
    return String(value ?? "").match(/\/status\/(\d+)/)?.[1] ?? "";
  }

  globalThis.AkuCapturePrimitives = Object.freeze({
    sourceReadinessState,
    structuredText,
    detectXAccessChallenge,
    canonicalizeXPermalink,
    xReplyOwnerId,
    xReplySnapshotOwners,
    mergeXReplyDirectContext,
    markXReplyContextAmbiguous,
    mergeXResponseReply,
    expansionLabel,
    expandContent,
    restoreContent,
    textCompleteness,
    evaluateTextReplacement,
    resolvePrimaryIdentity,
    resolveQuoteIdentity,
  });
})();

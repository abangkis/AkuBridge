(() => {
  const compactRecoveryText = value => String(value ?? "").replace(/\s+/g, " ").trim();

  function linkedinMenuARIAOwner(ids, surface, candidateButton) {
    if (!ids.length) return "unknown";
    const owners = document.querySelectorAll(ids.map(id => `[aria-owns~="${id}"]`).join(', '));
    if (owners.length > 8) return "unknown";
    const externalOwners = [...owners].filter(node => !surface.contains(node));
    if (externalOwners.length > 1) return "multiple";
    if (!externalOwners.length) return "absent";
    return externalOwners[0] === candidateButton ? "candidate" : "other";
  }

  function linkedinMenuTrigger(nodes, ids, surface, dropdown) {
    const controls = new Map();
    const add = (node, binding) => { if (!controls.has(node)) controls.set(node, binding); };
    const controlSelector = 'button, [role="button"], summary';
    for (const id of ids) {
      const targets = document.querySelectorAll(`:is(${controlSelector}):is([aria-controls~="${id}"], [popovertarget="${id}"])`);
      if (targets.length > 8) return { binding: "ambiguous", trigger: null };
      for (const target of targets) {
        if (!surface.contains(target)) add(target, "target_reference");
      }
    }
    for (const node of nodes) {
      const labels = compactRecoveryText(node.getAttribute("aria-labelledby")).split(" ").filter(Boolean);
      if (labels.length > 8) return { binding: "unresolved", trigger: null };
      for (const id of labels) {
        const trigger = document.getElementById(id)?.closest(controlSelector);
        if (trigger && !surface.contains(trigger)) add(trigger, "label_reference");
      }
    }
    if (controls.size === 0 && dropdown) {
      const toggles = dropdown.querySelectorAll('.artdeco-dropdown__trigger');
      if (toggles.length > 8) return { binding: "unresolved", trigger: null };
      for (const toggle of toggles) {
        if (toggle.matches(controlSelector) && toggle.closest('.artdeco-dropdown') === dropdown && !surface.contains(toggle)) {
          add(toggle, "component_toggle");
        }
      }
    }
    if (controls.size > 1) return { binding: "ambiguous", trigger: null };
    const [trigger, binding] = controls.entries().next().value ?? [null, "unresolved"];
    return { binding, trigger };
  }

  function linkedinMenuHitTest(menu, rect) {
    if (!rect || typeof document.elementsFromPoint !== "function") return null;
    const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
    if (!(right > left && bottom > top)) return null;
    const result = { hit: 0, covered: 0, miss: 0 };
    for (const [x, y] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const stack = document.elementsFromPoint(left + x * (right - left), top + y * (bottom - top));
      const position = stack.findIndex(element => menu.contains(element));
      if (position === 0) result.hit++;
      else if (position > 0) result.covered++;
      else result.miss++;
    }
    return result;
  }

  function linkedinMenuEvidence(menu, rect, owner, read) {
    const popover = menu.closest('[popover]');
    const dropdown = menu.closest('.artdeco-dropdown');
    const dropdownContent = menu.closest('.artdeco-dropdown__content');
    const surface = popover ?? dropdownContent ?? menu;
    const nodes = menu === surface ? [menu] : [menu, surface];
    const escape = globalThis.CSS?.escape;
    const ids = escape ? nodes.map(node => node.id).filter(Boolean).map(id => escape(id)) : [];
    const { binding, trigger } = read(() => linkedinMenuTrigger(nodes, ids, surface, dropdown)) ??
      { binding: "unresolved", trigger: null };
    const ariaOwnerRelation = read(() => linkedinMenuARIAOwner(ids, surface, owner.button)) ?? "unknown";
    const expanded = read(() => trigger?.getAttribute("aria-expanded")?.trim().toLowerCase());
    const triggerExpanded = expanded === "true" ? true : expanded === "false" ? false : null;
    const popoverOpen = popover ? read(() => popover.matches(':popover-open')) : null;
    const dropdownOpen = dropdownContent ? read(() => dropdownContent.matches('.artdeco-dropdown__content--is-open')) : null;
    const subject = trigger ?? menu;
    const inNavigation = Boolean(subject.closest('nav, [role="navigation"], .global-nav'));
    const inPost = owner.container.contains?.(subject) || subject.closest('.feed-shared-update-v2, .update-components-update-v2');
    return {
      component: popover ? "popover" : dropdown || dropdownContent ? "artdeco_dropdown" : "unclassified",
      scope: inNavigation ? "navigation" : inPost ? "feed_post" : "unclassified",
      ariaOwnerRelation,
      triggerBinding: binding,
      triggerRelation: trigger ? trigger === owner.button ? "candidate" : "other" : "unknown",
      triggerExpanded, popoverOpen, dropdownOpen,
      cssCheck: read(() => menu.checkVisibility?.({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) ?? null),
      hitTest: read(() => linkedinMenuHitTest(menu, rect)),
    };
  }

  // Observation only: never re-run the guard's visibility predicate or read raw labels/URLs.
  function recordBlocker(menus, dialogs, owner, helpers, candidateIndex, inspect) {
    let complete = menus.length <= 32 && dialogs !== null && dialogs.length <= 32;
    const read = fn => { try { return fn(); } catch { complete = false; return null; } };
    const flags = node => {
      const style = read(() => getComputedStyle(node));
      return {
        displayed: read(() => style && typeof style.display === "string" && style.display ? style.display !== "none" : null),
        cssVisible: read(() => style && typeof style.visibility === "string" && style.visibility ? !["hidden", "collapse"].includes(style.visibility) : null),
        opacityPositive: read(() => style && typeof style.opacity === "string" && style.opacity !== "" && Number.isFinite(Number(style.opacity)) ? Number(style.opacity) > 0 : null),
        hiddenAttribute: read(() => node.hasAttribute("hidden")),
        ariaHidden: read(() => node.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"),
        inert: read(() => node.hasAttribute("inert")),
      };
    };
    const ancestry = node => {
      const result = { inspected: 0, complete: true, displayNone: false, visibilityHidden: false,
        opacityZero: false, hiddenAttribute: false, ariaHidden: false, inert: false };
      const keys = ["displayNone", "visibilityHidden", "opacityZero", "hiddenAttribute", "ariaHidden", "inert"];
      let parentUnknown = false;
      const parent = element => {
        try { const value = element.parentElement; if (value === undefined) parentUnknown = true; return value; }
        catch { parentUnknown = true; return null; }
      };
      let current = parent(node);
      while (current && result.inspected < 16) {
        const value = flags(current);
        const observed = { displayNone: value.displayed === null ? null : !value.displayed,
          visibilityHidden: value.cssVisible === null ? null : !value.cssVisible,
          opacityZero: value.opacityPositive === null ? null : !value.opacityPositive,
          hiddenAttribute: value.hiddenAttribute, ariaHidden: value.ariaHidden, inert: value.inert };
        for (const key of keys) {
          if (observed[key] === true) result[key] = true;
          else if (observed[key] === null) { if (result[key] !== true) result[key] = null; result.complete = false; }
        }
        result.inspected++;
        current = parent(current);
      }
      if (current || parentUnknown) result.complete = false;
      if (!result.complete) for (const key of keys) if (result[key] === false) result[key] = null;
      if (!result.complete) complete = false;
      return result;
    };
    // These are independent ARIA reference comparisons, never ownership claims.
    const reference = (node, attribute, expected) => {
      try {
        const value = node.getAttribute(attribute);
        if (!value?.trim()) return "absent";
        if (typeof expected !== "string" || !expected) { complete = false; return "unknown"; }
        return value.trim().split(/\s+/).includes(expected) ? "matches" : "different";
      } catch { complete = false; return "unknown"; }
    };
    const samples = [];
    for (const [kind, nodes] of [["menu", menus], ["dialog", dialogs ?? []]]) {
      for (const node of nodes.slice(0, Math.max(0, 4 - samples.length))) {
        const rect = read(() => node.getBoundingClientRect());
        const selector = read(() => node.matches('[role="menu"]') ? "role_menu"
          : node.matches('[role="dialog"]') ? "role_dialog"
          : node.matches('[data-test-modal]') ? "data_test_modal"
          : node.matches('.artdeco-modal') ? "artdeco_modal" : "unknown");
        const menuEvidence = kind === "menu" && typeof node.closest === "function"
          ? read(() => linkedinMenuEvidence(node, rect, owner, read)) : null;
        samples.push({ kind, selector: selector ?? "unknown",
          aria: { labelledBy: reference(node, "aria-labelledby", read(() => owner.button.id)),
            controls: reference(owner.button, "aria-controls", read(() => node.id)),
            owns: reference(owner.button, "aria-owns", read(() => node.id)) },
          guardVisible: true,
          hasArea: rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) ? rect.width > 0 && rect.height > 0 : null,
          intersectsViewport: rect && [rect.top, rect.bottom, rect.left, rect.right, window.innerWidth, window.innerHeight].every(Number.isFinite)
            ? rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth : null,
          ...flags(node), ancestors: ancestry(node),
          ...(menuEvidence ? { menuEvidence } : {}),
        });
      }
    }
    if (samples.length < menus.length + (dialogs?.length ?? 0)) complete = false;
    if (samples.some(sample => Object.values(sample).includes(null) || sample.selector === "unknown")) complete = false;
    const snapshotIndex = read(() => helpers.diagnosticSnapshotIndex);
    const position = read(() => helpers.diagnosticCandidateIndex ? helpers.diagnosticCandidateIndex(owner.container) : candidateIndex);
    let surfaceInspection;
    try { surfaceInspection = inspect?.(); } catch { /* The legacy sample remains available. */ }
    return { code: "existing_surface", phase: "pre_recovery_guard",
      snapshotIndex: Number.isSafeInteger(snapshotIndex) && snapshotIndex >= 0 && snapshotIndex <= 1_000_000 ? snapshotIndex : null,
      candidateIndex: Number.isSafeInteger(position) && position >= 0 && position <= 1_000_000 ? position : null,
      menuCount: Math.min(32, menus.length),
      dialogCount: dialogs === null ? null : Math.min(32, dialogs.length), samples, complete,
      ...(surfaceInspection ? { surfaceInspection } : {}) };
  }

  const postRoot = 'article, [data-view-name="feed-full-update"], .feed-shared-update-v2, .update-components-update-v2';
  const components = [
    ["messaging", '.msg-overlay-container, [data-view-name^="messaging" i], [data-view-name^="msg-" i]'],
    ["feed_sort", '[data-view-name*="feed-sort" i], [data-testid*="feed-sort" i]'],
    ["post", postRoot],
    ["navigation", 'nav, [role="navigation"], [role="menubar"], .global-nav, [data-view-name^="nav-" i]'],
    ["header", 'header, [role="banner"]'],
    ["sidebar", 'aside, [role="complementary"]'],
    ["footer", 'footer, [role="contentinfo"]'],
    ["main", 'main, [role="main"]'],
  ];
  const actions = [
    ["post_link", /\b(?:copy (?:the )?link to (?:this )?post|embed (?:this )?post|salin tautan (?:ke )?postingan)\b/i],
    ["save_post", /^(?:save(?: this)? post|unsave(?: this)? post|simpan postingan)$/i],
    ["report_post", /^(?:report (?:this )?post|laporkan postingan)$/i],
    ["account", /^(?:view profile|settings\s*(?:&|and)\s*privacy|sign out|lihat profil|keluar)$/i],
    ["message", /^(?:new message|compose message|messaging|pesan baru)$/i],
    ["feed_order", /^(?:top|recent|latest|most recent|top posts|recent posts|sort by|terbaru)(?:\s+first)?$/i],
    ["navigation", /^(?:home|my network|jobs|notifications|beranda|jaringan saya|lowongan|notifikasi)$/i],
    ["dismiss", /^(?:close|dismiss|cancel|tutup|batal)$/i],
  ];

  function componentTrail(node) {
    const trail = [];
    for (let depth = 0; node && depth < 20; depth++, node = node.parentElement) {
      const kind = components.find(([, selector]) => node.matches(selector))?.[0];
      if (kind && !trail.includes(kind)) trail.push(kind);
      if (trail.length === 4) break;
    }
    return trail;
  }

  function actionHints(node) {
    const controls = node.querySelectorAll('button, a[href], [role^="menuitem"], [role="option"]');
    const hints = new Set();
    for (const control of [node, ...Array.prototype.slice.call(controls, 0, 24)]) {
      const label = compactRecoveryText(String(control.getAttribute("aria-label") ||
        (control === node ? "" : control.textContent) || "").slice(0, 160));
      const match = actions.find(([, pattern]) => pattern.test(label));
      if (match) hints.add(match[0]);
    }
    return { actionHints: [...hints], actionCount: Math.min(24, controls.length) };
  }

  function controlOcclusion(surface, button) {
    const rect = button.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
    if (!(rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight)) return "unknown";
    const first = document.elementsFromPoint(x, y)[0];
    if (!first) return "unknown";
    if (button.contains(first)) return "target_hit";
    return surface.contains(first) ? "surface_hit" : "other_hit";
  }

  function openState(node, parent, expanded) {
    if (node.matches('dialog')) return node.open ? "open" : "closed";
    if (parent.matches('[popover]')) return parent.matches(':popover-open') ? "open" : "closed";
    if (parent.matches('.artdeco-dropdown__content')) {
      return parent.matches('.artdeco-dropdown__content--is-open') ? "open" : "closed";
    }
    return expanded === "true" ? "open" : expanded === "false" ? "closed" : "unknown";
  }

  // Separate from the legacy guard sample. Dialog reads here never feed its
  // short-circuited decision, and structural hints grant no recovery authority.
  function inspectSurfaces(menus, dialogs, owner) {
    const dialogCandidates = dialogs.slice(0, 8);
    const shownDialogs = dialogCandidates.filter(node => {
      const rect = node.getBoundingClientRect();
      return node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < window.innerHeight && rect.left < window.innerWidth;
    });
    const surfaces = [];
    for (const [kind, nodes] of [["menu", menus], ["dialog", shownDialogs]]) {
      for (const node of nodes.slice(0, 2)) {
        const parent = node.closest('[popover], .artdeco-dropdown__content') ?? node;
        const refs = [...new Set([node, parent].map(value => value.id).filter(Boolean))].slice(0, 2);
        const dropdown = node.closest('.artdeco-dropdown');
        const { binding, trigger } = linkedinMenuTrigger([...new Set([node, parent])], refs.map(id => CSS.escape(id)), parent, dropdown);
        const expanded = trigger?.getAttribute("aria-expanded");
        const post = (trigger ?? node).closest(postRoot);
        const ownerRelation = trigger === owner.button || owner.container.contains(trigger ?? node) ? "candidate_post"
          : post ? "other_post" : "unknown";
        surfaces.push({ kind, slot: surfaces.length, trail: componentTrail(node), ...actionHints(node),
          ownerRelation, triggerBinding: binding, triggerTrail: trigger ? componentTrail(trigger) : [],
          triggerExpanded: expanded === "true" ? true : expanded === "false" ? false : null,
          openState: openState(node, parent, expanded), controlOcclusion: controlOcclusion(node, owner.button) });
      }
    }
    return { dialogCount: shownDialogs.length, complete: menus.length <= 2 && dialogs.length <= 8 && shownDialogs.length <= 2, surfaces };
  }

  globalThis.AkuLinkedInRecoveryDiagnostics = Object.freeze({ recordBlocker, inspectSurfaces });
})();

(() => {
  const registry = globalThis.AkuSourceAdapters;
  if (!registry) throw new Error("AkuBridge source-adapter runtime was not loaded.");

  registry.register({
    source: "x",
    version: "x-dom-v1",
    matchesPage: () => window.location.hostname === "x.com",
    loginRequired: () => false,
    feedRootPresent: () => Boolean(document.querySelector("main")),
    discoverCandidates: ({ uniqueElements }) => {
      const candidates = uniqueElements([
        ...document.querySelectorAll('article[data-testid="tweet"]'),
        ...document.querySelectorAll("main article"),
      ]);
      return {
        candidates,
        semanticCandidateCount: candidates.length,
        actionAnchoredCandidateCount: 0,
      };
    },
    findAuthor: (container, { compactText }) =>
      compactText(container.querySelector('[data-testid="User-Name"]')?.innerText).slice(0, 300),
    imageSelector: '[data-testid="tweetPhoto"] img',
    pendingContentPattern: /^(?:new posts?|show(?: \d+)? posts?)$/i,
  });
})();

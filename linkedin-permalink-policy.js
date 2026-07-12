(() => {
  function canonicalFromEmbedHref(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value, "https://www.linkedin.com/");
      if (url.protocol !== "https:" || url.hostname !== "www.linkedin.com") return null;
      const urn = url.searchParams.get("targetUrn");
      if (!/^urn:li:(?:activity|share|ugcPost):\d+$/i.test(urn ?? "")) return null;
      return `https://www.linkedin.com/feed/update/${urn}/`;
    } catch {
      return null;
    }
  }

  globalThis.AkuLinkedInPermalinkPolicy = Object.freeze({ canonicalFromEmbedHref });
})();

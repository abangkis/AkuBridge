(() => {
  // The signed vertical gap is positive when the rectangles are separate
  // and negative when they overlap. Either above or below is supported.
  function compareAnchorGeometry(anchor, panel, { maxHorizontalErrorPx, minVerticalGapPx, maxVerticalGapPx }) {
    const horizontalError = Math.min(Math.abs(panel.left - anchor.left), Math.abs(panel.right - anchor.right));
    const verticalGap = Math.max(panel.top - anchor.bottom, anchor.top - panel.bottom);
    const verticalMatch = verticalGap >= minVerticalGapPx && verticalGap <= maxVerticalGapPx;
    const verticalReason = verticalGap > maxVerticalGapPx ? "gap_too_large"
      : verticalGap < minVerticalGapPx ? "overlap_too_large" : null;
    return { horizontalMatch: horizontalError <= maxHorizontalErrorPx, verticalMatch, verticalReason, gapY: verticalGap };
  }

  globalThis.AkuAnchorGeometry = Object.freeze({ compareAnchorGeometry });
})();

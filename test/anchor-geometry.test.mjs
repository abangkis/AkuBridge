import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const context = {};
runInNewContext(readFileSync(new URL("../anchor-geometry.js", import.meta.url), "utf8"), context);
const { compareAnchorGeometry } = context.AkuAnchorGeometry;
const anchor = { top: 100, bottom: 132, left: 68, right: 100 };
const linkedInTolerance = { maxHorizontalErrorPx: 4, minVerticalGapPx: -2, maxVerticalGapPx: 16 };

test("signed anchor gap is symmetric above and below and uses inclusive CSS pixel thresholds", () => {
  for (const gap of [-2.25, -2, 16, 16.25]) {
    const below = { top: anchor.bottom + gap, bottom: anchor.bottom + gap + 200, left: -96, right: 104 };
    const above = { ...below, top: anchor.top - gap - 200, bottom: anchor.top - gap };
    for (const panel of [below, above]) {
      const result = compareAnchorGeometry(anchor, panel, linkedInTolerance);
      assert.equal(result.horizontalMatch, true);
      assert.equal(result.verticalMatch, gap >= -2 && gap <= 16);
      assert.equal(result.verticalReason, gap < -2 ? "overlap_too_large" : gap > 16 ? "gap_too_large" : null);
    }
  }
});

test("one rectangle pair can be checked against different caller tolerances", () => {
  const panel = { top: 152, bottom: 352, left: -95, right: 105 };
  const linkedIn = compareAnchorGeometry(anchor, panel, linkedInTolerance);
  assert.equal(linkedIn.horizontalMatch, false);
  assert.equal(linkedIn.verticalReason, "gap_too_large");
  const wider = compareAnchorGeometry(anchor, panel, { ...linkedInTolerance, maxHorizontalErrorPx: 5, maxVerticalGapPx: 20 });
  assert.equal(wider.horizontalMatch && wider.verticalMatch, true);
});

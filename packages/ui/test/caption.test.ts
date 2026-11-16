import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captionRect } from "../src/app/frame.js";

describe("caption hit areas", () => {
  it("measures a button in physical pixels from the window's right edge", () => {
    // The maximize button of a 1280px-wide page at 150% scale.
    assert.deepEqual(captionRect({ left: 1188, top: 0, width: 46, height: 48 }, 1280, 1.5), {
      right: 138,
      top: 0,
      width: 69,
      height: 72,
    });
  });

  it("keeps neighbouring buttons edge to edge at fractional scales", () => {
    const ratio = 1.25 * 1.1;
    const max = captionRect({ left: 1188, top: 0, width: 46, height: 48 }, 1280, ratio);
    const close = captionRect({ left: 1234, top: 0, width: 46, height: 48 }, 1280, ratio);
    assert.equal(max.right - max.width, close.right);
    assert.equal(close.right - close.width, 0);
  });
});

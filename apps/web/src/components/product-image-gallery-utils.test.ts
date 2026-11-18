import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getNextGalleryIndex,
  getSwipeDirection,
} from "./product-image-gallery-utils.js";

test("gallery cycles through only the current product images and wraps", () => {
  assert.equal(getNextGalleryIndex(0, 3), 1);
  assert.equal(getNextGalleryIndex(2, 3), 0);
  assert.equal(getNextGalleryIndex(0, 1), 0);
  assert.equal(getNextGalleryIndex(0, 0), 0);
});

test("swipe navigation ignores short gestures and reports direction", () => {
  assert.equal(getSwipeDirection(39), null);
  assert.equal(getSwipeDirection(-39), null);
  assert.equal(getSwipeDirection(40), 1);
  assert.equal(getSwipeDirection(-40), -1);
});

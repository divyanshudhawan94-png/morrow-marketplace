import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSearchSuggestions,
  highlightSearchText,
} from "./search-utils.js";

test("suggestions include matching products, brands, and categories", () => {
  const suggestions = createSearchSuggestions([
    {
      id: "product-1",
      title: "Men's Casual Sneakers",
      brand: "Generic",
      category: "footwear",
      priceMinor: 249900,
    },
  ]);
  assert.deepEqual(
    suggestions.map(({ kind, label }) => ({ kind, label })),
    [
      { kind: "product", label: "Men's Casual Sneakers" },
      { kind: "brand", label: "Generic" },
      { kind: "category", label: "Footwear" },
    ],
  );
  assert.equal(suggestions[0]?.productId, "product-1");
});

test("suggestion highlights are case-insensitive and preserve unmatched text", () => {
  assert.deepEqual(highlightSearchText("Nike Air Shoes", "nike shoes"), [
    { text: "Nike", matched: true },
    { text: " Air ", matched: false },
    { text: "Shoes", matched: true },
  ]);
  assert.deepEqual(highlightSearchText("Generic", "   "), [
    { text: "Generic", matched: false },
  ]);
});

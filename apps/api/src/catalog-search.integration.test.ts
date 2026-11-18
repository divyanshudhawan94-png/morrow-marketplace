import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp } from "./app.js";
import { scoreCatalogProduct, searchTerms } from "./catalog-search.js";
import { DynamoAuthRepository } from "./dynamodb-repository.js";

interface SearchResult {
  id: string;
  title: string;
  brand: string;
  category: string;
  priceMinor: number;
}

const endpoint = process.env.DYNAMODB_TEST_ENDPOINT ?? process.env.DYNAMODB_ENDPOINT;
const tableName = process.env.DYNAMODB_TABLE;
const isLoopback = endpoint
  ? ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(endpoint).hostname)
  : false;

const repository =
  endpoint && tableName && isLoopback
    ? new DynamoAuthRepository(
        tableName,
        process.env.AWS_REGION ?? "ap-south-1",
        endpoint,
      )
    : undefined;
const app = repository
  ? createApp({ repository, webOrigin: "http://localhost:3000", secureCookies: false })
  : undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readCatalogPage(value: unknown): {
  items: SearchResult[];
  nextCursor: string | null;
} {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")
  ) {
    throw new Error("The catalog API returned an invalid page.");
  }
  const items = value.items.map((item): SearchResult => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.brand !== "string" ||
      typeof item.category !== "string" ||
      typeof item.priceMinor !== "number"
    ) {
      throw new Error("The catalog API returned an invalid product.");
    }
    return {
      id: item.id,
      title: item.title,
      brand: item.brand,
      category: item.category,
      priceMinor: item.priceMinor,
    };
  });
  return { items, nextCursor: value.nextCursor };
}

after(async () => {
  if (app) await app.close();
});

async function search(query: string, options = ""): Promise<SearchResult[]> {
  if (!app) throw new Error("The local DynamoDB test app is unavailable.");
  const suffix = options ? `&${options}` : "";
  const response = await app.inject({
    method: "GET",
    url: `/catalog?q=${encodeURIComponent(query)}${suffix}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return readCatalogPage(response.json()).items;
}

function assertAllRelevant(results: readonly SearchResult[], query: string): void {
  for (const product of results) {
    assert.notEqual(
      scoreCatalogProduct(product, query),
      null,
      `Unexpected result "${product.title}" for "${query}".`,
    );
  }
}

function misspell(term: string): string {
  const index = Math.min(2, term.length - 2);
  const replacement = term[index] === "z" ? "x" : "z";
  return `${term.slice(0, index)}${replacement}${term.slice(index + 1)}`;
}

test(
  "searches and paginates actual active products in the local DynamoDB catalog",
  { skip: !repository || !app },
  async () => {
    const testApp = app!;
    await testApp.ready();
    const catalogResponse = await testApp.inject({
      method: "GET",
      url: "/catalog?limit=50",
    });
    assert.equal(catalogResponse.statusCode, 200, catalogResponse.body);
    const products = readCatalogPage(catalogResponse.json()).items;
    assert.ok(products.length > 0, "The local catalog has no active products to test.");

    const exactProduct = products[0]!;
    const exactResults = await search(exactProduct.title, "limit=50");
    assert.equal(exactResults[0]?.id, exactProduct.id);
    assertAllRelevant(exactResults, exactProduct.title);

    const partialQuery = searchTerms(exactProduct.title)[0]!.slice(0, 3);
    const partialResults = await search(partialQuery, "limit=50");
    assert.ok(partialResults.some((product) => product.id === exactProduct.id));
    assertAllRelevant(partialResults, partialQuery);

    const brandResults = await search(exactProduct.brand, "limit=50");
    assert.ok(brandResults.some((product) => product.brand === exactProduct.brand));
    assertAllRelevant(brandResults, exactProduct.brand);

    const categoryResults = await search(exactProduct.category, "limit=50");
    assert.ok(categoryResults.some((product) => product.category === exactProduct.category));
    assertAllRelevant(categoryResults, exactProduct.category);

    const footwear = products.find((product) => product.category === "footwear");
    if (footwear) {
      const relatedResults = await search("shoes", "limit=50");
      assert.ok(relatedResults.some((product) => product.id === footwear.id));
      assertAllRelevant(relatedResults, "shoes");
    }

    const multipleTerms = searchTerms(exactProduct.title).slice(0, 2).join(" ");
    const multipleResults = await search(multipleTerms, "limit=50");
    assert.ok(multipleResults.some((product) => product.id === exactProduct.id));
    assertAllRelevant(multipleResults, multipleTerms);

    const typoToken = searchTerms(exactProduct.title).find((term) => term.length >= 5);
    if (typoToken) {
      const misspelled = misspell(typoToken);
      const typoResults = await search(misspelled, "limit=50");
      assert.ok(
        typoResults.some((product) => product.id === exactProduct.id),
        `Expected ${exactProduct.title} for the one-character typo "${misspelled}".`,
      );
      assertAllRelevant(typoResults, misspelled);
    }

    const noMatches = await search("zzqvnotacatalogproduct", "limit=50");
    assert.deepEqual(noMatches, []);

    const emptySearchResponse = await testApp.inject({ method: "GET", url: "/catalog?limit=50" });
    assert.equal(emptySearchResponse.statusCode, 200, emptySearchResponse.body);
    assert.ok(readCatalogPage(emptySearchResponse.json()).items.length > 0);

    const pagedResults: SearchResult[] = [];
    let cursor: string | null = null;
    do {
      const pageResponse: {
        statusCode: number;
        body: string;
        json(): unknown;
      } = await testApp.inject({
        method: "GET",
        url: `/catalog?q=${encodeURIComponent("mens")}&sort=price_asc&limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      });
      assert.equal(pageResponse.statusCode, 200, pageResponse.body);
      const page = readCatalogPage(pageResponse.json());
      pagedResults.push(...page.items);
      cursor = page.nextCursor;
      assert.ok(pagedResults.length <= products.length);
    } while (cursor);
    assert.equal(new Set(pagedResults.map((product) => product.id)).size, pagedResults.length);
    assertAllRelevant(pagedResults, "mens");
    assert.deepEqual(
      pagedResults.map((product) => product.priceMinor),
      [...pagedResults.map((product) => product.priceMinor)].sort((left, right) => left - right),
    );
  },
);

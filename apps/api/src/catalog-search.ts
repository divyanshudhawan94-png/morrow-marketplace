import type { CatalogSort, ProductRecord } from "./repository.js";

const synonymGroups = [
  ["shoe", "shoes", "footwear", "sneaker", "sneakers", "trainer", "trainers"],
  ["run", "running", "runner", "runners", "jog", "jogging", "athletic", "sports", "sport"],
  ["bag", "bags", "handbag", "handbags", "purse", "purses"],
  ["backpack", "backpacks", "rucksack", "rucksacks"],
  ["phone", "phones", "mobile", "mobiles", "smartphone", "smartphones"],
  ["laptop", "laptops", "notebook", "notebooks"],
  ["jewelry", "jewellery"],
  ["sofa", "sofas", "couch", "couches"],
  ["wallet", "wallets", "billfold", "billfolds"],
  ["hoodie", "hoodies", "sweatshirt", "sweatshirts"],
  ["color", "colour"],
  ["gray", "grey"],
  ["pajamas", "pyjamas"],
] as const;

const synonymsByWord = new Map<string, readonly string[]>();
for (const group of synonymGroups) {
  for (const word of group) synonymsByWord.set(word, group);
}

const ignoredQueryWords = new Set([
  "a", "an", "and", "for", "in", "of", "the", "to", "with",
]);

function stem(term: string): string {
  if (term.length > 5 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/'s\b/gi, "s")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function searchTerms(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((term) => term.length > 1 && !ignoredQueryWords.has(term));
}

export function searchTermAlternatives(term: string): readonly string[] {
  const exactSynonyms = synonymsByWord.get(term);
  if (exactSynonyms) return exactSynonyms;

  const stemSynonyms = synonymsByWord.get(stem(term));
  if (stemSynonyms) return stemSynonyms;

  if (term.length >= 3) {
    const partialSynonyms = synonymGroups.find((group) =>
      group.some((word) => word.startsWith(term)),
    );
    if (partialSynonyms) return [term, ...partialSynonyms];
  }
  return [term];
}

export function searchIndexSignatures(token: string): string[] {
  const signatures = new Set<string>();
  for (let length = 2; length <= Math.min(4, token.length); length += 1) {
    signatures.add(`P#${token.slice(0, length)}`);
  }
  for (let index = 0; index <= token.length - 3; index += 1) {
    signatures.add(`G#${token.slice(index, index + 3)}`);
  }
  return [...signatures];
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left === right) return true;

  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) edits += 1;
  return edits <= 1;
}

type TokenMatch = "direct" | "related" | "fuzzy";

function directTokenMatch(queryTerm: string, productTerm: string): boolean {
  return (
    queryTerm === productTerm ||
    productTerm.startsWith(queryTerm) ||
    stem(queryTerm) === stem(productTerm)
  );
}

export function searchTermMatch(
  queryTerm: string,
  productTerm: string,
): TokenMatch | null {
  if (directTokenMatch(queryTerm, productTerm)) return "direct";
  let bestMatch: TokenMatch | null = null;
  for (const alternative of searchTermAlternatives(queryTerm)) {
    if (directTokenMatch(alternative, productTerm)) {
      if (alternative === queryTerm) return "direct";
      bestMatch = "related";
      continue;
    }
    if (
      queryTerm.length >= 5 &&
      productTerm.length >= 5 &&
      editDistanceAtMostOne(alternative, productTerm)
    ) {
      bestMatch = "fuzzy";
    }
  }
  return bestMatch;
}

export function scoreCatalogProduct(
  product: Pick<ProductRecord, "title" | "brand" | "category">,
  query: string,
): number | null {
  const terms = searchTerms(query);
  if (terms.length === 0) return null;

  const normalizedQuery = normalizeSearchText(query);
  const fields = [
    { tokens: searchTerms(product.title), weight: 100 },
    { tokens: searchTerms(product.brand), weight: 70 },
    { tokens: searchTerms(product.category), weight: 55 },
  ];
  const termMatches = terms.map((term) =>
    fields.map((field) =>
      field.tokens
        .map((token) => searchTermMatch(term, token))
        .filter((match): match is TokenMatch => match !== null),
    ),
  );
  if (termMatches.some((matches) => matches.every((field) => field.length === 0))) {
    return null;
  }

  const allTermsDirectlyMatchField = (fieldIndex: number) =>
    termMatches.every((matches) => matches[fieldIndex]?.includes("direct"));
  const anyTermDirectlyMatchesField = (fieldIndex: number) =>
    termMatches.some((matches) => matches[fieldIndex]?.includes("direct"));
  const title = normalizeSearchText(product.title);

  let tier: number;
  if (title === normalizedQuery) tier = 100_000;
  else if (title.startsWith(normalizedQuery)) tier = 90_000;
  else if (title.includes(normalizedQuery)) tier = 85_000;
  else if (allTermsDirectlyMatchField(0)) tier = 80_000;
  else if (anyTermDirectlyMatchesField(0)) tier = 70_000;
  else if (allTermsDirectlyMatchField(1)) tier = 60_000;
  else if (anyTermDirectlyMatchesField(1)) tier = 55_000;
  else if (allTermsDirectlyMatchField(2)) tier = 50_000;
  else if (anyTermDirectlyMatchesField(2)) tier = 45_000;
  else if (termMatches.some((matches) => matches.some((field) => field.includes("related")))) {
    tier = 30_000;
  } else {
    tier = 20_000;
  }

  let fieldScore = 0;
  for (const matches of termMatches) {
    const bestFieldScore = matches.reduce((best, fieldMatches, index) => {
      const matchWeight = fieldMatches.includes("direct")
        ? fields[index]?.weight ?? 0
        : fieldMatches.includes("related")
          ? (fields[index]?.weight ?? 0) * 0.6
          : (fields[index]?.weight ?? 0) * 0.3;
      return Math.max(best, matchWeight);
    }, 0);
    fieldScore += bestFieldScore;
  }
  return tier + fieldScore;
}

export function rankCatalogProducts<T extends ProductRecord>(
  products: readonly T[],
  query: string,
  sort: CatalogSort = "newest",
): T[] {
  return products
    .map((product, index) => ({
      product,
      index,
      score: scoreCatalogProduct(product, query),
    }))
    .filter(
      (entry): entry is { product: T; index: number; score: number } =>
        entry.score !== null,
    )
    .sort((left, right) => {
      const relevance = right.score - left.score;
      if (relevance !== 0) return relevance;
      if (sort === "price_asc") {
        return left.product.priceMinor - right.product.priceMinor ||
          right.product.createdAt.localeCompare(left.product.createdAt) ||
          left.index - right.index;
      }
      if (sort === "price_desc") {
        return right.product.priceMinor - left.product.priceMinor ||
          right.product.createdAt.localeCompare(left.product.createdAt) ||
          left.index - right.index;
      }
      return right.product.createdAt.localeCompare(left.product.createdAt) ||
        left.index - right.index;
    })
    .map((entry) => entry.product);
}

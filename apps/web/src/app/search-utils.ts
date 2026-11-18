export interface SearchProduct {
  id: string;
  title: string;
  brand: string;
  category: string;
  priceMinor: number;
}

export interface SearchSuggestion {
  key: string;
  kind: "product" | "brand" | "category";
  label: string;
  detail: string;
  query: string;
  productId?: string;
}

export interface HighlightPart {
  text: string;
  matched: boolean;
}

export function formatSearchCategory(category: string): string {
  return category
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function createSearchSuggestions(
  products: readonly SearchProduct[],
): SearchSuggestion[] {
  const productSuggestions = products.slice(0, 4).map((product) => ({
    key: `product-${product.id}`,
    kind: "product" as const,
    label: product.title,
    detail: `${product.brand} · ${formatSearchCategory(product.category)} · ${new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }).format(product.priceMinor / 100)}`,
    query: product.title,
    productId: product.id,
  }));
  const brands = [...new Set(products.map((product) => product.brand))]
    .slice(0, 2)
    .map((brand) => ({
      key: `brand-${brand.toLocaleLowerCase("en")}`,
      kind: "brand" as const,
      label: brand,
      detail: "Search this brand",
      query: brand,
    }));
  const categories = [...new Set(products.map((product) => product.category))]
    .slice(0, 2)
    .map((category) => ({
      key: `category-${category}`,
      kind: "category" as const,
      label: formatSearchCategory(category),
      detail: "Search this category",
      query: formatSearchCategory(category),
    }));
  return [...productSuggestions, ...brands, ...categories].slice(0, 8);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function highlightSearchText(text: string, query: string): HighlightPart[] {
  const terms = [...new Set(
    query.trim().split(/\s+/).filter((term) => term.length > 1),
  )].sort((left, right) => right.length - left.length);
  if (terms.length === 0) return [{ text, matched: false }];

  const matcher = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return text
    .split(matcher)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      matched: terms.some((term) => part.toLocaleLowerCase("en") === term.toLocaleLowerCase("en")),
    }));
}

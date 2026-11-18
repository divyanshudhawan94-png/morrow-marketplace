"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import MorrowHeader from "../../components/MorrowHeader";
import HighlightedSearchText from "../../components/HighlightedSearchText";
import ProductImageGallery from "../../components/ProductImageGallery";
import {
  createSearchSuggestions,
  type SearchSuggestion,
} from "../search-utils";

interface Product {
  id: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  currency: "INR";
  priceMinor: number;
  stock: number;
  images: Array<{ url: string; altText: string }>;
  specifications: Record<string, string>;
}

interface CatalogResponse {
  items: Product[];
  nextCursor: string | null;
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readCatalogResponse(value: unknown): CatalogResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("The catalog returned an invalid response.");
  }
  const items: Product[] = [];
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.description !== "string" ||
      typeof item.brand !== "string" ||
      typeof item.category !== "string" ||
      item.currency !== "INR" ||
      typeof item.priceMinor !== "number" ||
      typeof item.stock !== "number" ||
      !Array.isArray(item.images) ||
      !isRecord(item.specifications)
    ) {
      throw new Error("The catalog returned an invalid product.");
    }
    const images: Product["images"] = [];
    for (const image of item.images) {
      if (
        !isRecord(image) ||
        typeof image.url !== "string" ||
        typeof image.altText !== "string"
      ) {
        throw new Error("The catalog returned invalid product imagery.");
      }
      images.push({ url: image.url, altText: image.altText });
    }
    const specifications: Record<string, string> = {};
    for (const [key, entry] of Object.entries(item.specifications)) {
      if (typeof entry !== "string") {
        throw new Error("The catalog returned invalid specifications.");
      }
      specifications[key] = entry;
    }
    items.push({
      id: item.id,
      title: item.title,
      description: item.description,
      brand: item.brand,
      category: item.category,
      currency: "INR",
      priceMinor: item.priceMinor,
      stock: item.stock,
      images,
      specifications,
    });
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    throw new Error("The catalog returned an invalid pagination cursor.");
  }
  return { items, nextCursor: value.nextCursor };
}

async function getErrorMessage(response: Response): Promise<string> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string") return body.error;
  }
  return "Could not load the catalog. Please try again.";
}

function buildCatalogUrl(
  searchQuery: string,
  cursor: string | null,
  sort: string,
  category: string,
): string {
  const params = new URLSearchParams({ limit: "12" });
  if (searchQuery) params.set("q", searchQuery);
  if (category) params.set("category", category);
  if (sort !== "newest") params.set("sort", sort);
  if (cursor) params.set("cursor", cursor);
  return `${apiUrl}/catalog?${params.toString()}`;
}

function buildCollectionPath(
  searchQuery: string,
  cursor: string | null,
  sort: string,
  category: string,
): string {
  const params = new URLSearchParams();
  if (searchQuery) params.set("q", searchQuery);
  if (category) params.set("category", category);
  if (sort !== "newest") params.set("sort", sort);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/catalog?${query}` : "/catalog";
}

export default function CatalogPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("newest");
  const [products, setProducts] = useState<Product[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const requestSequence = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadCatalog(
    query: string,
    cursor: string | null,
    sortValue: string,
    categoryValue: string,
  ) {
    const requestId = ++requestSequence.current;
    if (!apiUrl) {
      setError("The catalog service is not configured.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        buildCatalogUrl(query, cursor, sortValue, categoryValue),
        {
        cache: "no-store",
        },
      );
      if (!response.ok) throw new Error(await getErrorMessage(response));
      const data = readCatalogResponse(await response.json());
      if (requestId !== requestSequence.current) return;
      setProducts(data.items);
      setNextCursor(data.nextCursor);
      setCurrentCursor(cursor);
    } catch (cause) {
      if (requestId === requestSequence.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not connect to the catalog service.",
        );
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = (params.get("q") ?? "").trim();
    const cursor = params.get("cursor");
    const categoryValue = params.get("category") ?? "";
    const requestedSort = params.get("sort") ?? "newest";
    const sortValue = ["newest", "price_asc", "price_desc"].includes(requestedSort)
      ? requestedSort
      : "newest";
    setSearchQuery(query);
    setSubmittedQuery(query);
    setCategory(categoryValue);
    setSort(sortValue);
    setCurrentCursor(cursor);
    void loadCatalog(query, cursor, sortValue, categoryValue);
  }, []);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  function updateSearchQuery(query: string) {
    requestSequence.current += 1;
    setSearchQuery(query);
    setSuggestionsOpen(true);
    setActiveSuggestion(-1);
    setLoading(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const normalizedQuery = query.trim();
      setSubmittedQuery(normalizedQuery);
      setPreviousCursors([]);
      window.history.replaceState(
        window.history.state,
        "",
        buildCollectionPath(normalizedQuery, null, sort, category),
      );
      void loadCatalog(normalizedQuery, null, sort, category);
    }, 300);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = null;
    setSearchQuery(query);
    setSubmittedQuery(query);
    setSuggestionsOpen(false);
    setActiveSuggestion(-1);
    setPreviousCursors([]);
    window.history.replaceState(
      window.history.state,
      "",
      buildCollectionPath(query, null, sort, category),
    );
    void loadCatalog(query, null, sort, category);
  }

  function chooseSuggestion(suggestion: SearchSuggestion) {
    setSuggestionsOpen(false);
    setActiveSuggestion(-1);
    if (suggestion.productId) {
      router.push(
        `/catalog/${encodeURIComponent(suggestion.productId)}?from=${encodeURIComponent(
          buildCollectionPath(searchQuery.trim(), null, sort, category),
        )}`,
      );
      return;
    }
    const query = suggestion.query;
    setSearchQuery(query);
    setSubmittedQuery(query);
    setCategory("");
    setPreviousCursors([]);
    window.history.replaceState(
      window.history.state,
      "",
      buildCollectionPath(query, null, sort, ""),
    );
    void loadCatalog(query, null, sort, "");
  }

  function clearSearch() {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = null;
    setSearchQuery("");
    setSubmittedQuery("");
    setCategory("");
    setSuggestionsOpen(false);
    setPreviousCursors([]);
    window.history.replaceState(window.history.state, "", "/catalog");
    void loadCatalog("", null, "newest", "");
  }

  function changeSort(nextSort: string) {
    setSort(nextSort);
    setPreviousCursors([]);
    window.history.replaceState(
      window.history.state,
      "",
      buildCollectionPath(submittedQuery, null, nextSort, category),
    );
    void loadCatalog(submittedQuery, null, nextSort, category);
  }

  function showNextPage() {
    if (!nextCursor) return;
    setPreviousCursors((cursors) => [...cursors, currentCursor ?? ""]);
    window.history.replaceState(
      window.history.state,
      "",
      buildCollectionPath(submittedQuery, nextCursor, sort, category),
    );
    void loadCatalog(submittedQuery, nextCursor, sort, category);
  }

  function showPreviousPage() {
    if (previousCursors.length === 0) return;
    const cursors = [...previousCursors];
    const cursor = cursors.pop() || null;
    setPreviousCursors(cursors);
    window.history.replaceState(
      window.history.state,
      "",
      buildCollectionPath(submittedQuery, cursor, sort, category),
    );
    void loadCatalog(submittedQuery, cursor, sort, category);
  }

  const suggestionOptions = createSearchSuggestions(products);

  return (
    <main className="catalog-page">
      <MorrowHeader />

      <section className="catalog-intro">
        <p className="eyebrow">THE COLLECTION</p>
        <h1>Good things, thoughtfully found.</h1>
        <p>Search products by name, brand, or category.</p>
      </section>

      <form className="catalog-search-form" role="search" onSubmit={handleSearch}>
        <label className="visually-hidden" htmlFor="catalog-search">Search products</label>
        <div className="catalog-search-autocomplete">
          <input
            id="catalog-search"
            type="search"
            value={searchQuery}
            onChange={(event) => updateSearchQuery(event.target.value)}
            placeholder="Search products by name or brand..."
            maxLength={80}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen && searchQuery.trim().length >= 2}
            aria-controls="catalog-search-suggestions"
            aria-activedescendant={
              activeSuggestion >= 0
                ? `catalog-search-option-${activeSuggestion}`
                : undefined
            }
            onFocus={() => setSuggestionsOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSuggestionsOpen(false);
                setActiveSuggestion(-1);
              } else if (event.key === "ArrowDown" && suggestionOptions.length > 0) {
                event.preventDefault();
                setSuggestionsOpen(true);
                setActiveSuggestion((index) => (index + 1) % suggestionOptions.length);
              } else if (event.key === "ArrowUp" && suggestionOptions.length > 0) {
                event.preventDefault();
                setSuggestionsOpen(true);
                setActiveSuggestion((index) =>
                  index <= 0 ? suggestionOptions.length - 1 : index - 1,
                );
              } else if (
                event.key === "Enter" &&
                suggestionsOpen &&
                activeSuggestion >= 0 &&
                suggestionOptions[activeSuggestion]
              ) {
                event.preventDefault();
                chooseSuggestion(suggestionOptions[activeSuggestion]);
              }
            }}
          />
          {suggestionsOpen && searchQuery.trim().length >= 2 && (
            <div
              className="catalog-search-suggestions"
              id="catalog-search-suggestions"
              role="listbox"
              aria-label="Product suggestions"
            >
              {loading ? (
                <p className="catalog-search-suggestion-state" role="status">
                  Finding matching suggestions…
                </p>
              ) : suggestionOptions.length > 0 ? (
                suggestionOptions.map((suggestion, index) => (
                  <button
                    className="catalog-search-suggestion"
                    id={`catalog-search-option-${index}`}
                    type="button"
                    key={suggestion.key}
                    role="option"
                    aria-selected={index === activeSuggestion}
                    onMouseEnter={() => setActiveSuggestion(index)}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    <span className="catalog-search-suggestion-name">
                      <HighlightedSearchText
                        text={suggestion.label}
                        query={searchQuery}
                      />
                    </span>
                    <span className="catalog-search-suggestion-detail">
                      <span>
                        {suggestion.kind === "product"
                          ? "PRODUCT"
                          : suggestion.kind === "brand"
                            ? "BRAND"
                            : "CATEGORY"}
                      </span>
                      {suggestion.detail}
                    </span>
                  </button>
                ))
              ) : (
                <p className="catalog-search-suggestion-state" role="status">
                  No matching suggestions.
                </p>
              )}
            </div>
          )}
        </div>
        <label className="visually-hidden" htmlFor="catalog-sort">Sort search results</label>
        <select
          id="catalog-sort"
          className="catalog-sort-select"
          value={sort}
          disabled={!submittedQuery && !category}
          onChange={(event) => changeSort(event.target.value)}
        >
          <option value="newest">Most relevant</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
        </select>
        {searchQuery && (
          <button
            className="catalog-search-clear"
            type="button"
            onClick={clearSearch}
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
        <button className="button button-dark" type="submit" disabled={!apiUrl}>
          {loading ? "Searching…" : "Search"} <span aria-hidden="true">↗</span>
        </button>
      </form>

      <section className="catalog-results" aria-live="polite">
        {error && (
          <div className="catalog-message form-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => void loadCatalog(submittedQuery, currentCursor, sort, category)}
            >
              Try again
            </button>
          </div>
        )}
        {!error && loading && <p className="catalog-message" role="status">Finding thoughtful things…</p>}
        {!error && !loading && products.length === 0 && (
          <div className="catalog-empty">
            <span className="promise-icon" aria-hidden="true">✳</span>
            <h2>{submittedQuery ? "No products found" : "No approved listings just yet."}</h2>
            <p>{submittedQuery
              ? "Try a different product name, brand, or category."
              : "We’ll show products when a store’s listing and imagery have been reviewed. We won’t fill the shelves with unrelated or unverified images."}</p>
            {submittedQuery && (
              <button type="button" className="text-button" onClick={clearSearch}>
                Clear search
              </button>
            )}
          </div>
        )}
        {!error && !loading && products.length > 0 && (
          <>
            <div className="product-grid">
              {products.map((product) => (
                <article className="product-card" key={product.id}>
                  <Link
                    className="product-photo"
                    href={`/catalog/${encodeURIComponent(product.id)}?from=${encodeURIComponent(buildCollectionPath(submittedQuery, currentCursor, sort, category))}`}
                  >
                    <ProductImageGallery
                      images={product.images}
                      title={product.title}
                      sizes="(max-width: 650px) 100vw, (max-width: 1000px) 50vw, 33vw"
                    />
                  </Link>
                  <div className="product-card-copy">
                    <p className="product-brand">{product.brand} · {product.category.replaceAll("-", " ")}</p>
                    <h2>
                      <Link
                        href={`/catalog/${encodeURIComponent(product.id)}?from=${encodeURIComponent(buildCollectionPath(submittedQuery, currentCursor, sort, category))}`}
                      >
                        {product.title}
                      </Link>
                    </h2>
                    <p className="product-price">{new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(product.priceMinor / 100)}</p>
                  </div>
                </article>
              ))}
            </div>
            <nav className="catalog-pagination" aria-label="Catalog pages">
              <button type="button" className="text-button" onClick={showPreviousPage} disabled={loading || previousCursors.length === 0}>
                ← Previous
              </button>
              <button type="button" className="text-button" onClick={showNextPage} disabled={loading || !nextCursor}>
                More finds →
              </button>
            </nav>
          </>
        )}
      </section>

      <footer className="site-footer">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <span>Good things take time.</span>
        <span>© Morrow Market</span>
      </footer>
    </main>
  );
}

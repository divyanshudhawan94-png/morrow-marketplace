"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import MorrowHeader from "../components/MorrowHeader";
import HighlightedSearchText from "../components/HighlightedSearchText";
import ProductImageGallery, {
  type ProductGalleryImage,
} from "../components/ProductImageGallery";
import {
  createSearchSuggestions,
  type SearchSuggestion,
} from "./search-utils";

interface FeaturedProduct {
  id: string;
  title: string;
  brand: string;
  category: string;
  priceMinor: number;
  images: ProductGalleryImage[];
}

interface CatalogOptions {
  query?: string;
  category?: string;
  maxPrice?: number;
  limit?: number;
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readProducts(value: unknown): FeaturedProduct[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("The catalog returned an invalid response.");
  }

  return value.items.map((item): FeaturedProduct => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.brand !== "string" ||
      typeof item.category !== "string" ||
      item.currency !== "INR" ||
      typeof item.priceMinor !== "number" ||
      !Array.isArray(item.images)
    ) {
      throw new Error("The catalog returned an invalid product.");
    }

    const images: ProductGalleryImage[] = [];
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

    return {
      id: item.id,
      title: item.title,
      brand: item.brand,
      category: item.category,
      priceMinor: item.priceMinor,
      images,
    };
  });
}

function catalogUrl(options: CatalogOptions): string {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 12),
  });
  if (options.query) params.set("q", options.query);
  if (options.category) params.set("category", options.category);
  if (options.maxPrice !== undefined) {
    params.set("maxPrice", String(options.maxPrice));
  }
  return `${apiUrl}/catalog?${params.toString()}`;
}

async function loadProducts(options: CatalogOptions): Promise<FeaturedProduct[]> {
  if (!apiUrl) throw new Error("The catalog service is not configured.");
  const response = await fetch(catalogUrl(options), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`The catalog request failed (${response.status}).`);
  }
  return readProducts(await response.json());
}

function categoryLabel(category: string): string {
  return category
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPrice(priceMinor: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(priceMinor / 100);
}

function selectHeroProducts(products: FeaturedProduct[]): FeaturedProduct[] {
  return products
    .flatMap((product) => {
      const images = product.images.filter((image) => image.url.trim().length > 0);
      return images.length > 0 ? [{ ...product, images }] : [];
    })
    .slice(0, 3);
}

function ProductGrid({
  products,
  loading,
  emptyMessage,
  variant = "standard",
}: {
  products: FeaturedProduct[];
  loading: boolean;
  emptyMessage: string;
  variant?: "standard" | "hero";
}) {
  if (loading) {
    if (variant === "hero") {
      return (
        <p className="winter-hero-products-state" role="status">
          Finding current favourites from Morrow stores…
        </p>
      );
    }
    return <p className="catalog-message" role="status">Finding winter favourites…</p>;
  }
  if (products.length === 0) {
    if (variant === "hero") {
      return (
        <div className="winter-hero-products-empty">
          <span aria-hidden="true">✳</span>
          <p>New finds will appear here as Morrow stores add their latest pieces.</p>
        </div>
      );
    }
    return <p className="catalog-message">{emptyMessage}</p>;
  }
  return (
    <div className={`product-grid${variant === "hero" ? " winter-hero-products" : ""}`}>
      {products.map((product) => (
        <article
          className={`product-card winter-product-card${variant === "hero" ? " winter-hero-product-card" : ""}`}
          key={product.id}
        >
          <Link
            className="product-photo"
            href={`/catalog/${encodeURIComponent(product.id)}`}
            aria-label={`View ${product.title}`}
          >
            <ProductImageGallery
              images={product.images}
              title={product.title}
              showPosition={variant !== "hero"}
              sizes={variant === "hero"
                ? "(max-width: 760px) 28vw, (max-width: 1024px) 20vw, 14vw"
                : "(max-width: 650px) 50vw, (max-width: 1000px) 33vw, 25vw"}
            />
            {variant !== "hero" && (
              <span className="winter-product-arrow" aria-hidden="true">↗</span>
            )}
          </Link>
          {variant !== "hero" && (
            <div className="product-card-copy">
              <p className="product-brand">
                {product.brand} <span aria-hidden="true">·</span> {categoryLabel(product.category)}
              </p>
              <h2>
                <Link href={`/catalog/${encodeURIComponent(product.id)}`}>{product.title}</Link>
              </h2>
              <p className="product-price">{formatPrice(product.priceMinor)}</p>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [products, setProducts] = useState<FeaturedProduct[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<FeaturedProduct[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [visibleProducts, setVisibleProducts] = useState<FeaturedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [suggestionError, setSuggestionError] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [retryCount, setRetryCount] = useState(0);
  const requestSequence = useRef(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void loadProducts({ limit: 50 })
      .then((loadedProducts) => {
        if (!active) return;
        setProducts(loadedProducts);
        setVisibleProducts(loadedProducts.slice(0, 8));
        setCategories([...new Set(loadedProducts.map((product) => product.category))]);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not load products.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retryCount]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!suggestionsOpen || normalizedQuery.length < 2) {
      setSuggestions([]);
      setSuggestionError("");
      setSuggestionLoading(false);
      return;
    }
    const controller = new AbortController();
    setSuggestions([]);
    setSuggestionLoading(true);
    setSuggestionError("");
    setActiveSuggestion(-1);
    const timer = window.setTimeout(async () => {
      const requestId = ++requestSequence.current;
      try {
        const url = new URL(catalogUrl({
          query: normalizedQuery,
          category: category || undefined,
          limit: 8,
        }));
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Search suggestions could not be loaded (${response.status}).`);
        }
        const loadedSuggestions = readProducts(await response.json());
        if (requestId === requestSequence.current) {
          setSuggestions(loadedSuggestions);
          setSuggestionLoading(false);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setSuggestionError(
            cause instanceof Error ? cause.message : "Search suggestions could not be loaded.",
          );
          setSuggestionLoading(false);
        }
      }
    }, 240);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, category, suggestionsOpen]);

  async function applyFilters(options: CatalogOptions, nextCategory: string, nextQuery: string) {
    const requestId = ++requestSequence.current;
    setSearching(true);
    setError("");
    try {
      const results = await loadProducts(options);
      if (requestId !== requestSequence.current) return;
      setCategory(nextCategory);
      setQuery(nextQuery);
      setVisibleProducts(results);
      setSuggestions([]);
      setSuggestionsOpen(false);
    } catch (cause) {
      if (requestId === requestSequence.current) {
        setError(cause instanceof Error ? cause.message : "Could not find products.");
      }
    } finally {
      if (requestId === requestSequence.current) setSearching(false);
    }
  }

  function chooseSuggestion(suggestion: SearchSuggestion) {
    setActiveSuggestion(-1);
    setSuggestionsOpen(false);
    if (suggestion.productId) {
      router.push(`/catalog/${encodeURIComponent(suggestion.productId)}`);
      return;
    }
    router.push(`/catalog?q=${encodeURIComponent(suggestion.query)}`);
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuggestionsOpen(false);
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (category) params.set("category", category);
    const search = params.toString();
    router.push(search ? `/catalog?${search}` : "/catalog");
  }

  function chooseCategory(nextCategory: string) {
    const selectedCategory = nextCategory === category ? "" : nextCategory;
    void applyFilters(
      {
        query: query.trim() || undefined,
        category: selectedCategory || undefined,
        limit: 12,
      },
      selectedCategory,
      query.trim(),
    );
  }

  function choosePrice(maxPrice: number) {
    setCategory("");
    setQuery("");
    void applyFilters({ maxPrice, limit: 8 }, "", "");
    document.getElementById("winter-finds")?.scrollIntoView({ behavior: "smooth" });
  }

  function resetSearch() {
    setCategory("");
    setQuery("");
    setError("");
    setSuggestions([]);
    setVisibleProducts(products.slice(0, 8));
  }

  const featuredCategories = categories.slice(0, 6);
  const heroProducts = selectHeroProducts(products);
  const suggestionOptions = createSearchSuggestions(suggestions);
  const catalogParams = new URLSearchParams();
  if (query.trim()) catalogParams.set("q", query.trim());
  if (category) catalogParams.set("category", category);
  const catalogQuery = catalogParams.toString();
  const catalogHref = catalogQuery ? `/catalog?${catalogQuery}` : "/catalog";

  return (
    <main className="winter-storefront">
      <div className="announcement winter-announcement">
        <span aria-hidden="true">✦</span> WINTER, THOUGHTFULLY FOUND · GOOD THINGS FROM INDEPENDENT STORES <span aria-hidden="true">✦</span>
      </div>
      <MorrowHeader home />

      <section className="winter-hero" id="discover">
        <div className="winter-hero-glow" aria-hidden="true" />
        <div className="winter-hero-copy">
          <p className="winter-kicker"><span aria-hidden="true">✦</span> THE MORROW WINTER EDIT</p>
          <h1>Winter Collection<span className="winter-title-dot">.</span></h1>
          <p className="winter-hero-subtitle">Made for the season, and all the moments in it.</p>
          <p className="winter-hero-description">
            Find warm layers, seasonal essentials, considered home comforts and
            thoughtful gifts, all from independent stores.
          </p>
          <a className="winter-primary-button" href="#winter-finds">
            Explore Winter Collection <span aria-hidden="true">↘</span>
          </a>
          <div className="winter-hero-notes" aria-label="Marketplace highlights">
            <span><i aria-hidden="true">✳</i> Independent stores</span>
            <span><i aria-hidden="true">✳</i> Thoughtful finds</span>
          </div>
        </div>
        <ProductGrid
          products={heroProducts}
          loading={loading}
          emptyMessage="New finds will appear here as Morrow stores add their latest pieces."
          variant="hero"
        />
        <form className="winter-search" role="search" onSubmit={submitSearch}>
          <label className="visually-hidden" htmlFor="winter-search-input">Search products</label>
          <span className="winter-search-icon" aria-hidden="true">⌕</span>
          <input
            id="winter-search-input"
            type="search"
            value={query}
            placeholder="Search gifts, home, accessories…"
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen && query.trim().length >= 2}
            aria-controls="winter-search-suggestions"
            aria-activedescendant={
              activeSuggestion >= 0
                ? `winter-search-option-${activeSuggestion}`
                : undefined
            }
            onFocus={() => setSuggestionsOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setSuggestions([]);
              setActiveSuggestion(-1);
              setSuggestionsOpen(true);
            }}
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
          <label className="visually-hidden" htmlFor="winter-search-category">Filter by category</label>
          <select
            id="winter-search-category"
            value={category}
            onChange={(event) => chooseCategory(event.target.value)}
            aria-label="Filter products by category"
          >
            <option value="">All categories</option>
            {categories.map((entry) => (
              <option value={entry} key={entry}>{categoryLabel(entry)}</option>
            ))}
          </select>
          <button type="submit" className="winter-search-submit">Search</button>
          {suggestionsOpen && query.trim().length >= 2 && (
            <div className="winter-suggestions" id="winter-search-suggestions" role="listbox" aria-label="Product suggestions">
              {suggestionError ? (
                <p className="winter-suggestion-state" role="alert">{suggestionError}</p>
              ) : suggestionLoading ? (
                <p className="winter-suggestion-state" role="status">Finding matching suggestions…</p>
              ) : suggestionOptions.length > 0 ? (
                suggestionOptions.map((suggestion, index) => (
                  <button
                    className="winter-suggestion"
                    id={`winter-search-option-${index}`}
                    type="button"
                    key={suggestion.key}
                    role="option"
                    aria-selected={index === activeSuggestion}
                    onMouseEnter={() => setActiveSuggestion(index)}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    <span className="winter-suggestion-name">
                      <HighlightedSearchText text={suggestion.label} query={query} />
                    </span>
                    <span className="winter-suggestion-detail">
                      <span>{suggestion.kind === "product" ? "PRODUCT" : suggestion.kind === "brand" ? "BRAND" : "CATEGORY"}</span>
                      {suggestion.detail}
                    </span>
                  </button>
                ))
              ) : (
                <p className="winter-suggestion-state" role="status">No matching suggestions. Try another search.</p>
              )}
            </div>
          )}
        </form>
      </section>

      <section className="winter-category-strip" aria-label="Shop categories">
        <div className="winter-category-heading">
          <span>EXPLORE THE COLLECTION</span>
          <Link href="/catalog">View all <span aria-hidden="true">↗</span></Link>
        </div>
        <div className="winter-category-list">
          {featuredCategories.length > 0 ? featuredCategories.map((entry, index) => (
            <button
              className={`winter-category-chip${category === entry ? " is-active" : ""}`}
              type="button"
              onClick={() => chooseCategory(entry)}
              key={entry}
            >
              <span aria-hidden="true">{["✳", "✦", "◈", "✧", "❋", "✺"][index % 6]}</span>
              {categoryLabel(entry)}
            </button>
          )) : (
            <span className="winter-category-loading">{loading ? "Gathering categories…" : "Browse the collection to discover categories."}</span>
          )}
        </div>
      </section>

      <section className="winter-promos" aria-label="Winter shopping shortcuts">
        <Link className="winter-promo-card promo-gifting" href="/catalog">
          <span className="winter-promo-index">01 / THOUGHTFUL GIFTING</span>
          <span className="winter-promo-copy"><strong>Gifts to make the season warmer.</strong><i aria-hidden="true">↗</i></span>
          <span className="winter-promo-detail">Find something personal from independent stores</span>
        </Link>
        <button className="winter-promo-card promo-under" type="button" onClick={() => choosePrice(250000)}>
          <span className="winter-promo-index">02 / EVERYDAY LAYERS</span>
          <span className="winter-promo-copy"><strong>Winter favourites under ₹2,500.</strong><i aria-hidden="true">↗</i></span>
          <span className="winter-promo-detail">Browse current listings by price</span>
        </button>
        <button className="winter-promo-card promo-home" type="button" onClick={() => choosePrice(500000)}>
          <span className="winter-promo-index">03 / HOME COMFORTS</span>
          <span className="winter-promo-copy"><strong>Bring a little more warmth home.</strong><i aria-hidden="true">↗</i></span>
          <span className="winter-promo-detail">Explore current finds under ₹5,000</span>
        </button>
      </section>

      <section className="winter-products-section" id="winter-finds" aria-labelledby="winter-heading">
        <div className="winter-section-heading">
          <div>
            <p className="winter-section-kicker">MADE BY PEOPLE, FOUND BY YOU</p>
            <h2 id="winter-heading">
              {query || category ? "Your winter finds." : "A considered collection."}
            </h2>
            <p>Current prices and products, straight from approved Morrow stores.</p>
          </div>
          <div className="winter-section-actions">
            {(query || category) && (
              <button type="button" className="winter-clear-filter" onClick={resetSearch}>Clear filters ×</button>
            )}
            <Link className="winter-text-link" href={catalogHref}>Shop all products <span aria-hidden="true">↗</span></Link>
          </div>
        </div>
        {error && (
          <div className="catalog-message form-error" role="alert">
            <p>{error}</p>
            <button className="text-button" type="button" onClick={() => {
              if (query || category) {
                void applyFilters(
                  { query: query || undefined, category: category || undefined, limit: 12 },
                  category,
                  query,
                );
              } else {
                setRetryCount((count) => count + 1);
              }
            }}>Try again</button>
          </div>
        )}
        {!error && <ProductGrid
          products={visibleProducts}
          loading={loading || searching}
          emptyMessage={query || category
            ? "No products found. Try changing your search or category."
            : "No live products match just yet. Explore the full collection."}
        />}
        {!error && !searching && visibleProducts.length === 0 && (query || category) && (
          <button type="button" className="winter-clear-filter winter-no-results-action" onClick={resetSearch}>
            Change search
          </button>
        )}
      </section>

      <section className="winter-price-edit" aria-labelledby="price-edit-heading">
        <div>
          <p className="winter-section-kicker">THE WINTER PRICE EDIT</p>
          <h2 id="price-edit-heading">Find something lovely, at your pace.</h2>
          <p>Price picks use current product listings from our stores. No marked-down prices are shown unless a store has provided them.</p>
        </div>
        <div className="winter-price-buttons">
          <button type="button" onClick={() => choosePrice(250000)}>Under ₹2,500 <span aria-hidden="true">↗</span></button>
          <button type="button" onClick={() => choosePrice(500000)}>Under ₹5,000 <span aria-hidden="true">↗</span></button>
        </div>
      </section>

      <section className="winter-maker-note" id="about">
        <span className="winter-maker-spark" aria-hidden="true">✦</span>
        <div>
          <p className="winter-section-kicker">A MARKETPLACE WITH A HUMAN SIDE</p>
          <h2>Every good find starts with a good person.</h2>
        </div>
        <p>Discover independent stores and the people behind them. Thoughtful things, found together.</p>
      </section>

      <footer className="site-footer winter-footer">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <span>Good things, found in good company.</span>
        <span>© Morrow Market</span>
      </footer>
    </main>
  );
}

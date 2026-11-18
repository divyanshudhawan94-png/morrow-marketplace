"use client";

import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import MorrowHeader from "../../../components/MorrowHeader";

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

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const defaultShoeSizes = ["5", "6", "7", "8", "9", "10", "11", "12"];

function isFootwear(product: Pick<Product, "category">): boolean {
  return /shoe|footwear|sneaker|boot|sandal/i.test(product.category);
}

function shoeSizes(product: Product): string[] {
  const listedSizes = Object.entries(product.specifications).find(([name]) =>
    /^(available\s+)?(shoe\s*)?sizes?$/i.test(name.trim()),
  )?.[1];
  const parsed = listedSizes?.split(/[,;|\/]/).map((size) => size.trim()).filter(Boolean);
  return parsed?.length ? parsed : defaultShoeSizes;
}

function isLocalProductImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "localhost" &&
      url.port === "4000" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/local-product-images\/[0-9a-f-]{36}\.webp$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function ProductImageView({
  image,
  sizes,
  priority = false,
  className,
}: {
  image: Product["images"][number];
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  if (isLocalProductImageUrl(image.url)) {
    return <img className={className} src={image.url} alt={image.altText} />;
  }
  return (
    <Image
      className={className}
      src={image.url}
      alt={image.altText}
      fill
      sizes={sizes}
      priority={priority}
    />
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default function ProductDetailsPage() {
  const params = useParams<{ productId: string }>();
  const router = useRouter();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cartWorking, setCartWorking] = useState(false);
  const [cartNotice, setCartNotice] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [shoeSize, setShoeSize] = useState("");
  const [collectionPath, setCollectionPath] = useState("/catalog");
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [imageViewerZoomed, setImageViewerZoomed] = useState(false);

  useEffect(() => {
    if (!imageViewerOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setImageViewerOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [imageViewerOpen]);

  useEffect(() => {
    const source = new URLSearchParams(window.location.search).get("from");
    if (!source) return;
    try {
      const url = new URL(source, window.location.origin);
      if (url.origin === window.location.origin && url.pathname === "/catalog") {
        setCollectionPath(`${url.pathname}${url.search}`);
      }
    } catch {
      setCollectionPath("/catalog");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadProduct() {
      if (!apiUrl) {
        setError("The catalog service is not configured.");
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(
          `${apiUrl}/catalog/${encodeURIComponent(params.productId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) {
          const body: unknown = await response.json();
          const message =
            isRecord(body) && typeof body.error === "string"
              ? body.error
              : "Could not load this product.";
          throw new Error(message);
        }
        const body: unknown = await response.json();
        if (!isRecord(body) || !isRecord(body.product)) {
          throw new Error("The catalog returned an invalid product.");
        }
        const item = body.product;
        if (
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
        for (const [key, value] of Object.entries(item.specifications)) {
          if (typeof value !== "string") {
            throw new Error("The catalog returned invalid specifications.");
          }
          specifications[key] = value;
        }
        setProduct({
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
        setSelectedImageIndex(0);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not connect to the catalog service.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadProduct();
    return () => controller.abort();
  }, [params.productId]);

  async function addToCart() {
    if (!product || !apiUrl) return;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      setError("Choose a quantity between 1 and 99.");
      return;
    }
    if (quantity > product.stock) {
      setError(`Only ${product.stock} units are available.`);
      return;
    }
    if (isFootwear(product) && !shoeSize) {
      setError("Choose a shoe size before adding this item to your cart.");
      return;
    }
    setCartWorking(true);
    setError("");
    setCartNotice("");
    try {
      const currentResponse = await fetch(`${apiUrl}/cart`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!currentResponse.ok) {
        const body: unknown = await currentResponse.json();
        const message =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : "Could not load your saved cart.";
        throw new Error(message);
      }
      const body: unknown = await currentResponse.json();
      if (!isRecord(body) || !isRecord(body.cart) || !Array.isArray(body.cart.items)) {
        throw new Error("The order service returned an invalid cart.");
      }
      const cartItems: Array<{ productId: string; quantity: number; size?: string }> = [];
      for (const item of body.cart.items) {
        if (
          !isRecord(item) ||
          typeof item.productId !== "string" ||
          typeof item.quantity !== "number"
        ) {
          throw new Error("The order service returned an invalid cart item.");
        }
        if (item.size !== undefined && typeof item.size !== "string") {
          throw new Error("The order service returned an invalid cart size.");
        }
        cartItems.push({
          productId: item.productId,
          quantity: item.quantity,
          ...(item.size ? { size: item.size } : {}),
        });
      }
      const selectedSize = isFootwear(product) ? shoeSize : undefined;
      const existing = cartItems.find(
        (item) => item.productId === product.id && item.size === selectedSize,
      );
      if (existing) {
        if (existing.quantity + quantity > product.stock) {
          throw new Error(`Only ${product.stock} units are available for this size.`);
        }
        existing.quantity += quantity;
      } else {
        cartItems.push({
          productId: product.id,
          quantity,
          ...(selectedSize ? { size: selectedSize } : {}),
        });
      }
      if (cartItems.length > 6) {
        throw new Error("A local test cart can contain at most six distinct products.");
      }
      const saveResponse = await fetch(`${apiUrl}/cart`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: cartItems }),
      });
      if (!saveResponse.ok) {
        const saveBody: unknown = await saveResponse.json();
        const message =
          isRecord(saveBody) && typeof saveBody.error === "string"
            ? saveBody.error
            : "Could not save your cart.";
        throw new Error(message);
      }
      setCartNotice("Saved to your account cart.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this product to your cart.");
    } finally {
      setCartWorking(false);
    }
  }

  async function buyNow() {
    if (!product) return;
    if (quantity > product.stock) {
      setError(`Only ${product.stock} units are available.`);
      return;
    }
    if (isFootwear(product) && !shoeSize) {
      setError("Choose a shoe size before continuing to checkout.");
      return;
    }
    const params = new URLSearchParams({
      buyNow: product.id,
      quantity: String(quantity),
    });
    if (isFootwear(product)) params.set("size", shoeSize);
    const checkoutPath = `/cart?${params.toString()}`;
    if (!apiUrl) {
      setError("The account service is not configured.");
      return;
    }
    setCartWorking(true);
    setError("");
    try {
      const sessionResponse = await fetch(`${apiUrl}/auth/me`, {
        credentials: "include",
        cache: "no-store",
      });
      if (sessionResponse.status === 401) {
        router.push(`/login?next=${encodeURIComponent(checkoutPath)}`);
        return;
      }
      if (!sessionResponse.ok) {
        throw new Error("Could not check your customer session.");
      }
      router.push(checkoutPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue to checkout.");
    } finally {
      setCartWorking(false);
    }
  }

  return (
    <main className="catalog-page">
      <MorrowHeader />
      <div className="product-detail-back">
        <Link className="text-link" href={collectionPath}>← Back to the collection</Link>
      </div>
      {loading && <p className="catalog-message" role="status">Finding the details…</p>}
      {error && <p className="catalog-message form-error" role="alert">{error}</p>}
      {product && (
        <article className="product-detail">
          <div className="product-gallery">
            {product.images.length > 1 && (
              <div className="product-gallery-thumbnails" role="group" aria-label="Product images">
                {product.images.map((image, index) => (
                  <button
                    className={`product-gallery-thumbnail${selectedImageIndex === index ? " is-selected" : ""}`}
                    type="button"
                    key={`${image.url}-${index}`}
                    aria-label={`Show ${image.altText}, image ${index + 1} of ${product.images.length}`}
                    aria-pressed={selectedImageIndex === index}
                    onClick={() => setSelectedImageIndex(index)}
                  >
                    <ProductImageView image={image} sizes="72px" />
                  </button>
                ))}
              </div>
            )}
            <button
              className="product-detail-photo"
              type="button"
              onClick={() => {
                if (!product.images[selectedImageIndex]) return;
                setImageViewerZoomed(false);
                setImageViewerOpen(true);
              }}
              aria-label={product.images[selectedImageIndex]
                ? `View larger image: ${product.images[selectedImageIndex].altText}`
                : "Product image unavailable"}
              disabled={!product.images[selectedImageIndex]}
            >
              {product.images[selectedImageIndex] ? (
                <ProductImageView
                  image={product.images[selectedImageIndex]}
                  sizes="(max-width: 760px) 100vw, 50vw"
                  priority
                />
              ) : (
                <span className="image-placeholder">Image awaiting review</span>
              )}
            </button>
          </div>
          <div className="product-detail-copy">
            <p className="eyebrow">{product.brand} · {product.category.replaceAll("-", " ")}</p>
            <h1>{product.title}</h1>
            <p className="detail-price">
              {new Intl.NumberFormat("en-IN", { style: "currency", currency: product.currency }).format(product.priceMinor / 100)}
            </p>
            <p className="detail-description">{product.description}</p>
            <p className="detail-availability">
              {product.stock > 0 ? "Available from the store" : "Currently unavailable"}
            </p>
            <div className="product-purchase">
              <label className="purchase-quantity" htmlFor="product-quantity">
                Quantity
                <input
                  id="product-quantity"
                  type="number"
                  min={1}
                  max={Math.min(product.stock, 99)}
                  step={1}
                  value={quantity}
                  onChange={(event) => {
                    const parsed = Number(event.target.value);
                    setQuantity(
                      Number.isFinite(parsed)
                        ? Math.max(1, Math.min(99, Math.trunc(parsed)))
                        : 1,
                    );
                  }}
                  disabled={product.stock < 1}
                />
              </label>
              {isFootwear(product) && (
                <label className="purchase-size" htmlFor="product-shoe-size">
                  Shoe size (UK)
                  <select
                    id="product-shoe-size"
                    value={shoeSize}
                    onChange={(event) => setShoeSize(event.target.value)}
                    required
                  >
                    <option value="">Choose a size</option>
                    {shoeSizes(product).map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="detail-cart-actions">
              <button
                className="button button-dark"
                type="button"
                onClick={() => void addToCart()}
                disabled={cartWorking || product.stock < 1}
              >
                {cartWorking ? "Saving…" : "Add to Cart"} <span aria-hidden="true">↗</span>
              </button>
              <button
                className="button button-outline"
                type="button"
                onClick={buyNow}
                disabled={cartWorking || product.stock < 1}
              >
                Buy Now <span aria-hidden="true">↗</span>
              </button>
              <Link className="text-link" href="/cart">View your cart</Link>
            </div>
            {cartNotice && <p className="form-message form-notice" role="status">{cartNotice}</p>}
            {Object.keys(product.specifications).length > 0 && (
              <section className="specifications">
                <h2>Product details</h2>
                <dl>
                  {Object.entries(product.specifications).map(([name, value]) => (
                    <div key={name}><dt>{name}</dt><dd>{value}</dd></div>
                  ))}
                </dl>
              </section>
            )}
          </div>
        </article>
      )}
      {imageViewerOpen && product?.images[selectedImageIndex] && (
        <div
          className="product-image-viewer"
          role="dialog"
          aria-modal="true"
          aria-label="Product image viewer"
          onClick={() => setImageViewerOpen(false)}
        >
          <button
            className="product-image-viewer-close"
            type="button"
            onClick={() => setImageViewerOpen(false)}
            aria-label="Close image viewer"
          >
            Close
          </button>
          <button
            className={`product-image-viewer-photo${imageViewerZoomed ? " is-zoomed" : ""}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setImageViewerZoomed((zoomed) => !zoomed);
            }}
            aria-label={imageViewerZoomed ? "Zoom out" : "Zoom in"}
          >
            <ProductImageView
              image={product.images[selectedImageIndex]}
              sizes="100vw"
              className="product-image-viewer-image"
            />
          </button>
          <p>Click the image to {imageViewerZoomed ? "zoom out" : "zoom in"} · press Escape to close</p>
        </div>
      )}
      <footer className="site-footer">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <span>Good things take time.</span>
        <span>© Morrow Market</span>
      </footer>
    </main>
  );
}

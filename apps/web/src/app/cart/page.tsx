"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

interface Product {
  id: string;
  title: string;
  brand: string;
  category: string;
  currency: "INR";
  priceMinor: number;
  stock: number;
  images: Array<{ url: string; altText: string }>;
}

interface CartLine {
  productId: string;
  quantity: number;
  size?: string;
  product: Product | null;
}

interface DeliveryDetails {
  recipientName: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pinCode: string;
}

interface Order {
  id: string;
  totalMinor: number;
  currency: "INR";
  paymentResult: "NOT_CONFIGURED";
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const localDevelopmentCheckout = process.env.NODE_ENV === "development";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function errorMessage(response: Response): Promise<string> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string") return body.error;
  }
  return "The request could not be completed.";
}

function readProduct(value: unknown): Product {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.brand !== "string" ||
    typeof value.category !== "string" ||
    value.currency !== "INR" ||
    typeof value.priceMinor !== "number" ||
    typeof value.stock !== "number" ||
    !Array.isArray(value.images)
  ) {
    throw new Error("The catalog returned an invalid product.");
  }
  const images: Product["images"] = [];
  for (const image of value.images) {
    if (!isRecord(image) || typeof image.url !== "string" || typeof image.altText !== "string") {
      throw new Error("The catalog returned invalid product imagery.");
    }
    images.push({ url: image.url, altText: image.altText });
  }
  return {
    id: value.id,
    title: value.title,
    brand: value.brand,
    category: value.category,
    currency: "INR",
    priceMinor: value.priceMinor,
    stock: value.stock,
    images,
  };
}

export default function CartPage() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [checkoutStarted, setCheckoutStarted] = useState(false);
  const [directCheckout, setDirectCheckout] = useState(false);
  const [checkoutCompleted, setCheckoutCompleted] = useState(false);
  const checkoutIdempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function loadCart() {
      if (!apiUrl) {
        setError("The order service is not configured.");
        setLoading(false);
        return;
      }
      try {
        const sessionResponse = await fetch(`${apiUrl}/auth/me`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (sessionResponse.status === 401) {
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.replace(`/login?next=${encodeURIComponent(next)}`);
          return;
        }
        if (!sessionResponse.ok) {
          throw new Error(await errorMessage(sessionResponse));
        }
        const buyNowParams = new URLSearchParams(window.location.search);
        const buyNowProductId = buyNowParams.get("buyNow");
        if (buyNowProductId) {
          const quantity = Number(buyNowParams.get("quantity") ?? "1");
          const size = buyNowParams.get("size") ?? undefined;
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
            throw new Error("The requested quantity must be between 1 and 99.");
          }
          const productResponse = await fetch(
            `${apiUrl}/catalog/${encodeURIComponent(buyNowProductId)}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!productResponse.ok) throw new Error(await errorMessage(productResponse));
          const productBody: unknown = await productResponse.json();
          if (!isRecord(productBody) || !isRecord(productBody.product)) {
            throw new Error("The catalog returned an invalid product.");
          }
          const product = readProduct(productBody.product);
          if (quantity > product.stock) {
            throw new Error(`Only ${product.stock} units are available.`);
          }
          const footwear = /shoe|footwear|sneaker|boot|sandal/i.test(product.category);
          if (footwear && !size) {
            throw new Error("Choose a shoe size before continuing to checkout.");
          }
          setLines([{
            productId: product.id,
            quantity,
            ...(size ? { size } : {}),
            product,
          }]);
          setDirectCheckout(true);
          setCheckoutStarted(true);
          return;
        }
        const response = await fetch(`${apiUrl}/cart`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await errorMessage(response));
        const body: unknown = await response.json();
        if (!isRecord(body) || !isRecord(body.cart) || !Array.isArray(body.cart.items)) {
          throw new Error("The order service returned an invalid cart.");
        }
        const cartItems = body.cart.items;
        const loadedLines = await Promise.all(
          cartItems.map(async (entry): Promise<CartLine> => {
            if (
              !isRecord(entry) ||
              typeof entry.productId !== "string" ||
              typeof entry.quantity !== "number" ||
              (entry.size !== undefined && typeof entry.size !== "string")
            ) {
              throw new Error("The order service returned an invalid cart item.");
            }
            const productResponse = await fetch(
              `${apiUrl}/catalog/${encodeURIComponent(entry.productId)}`,
              { cache: "no-store", signal: controller.signal },
            );
            if (!productResponse.ok) {
              if (productResponse.status === 404) {
                return { productId: entry.productId, quantity: entry.quantity, product: null };
              }
              throw new Error(await errorMessage(productResponse));
            }
            const productBody: unknown = await productResponse.json();
            if (!isRecord(productBody) || !isRecord(productBody.product)) {
              throw new Error("The catalog returned an invalid product.");
            }
            return {
              productId: entry.productId,
              quantity: entry.quantity,
              ...(typeof entry.size === "string" ? { size: entry.size } : {}),
              product: readProduct(productBody.product),
            };
          }),
        );
        if (!controller.signal.aborted) setLines(loadedLines);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load your cart.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadCart();
    return () => controller.abort();
  }, []);

  async function saveCart(nextLines: CartLine[]) {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${apiUrl}/cart`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: nextLines.map(({ productId, quantity, size }) => ({
            productId,
            quantity,
            ...(size ? { size } : {}),
          })),
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setLines(nextLines);
      checkoutIdempotencyKey.current = null;
      if (nextLines.length === 0) setCheckoutStarted(false);
      setNotice("Your cart is saved to your account.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your cart.");
    } finally {
      setWorking(false);
    }
  }

  async function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError("");
    setNotice("");
    const formData = new FormData(event.currentTarget);
    const delivery: DeliveryDetails = {
      recipientName: String(formData.get("recipientName") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      address: String(formData.get("address") ?? ""),
      city: String(formData.get("city") ?? ""),
      state: String(formData.get("state") ?? ""),
      pinCode: String(formData.get("pinCode") ?? ""),
    };
    checkoutIdempotencyKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`${apiUrl}/checkout`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: checkoutIdempotencyKey.current,
          delivery,
          ...(directCheckout
            ? {
                items: lines.map(({ productId, quantity, size }) => ({
                  productId,
                  quantity,
                  ...(size ? { size } : {}),
                })),
              }
            : {}),
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        !isRecord(body.order) ||
        typeof body.order.id !== "string" ||
        typeof body.order.totalMinor !== "number" ||
        body.order.currency !== "INR" ||
        body.order.paymentResult !== "NOT_CONFIGURED"
      ) {
        throw new Error("The order service returned an invalid order.");
      }
      setLastOrder({
        id: body.order.id,
        totalMinor: body.order.totalMinor,
        currency: "INR",
        paymentResult: "NOT_CONFIGURED",
      });
      if (directCheckout) {
        setCheckoutCompleted(true);
      } else {
        setLines([]);
      }
      setCheckoutStarted(false);
      checkoutIdempotencyKey.current = null;
      setNotice(
        directCheckout
          ? "Local development order saved. Your account cart was not changed; payment is not configured."
          : "Local development order saved. Payment is not configured; no payment was collected.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not place your order.");
    } finally {
      setWorking(false);
    }
  }

  const totalMinor = lines.reduce(
    (total, line) =>
      total + (line.product ? line.product.priceMinor * line.quantity : 0),
    0,
  );

  return (
    <main className="catalog-page">
      <header className="catalog-header">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <div className="seller-nav">
          <Link className="text-link" href="/account/orders">Your orders ↗</Link>
          <Link className="text-link" href="/account">Your account ↗</Link>
        </div>
      </header>
      <section className="workflow-page">
        <p className="eyebrow">{directCheckout ? "CHECKOUT" : "YOUR BAG"}</p>
        <h1>{directCheckout ? "One thoughtful find." : "Thoughtful finds, together."}</h1>
        <p className="workflow-warning">
          Payment is not configured. Checkout is available only in local development and does not collect payment details.
        </p>
        {loading && <p className="catalog-message" role="status">Loading your saved cart…</p>}
        {error && <p className="form-message form-error" role="alert">{error}</p>}
        {notice && <p className="form-message form-notice" role="status">{notice}</p>}
        {lastOrder && (
          <p className="workflow-success" role="status">
            Order {lastOrder.id} saved · Payment: Not configured · no money was charged.
          </p>
        )}
        {!loading && lines.length === 0 && (
          <div className="catalog-empty">
            <p>Your cart is empty.</p>
            <Link className="button button-dark" href="/catalog">Browse the collection <span>↗</span></Link>
          </div>
        )}
        {lines.length > 0 && (
          <div className="workflow-layout">
            <section className="workflow-lines" aria-label="Cart items">
              {lines.map((line) => (
                <article className="workflow-line" key={line.productId}>
                  <div className="workflow-line-image">
                    {line.product?.images[0] && (
                      isLocalProductImageUrl(line.product.images[0].url) ? (
                        <img
                          src={line.product.images[0].url}
                          alt={line.product.images[0].altText}
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      ) : (
                        <Image
                          src={line.product.images[0].url}
                          alt={line.product.images[0].altText}
                          fill
                          sizes="120px"
                        />
                      )
                    )}
                  </div>
                  <div className="workflow-line-details">
                    <h2>{line.product?.title ?? "Unavailable product"}</h2>
                    <p>{line.product?.brand ?? "Remove this item to continue"}</p>
                    {line.product && (
                      <p>
                        {new Intl.NumberFormat("en-IN", {
                          style: "currency",
                          currency: line.product.currency,
                        }).format(line.product.priceMinor / 100)}
                      </p>
                    )}
                    {line.size && <p>Shoe size (UK): {line.size}</p>}
                    {line.product && line.quantity > line.product.stock && (
                      <p className="form-error" role="alert">
                        Only {line.product.stock} available. Reduce the quantity to continue.
                      </p>
                    )}
                    {line.product && !directCheckout && (
                      <div className="workflow-quantity" aria-label="Quantity">
                        <button
                          type="button"
                          aria-label={`Decrease quantity for ${line.product.title}`}
                          disabled={working}
                          onClick={() => {
                            if (line.quantity === 1) {
                              void saveCart(lines.filter((item) => item.productId !== line.productId));
                            } else {
                              void saveCart(lines.map((item) =>
                                item.productId === line.productId
                                  ? { ...item, quantity: item.quantity - 1 }
                                  : item,
                              ));
                            }
                          }}
                        >
                          −
                        </button>
                        <span>Qty {line.quantity}</span>
                        <button
                          type="button"
                          aria-label={`Increase quantity for ${line.product.title}`}
                          disabled={working || line.quantity >= line.product.stock || line.quantity >= 99}
                          onClick={() => void saveCart(lines.map((item) =>
                            item.productId === line.productId
                              ? { ...item, quantity: item.quantity + 1 }
                              : item,
                          ))}
                        >
                          +
                        </button>
                      </div>
                    )}
                    {!line.product && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => void saveCart(lines.filter((item) => item.productId !== line.productId))}
                        disabled={working}
                      >
                        Remove unavailable item
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {!directCheckout && <button
                className="text-button"
                type="button"
                onClick={() => void saveCart([])}
                disabled={working}
              >
                Clear cart
              </button>}
            </section>
            {checkoutCompleted && directCheckout ? (
              <aside className="workflow-checkout">
                <h2>Checkout complete</h2>
                <p>Your local development order was saved. No payment was collected, and your saved cart is unchanged.</p>
                <Link className="button button-dark" href="/catalog">Continue shopping <span aria-hidden="true">↗</span></Link>
              </aside>
            ) : !checkoutStarted ? (
              <aside className="workflow-checkout">
                <h2>Order summary</h2>
                <div className="workflow-total">
                  <span>Subtotal</span>
                  <strong>
                    {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(totalMinor / 100)}
                  </strong>
                </div>
                <p className="form-hint">Payment: Not configured. No payment will be collected.</p>
                <button
                  className="button button-dark"
                  type="button"
                  onClick={() => setCheckoutStarted(true)}
                  disabled={
                    !localDevelopmentCheckout ||
                    checkoutCompleted ||
                    lines.some((line) => !line.product || line.quantity > line.product.stock)
                  }
                >
                  Proceed to Checkout <span aria-hidden="true">↗</span>
                </button>
                {!localDevelopmentCheckout && (
                  <p className="form-hint">Checkout is disabled until a real payment provider is configured.</p>
                )}
              </aside>
            ) : (
            <form className="workflow-checkout" onSubmit={checkout}>
              <h2>Delivery details</h2>
              <button className="text-button" type="button" onClick={() => setCheckoutStarted(false)}>
                {directCheckout ? "← Back to item" : "← Back to cart"}
              </button>
              <label htmlFor="recipientName">Recipient name</label>
              <input id="recipientName" name="recipientName" autoComplete="name" required minLength={2} maxLength={100} />
              <label htmlFor="phone">Phone</label>
              <input id="phone" name="phone" type="tel" autoComplete="tel" required pattern="\+?[1-9][0-9]{9,14}" />
              <label htmlFor="address">Address</label>
              <textarea id="address" name="address" autoComplete="street-address" required minLength={5} maxLength={300} />
              <label htmlFor="city">City</label>
              <input id="city" name="city" autoComplete="address-level2" required minLength={2} maxLength={80} />
              <label htmlFor="state">State</label>
              <input id="state" name="state" autoComplete="address-level1" required minLength={2} maxLength={80} />
              <label htmlFor="pinCode">PIN code</label>
              <input id="pinCode" name="pinCode" autoComplete="postal-code" required pattern="[1-9][0-9]{5}" />
              <div className="workflow-total">
                <span>Order total</span>
                <strong>
                  {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(totalMinor / 100)}
                </strong>
              </div>
              <button className="button button-dark" type="submit" disabled={working || !localDevelopmentCheckout || lines.some((line) => !line.product || line.quantity > line.product.stock)}>
                {working ? "Saving order…" : "Place development test order"} <span aria-hidden="true">↗</span>
              </button>
              <p className="form-hint">The server rechecks stock and seller approvals. Payment is not configured; no payment is made.</p>
            </form>
            )}
          </div>
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

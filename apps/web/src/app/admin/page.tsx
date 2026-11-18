"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface AdminStore {
  id: string;
  ownerUserId: string;
  name: string;
  status: "pending" | "approved" | "rejected" | "suspended";
  createdAt: string;
}

interface AdminProduct {
  id: string;
  sellerId: string;
  storeId: string;
  title: string;
  description: string;
  brand: string;
  sku: string;
  category: string;
  currency: "INR";
  priceMinor: number;
  stock: number;
  images: Array<{ url: string; altText: string }>;
  specifications: Record<string, string>;
  status: "draft" | "rejected" | "active" | "archived";
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

interface VerificationQueueItem {
  storeId: string;
  status: "PENDING_REVIEW";
  updatedAt?: string;
}

interface AdminVerification {
  store: { id: string; name: string; status: string };
  status: string;
  business: {
    legalName: string;
    tradeName: string;
    businessType: string;
    gstRegistration: string;
    gstin: string | null;
    pan: string;
    address: string;
    state: string;
    city: string;
    pinCode: string;
  };
  documents: Array<{
    id: string;
    kind: "BUSINESS_PROOF" | "GST_CERTIFICATE";
    contentType: string;
    createdAt: string;
  }>;
  history: Array<{
    status: string;
    actorUserId: string;
    reason?: string;
    createdAt: string;
  }>;
  providerStatus: "NOT_CONFIGURED" | "CONFIGURED";
}

type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED";

const orderStatuses: readonly OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
];

function isOrderStatus(value: unknown): value is OrderStatus {
  return orderStatuses.some((status) => status === value);
}

function formatOrderStatus(status: OrderStatus): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatReturnStatus(status: AdminOrder["returns"][number]["status"]): string {
  return status.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface AdminOrder {
  id: string;
  customerId: string;
  createdAt: string;
  totalMinor: number;
  status: OrderStatus;
  items: Array<{ id: string; title: string; quantity: number }>;
  returns: Array<{
    id: string;
    orderItemId: string;
    productId: string;
    customerId: string;
    reason: string;
    status: "REQUESTED" | "ACCEPTED" | "REJECTED";
    refundStatus: "NOT_APPLICABLE" | "LOCAL_SIMULATED_NOT_PROCESSED";
    images: Array<{ id: string; url: string; createdAt: string }>;
    sellerResponseDeadlineAt?: string;
    sellerReviewStatus: "PENDING" | "ACCEPTED" | "FORWARDED" | "REJECTED" | "SYSTEM_AUTO_ACCEPTED";
    decisionSource?: "SELLER" | "SYSTEM_AUTO_ACCEPTED";
    sellerRecommendation?: "ACCEPTED" | "REJECTED";
    sellerReviewReason?: string;
    sellerReviewedAt?: string;
  }>;
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

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

function readPage<T>(
  value: unknown,
  readItem: (item: unknown) => T,
): Page<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("The moderation service returned an invalid response.");
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== "string") {
    throw new Error("The moderation service returned an invalid cursor.");
  }
  return {
    items: value.items.map(readItem),
    nextCursor: value.nextCursor,
  };
}

function readStore(value: unknown): AdminStore {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.ownerUserId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    (value.status !== "pending" &&
      value.status !== "approved" &&
      value.status !== "rejected" &&
      value.status !== "suspended")
  ) {
    throw new Error("The moderation service returned an invalid store.");
  }
  return {
    id: value.id,
    ownerUserId: value.ownerUserId,
    name: value.name,
    status: value.status,
    createdAt: value.createdAt,
  };
}

function readProduct(value: unknown): AdminProduct {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.sellerId !== "string" ||
    typeof value.storeId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    typeof value.brand !== "string" ||
    typeof value.sku !== "string" ||
    typeof value.category !== "string" ||
    value.currency !== "INR" ||
    typeof value.priceMinor !== "number" ||
    typeof value.stock !== "number" ||
    !Array.isArray(value.images) ||
    !isRecord(value.specifications)
  ) {
    throw new Error("The moderation service returned an invalid product.");
  }
  const images: AdminProduct["images"] = [];
  for (const image of value.images) {
    if (
      !isRecord(image) ||
      typeof image.url !== "string" ||
      typeof image.altText !== "string"
    ) {
      throw new Error("The moderation service returned invalid imagery.");
    }
    images.push({ url: image.url, altText: image.altText });
  }
  const specifications: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.specifications)) {
    if (typeof entry !== "string") {
      throw new Error("The moderation service returned invalid specifications.");
    }
    specifications[key] = entry;
  }
  return {
    id: value.id,
    sellerId: value.sellerId,
    storeId: value.storeId,
    title: value.title,
    description: value.description,
    brand: value.brand,
    sku: value.sku,
    category: value.category,
    currency: "INR",
    priceMinor: value.priceMinor,
    stock: value.stock,
    images,
    specifications,
    status:
      value.status === "active" || value.status === "archived" || value.status === "rejected"
        ? value.status
        : "draft",
  };
}

async function apiError(response: Response): Promise<string> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const value: unknown = await response.json();
    if (isRecord(value) && typeof value.error === "string") return value.error;
  }
  return "The request could not be completed.";
}

async function loadPage<T>(
  path: string,
  cursor: string | null,
  readItem: (item: unknown) => T,
): Promise<Page<T>> {
  const params = new URLSearchParams({ limit: "20" });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${apiUrl}${path}?${params.toString()}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await apiError(response));
  return readPage(await response.json(), readItem);
}

export default function AdminDashboardPage() {
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);
  const [stores, setStores] = useState<AdminStore[]>([]);
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [verifications, setVerifications] = useState<VerificationQueueItem[]>([]);
  const [selectedVerification, setSelectedVerification] = useState<AdminVerification | null>(null);
  const [verificationCursor, setVerificationCursor] = useState<string | null>(null);
  const [loadingVerifications, setLoadingVerifications] = useState(false);
  const [storeCursor, setStoreCursor] = useState<string | null>(null);
  const [productCursor, setProductCursor] = useState<string | null>(null);
  const [loadingStores, setLoadingStores] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [adminOrders, setAdminOrders] = useState<AdminOrder[]>([]);
  const [workingId, setWorkingId] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fetchStores = useCallback(async (cursor: string | null, append: boolean) => {
    setLoadingStores(true);
    try {
      const page = await loadPage("/admin/stores/pending", cursor, readStore);
      setStores((current) => append ? [...current, ...page.items] : page.items);
      setStoreCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load store applications.");
    } finally {
      setLoadingStores(false);
    }
  }, []);

  const fetchProducts = useCallback(async (cursor: string | null, append: boolean) => {
    setLoadingProducts(true);
    try {
      const page = await loadPage("/admin/products/pending", cursor, readProduct);
      setProducts((current) => append ? [...current, ...page.items] : page.items);
      setProductCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load product drafts.");
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  const fetchVerifications = useCallback(async (cursor: string | null, append: boolean) => {
    setLoadingVerifications(true);
    try {
      const page = await loadPage(
        "/admin/seller-verifications/pending",
        cursor,
        (value) => {
          if (
            !isRecord(value) ||
            typeof value.storeId !== "string" ||
            value.status !== "PENDING_REVIEW"
          ) {
            throw new Error("The verification service returned an invalid queue item.");
          }
          return {
            storeId: value.storeId,
            status: "PENDING_REVIEW" as const,
            ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
          };
        },
      );
      setVerifications((current) => append ? [...current, ...page.items] : page.items);
      setVerificationCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load seller verifications.");
    } finally {
      setLoadingVerifications(false);
    }
  }, []);

  const fetchAdminOrders = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/admin/orders`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await apiError(response));
      const value: unknown = await response.json();
      if (
        !isRecord(value) ||
        !Array.isArray(value.orders) ||
        typeof value.returnTestingEnabled !== "boolean"
      ) {
        throw new Error("The order service returned an invalid admin response.");
      }
      const orders = value.orders.map((entry): AdminOrder => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          typeof entry.customerId !== "string" ||
          typeof entry.createdAt !== "string" ||
          typeof entry.totalMinor !== "number" ||
          !isOrderStatus(entry.status) ||
          !Array.isArray(entry.items) ||
          !Array.isArray(entry.returns)
        ) {
          throw new Error("The order service returned invalid order details.");
        }
        return {
          id: entry.id,
          customerId: entry.customerId,
          createdAt: entry.createdAt,
          totalMinor: entry.totalMinor,
          status: entry.status,
          items: entry.items.map((item) => {
            if (
              !isRecord(item) ||
              typeof item.id !== "string" ||
              typeof item.title !== "string" ||
              typeof item.quantity !== "number"
            ) {
              throw new Error("The local order service returned an invalid item.");
            }
            return { id: item.id, title: item.title, quantity: item.quantity };
          }),
          returns: entry.returns.map((returnValue) => {
            if (
              !isRecord(returnValue) ||
              typeof returnValue.id !== "string" ||
              typeof returnValue.orderItemId !== "string" ||
              typeof returnValue.productId !== "string" ||
              typeof returnValue.customerId !== "string" ||
              typeof returnValue.reason !== "string" ||
              (returnValue.status !== "REQUESTED" &&
                returnValue.status !== "ACCEPTED" &&
                returnValue.status !== "REJECTED") ||
              (returnValue.refundStatus !== "NOT_APPLICABLE" &&
                returnValue.refundStatus !== "LOCAL_SIMULATED_NOT_PROCESSED") ||
              (returnValue.sellerReviewStatus !== "PENDING" &&
                returnValue.sellerReviewStatus !== "ACCEPTED" &&
                returnValue.sellerReviewStatus !== "FORWARDED" &&
                returnValue.sellerReviewStatus !== "REJECTED" &&
                returnValue.sellerReviewStatus !== "SYSTEM_AUTO_ACCEPTED") ||
              !Array.isArray(returnValue.images)
            ) {
              throw new Error("The local order service returned an invalid return request.");
            }
            const images = returnValue.images.map((image) => {
              if (
                !isRecord(image) ||
                typeof image.id !== "string" ||
                typeof image.url !== "string" ||
                typeof image.createdAt !== "string"
              ) {
                throw new Error("The order service returned an invalid damage photo.");
              }
              return { id: image.id, url: image.url, createdAt: image.createdAt };
            });
            return {
              id: returnValue.id,
              orderItemId: returnValue.orderItemId,
              productId: returnValue.productId,
              customerId: returnValue.customerId,
              reason: returnValue.reason,
              status: returnValue.status,
              refundStatus: returnValue.refundStatus,
              images,
              sellerReviewStatus: returnValue.sellerReviewStatus,
              ...(typeof returnValue.sellerResponseDeadlineAt === "string"
                ? { sellerResponseDeadlineAt: returnValue.sellerResponseDeadlineAt }
                : {}),
              ...(returnValue.decisionSource === "SELLER" ||
              returnValue.decisionSource === "SYSTEM_AUTO_ACCEPTED"
                ? { decisionSource: returnValue.decisionSource }
                : {}),
              ...(returnValue.sellerRecommendation === "ACCEPTED" ||
              returnValue.sellerRecommendation === "REJECTED"
                ? { sellerRecommendation: returnValue.sellerRecommendation }
                : {}),
              ...(typeof returnValue.sellerReviewReason === "string"
                ? { sellerReviewReason: returnValue.sellerReviewReason }
                : {}),
              ...(typeof returnValue.sellerReviewedAt === "string"
                ? { sellerReviewedAt: returnValue.sellerReviewedAt }
                : {}),
            };
          }),
        };
      });
      setAdminOrders(orders);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load orders.");
      throw cause;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function checkAccess() {
      if (!apiUrl) {
        setError("The account service is not configured.");
        setChecking(false);
        return;
      }
      try {
        const response = await fetch(`${apiUrl}/auth/me`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          if (response.status !== 401) throw new Error(await apiError(response));
          return;
        }
        const body: unknown = await response.json();
        if (
          !isRecord(body) ||
          !isRecord(body.user) ||
          !Array.isArray(body.user.roles)
        ) {
          throw new Error("The account service returned an invalid response.");
        }
        if (!body.user.roles.includes("super_admin")) {
          setError("This account is not authorized to access administration.");
          return;
        }
        if (!cancelled) {
          setAuthorized(true);
          await Promise.all([
            fetchStores(null, false),
            fetchProducts(null, false),
            fetchVerifications(null, false),
            fetchAdminOrders(),
          ]);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not check admin access.");
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    void checkAccess();
    return () => { cancelled = true; };
  }, [fetchAdminOrders, fetchProducts, fetchStores, fetchVerifications]);

  async function openVerification(storeId: string) {
    setWorkingId(storeId);
    setError("");
    try {
      const response = await fetch(
        `${apiUrl}/admin/seller-verifications/${encodeURIComponent(storeId)}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) throw new Error(await apiError(response));
      const value: unknown = await response.json();
      if (
        !isRecord(value) ||
        !isRecord(value.store) ||
        !isRecord(value.business) ||
        !Array.isArray(value.documents) ||
        !Array.isArray(value.history) ||
        (value.providerStatus !== "NOT_CONFIGURED" &&
          value.providerStatus !== "CONFIGURED")
      ) {
        throw new Error("The verification service returned invalid review details.");
      }
      const business = value.business;
      if (
        typeof value.store.id !== "string" ||
        typeof value.store.name !== "string" ||
        typeof value.store.status !== "string" ||
        typeof value.status !== "string" ||
        typeof business.legalName !== "string" ||
        typeof business.tradeName !== "string" ||
        typeof business.businessType !== "string" ||
        typeof business.gstRegistration !== "string" ||
        !(typeof business.gstin === "string" || business.gstin === null) ||
        typeof business.pan !== "string" ||
        typeof business.address !== "string" ||
        typeof business.state !== "string" ||
        typeof business.city !== "string" ||
        typeof business.pinCode !== "string"
      ) {
        throw new Error("The verification service returned invalid business details.");
      }
      const documents = value.documents.map((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== "string" ||
          (entry.kind !== "BUSINESS_PROOF" && entry.kind !== "GST_CERTIFICATE") ||
          typeof entry.contentType !== "string" ||
          typeof entry.createdAt !== "string"
        ) {
          throw new Error("The verification service returned invalid document details.");
        }
        return {
          id: entry.id,
          kind: entry.kind === "BUSINESS_PROOF"
            ? "BUSINESS_PROOF" as const
            : "GST_CERTIFICATE" as const,
          contentType: entry.contentType,
          createdAt: entry.createdAt,
        };
      });
      const history = value.history.map((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.status !== "string" ||
          typeof entry.actorUserId !== "string" ||
          typeof entry.createdAt !== "string" ||
          (entry.reason !== undefined && typeof entry.reason !== "string")
        ) {
          throw new Error("The verification service returned invalid audit history.");
        }
        return {
          status: entry.status,
          actorUserId: entry.actorUserId,
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
          createdAt: entry.createdAt,
        };
      });
      setSelectedVerification({
        store: { id: value.store.id, name: value.store.name, status: value.store.status },
        status: value.status,
        business: {
          legalName: business.legalName,
          tradeName: business.tradeName,
          businessType: business.businessType,
          gstRegistration: business.gstRegistration,
          gstin: business.gstin,
          pan: business.pan,
          address: business.address,
          state: business.state,
          city: business.city,
          pinCode: business.pinCode,
        },
        documents,
        history,
        providerStatus: value.providerStatus,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load private verification details.");
    } finally {
      setWorkingId("");
    }
  }

  async function reviewVerification(
    storeId: string,
    status: "APPROVED" | "NEEDS_CORRECTION" | "REJECTED",
  ) {
    const reason = reasons[storeId]?.trim() ?? "";
    if (status !== "APPROVED" && reason.length < 5) {
      setError("Enter a review reason of at least five characters.");
      return;
    }
    setWorkingId(storeId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `${apiUrl}/admin/seller-verifications/${encodeURIComponent(storeId)}/review`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            ...(status !== "APPROVED" ? { reason } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await apiError(response));
      setSelectedVerification(null);
      setNotice(`Business verification marked ${status.replaceAll("_", " ").toLowerCase()}.`);
      await fetchVerifications(null, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Verification review failed.");
    } finally {
      setWorkingId("");
    }
  }

  async function moderate(
    type: "stores" | "products",
    id: string,
    decision: "approve" | "reject",
  ) {
    const reason = reasons[id]?.trim() ?? "";
    if (decision === "reject" && reason.length < 5) {
      setError("Enter a rejection reason of at least five characters.");
      return;
    }

    setWorkingId(id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `${apiUrl}/admin/${type}/${encodeURIComponent(id)}/${decision}`,
        {
          method: "POST",
          credentials: "include",
          ...(decision === "reject"
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason }),
              }
            : {}),
        },
      );
      if (!response.ok) throw new Error(await apiError(response));
      setNotice(
        `${type === "stores" ? "Store" : "Product"} ${decision === "approve" ? "approved" : "rejected"}.`,
      );
      if (type === "stores") await fetchStores(null, false);
      else await fetchProducts(null, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Moderation action failed.");
    } finally {
      setWorkingId("");
    }
  }

  return (
    <main className="admin-page">
      <header className="account-header">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <div className="seller-nav">
          <Link className="text-link" href="/account">Account ↗</Link>
          <Link className="button button-dark dashboard-home-link" href="/">Home</Link>
        </div>
      </header>
      <section className="seller-intro">
        <p className="eyebrow">PLATFORM ADMINISTRATION</p>
        <h1>Review the marketplace.</h1>
        <p>Administrative routes enforce your server-side role. Product approval publishes a listing; inspect its actual imagery and details before approving.</p>
      </section>
      <section className="admin-content">
        {checking && <p className="catalog-message" role="status">Checking administrator access…</p>}
        {!checking && !authorized && (
          <div className="catalog-empty">
            <h2>Administrator access is required.</h2>
            <p>Sign in with an account provisioned by the platform operator.</p>
            <Link className="text-link" href="/account">Go to account ↗</Link>
          </div>
        )}
        {authorized && (
          <>
            <section className="admin-queue" aria-labelledby="verification-queue-title">
              <div className="admin-section-heading">
                <div><p className="eyebrow">PRIVATE SELLER REVIEW</p><h2 id="verification-queue-title">Business verification</h2></div>
                <span>{verifications.length} pending</span>
              </div>
              <p className="form-hint">PAN, GSTIN, address, and documents are private. All checks in this queue are manual; government API verification is NOT CONFIGURED.</p>
              {verifications.length === 0 ? (
                <p className="account-description">No business verifications are waiting for review.</p>
              ) : (
                <div className="admin-store-list">
                  {verifications.map((item) => (
                    <article className="admin-store-row verification-queue-row" key={item.storeId}>
                      <div>
                        <h3>Store {item.storeId}</h3>
                        <p>Submitted business information and private documents</p>
                        {item.updatedAt && <small>Submitted {new Date(item.updatedAt).toLocaleString()}</small>}
                      </div>
                      <div className="admin-actions">
                        <button
                          className="button button-dark"
                          type="button"
                          onClick={() => void openVerification(item.storeId)}
                          disabled={workingId === item.storeId}
                        >
                          {workingId === item.storeId ? "Loading…" : "Review private details"}
                        </button>
                      </div>
                      {selectedVerification?.store.id === item.storeId && (
                        <div className="verification-review-details">
                          <h3>{selectedVerification.store.name}</h3>
                          <p>Manual checks only · Government API: {selectedVerification.providerStatus}</p>
                          <dl className="admin-spec-list verification-detail-list">
                            <div><dt>Legal name</dt><dd>{selectedVerification.business.legalName}</dd></div>
                            <div><dt>Trade name</dt><dd>{selectedVerification.business.tradeName}</dd></div>
                            <div><dt>Business type</dt><dd>{selectedVerification.business.businessType}</dd></div>
                            <div><dt>PAN</dt><dd>{selectedVerification.business.pan}</dd></div>
                            <div><dt>GST registration</dt><dd>{selectedVerification.business.gstRegistration === "REGISTERED" ? "Registered" : "Seller states registration is not required"}</dd></div>
                            {selectedVerification.business.gstin && <div><dt>GSTIN</dt><dd>{selectedVerification.business.gstin}</dd></div>}
                            <div><dt>Address</dt><dd>{selectedVerification.business.address}, {selectedVerification.business.city}, {selectedVerification.business.state} {selectedVerification.business.pinCode}</dd></div>
                          </dl>
                          <h4>Private documents</h4>
                          <ul className="verification-document-list">
                            {selectedVerification.documents.map((document) => (
                              <li key={document.id}>
                                <a
                                  href={`${apiUrl}/admin/seller-verifications/${encodeURIComponent(item.storeId)}/documents/${encodeURIComponent(document.id)}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {document.kind === "BUSINESS_PROOF" ? "Business proof" : "GST certificate"} · authenticated download
                                </a>
                              </li>
                            ))}
                          </ul>
                          <h4>Review history</h4>
                          <ol className="verification-history">
                            {selectedVerification.history.map((entry, index) => (
                              <li key={`${entry.createdAt}-${index}`}>
                                {entry.status.replaceAll("_", " ")} · {new Date(entry.createdAt).toLocaleString()}
                                {entry.reason && <span> — {entry.reason}</span>}
                              </li>
                            ))}
                          </ol>
                          <div className="admin-actions verification-review-actions">
                            <input
                              aria-label={`Correction or rejection reason for ${selectedVerification.store.name}`}
                              value={reasons[item.storeId] ?? ""}
                              onChange={(event) => setReasons({ ...reasons, [item.storeId]: event.target.value })}
                              placeholder="Reason required for correction or rejection"
                              minLength={5}
                              maxLength={500}
                            />
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => void reviewVerification(item.storeId, "NEEDS_CORRECTION")}
                              disabled={workingId === item.storeId}
                            >
                              Request correction
                            </button>
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => void reviewVerification(item.storeId, "REJECTED")}
                              disabled={workingId === item.storeId}
                            >
                              Reject verification
                            </button>
                            <button
                              className="button button-dark"
                              type="button"
                              onClick={() => void reviewVerification(item.storeId, "APPROVED")}
                              disabled={workingId === item.storeId}
                            >
                              Approve verification
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
              {verificationCursor && <button className="text-button" type="button" onClick={() => void fetchVerifications(verificationCursor, true)} disabled={loadingVerifications}>{loadingVerifications ? "Loading…" : "Load more verifications"}</button>}
            </section>

            <section className="admin-queue" aria-labelledby="store-queue-title">
              <div className="admin-section-heading">
                <div><p className="eyebrow">SELLER ONBOARDING</p><h2 id="store-queue-title">Store applications</h2></div>
                <span>{stores.length} loaded</span>
              </div>
              {stores.length === 0 ? <p className="account-description">No pending store applications.</p> : (
                <div className="admin-store-list">
                  {stores.map((store) => (
                    <article className="admin-store-row" key={store.id}>
                      <div><h3>{store.name}</h3><p>Owner account: {store.ownerUserId}</p><small>Applied {new Date(store.createdAt).toLocaleDateString()}</small></div>
                      <div className="admin-actions">
                        <button className="button button-dark" type="button" onClick={() => void moderate("stores", store.id, "approve")} disabled={workingId === store.id}>Approve store</button>
                        <small>Business verification must be approved first.</small>
                        <input
                          aria-label={`Rejection reason for ${store.name}`}
                          value={reasons[store.id] ?? ""}
                          onChange={(event) => setReasons({ ...reasons, [store.id]: event.target.value })}
                          placeholder="Reason required to reject"
                          maxLength={500}
                        />
                        <button className="text-button" type="button" onClick={() => void moderate("stores", store.id, "reject")} disabled={workingId === store.id}>Reject</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {storeCursor && <button className="text-button" type="button" onClick={() => void fetchStores(storeCursor, true)} disabled={loadingStores}>{loadingStores ? "Loading…" : "Load more store applications"}</button>}
            </section>

            <section className="admin-queue" aria-labelledby="product-queue-title">
              <div className="admin-section-heading">
                <div><p className="eyebrow">CATALOG MODERATION</p><h2 id="product-queue-title">Product drafts</h2></div>
                <span>{products.length} loaded</span>
              </div>
              {products.length === 0 ? <p className="account-description">No pending product drafts.</p> : (
                <div className="admin-product-list">
                  {products.map((product) => (
                    <article className="admin-product-row" key={product.id}>
                      <div
                        className="admin-product-images"
                        aria-label={`Product images; ${product.images.length} submitted`}
                      >
                        {product.images.length === 0 ? <span className="image-placeholder">No product image submitted</span> : product.images.map((image, index) => (
                          <a
                            href={image.url}
                            target="_blank"
                            rel="noreferrer"
                            key={image.url}
                            title={index === 0 ? "Primary product image — open full image" : "Open full image"}
                          >
                            {isLocalProductImageUrl(image.url) ? (
                              <img
                                src={image.url}
                                alt={image.altText}
                                style={{ width: "100%", height: "100%", objectFit: "contain" }}
                              />
                            ) : (
                              <Image src={image.url} alt={image.altText} fill sizes="180px" />
                            )}
                          </a>
                        ))}
                      </div>
                      <div className="admin-product-info">
                        <p className="product-brand">{product.brand} · {product.category.replaceAll("-", " ")} · {product.sku}</p>
                        <h3>{product.title}</h3>
                        <p>{product.description}</p>
                        <p className="seller-product-meta">
                          {product.storeId} · {new Intl.NumberFormat("en-IN", { style: "currency", currency: product.currency }).format(product.priceMinor / 100)} · {product.stock} in stock
                        </p>
                        {Object.keys(product.specifications).length > 0 && (
                          <dl className="admin-spec-list">
                            {Object.entries(product.specifications).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                          </dl>
                        )}
                      </div>
                      <div className="admin-actions admin-product-moderation">
                        <button className="button button-dark" type="button" onClick={() => void moderate("products", product.id, "approve")} disabled={workingId === product.id || product.images.length === 0}>Approve after image review</button>
                        <input
                          aria-label={`Rejection reason for ${product.title}`}
                          value={reasons[product.id] ?? ""}
                          onChange={(event) => setReasons({ ...reasons, [product.id]: event.target.value })}
                          placeholder="Reason required to reject"
                          maxLength={500}
                        />
                        <button className="text-button" type="button" onClick={() => void moderate("products", product.id, "reject")} disabled={workingId === product.id}>Reject draft</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {productCursor && <button className="text-button" type="button" onClick={() => void fetchProducts(productCursor, true)} disabled={loadingProducts}>{loadingProducts ? "Loading…" : "Load more product drafts"}</button>}
            </section>

            <section className="admin-queue" aria-labelledby="orders-title">
                <div className="admin-section-heading">
                  <div>
                    <p className="eyebrow">ORDER MANAGEMENT</p>
                    <h2 id="orders-title">Orders</h2>
                  </div>
                  <span>{adminOrders.length} orders</span>
                </div>
                <p className="form-hint">Order and item delivery statuses are managed by each seller.</p>
                {adminOrders.length === 0 ? (
                  <p className="account-description">No orders have been placed.</p>
                ) : (
                  <div className="admin-store-list">
                    {adminOrders.map((order) => (
                      <article className="admin-store-row local-order-row" key={order.id}>
                        <div>
                          <h3>Order {order.id}</h3>
                          <p>Customer {order.customerId} · {new Date(order.createdAt).toLocaleString()}</p>
                          <p>
                            {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(order.totalMinor / 100)}
                            {" · Status: "}{formatOrderStatus(order.status)}
                          </p>
                          <ul>
                            {order.items.map((item) => (
                              <li key={item.id}>{item.title} · quantity {item.quantity}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="admin-actions">
                          {order.returns.map((returnRequest) => (
                            <div
                              className="local-return-review"
                              key={returnRequest.id}
                            >
                              <strong>Return {formatReturnStatus(returnRequest.status)}</strong>
                              <small>Customer reason: {returnRequest.reason}</small>
                              <small>Product: {order.items.find((item) => item.id === returnRequest.orderItemId)?.title ?? "Order item"}</small>
                              {returnRequest.sellerResponseDeadlineAt && (
                                <small>
                                  Seller response deadline:{" "}
                                  {new Date(returnRequest.sellerResponseDeadlineAt).toLocaleString()}
                                </small>
                              )}
                              {returnRequest.sellerReviewReason && (
                                <small>Seller rejection reason: {returnRequest.sellerReviewReason}</small>
                              )}
                              {returnRequest.sellerReviewedAt && (
                                <small>
                                  Decision recorded: {new Date(returnRequest.sellerReviewedAt).toLocaleString()}
                                  {returnRequest.decisionSource === "SYSTEM_AUTO_ACCEPTED" ||
                                  returnRequest.sellerReviewStatus === "SYSTEM_AUTO_ACCEPTED"
                                    ? " · SYSTEM_AUTO_ACCEPTED"
                                    : ""}
                                </small>
                              )}
                              <small>Monitoring only: return decisions are handled by the product’s seller.</small>
                              {returnRequest.images.map((image) => (
                                <a
                                  href={`${apiUrl}${image.url}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  key={image.id}
                                >
                                  <img
                                    src={`${apiUrl}${image.url}`}
                                    alt="Customer-provided product damage"
                                    crossOrigin="use-credentials"
                                    width={120}
                                    height={90}
                                  />
                                </a>
                              ))}
                              <small>
                                Refund status: not processed.
                              </small>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
            </section>
          </>
        )}
        {error && <p className="form-message form-error" role="alert">{error}</p>}
        {notice && <p className="form-message form-notice" role="status">{notice}</p>}
      </section>
    </main>
  );
}

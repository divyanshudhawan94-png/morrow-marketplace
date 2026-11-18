"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

interface ReturnRequest {
  id: string;
  orderItemId: string;
  updatedAt?: string;
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
}

interface OrderItem {
  id: string;
  productId: string;
  title: string;
  brand: string;
  imageUrl: string | null;
  quantity: number;
  size?: string;
  sellerStatus: OrderStatus;
  sellerStatusHistory?: Array<{ status: OrderStatus; updatedAt: string }>;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

interface CustomerOrder {
  id: string;
  createdAt: string;
  totalMinor: number;
  currency: "INR";
  status: OrderStatus;
  paymentResult: "NOT_CONFIGURED" | "LOCAL_SIMULATED_SUCCESS";
  deliveryStatus: "NOT_DELIVERED" | "LOCAL_TEST_DELIVERED";
  delivery: {
    recipientName: string;
    phone: string;
    address: string;
    city: string;
    state: string;
    pinCode: string;
  };
  items: OrderItem[];
  returns: ReturnRequest[];
}

interface ReturnFeedback {
  error?: string;
  success?: string;
}

interface SelectedReturnPhoto {
  id: string;
  file: File;
  previewUrl: string;
}

type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED";

const MAX_RETURN_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_RETURN_PHOTO_PIXELS = 40_000_000;

function getReturnPhotoFormat(bytes: Uint8Array): "jpeg" | "png" | "webp" | "avif" | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  if (
    bytes.length >= 16 &&
    String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp"
  ) {
    const brands = String.fromCharCode(...bytes.subarray(8, 64));
    if (brands.includes("avif") || brands.includes("avis")) return "avif";
  }
  return undefined;
}

async function prepareReturnPhoto(file: File): Promise<File> {
  const format = getReturnPhotoFormat(
    new Uint8Array(await file.slice(0, 64).arrayBuffer()),
  );
  if (format === "jpeg" || format === "png" || format === "webp") return file;
  if (format !== "avif") {
    throw new Error("Unsupported photo format. Choose a JPEG, PNG, or WebP image.");
  }
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot convert AVIF photos. Choose a JPEG, PNG, or WebP image.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This AVIF photo could not be converted. Choose a JPEG, PNG, or WebP image.");
  }
  try {
    if (
      bitmap.width > 8000 ||
      bitmap.height > 8000 ||
      bitmap.width * bitmap.height > MAX_RETURN_PHOTO_PIXELS
    ) {
      throw new Error("Photo dimensions must not exceed 8,000 pixels or 40 megapixels.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the AVIF photo.");
    context.drawImage(bitmap, 0, 0);
    const jpeg = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("This browser could not convert the AVIF photo.")),
        "image/jpeg",
        0.88,
      );
    });
    if (jpeg.size > MAX_RETURN_PHOTO_BYTES) {
      throw new Error("The converted photo exceeds the 5 MB limit.");
    }
    const name = file.name.replace(/\.[^.]+$/, "") || "return-photo";
    return new File([jpeg], `${name}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

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
  return status.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatReturnStatus(status: ReturnRequest["status"]): string {
  return status.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const trackingSteps: Array<{ status: OrderStatus; label: string }> = [
  { status: "PENDING", label: "Order Placed" },
  { status: "CONFIRMED", label: "Confirmed" },
  { status: "SHIPPED", label: "Shipped" },
  { status: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { status: "DELIVERED", label: "Delivered" },
];
const trackingProgress = trackingSteps.map((step) => step.status);

function getTrackingProgress(item: OrderItem): number {
  if (item.sellerStatus !== "CANCELLED") {
    return trackingProgress.indexOf(item.sellerStatus);
  }
  const previousStatus = [...(item.sellerStatusHistory ?? [])]
    .reverse()
    .find((entry) => entry.status !== "CANCELLED" && trackingProgress.includes(entry.status))
    ?.status;
  return previousStatus ? trackingProgress.indexOf(previousStatus) : 0;
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

async function errorMessage(response: Response): Promise<string> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string") return body.error;
  }
  return "The request could not be completed.";
}

function readOrder(value: unknown): CustomerOrder {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.totalMinor !== "number" ||
    value.currency !== "INR" ||
    !isOrderStatus(value.status) ||
    (value.paymentResult !== "NOT_CONFIGURED" &&
      value.paymentResult !== "LOCAL_SIMULATED_SUCCESS") ||
    (value.deliveryStatus !== "NOT_DELIVERED" &&
      value.deliveryStatus !== "LOCAL_TEST_DELIVERED") ||
    !isRecord(value.delivery) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.returns)
  ) {
    throw new Error("The order service returned an invalid order.");
  }
  const orderStatus = value.status;
  const delivery = value.delivery;
  for (const field of ["recipientName", "phone", "address", "city", "state", "pinCode"]) {
    if (typeof delivery[field] !== "string") {
      throw new Error("The order service returned invalid delivery details.");
    }
  }
  const items = value.items.map((entry): OrderItem => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.productId !== "string" ||
      typeof entry.title !== "string" ||
      typeof entry.brand !== "string" ||
      !(typeof entry.imageUrl === "string" || entry.imageUrl === null) ||
      typeof entry.quantity !== "number" ||
      (entry.size !== undefined && typeof entry.size !== "string") ||
      (entry.sellerStatus !== undefined && !isOrderStatus(entry.sellerStatus)) ||
      (entry.sellerStatusHistory !== undefined &&
        (!Array.isArray(entry.sellerStatusHistory) ||
          !entry.sellerStatusHistory.every(
            (history) =>
              isRecord(history) &&
              isOrderStatus(history.status) &&
              typeof history.updatedAt === "string",
          ))) ||
      typeof entry.unitPriceMinor !== "number" ||
      typeof entry.lineTotalMinor !== "number"
    ) {
      throw new Error("The order service returned an invalid order item.");
    }
    const sellerStatusHistory = entry.sellerStatusHistory === undefined
      ? undefined
      : entry.sellerStatusHistory.map((history): { status: OrderStatus; updatedAt: string } => {
          if (
            !isRecord(history) ||
            !isOrderStatus(history.status) ||
            typeof history.updatedAt !== "string"
          ) {
            throw new Error("The order service returned invalid status history.");
          }
          return { status: history.status, updatedAt: history.updatedAt };
        });
    return {
      id: entry.id,
      productId: entry.productId,
      title: entry.title,
      brand: entry.brand,
      imageUrl: entry.imageUrl,
      quantity: entry.quantity,
      ...(typeof entry.size === "string" ? { size: entry.size } : {}),
      sellerStatus: isOrderStatus(entry.sellerStatus) ? entry.sellerStatus : orderStatus,
      ...(sellerStatusHistory ? { sellerStatusHistory } : {}),
      unitPriceMinor: entry.unitPriceMinor,
      lineTotalMinor: entry.lineTotalMinor,
    };
  });
  const returns = value.returns.map((entry): ReturnRequest => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.orderItemId !== "string" ||
      (entry.updatedAt !== undefined && typeof entry.updatedAt !== "string") ||
      typeof entry.reason !== "string" ||
      (entry.status !== "REQUESTED" &&
        entry.status !== "ACCEPTED" &&
        entry.status !== "REJECTED") ||
      (entry.refundStatus !== "NOT_APPLICABLE" &&
        entry.refundStatus !== "LOCAL_SIMULATED_NOT_PROCESSED") ||
      (entry.sellerReviewStatus !== "PENDING" &&
        entry.sellerReviewStatus !== "ACCEPTED" &&
        entry.sellerReviewStatus !== "FORWARDED" &&
        entry.sellerReviewStatus !== "REJECTED" &&
        entry.sellerReviewStatus !== "SYSTEM_AUTO_ACCEPTED") ||
      !Array.isArray(entry.images) ||
      (entry.sellerResponseDeadlineAt !== undefined &&
        typeof entry.sellerResponseDeadlineAt !== "string")
    ) {
      throw new Error("The order service returned an invalid return request.");
    }
    const images = entry.images.map((image) => {
      if (
        !isRecord(image) ||
        typeof image.id !== "string" ||
        typeof image.url !== "string" ||
        typeof image.createdAt !== "string"
      ) {
        throw new Error("The order service returned an invalid return photo.");
      }
      return { id: image.id, url: image.url, createdAt: image.createdAt };
    });
    return {
      id: entry.id,
      orderItemId: entry.orderItemId,
      ...(typeof entry.updatedAt === "string" ? { updatedAt: entry.updatedAt } : {}),
      reason: entry.reason,
      status: entry.status,
      refundStatus: entry.refundStatus,
      images,
      sellerReviewStatus: entry.sellerReviewStatus,
      ...(typeof entry.sellerResponseDeadlineAt === "string"
        ? { sellerResponseDeadlineAt: entry.sellerResponseDeadlineAt }
        : {}),
      ...(entry.decisionSource === "SELLER" ||
      entry.decisionSource === "SYSTEM_AUTO_ACCEPTED"
        ? { decisionSource: entry.decisionSource }
        : {}),
      ...(entry.sellerRecommendation === "ACCEPTED" ||
      entry.sellerRecommendation === "REJECTED"
        ? { sellerRecommendation: entry.sellerRecommendation }
        : {}),
      ...(typeof entry.sellerReviewReason === "string"
        ? { sellerReviewReason: entry.sellerReviewReason }
        : {}),
      ...(typeof entry.sellerReviewedAt === "string"
        ? { sellerReviewedAt: entry.sellerReviewedAt }
        : {}),
    };
  });
  return {
    id: value.id,
    createdAt: value.createdAt,
    totalMinor: value.totalMinor,
    currency: "INR",
    status: orderStatus,
    paymentResult: value.paymentResult,
    deliveryStatus: value.deliveryStatus,
    delivery: {
      recipientName: delivery.recipientName as string,
      phone: delivery.phone as string,
      address: delivery.address as string,
      city: delivery.city as string,
      state: delivery.state as string,
      pinCode: delivery.pinCode as string,
    },
    items,
    returns,
  };
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [returnPhotos, setReturnPhotos] = useState<Record<string, SelectedReturnPhoto[]>>({});
  const [returnFeedback, setReturnFeedback] = useState<Record<string, ReturnFeedback>>({});
  const [cancelFeedback, setCancelFeedback] = useState<Record<string, ReturnFeedback>>({});
  const [reviewClock, setReviewClock] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [error, setError] = useState("");
  const previewUrls = useRef(new Set<string>());
  const returnPhotoInputs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => () => {
    for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl);
    previewUrls.current.clear();
  }, []);

  function releaseReturnPhotos(photos: SelectedReturnPhoto[]) {
    for (const photo of photos) {
      if (previewUrls.current.delete(photo.previewUrl)) {
        URL.revokeObjectURL(photo.previewUrl);
      }
    }
  }

  const loadOrders = useCallback(async () => {
    if (!apiUrl) {
      setError("The order service is not configured.");
      setLoading(false);
      return;
    }
    setError("");
    try {
      const response = await fetch(`${apiUrl}/orders`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        !Array.isArray(body.orders) ||
        typeof body.returnTestingEnabled !== "boolean"
      ) {
        throw new Error("The order service returned an invalid order list.");
      }
      setOrders(body.orders.map(readOrder));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your orders.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrders();
    const refreshVisibleOrders = () => {
      if (!document.hidden) void loadOrders();
    };
    const refreshInterval = window.setInterval(refreshVisibleOrders, 2000);
    const countdownInterval = window.setInterval(() => setReviewClock(Date.now()), 15_000);
    window.addEventListener("focus", refreshVisibleOrders);
    document.addEventListener("visibilitychange", refreshVisibleOrders);
    return () => {
      window.clearInterval(refreshInterval);
      window.clearInterval(countdownInterval);
      window.removeEventListener("focus", refreshVisibleOrders);
      document.removeEventListener("visibilitychange", refreshVisibleOrders);
    };
  }, [loadOrders]);

  async function cancelOrder(order: CustomerOrder) {
    if (!window.confirm(
      "Cancel this order? This cannot be undone. No payment or refund will be processed.",
    )) {
      return;
    }
    if (!apiUrl) {
      setCancelFeedback((current) => ({
        ...current,
        [order.id]: { error: "The order service is not configured. Please try again later." },
      }));
      return;
    }
    setWorkingId(order.id);
    setCancelFeedback((current) => ({ ...current, [order.id]: {} }));
    try {
      const response = await fetch(
        `${apiUrl}/orders/${encodeURIComponent(order.id)}/cancel`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) throw new Error(await errorMessage(response));
      const body: unknown = await response.json();
      if (!isRecord(body) || !isRecord(body.order)) {
        throw new Error("The order service returned an invalid cancellation.");
      }
      const cancelledOrder = readOrder(body.order);
      if (cancelledOrder.id !== order.id || cancelledOrder.status !== "CANCELLED") {
        throw new Error("The order service did not confirm the cancellation.");
      }
      setOrders((current) =>
        current.map((entry) => entry.id === cancelledOrder.id ? cancelledOrder : entry),
      );
      setCancelFeedback((current) => ({
        ...current,
        [order.id]: {
          success: "Order cancelled. No payment or refund was processed.",
        },
      }));
    } catch (cause) {
      setCancelFeedback((current) => ({
        ...current,
        [order.id]: {
          error: cause instanceof Error ? cause.message : "Could not cancel this order.",
        },
      }));
    } finally {
      setWorkingId("");
    }
  }

  async function requestReturn(
    event: FormEvent<HTMLFormElement>,
    order: CustomerOrder,
    item: OrderItem,
  ) {
    event.preventDefault();
    const reason = reasons[item.id]?.trim() ?? "";
    if (reason.length < 5) {
      setReturnFeedback((current) => ({
        ...current,
        [item.id]: { error: "Enter a return reason of at least five characters." },
      }));
      return;
    }
    if (!apiUrl) {
      setReturnFeedback((current) => ({
        ...current,
        [item.id]: { error: "The return service is not configured. Please try again later." },
      }));
      return;
    }
    setWorkingId(item.id);
    setReturnFeedback((current) => ({ ...current, [item.id]: {} }));
    try {
      const form = new FormData();
      form.set("reason", reason);
      for (const photo of returnPhotos[item.id] ?? []) {
        form.append("images", photo.file);
      }
      const response = await fetch(
        `${apiUrl}/orders/${encodeURIComponent(order.id)}/items/${encodeURIComponent(item.id)}/returns`,
        {
          method: "POST",
          credentials: "include",
          body: form,
        },
      );
      if (!response.ok) throw new Error(await errorMessage(response));
      setReturnFeedback((current) => ({
        ...current,
        [item.id]: { success: "Return request submitted successfully." },
      }));
      setReasons((current) => ({ ...current, [item.id]: "" }));
      releaseReturnPhotos(returnPhotos[item.id] ?? []);
      setReturnPhotos((current) => ({ ...current, [item.id]: [] }));
      const photoInput = returnPhotoInputs.current[item.id];
      if (photoInput) photoInput.value = "";
      await loadOrders();
    } catch (cause) {
      setReturnFeedback((current) => ({
        ...current,
        [item.id]: {
          error: cause instanceof Error ? cause.message : "Could not submit the return request.",
        },
      }));
    } finally {
      setWorkingId("");
    }
  }

  return (
    <main className="catalog-page">
      <header className="catalog-header">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <div className="seller-nav">
          <Link className="text-link" href="/cart">Your cart ↗</Link>
          <Link className="text-link" href="/account">Your account ↗</Link>
        </div>
      </header>
      <section className="workflow-page">
        <p className="eyebrow">YOUR ACCOUNT</p>
        <h1>Your orders.</h1>
        <p className="workflow-warning">
          Payment is not configured. Local development orders do not process payment or refunds.
        </p>
        {loading && <p className="catalog-message" role="status">Loading your orders…</p>}
        {error && <p className="form-message form-error" role="alert">{error}</p>}
        {!loading && orders.length === 0 && (
          <div className="catalog-empty">
            <p>No orders yet.</p>
            <Link className="button button-dark" href="/catalog">Browse the collection <span>↗</span></Link>
          </div>
        )}
        <div className="workflow-orders">
          {orders.map((order) => (
            <article className="workflow-order" key={order.id}>
              <header>
                <div>
                  <p className="eyebrow">ORDER PLACED</p>
                  <h2>{new Date(order.createdAt).toLocaleString()}</h2>
                  <small>Order ID {order.id}</small>
                </div>
                <div className="workflow-order-status">
                  <span>Order status: {formatOrderStatus(order.status)}</span>
                  <span>Payment: Not configured</span>
                  {(order.status === "PENDING" || order.status === "CONFIRMED") &&
                    order.returns.length === 0 &&
                    order.items.every((item) =>
                      item.sellerStatus === "PENDING" ||
                      item.sellerStatus === "CONFIRMED",
                    ) && (
                      <button
                        className="button button-dark"
                        type="button"
                        disabled={workingId !== ""}
                        onClick={() => void cancelOrder(order)}
                      >
                        {workingId === order.id ? "Cancelling…" : "Cancel Order"}
                      </button>
                    )}
                  {cancelFeedback[order.id]?.error && (
                    <p className="form-message form-error" role="alert">
                      {cancelFeedback[order.id].error}
                    </p>
                  )}
                  {cancelFeedback[order.id]?.success && (
                    <p className="form-message form-notice" role="status">
                      {cancelFeedback[order.id].success}
                    </p>
                  )}
                </div>
              </header>
              <section className="workflow-delivery">
                <h3>Delivery details</h3>
                <p>{order.delivery.recipientName} · {order.delivery.phone}</p>
                <p>{order.delivery.address}, {order.delivery.city}, {order.delivery.state} {order.delivery.pinCode}</p>
              </section>
              {order.items.map((item) => {
                const returnRequest = order.returns.find((entry) => entry.orderItemId === item.id);
                const currentProgress = getTrackingProgress(item);
                return (
                  <section className="workflow-order-item" key={item.id}>
                    <div className="workflow-line-image">
                      {item.imageUrl && (
                        isLocalProductImageUrl(item.imageUrl) ? (
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            style={{ width: "100%", height: "100%", objectFit: "contain" }}
                          />
                        ) : (
                          <Image src={item.imageUrl} alt={item.title} fill sizes="100px" />
                        )
                      )}
                      {!item.imageUrl && <span className="workflow-no-image">Image unavailable</span>}
                    </div>
                    <div className="workflow-line-details">
                      <h3>{item.title}</h3>
                      <p>
                        {item.brand} · quantity {item.quantity}
                        {item.size ? ` · shoe size (UK) ${item.size}` : ""}
                      </p>
                      <p>
                        {new Intl.NumberFormat("en-IN", {
                          style: "currency",
                          currency: order.currency,
                        }).format(item.lineTotalMinor / 100)}
                      </p>
                      <p className="workflow-item-status">
                        Item status: {formatOrderStatus(item.sellerStatus)}
                      </p>
                      <section
                        className="workflow-tracking"
                        aria-label={`Tracking timeline for ${item.title}`}
                      >
                        <ol className="workflow-tracking-steps">
                          {trackingSteps.map((step, index) => {
                            const event = item.sellerStatusHistory?.find(
                              (historyEntry) => historyEntry.status === step.status,
                            );
                            const timestamp = step.status === "PENDING"
                              ? event?.updatedAt ?? order.createdAt
                              : event?.updatedAt;
                            const completed = index <= currentProgress;
                            return (
                              <li
                                className={completed ? "is-complete" : ""}
                                key={step.status}
                                aria-current={index === currentProgress ? "step" : undefined}
                              >
                                <span className="workflow-tracking-marker" aria-hidden="true" />
                                <span className="workflow-tracking-label">{step.label}</span>
                                {timestamp && Number.isFinite(Date.parse(timestamp)) && (
                                  <time dateTime={timestamp}>
                                    {new Date(timestamp).toLocaleString()}
                                  </time>
                                )}
                              </li>
                            );
                          })}
                        </ol>
                        <p>
                          Fulfillment statuses are manual seller updates; courier tracking and real delivery events are not connected.
                        </p>
                        {item.sellerStatus === "CANCELLED" && <strong>Item cancelled by seller.</strong>}
                      </section>
                      {returnRequest ? (
                        <div className="workflow-return-status">
                          <strong>Return {formatReturnStatus(returnRequest.status)}</strong>
                          <span>Customer reason: {returnRequest.reason}</span>
                          {returnRequest.status === "REQUESTED" ? (
                            <>
                              <span role="status">
                                Your return request is under review. The seller’s decision is expected
                                {returnRequest.sellerResponseDeadlineAt &&
                                Number.isFinite(Date.parse(returnRequest.sellerResponseDeadlineAt))
                                  ? <> by{" "}
                                    <time dateTime={returnRequest.sellerResponseDeadlineAt}>
                                      {new Date(returnRequest.sellerResponseDeadlineAt).toLocaleString()}
                                    </time>
                                  </>
                                  : " within 24 hours"}.
                              </span>
                              {returnRequest.sellerResponseDeadlineAt &&
                              Number.isFinite(Date.parse(returnRequest.sellerResponseDeadlineAt)) && (
                                <span>
                                  {Date.parse(returnRequest.sellerResponseDeadlineAt) > reviewClock
                                    ? ` (about ${Math.ceil(
                                        (Date.parse(returnRequest.sellerResponseDeadlineAt) - reviewClock) /
                                          3_600_000,
                                      )} hours remaining).`
                                    : ". If the seller does not respond, the return will be automatically accepted."}
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              <span role="status">
                                {returnRequest.status === "ACCEPTED"
                                  ? returnRequest.decisionSource === "SYSTEM_AUTO_ACCEPTED" ||
                                    returnRequest.sellerReviewStatus === "SYSTEM_AUTO_ACCEPTED"
                                    ? "Return accepted automatically because the seller did not respond by the deadline."
                                    : "Your return request was accepted by the seller."
                                  : "Your return request was rejected by the seller."}
                              </span>
                              {returnRequest.sellerReviewedAt &&
                              Number.isFinite(Date.parse(returnRequest.sellerReviewedAt)) && (
                                <span>
                                  Decision recorded{" "}
                                  <time dateTime={returnRequest.sellerReviewedAt}>
                                    {new Date(returnRequest.sellerReviewedAt).toLocaleString()}
                                  </time>.
                                </span>
                              )}
                            </>
                          )}
                          {returnRequest.sellerReviewReason && (
                            <span>Seller’s rejection reason: {returnRequest.sellerReviewReason}</span>
                          )}
                          {returnRequest.images.length > 0 && <strong>Damage photos</strong>}
                          {returnRequest.images.map((image) => (
                            <a
                              href={`${apiUrl}${image.url}`}
                              target="_blank"
                              rel="noreferrer"
                              key={image.id}
                            >
                              <img
                                src={`${apiUrl}${image.url}`}
                                alt="Damage photo submitted with return request"
                                crossOrigin="use-credentials"
                                width={120}
                                height={90}
                              />
                            </a>
                          ))}
                          <span>
                            Refund: {returnRequest.refundStatus === "LOCAL_SIMULATED_NOT_PROCESSED"
                              ? "LOCAL SIMULATED — NOT PROCESSED"
                              : "Not applicable"}
                          </span>
                        </div>
                      ) : (order.status === "DELIVERED" ||
                          item.sellerStatus === "DELIVERED") &&
                        item.sellerStatus !== "CANCELLED" ? (
                        <form
                          className="workflow-return-form"
                          noValidate
                          aria-busy={workingId === item.id}
                          onSubmit={(event) => void requestReturn(event, order, item)}
                        >
                          <label htmlFor={`return-reason-${item.id}`}>Return reason (required)</label>
                          <textarea
                            id={`return-reason-${item.id}`}
                            value={reasons[item.id] ?? ""}
                            minLength={5}
                            maxLength={500}
                            required
                            disabled={workingId === item.id}
                            aria-invalid={Boolean(returnFeedback[item.id]?.error)}
                            aria-describedby={
                              returnFeedback[item.id]?.error
                                ? `return-error-${item.id}`
                                : undefined
                            }
                            onChange={(event) => {
                              setReasons({ ...reasons, [item.id]: event.target.value });
                              if (returnFeedback[item.id]?.error) {
                                setReturnFeedback((current) => ({
                                  ...current,
                                  [item.id]: {},
                                }));
                              }
                            }}
                          />
                          <label htmlFor={`return-photos-${item.id}`}>
                            Product-damage photos (optional, up to 5 JPEG, PNG, or WebP files, 5 MB each; AVIF is converted when supported)
                          </label>
                          <input
                            id={`return-photos-${item.id}`}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif"
                            multiple
                            ref={(element) => {
                              returnPhotoInputs.current[item.id] = element;
                            }}
                            disabled={workingId === item.id}
                            onChange={async (event) => {
                              const input = event.currentTarget;
                              const files = Array.from(input.files ?? []);
                              input.value = "";
                              const currentPhotos = returnPhotos[item.id] ?? [];
                              if (files.length > 5) {
                                setReturnFeedback((current) => ({
                                  ...current,
                                  [item.id]: {
                                    error: "Choose no more than five photos.",
                                  },
                                }));
                                releaseReturnPhotos(currentPhotos);
                                setReturnPhotos((current) => ({ ...current, [item.id]: [] }));
                                return;
                              }
                              const oversized = files.some(
                                (file) => file.size === 0 || file.size > MAX_RETURN_PHOTO_BYTES,
                              );
                              if (oversized) {
                                setReturnFeedback((current) => ({
                                  ...current,
                                  [item.id]: {
                                    error: "Each photo must be between 1 byte and 5 MB.",
                                  },
                                }));
                                releaseReturnPhotos(currentPhotos);
                                setReturnPhotos((current) => ({ ...current, [item.id]: [] }));
                                return;
                              }
                              let selectedFiles: File[];
                              try {
                                selectedFiles = await Promise.all(files.map(prepareReturnPhoto));
                              } catch (cause) {
                                setReturnFeedback((current) => ({
                                  ...current,
                                  [item.id]: {
                                    error: cause instanceof Error
                                      ? cause.message
                                      : "Could not read the selected photo.",
                                  },
                                }));
                                releaseReturnPhotos(currentPhotos);
                                setReturnPhotos((current) => ({ ...current, [item.id]: [] }));
                                return;
                              }
                              releaseReturnPhotos(currentPhotos);
                              const selectedPhotos = selectedFiles.map((file): SelectedReturnPhoto => {
                                const previewUrl = URL.createObjectURL(file);
                                previewUrls.current.add(previewUrl);
                                return {
                                  id: crypto.randomUUID(),
                                  file,
                                  previewUrl,
                                };
                              });
                              setReturnFeedback((current) => ({
                                ...current,
                                [item.id]: {},
                              }));
                              setReturnPhotos((current) => ({
                                ...current,
                                [item.id]: selectedPhotos,
                              }));
                            }}
                          />
                          {(returnPhotos[item.id] ?? []).length > 0 && (
                            <ul className="return-photo-previews" aria-label="Selected damage photos">
                              {(returnPhotos[item.id] ?? []).map((photo, photoIndex) => (
                                <li key={photo.id}>
                                  <img
                                    src={photo.previewUrl}
                                    alt={`Selected damage photo ${photoIndex + 1}`}
                                  />
                                  <span>{photo.file.name}</span>
                                  <button
                                    className="text-button"
                                    type="button"
                                    disabled={workingId === item.id}
                                    onClick={() => {
                                      releaseReturnPhotos([photo]);
                                      setReturnPhotos((current) => ({
                                        ...current,
                                        [item.id]: (current[item.id] ?? []).filter(
                                          (selectedPhoto) => selectedPhoto.id !== photo.id,
                                        ),
                                      }));
                                    }}
                                  >
                                    Remove
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                          <button
                            className="button button-dark"
                            type="submit"
                            disabled={workingId !== ""}
                          >
                            {workingId === item.id ? "Submitting…" : "Request Return"}
                          </button>
                          {returnFeedback[item.id]?.error && (
                            <p
                              className="form-message form-error"
                              id={`return-error-${item.id}`}
                              role="alert"
                            >
                              {returnFeedback[item.id].error}
                            </p>
                          )}
                        </form>
                      ) : null}
                      {returnFeedback[item.id]?.success && (
                        <p className="form-message form-notice" role="status">
                          {returnFeedback[item.id].success}
                        </p>
                      )}
                    </div>
                  </section>
                );
              })}
              <footer>
                <span>Order total</span>
                <strong>
                  {new Intl.NumberFormat("en-IN", { style: "currency", currency: order.currency }).format(order.totalMinor / 100)}
                </strong>
              </footer>
            </article>
          ))}
        </div>
      </section>
      <footer className="site-footer">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <span>Good things take time.</span>
        <span>© Morrow Market</span>
      </footer>
    </main>
  );
}

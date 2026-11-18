"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

interface SellerProduct {
  id: string;
  title: string;
  description: string;
  brand: string;
  sku: string;
  category: string;
  priceMinor: number;
  stock: number;
  images: Array<{ url: string; altText: string }>;
  specifications: Record<string, string>;
  status: "draft" | "rejected" | "active" | "archived";
  createdAt: string;
}

interface ProductImageDraft {
  key: string;
  url?: string;
  file?: File;
  previewUrl?: string;
  altText: string;
}

interface SellerAccount {
  id: string;
  email?: string;
  mobileNumber?: string;
  roles: string[];
  storeId?: string;
}

type VerificationStatus =
  | "NOT_SUBMITTED"
  | "PENDING_REVIEW"
  | "NEEDS_CORRECTION"
  | "APPROVED"
  | "REJECTED";

interface SellerVerification {
  status: VerificationStatus;
  storeStatus?: "pending" | "approved" | "rejected" | "suspended";
  submissionAvailable: boolean;
  providerStatus: "NOT_CONFIGURED" | "CONFIGURED";
  reason?: string;
}

type SellerOrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED";

interface SellerOrderItem {
  id: string;
  productId: string;
  title: string;
  brand: string;
  quantity: number;
  lineTotalMinor: number;
  sellerStatus: SellerOrderStatus;
}

interface SellerOrderReturn {
  id: string;
  orderItemId: string;
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

interface SellerReturnActionFeedback {
  error?: string;
  success?: string;
}

interface SellerOrder {
  id: string;
  createdAt: string;
  status: SellerOrderStatus;
  delivery: {
    recipientName: string;
    phone: string;
    address: string;
    city: string;
    state: string;
    pinCode: string;
  };
  items: SellerOrderItem[];
  returns: SellerOrderReturn[];
}

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
const nextSellerStatuses: Record<SellerOrderStatus, SellerOrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function responseError(response: Response): Promise<string> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string") return body.error;
  }
  return "The request could not be completed.";
}

function readAccount(value: unknown): SellerAccount {
  if (
    !isRecord(value) ||
    !isRecord(value.user) ||
    typeof value.user.id !== "string" ||
    (value.user.email !== undefined && typeof value.user.email !== "string") ||
    (value.user.mobileNumber !== undefined &&
      typeof value.user.mobileNumber !== "string") ||
    (typeof value.user.email !== "string" &&
      typeof value.user.mobileNumber !== "string") ||
    !Array.isArray(value.user.roles) ||
    !value.user.roles.every((role) => typeof role === "string")
  ) {
    throw new Error("The account service returned an invalid response.");
  }
  return {
    id: value.user.id,
    ...(typeof value.user.email === "string" ? { email: value.user.email } : {}),
    ...(typeof value.user.mobileNumber === "string"
      ? { mobileNumber: value.user.mobileNumber }
      : {}),
    roles: value.user.roles,
    ...(typeof value.user.storeId === "string" ? { storeId: value.user.storeId } : {}),
  };
}

function readProducts(value: unknown): SellerProduct[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("The product service returned an invalid response.");
  }
  return value.items.map(readProduct);
}

function readOrders(value: unknown): SellerOrder[] {
  if (!isRecord(value) || !Array.isArray(value.orders)) {
    throw new Error("The order service returned an invalid response.");
  }
  return value.orders.map((entry): SellerOrder => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.createdAt !== "string" ||
      !isSellerOrderStatus(entry.status) ||
      !isRecord(entry.delivery) ||
      !Array.isArray(entry.items) ||
      !Array.isArray(entry.returns)
    ) {
      throw new Error("The order service returned an invalid seller order.");
    }
    const delivery = entry.delivery;
    if (
      typeof delivery.recipientName !== "string" ||
      typeof delivery.phone !== "string" ||
      typeof delivery.address !== "string" ||
      typeof delivery.city !== "string" ||
      typeof delivery.state !== "string" ||
      typeof delivery.pinCode !== "string"
    ) {
      throw new Error("The order service returned invalid delivery details.");
    }
    const items = entry.items.map((item): SellerOrderItem => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        typeof item.productId !== "string" ||
        typeof item.title !== "string" ||
        typeof item.brand !== "string" ||
        typeof item.quantity !== "number" ||
        typeof item.lineTotalMinor !== "number" ||
        !isSellerOrderStatus(item.sellerStatus)
      ) {
        throw new Error("The order service returned an invalid seller order item.");
      }
      return {
        id: item.id,
        productId: item.productId,
        title: item.title,
        brand: item.brand,
        quantity: item.quantity,
        lineTotalMinor: item.lineTotalMinor,
        sellerStatus: item.sellerStatus,
      };
    });
    const returns = entry.returns.map((returnValue): SellerOrderReturn => {
      if (
        !isRecord(returnValue) ||
        typeof returnValue.id !== "string" ||
        typeof returnValue.orderItemId !== "string" ||
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
        throw new Error("The order service returned an invalid seller return request.");
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
    });
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      status: entry.status,
      delivery: {
        recipientName: delivery.recipientName,
        phone: delivery.phone,
        address: delivery.address,
        city: delivery.city,
        state: delivery.state,
        pinCode: delivery.pinCode,
      },
      items,
      returns,
    };
  });
}

function isSellerOrderStatus(value: unknown): value is SellerOrderStatus {
  return (
    value === "PENDING" ||
    value === "CONFIRMED" ||
    value === "SHIPPED" ||
    value === "OUT_FOR_DELIVERY" ||
    value === "DELIVERED" ||
    value === "CANCELLED"
  );
}

function formatReturnStatus(status: SellerOrderReturn["status"]): string {
  return status.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readProduct(value: unknown): SellerProduct {
  const item = value;
  if (
    !isRecord(item) ||
    typeof item.id !== "string" ||
    typeof item.title !== "string" ||
    typeof item.description !== "string" ||
    typeof item.brand !== "string" ||
    typeof item.sku !== "string" ||
    typeof item.category !== "string" ||
    typeof item.priceMinor !== "number" ||
    typeof item.stock !== "number" ||
    !Array.isArray(item.images) ||
    !isRecord(item.specifications) ||
    (item.status !== "draft" &&
      item.status !== "rejected" &&
      item.status !== "active" &&
      item.status !== "archived") ||
    typeof item.createdAt !== "string"
  ) {
    throw new Error("The product service returned an invalid product.");
  }
  const images: SellerProduct["images"] = [];
  for (const image of item.images) {
    if (
      !isRecord(image) ||
      typeof image.url !== "string" ||
      typeof image.altText !== "string"
    ) {
      throw new Error("The product service returned invalid imagery.");
    }
    images.push({ url: image.url, altText: image.altText });
  }
  const specifications: Record<string, string> = {};
  for (const [key, entry] of Object.entries(item.specifications)) {
    if (typeof entry !== "string") {
      throw new Error("The product service returned invalid specifications.");
    }
    specifications[key] = entry;
  }
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    brand: item.brand,
    sku: item.sku,
    category: item.category,
    priceMinor: item.priceMinor,
    stock: item.stock,
    images,
    specifications,
    status: item.status,
    createdAt: item.createdAt,
  };
}

function existingImageDrafts(images: SellerProduct["images"]): ProductImageDraft[] {
  return images.map((image, index) => ({
    key: `existing-${index}-${image.url}`,
    url: image.url,
    altText: image.altText,
  }));
}

function uploadProductImage(
  productId: string,
  file: File,
  altText: string,
  onProgress: (progress: number) => void,
): Promise<{ url: string; altText: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("image", file);
    form.append("altText", altText);

    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `${apiUrl}/seller/products/${encodeURIComponent(productId)}/images`,
    );
    request.withCredentials = true;
    request.timeout = 120_000;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        try {
          const body: unknown = JSON.parse(request.responseText);
          reject(
            isRecord(body) && typeof body.error === "string"
              ? new Error(body.error)
              : new Error("The image upload could not be completed."),
          );
        } catch (cause) {
          reject(
            cause instanceof Error
              ? cause
              : new Error("The image upload could not be completed."),
          );
        }
        return;
      }
      try {
        const body: unknown = JSON.parse(request.responseText);
        if (
          !isRecord(body) ||
          !isRecord(body.image) ||
          typeof body.image.url !== "string" ||
          typeof body.image.altText !== "string"
        ) {
          throw new Error("The image service returned an invalid response.");
        }
        resolve({ url: body.image.url, altText: body.image.altText });
      } catch (cause) {
        reject(
          cause instanceof Error
            ? cause
            : new Error("The image service returned an invalid response."),
        );
      }
    });
    request.addEventListener("error", () =>
      reject(new Error("Could not connect to the image service.")),
    );
    request.addEventListener("timeout", () =>
      reject(new Error("The image upload timed out. Try again.")),
    );
    request.send(form);
  });
}

function uploadVerification(
  payload: FormData,
  onProgress: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${apiUrl}/seller/verification`);
    request.withCredentials = true;
    request.timeout = 120_000;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        try {
          const value: unknown = JSON.parse(request.responseText);
          reject(
            isRecord(value) && typeof value.error === "string"
              ? new Error(value.error)
              : new Error("Business verification could not be submitted."),
          );
        } catch (cause) {
          reject(
            cause instanceof Error
              ? cause
              : new Error("Business verification could not be submitted."),
          );
        }
        return;
      }
      resolve();
    });
    request.addEventListener("error", () =>
      reject(new Error("Could not connect to the verification service.")),
    );
    request.addEventListener("timeout", () =>
      reject(new Error("The verification upload timed out. Try again.")),
    );
    request.send(payload);
  });
}

export default function SellerDashboardPage() {
  const [account, setAccount] = useState<SellerAccount | null>(null);
  const [products, setProducts] = useState<SellerProduct[]>([]);
  const [orders, setOrders] = useState<SellerOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [workingOrderItemId, setWorkingOrderItemId] = useState("");
  const [returnReviewReasons, setReturnReviewReasons] = useState<Record<string, string>>({});
  const [returnActionFeedback, setReturnActionFeedback] = useState<
    Record<string, SellerReturnActionFeedback>
  >({});
  const [returnClock, setReturnClock] = useState(Date.now());
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [editingProduct, setEditingProduct] = useState<SellerProduct | null>(null);
  const [productImageDrafts, setProductImageDrafts] = useState<ProductImageDraft[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadingImageIndex, setUploadingImageIndex] = useState(0);
  const previewUrls = useRef(new Set<string>());
  const [verification, setVerification] = useState<SellerVerification | null>(null);
  const [verificationSubmitting, setVerificationSubmitting] = useState(false);
  const [verificationProgress, setVerificationProgress] = useState<number | null>(null);
  const [businessType, setBusinessType] = useState("PROPRIETORSHIP");
  const [gstRegistration, setGstRegistration] = useState("NOT_REQUIRED");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => () => {
    for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl);
    previewUrls.current.clear();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setReturnClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  function releaseImagePreviews(images: ProductImageDraft[]) {
    for (const image of images) {
      if (image.previewUrl && previewUrls.current.delete(image.previewUrl)) {
        URL.revokeObjectURL(image.previewUrl);
      }
    }
  }

  const loadProducts = useCallback(async () => {
    const response = await fetch(`${apiUrl}/seller/products?limit=50`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await responseError(response));
    setProducts(readProducts(await response.json()));
  }, []);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const response = await fetch(`${apiUrl}/seller/orders`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await responseError(response));
      setOrders(readOrders(await response.json()));
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  const loadVerification = useCallback(async () => {
    const response = await fetch(`${apiUrl}/seller/verification`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await responseError(response));
    const value: unknown = await response.json();
    if (
      !isRecord(value) ||
      (value.status !== "NOT_SUBMITTED" &&
        value.status !== "PENDING_REVIEW" &&
        value.status !== "NEEDS_CORRECTION" &&
        value.status !== "APPROVED" &&
        value.status !== "REJECTED") ||
      typeof value.submissionAvailable !== "boolean" ||
      (value.providerStatus !== "NOT_CONFIGURED" &&
        value.providerStatus !== "CONFIGURED")
    ) {
      throw new Error("The verification service returned an invalid response.");
    }
    const result: SellerVerification = {
      status: value.status,
      submissionAvailable: value.submissionAvailable,
      providerStatus: value.providerStatus,
      ...(value.storeStatus === "pending" ||
      value.storeStatus === "approved" ||
      value.storeStatus === "rejected" ||
      value.storeStatus === "suspended"
        ? { storeStatus: value.storeStatus }
        : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
    setVerification(result);
    return result;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let orderRefreshInterval: number | undefined;
    async function loadDashboard() {
      if (!apiUrl) {
        setError("The account service is not configured.");
        setChecking(false);
        return;
      }
      try {
        const response = await fetch(`${apiUrl}/auth/me`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          setChecking(false);
          return;
        }
        if (!response.ok) throw new Error(await responseError(response));
        const user = readAccount(await response.json());
        setAccount(user);
        if (user.storeId) {
          const state = await loadVerification();
          if (
            user.roles.includes("seller") &&
            state.status === "APPROVED" &&
            state.storeStatus === "approved"
          ) {
            await loadProducts();
            await loadOrders();
            orderRefreshInterval = window.setInterval(() => {
              if (!document.hidden) {
                void loadOrders().catch((cause: unknown) => {
                  setError(cause instanceof Error
                    ? cause.message
                    : "Could not refresh seller orders.");
                });
              }
            }, 30_000);
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load the seller dashboard.");
        }
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    }
    void loadDashboard();
    return () => {
      controller.abort();
      if (orderRefreshInterval !== undefined) {
        window.clearInterval(orderRefreshInterval);
      }
    };
  }, [loadOrders, loadProducts, loadVerification]);

  async function submitVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setVerificationSubmitting(true);
    setVerificationProgress(0);
    setError("");
    setNotice("");
    const values = new FormData(form);
    const businessProof = values.get("businessProof");
    const gstCertificate = values.get("gstCertificate");
    if (!(businessProof instanceof File) || businessProof.size === 0) {
      setError("Choose a business proof document.");
      setVerificationSubmitting(false);
      setVerificationProgress(null);
      return;
    }
    if (
      (gstRegistration === "REGISTERED" &&
        (!(gstCertificate instanceof File) || gstCertificate.size === 0))
    ) {
      setError("Upload your GST registration certificate.");
      setVerificationSubmitting(false);
      setVerificationProgress(null);
      return;
    }
    const documentFiles = [
      businessProof,
      ...(gstRegistration === "REGISTERED" && gstCertificate instanceof File
        ? [gstCertificate]
        : []),
    ];
    if (
      documentFiles.some(
        (file) =>
          !["application/pdf", "image/jpeg", "image/png"].includes(file.type) ||
          file.size > 10 * 1024 * 1024,
      )
    ) {
      setError("Documents must be PDF, JPEG, or PNG files no larger than 10 MB each.");
      setVerificationSubmitting(false);
      setVerificationProgress(null);
      return;
    }
    const details = {
      legalName: values.get("legalName"),
      tradeName: values.get("tradeName"),
      businessType: values.get("businessType"),
      gstRegistration: values.get("gstRegistration"),
      gstin:
        gstRegistration === "REGISTERED"
          ? String(values.get("gstin") ?? "").trim().toUpperCase()
          : null,
      pan: String(values.get("pan") ?? "").trim().toUpperCase(),
      address: values.get("businessAddress"),
      state: values.get("businessState"),
      city: values.get("businessCity"),
      pinCode: values.get("pinCode"),
      consent: values.get("verificationConsent") === "on",
    };
    const payload = new FormData();
    payload.set("details", JSON.stringify(details));
    payload.set("businessProof", businessProof);
    if (gstRegistration === "REGISTERED" && gstCertificate instanceof File) {
      payload.set("gstCertificate", gstCertificate);
    }
    try {
      await uploadVerification(payload, setVerificationProgress);
      await loadVerification();
      form.reset();
      setBusinessType("PROPRIETORSHIP");
      setGstRegistration("NOT_REQUIRED");
      setNotice("Business verification submitted for manual review.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit business verification.");
    } finally {
      setVerificationSubmitting(false);
      setVerificationProgress(null);
    }
  }

  function addProductImages(files: FileList | null) {
    const selected = Array.from(files ?? []);
    if (productImageDrafts.length + selected.length > 5) {
      setError("A product can have at most five images.");
      return;
    }
    const invalidFile = selected.find(
      (file) =>
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size === 0 ||
        file.size > 5 * 1024 * 1024,
    );
    if (invalidFile) {
      setError("Choose JPEG, PNG, or WebP images no larger than 5 MB each.");
      return;
    }
    const newImages = selected.map((file): ProductImageDraft => {
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      return {
        key: crypto.randomUUID(),
        file,
        previewUrl,
        altText: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim(),
      };
    });
    setProductImageDrafts((current) => [...current, ...newImages]);
    setError("");
    setNotice("");
  }

  function updateImageDraft(key: string, update: Partial<ProductImageDraft>) {
    setProductImageDrafts((current) =>
      current.map((image) => image.key === key ? { ...image, ...update } : image),
    );
  }

  function moveImageDraft(key: string, targetIndex: number) {
    setProductImageDrafts((current) => {
      const sourceIndex = current.findIndex((image) => image.key === key);
      if (
        sourceIndex < 0 ||
        targetIndex < 0 ||
        targetIndex >= current.length ||
        sourceIndex === targetIndex
      ) {
        return current;
      }
      const reordered = [...current];
      const [image] = reordered.splice(sourceIndex, 1);
      if (!image) return current;
      reordered.splice(targetIndex, 0, image);
      return reordered;
    });
  }

  function removeImageDraft(key: string) {
    const removed = productImageDrafts.find((image) => image.key === key);
    if (removed) releaseImagePreviews([removed]);
    setProductImageDrafts((current) => current.filter((image) => image.key !== key));
  }

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSubmitting(true);
    setError("");
    setNotice("");
    const values = new FormData(form);
    if (productImageDrafts.length > 5) {
      setError("A product can have at most five images.");
      setSubmitting(false);
      return;
    }
    if (!editingProduct && productImageDrafts.length < 3) {
      setError("Add at least three product images before submitting a new listing.");
      setSubmitting(false);
      return;
    }
    if (
      productImageDrafts.some(
        (image) =>
          image.altText.trim().length < 3 ||
          image.altText.trim().length > 180 ||
          (image.file &&
            (!["image/jpeg", "image/png", "image/webp"].includes(image.file.type) ||
              image.file.size === 0 ||
              image.file.size > 5 * 1024 * 1024)),
      )
    ) {
      setError("Each image needs a description of 3–180 characters and must be JPEG, PNG, or WebP up to 5 MB.");
      setSubmitting(false);
      return;
    }
    const price = Number(values.get("price"));
    const stock = Number(values.get("stock"));
    if (!Number.isFinite(price) || !Number.isFinite(stock)) {
      setError("Enter a valid price and stock quantity.");
      setSubmitting(false);
      return;
    }
    let savedProduct = editingProduct;
    let productSaved = false;
    let nextImageDrafts = productImageDrafts;
    const pendingImageCount = productImageDrafts.filter((image) => image.file).length;
    const productDetails = {
      title: values.get("title"),
      description: values.get("description"),
      brand: values.get("brand"),
      sku: values.get("sku"),
      category: values.get("category"),
      priceMinor: Math.round(price * 100),
      stock,
      specifications: editingProduct?.specifications ?? {},
    };
    async function saveProduct(
      images: SellerProduct["images"],
      productId = savedProduct?.id,
    ): Promise<SellerProduct> {
      const response = await fetch(
        productId
          ? `${apiUrl}/seller/products/${encodeURIComponent(productId)}`
          : `${apiUrl}/seller/products`,
        {
          method: productId ? "PATCH" : "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...productDetails, images }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      const body: unknown = await response.json();
      if (!isRecord(body) || !("product" in body)) {
        throw new Error("The product service returned an invalid response.");
      }
      return readProduct(body.product);
    }

    try {
      savedProduct = await saveProduct(
        nextImageDrafts.flatMap((image) =>
          image.url ? [{ url: image.url, altText: image.altText.trim() }] : [],
        ),
      );
      productSaved = true;
      setEditingProduct(savedProduct);

      for (let index = 0; index < nextImageDrafts.length; index += 1) {
        const draftImage = nextImageDrafts[index];
        if (!draftImage?.file || !savedProduct) continue;
        setUploadingImageIndex(index + 1);
        setUploadProgress(0);
        const uploadedImage = await uploadProductImage(
          savedProduct.id,
          draftImage.file,
          draftImage.altText.trim(),
          setUploadProgress,
        );
        savedProduct = {
          ...savedProduct,
          images: [...savedProduct.images, uploadedImage],
        };
        releaseImagePreviews([draftImage]);
        nextImageDrafts = nextImageDrafts.map((image) =>
          image.key === draftImage.key
            ? {
                key: image.key,
                url: uploadedImage.url,
                altText: uploadedImage.altText,
              }
            : image,
        );
        setProductImageDrafts(nextImageDrafts);
        setEditingProduct(savedProduct);
      }

      if (pendingImageCount > 0 && savedProduct) {
        savedProduct = await saveProduct(
          nextImageDrafts.flatMap((image) =>
            image.url ? [{ url: image.url, altText: image.altText.trim() }] : [],
          ),
          savedProduct.id,
        );
        setEditingProduct(savedProduct);
      }

      releaseImagePreviews(nextImageDrafts);
      form.reset();
      setEditingProduct(null);
      setProductImageDrafts([]);
      setUploadProgress(null);
      setUploadingImageIndex(0);
      await loadProducts();
      setNotice("Product details and ordered images saved for administrator review.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save the product draft.";
      if (productSaved && savedProduct && pendingImageCount > 0) {
        setProductImageDrafts(nextImageDrafts);
        setEditingProduct(savedProduct);
        setError(`Draft saved, but an image upload or ordering step failed: ${message} Review the images and submit again to retry.`);
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
      setUploadingImageIndex(0);
    }
  }

  async function archiveProduct(productId: string) {
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `${apiUrl}/seller/products/${encodeURIComponent(productId)}/archive`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await loadProducts();
      setNotice("Product archived.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not archive the product.");
    } finally {
      setSubmitting(false);
    }
  }

  async function restoreProduct(productId: string) {
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `${apiUrl}/seller/products/${encodeURIComponent(productId)}/restore`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await loadProducts();
      setNotice("Product restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore the product.");
    } finally {
      setSubmitting(false);
    }
  }

  async function updateOrderItemStatus(
    orderId: string,
    itemId: string,
    status: SellerOrderStatus,
  ) {
    setWorkingOrderItemId(itemId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `${apiUrl}/seller/orders/${encodeURIComponent(orderId)}/items/${encodeURIComponent(itemId)}/status`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await loadOrders();
      setNotice("Order item status updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the order item.");
    } finally {
      setWorkingOrderItemId("");
    }
  }

  async function decideReturn(
    orderId: string,
    returnId: string,
    decision: "ACCEPTED" | "REJECTED",
  ) {
    const reason = returnReviewReasons[returnId]?.trim() ?? "";
    if (
      decision === "REJECTED" && reason.length < 5
    ) {
      setReturnActionFeedback((current) => ({
        ...current,
        [returnId]: {
          error: "Enter a rejection reason of at least five characters.",
        },
      }));
      return;
    }
    if (!apiUrl) {
      setReturnActionFeedback((current) => ({
        ...current,
        [returnId]: { error: "The seller order service is not configured." },
      }));
      return;
    }
    setWorkingOrderItemId(returnId);
    setReturnActionFeedback((current) => ({
      ...current,
      [returnId]: {},
    }));
    try {
      const response = await fetch(
        `${apiUrl}/seller/orders/${encodeURIComponent(orderId)}/returns/${encodeURIComponent(returnId)}/review`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(decision === "REJECTED" ? { reason } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await loadOrders();
      setReturnReviewReasons((current) => ({ ...current, [returnId]: "" }));
      setReturnActionFeedback((current) => ({
        ...current,
        [returnId]: {
          success: decision === "REJECTED"
            ? "Return rejected. The customer can now see your decision."
            : "Return accepted. The customer can now see your decision. No refund was processed.",
        },
      }));
    } catch (cause) {
      setReturnActionFeedback((current) => ({
        ...current,
        [returnId]: {
          error:
            cause instanceof Error
              ? cause.message
              : "Could not save the seller return decision.",
        },
      }));
    } finally {
      setWorkingOrderItemId("");
    }
  }

  return (
    <main className="seller-page">
      <header className="account-header">
        <Link className="wordmark" href="/">morrow<span>.</span></Link>
        <div className="seller-nav">
          {account && <span>{account.email ?? account.mobileNumber}</span>}
          <Link className="text-link" href="/account">Account ↗</Link>
          <Link className="button button-dark dashboard-home-link" href="/">Home</Link>
        </div>
      </header>

      <section className="seller-intro">
        <p className="eyebrow">SELLER SPACE</p>
        <h1>Your store, thoughtfully managed.</h1>
        <p>Manage listings for your approved store. Submitted products are reviewed by a platform administrator before they appear in the catalog.</p>
      </section>

      <section className="seller-content">
        {checking && <p className="catalog-message" role="status">Checking your store access…</p>}
        {!checking && !account && (
          <div className="catalog-empty">
            <h2>Sign in to your seller account.</h2>
            <Link className="button button-dark" href="/account">Go to your account <span>↗</span></Link>
          </div>
        )}
        {!checking && account && !account.storeId && (
          <div className="catalog-empty">
            <h2>Start your seller application.</h2>
            <p>Apply for a store from your account before submitting business verification.</p>
            <Link className="text-link" href="/account">Apply to sell ↗</Link>
          </div>
        )}
        {account?.storeId && verification && (
          <section className="seller-verification">
            <p className="eyebrow">BUSINESS VERIFICATION</p>
            <h2>Verify your business.</h2>
            <p className="form-hint">
              Your information and documents are private and visible only to authorized marketplace reviewers.
              Format checks do not confirm that a PAN, GSTIN, or document is genuine.
            </p>
            <p className={`verification-status verification-status-${verification.status.toLowerCase()}`} role="status">
              Status: {verification.status.replaceAll("_", " ")}
            </p>
            {verification.reason && (
              <p className="verification-reason"><strong>Reviewer feedback:</strong> {verification.reason}</p>
            )}
            {verification.status === "PENDING_REVIEW" && (
              <p className="form-hint">Your submission is waiting for manual review. Automated government verification is NOT CONFIGURED.</p>
            )}
            {verification.status === "APPROVED" && verification.storeStatus !== "approved" && (
              <p className="form-hint">Business verification is approved. Store access remains unavailable until a Super Admin approves the store application.</p>
            )}
            {!verification.submissionAvailable && verification.status !== "PENDING_REVIEW" && verification.status !== "APPROVED" && (
              <p className="form-message form-error">
                Private document storage and the KYC encryption key are not configured. Ask the platform operator to configure them before submitting documents.
              </p>
            )}
            {verification.submissionAvailable && (
              <form className="account-form verification-form" onSubmit={submitVerification}>
                <label htmlFor="legalName">Legal business / proprietor name</label>
                <input id="legalName" name="legalName" required minLength={2} maxLength={120} autoComplete="organization" />
                <label htmlFor="tradeName">Shop or trade name</label>
                <input id="tradeName" name="tradeName" required minLength={2} maxLength={120} autoComplete="organization" />
                <label htmlFor="businessType">Business type</label>
                <select
                  id="businessType"
                  name="businessType"
                  value={businessType}
                  onChange={(event) => setBusinessType(event.target.value)}
                  required
                >
                  <option value="PROPRIETORSHIP">Proprietorship</option>
                  <option value="PARTNERSHIP">Partnership</option>
                  <option value="LLP">LLP</option>
                  <option value="COMPANY">Company</option>
                  <option value="OTHER">Other</option>
                </select>
                <label htmlFor="pan">
                  {businessType === "PROPRIETORSHIP"
                    ? "Proprietor PAN"
                    : businessType === "OTHER"
                      ? "PAN of responsible person or entity"
                      : "Business entity PAN"}
                </label>
                <input id="pan" name="pan" required minLength={10} maxLength={10} pattern="[A-Za-z]{5}[0-9]{4}[A-Za-z]" autoComplete="off" />
                <label htmlFor="gstRegistration">GST registration</label>
                <select
                  id="gstRegistration"
                  name="gstRegistration"
                  value={gstRegistration}
                  onChange={(event) => setGstRegistration(event.target.value)}
                  required
                >
                  <option value="NOT_REQUIRED">I am not legally required to register for GST</option>
                  <option value="REGISTERED">My business is GST-registered</option>
                </select>
                {gstRegistration === "REGISTERED" ? (
                  <>
                    <label htmlFor="gstin">GSTIN</label>
                    <input id="gstin" name="gstin" required minLength={15} maxLength={15} pattern="[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z]Z[A-Za-z0-9]" autoComplete="off" />
                    <label htmlFor="gstCertificate">GST registration certificate (PDF, JPEG, or PNG; up to 10 MB)</label>
                    <input id="gstCertificate" name="gstCertificate" type="file" accept="application/pdf,image/jpeg,image/png" required />
                  </>
                ) : (
                  <p className="form-hint">No GSTIN or GST certificate is required when you are not legally required to register.</p>
                )}
                <label htmlFor="businessAddress">Business address</label>
                <textarea id="businessAddress" name="businessAddress" required minLength={5} maxLength={300} rows={3} autoComplete="street-address" />
                <div className="seller-form-row">
                  <div>
                    <label htmlFor="businessState">State / Union Territory</label>
                    <input id="businessState" name="businessState" required minLength={2} maxLength={80} autoComplete="address-level1" />
                  </div>
                  <div>
                    <label htmlFor="businessCity">City</label>
                    <input id="businessCity" name="businessCity" required minLength={2} maxLength={80} autoComplete="address-level2" />
                  </div>
                </div>
                <label htmlFor="pinCode">PIN code</label>
                <input id="pinCode" name="pinCode" required minLength={6} maxLength={6} pattern="[1-9][0-9]{5}" inputMode="numeric" autoComplete="postal-code" />
                <label htmlFor="businessProof">Shop / business proof document (PDF, JPEG, or PNG; up to 10 MB)</label>
                <input id="businessProof" name="businessProof" type="file" accept="application/pdf,image/jpeg,image/png" required />
                <label className="verification-consent">
                  <input name="verificationConsent" type="checkbox" required />
                  <span>I consent to Morrow collecting and manually reviewing these business details and documents to verify my seller application. The information will not be used as public product content.</span>
                </label>
                {verificationProgress !== null && (
                  <div className="seller-upload-progress" role="status">
                    <progress value={verificationProgress} max={100} />
                    <span>Submitting private documents: {verificationProgress}%</span>
                  </div>
                )}
                <p className="form-hint">Checks are manual. Government API verification: NOT CONFIGURED.</p>
                <button className="button button-dark" type="submit" disabled={verificationSubmitting}>
                  {verificationSubmitting ? "Submitting verification…" : "Submit for verification"} <span aria-hidden="true">↗</span>
                </button>
              </form>
            )}
          </section>
        )}
        {account?.storeId &&
          account.roles.includes("seller") &&
          verification?.status === "APPROVED" &&
          verification.storeStatus === "approved" && (
          <>
            <div className="seller-layout">
            <section className="seller-create">
              <p className="eyebrow">{editingProduct ? "UPDATE LISTING" : "NEW LISTING"}</p>
              <h2>{editingProduct ? "Update product details." : "Create a product draft."}</h2>
              <p className="form-hint">Price is entered in rupees. Product images are securely uploaded and reviewed with your listing.</p>
              <form
                className="account-form"
                key={editingProduct?.id ?? "new-product"}
                onSubmit={createDraft}
              >
                <label htmlFor="title">Product name</label>
                <input id="title" name="title" required minLength={2} maxLength={160} defaultValue={editingProduct?.title ?? ""} />
                <label htmlFor="description">Description</label>
                <textarea id="description" name="description" required minLength={10} maxLength={5000} rows={4} defaultValue={editingProduct?.description ?? ""} />
                <label htmlFor="brand">Brand or maker</label>
                <input id="brand" name="brand" required minLength={1} maxLength={80} defaultValue={editingProduct?.brand ?? ""} />
                <label htmlFor="sku">SKU (unique in your store)</label>
                <input id="sku" name="sku" required minLength={1} maxLength={64} pattern="[A-Za-z0-9._-]+" defaultValue={editingProduct?.sku ?? ""} />
                <label htmlFor="category">Category slug</label>
                <input id="category" name="category" required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="home-goods" defaultValue={editingProduct?.category ?? ""} />
                <div className="seller-form-row">
                  <div>
                    <label htmlFor="price">Price (₹)</label>
                    <input id="price" name="price" type="number" required min="0.01" max="10000000000" step="0.01" defaultValue={editingProduct ? editingProduct.priceMinor / 100 : ""} />
                  </div>
                  <div>
                    <label htmlFor="stock">Stock</label>
                    <input id="stock" name="stock" type="number" required min="0" max="1000000" step="1" defaultValue={editingProduct?.stock ?? ""} />
                  </div>
                </div>
                <label htmlFor="productImages">
                  Product images (3–5 for a new listing; JPEG, PNG, or WebP; up to 5 MB each)
                </label>
                <input
                  id="productImages"
                  name="productImages"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(event) => {
                    addProductImages(event.currentTarget.files);
                    event.currentTarget.value = "";
                    setUploadProgress(null);
                  }}
                  disabled={submitting || productImageDrafts.length >= 5}
                />
                <p className="form-hint">
                  {productImageDrafts.length} of 5 images · The first image is the primary image. Use Move up or Set as primary to change the order.
                </p>
                {productImageDrafts.length > 0 && (
                  <ol className="seller-image-gallery" aria-label="Product images in display order">
                    {productImageDrafts.map((image, index) => (
                      <li className="seller-image-preview" key={image.key}>
                        <img
                          src={image.previewUrl ?? image.url}
                          alt={image.altText || "Selected product image preview"}
                        />
                        <div className="seller-image-preview-details">
                          <strong>{index === 0 ? "Primary image" : `Image ${index + 1}`}</strong>
                          {image.file && <span>{image.file.name} · Ready to upload</span>}
                          <label htmlFor={`product-image-alt-${index}`}>Image description</label>
                          <input
                            id={`product-image-alt-${index}`}
                            value={image.altText}
                            onChange={(event) =>
                              updateImageDraft(image.key, { altText: event.target.value })
                            }
                            required
                            minLength={3}
                            maxLength={180}
                            disabled={submitting}
                          />
                          <div className="seller-image-actions">
                            {index > 0 && (
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => moveImageDraft(image.key, 0)}
                                disabled={submitting}
                              >
                                Set as primary
                              </button>
                            )}
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => moveImageDraft(image.key, index - 1)}
                              disabled={submitting || index === 0}
                              aria-label={`Move image ${index + 1} up`}
                            >
                              Move up
                            </button>
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => moveImageDraft(image.key, index + 1)}
                              disabled={submitting || index === productImageDrafts.length - 1}
                              aria-label={`Move image ${index + 1} down`}
                            >
                              Move down
                            </button>
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => removeImageDraft(image.key)}
                              disabled={submitting}
                              aria-label={`Remove image ${index + 1}`}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                {uploadProgress !== null && (
                  <div className="seller-upload-progress" role="status">
                    <progress value={uploadProgress} max={100} />
                    <span>Uploading image {uploadingImageIndex} of {productImageDrafts.length}: {uploadProgress}%</span>
                  </div>
                )}
                <button className="button button-dark" type="submit" disabled={submitting || !apiUrl}>
                  {submitting
                    ? uploadProgress !== null
                      ? `Uploading image ${uploadingImageIndex} of ${productImageDrafts.length}…`
                      : "Saving…"
                    : editingProduct
                      ? "Save and resubmit"
                      : "Save images and submit for review"} <span aria-hidden="true">↗</span>
                </button>
                {editingProduct && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      releaseImagePreviews(productImageDrafts);
                      setEditingProduct(null);
                      setProductImageDrafts([]);
                      setUploadProgress(null);
                    }}
                    disabled={submitting}
                  >
                    Cancel editing
                  </button>
                )}
              </form>
            </section>

            <section className="seller-products">
              <p className="eyebrow">YOUR LISTINGS</p>
              <h2>Products</h2>
              {products.length === 0 ? (
                <p className="account-description">No product drafts yet.</p>
              ) : (
                <div className="seller-product-list">
                  {products.map((product) => (
                    <article className="seller-product-row" key={product.id}>
                      <div>
                        <p className="product-brand">{product.brand} · {product.sku}</p>
                        <h3>{product.title}</h3>
                        <p className="seller-product-meta">
                          {product.category.replaceAll("-", " ")} · {product.stock} in stock ·{" "}
                          {new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(product.priceMinor / 100)}
                        </p>
                      </div>
                      <div className="seller-product-actions">
                        <span className={`role-chip status-chip-${product.status}`}>{product.status}</span>
                        {(product.status === "draft" || product.status === "rejected") && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setEditingProduct(product);
                              releaseImagePreviews(productImageDrafts);
                              setProductImageDrafts(existingImageDrafts(product.images));
                              setError("");
                              setNotice("");
                            }}
                            disabled={submitting}
                          >
                            {product.status === "rejected" ? "Edit and resubmit" : "Edit draft"}
                          </button>
                        )}
                        {product.status !== "archived" && (
                          <button type="button" className="text-button" onClick={() => void archiveProduct(product.id)} disabled={submitting}>
                            Archive
                          </button>
                        )}
                        {product.status === "archived" && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void restoreProduct(product.id)}
                            disabled={submitting}
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
            </div>
            <section className="seller-orders" aria-labelledby="seller-orders-title">
            <p className="eyebrow">FULFILMENT</p>
            <h2 id="seller-orders-title">Orders</h2>
            <p className="account-description">
              Statuses are updated manually by your store. Courier tracking and delivery events are not connected.
            </p>
            {ordersLoading ? (
              <p className="account-description" role="status">Loading your orders…</p>
            ) : orders.length === 0 ? (
              <p className="account-description">No orders for your store yet.</p>
            ) : (
              <div className="seller-order-list">
                {orders.map((order) => (
                  <article className="seller-order-card" key={order.id}>
                    <header>
                      <div>
                        <p className="product-brand">
                          Order · {new Date(order.createdAt).toLocaleDateString("en-IN")}
                        </p>
                        <h3>{order.delivery.recipientName}</h3>
                        <p className="seller-product-meta">
                          {order.delivery.phone} · {order.delivery.address}, {order.delivery.city},{" "}
                          {order.delivery.state} {order.delivery.pinCode}
                        </p>
                      </div>
                      <small>{order.id}</small>
                    </header>
                    {order.items.map((item) => {
                      const nextStatuses = nextSellerStatuses[item.sellerStatus];
                      return (
                        <div className="seller-order-item" key={item.id}>
                          <div>
                            <h4>{item.title}</h4>
                            <p>{item.brand} · quantity {item.quantity}</p>
                            <p>
                              {new Intl.NumberFormat("en-IN", {
                                style: "currency",
                                currency: "INR",
                              }).format(item.lineTotalMinor / 100)}
                            </p>
                          </div>
                          <div className="seller-order-item-actions">
                            <span className="role-chip">
                              {item.sellerStatus.replaceAll("_", " ")}
                            </span>
                            {nextStatuses.map((status) => (
                              <button
                                className="text-button"
                                type="button"
                                key={status}
                                disabled={workingOrderItemId !== ""}
                                onClick={() =>
                                  void updateOrderItemStatus(order.id, item.id, status)
                                }
                              >
                                {workingOrderItemId === item.id
                                  ? "Updating…"
                                  : status === "CANCELLED"
                                    ? "Cancel item"
                                    : `Mark ${status.replaceAll("_", " ").toLowerCase()}`}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {order.returns.map((returnRequest) => (
                      <section
                        className="seller-return-request"
                        key={returnRequest.id}
                        aria-busy={workingOrderItemId === returnRequest.id}
                      >
                        <h4>
                          Return request ·{" "}
                          {order.items.find((item) => item.id === returnRequest.orderItemId)?.title ??
                            "Order item"}
                        </h4>
                        <p>Customer reason: {returnRequest.reason}</p>
                        <p>
                          Return status: {formatReturnStatus(returnRequest.status)}
                        </p>
                        {returnRequest.status === "REQUESTED" &&
                          returnRequest.sellerResponseDeadlineAt &&
                          Number.isFinite(Date.parse(returnRequest.sellerResponseDeadlineAt)) && (
                            <p>
                              Response deadline:{" "}
                              <time dateTime={returnRequest.sellerResponseDeadlineAt}>
                                {new Date(returnRequest.sellerResponseDeadlineAt).toLocaleString()}
                              </time>
                              {Date.parse(returnRequest.sellerResponseDeadlineAt) <= returnClock
                                ? " · Deadline passed; automatic acceptance is processing."
                                : ""}
                            </p>
                          )}
                        {returnRequest.images.length > 0 && (
                          <>
                            <p>Damage photos</p>
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
                          </>
                        )}
                        {returnRequest.sellerReviewReason && (
                          <p>Seller rejection reason: {returnRequest.sellerReviewReason}</p>
                        )}
                        {returnRequest.sellerReviewStatus === "PENDING" &&
                          returnRequest.status === "REQUESTED" &&
                          (!returnRequest.sellerResponseDeadlineAt ||
                            Date.parse(returnRequest.sellerResponseDeadlineAt) > returnClock) && (
                            <div className="seller-return-actions">
                              <label>
                                Rejection reason (required to reject)
                                <textarea
                                  value={returnReviewReasons[returnRequest.id] ?? ""}
                                  maxLength={500}
                                  disabled={workingOrderItemId === returnRequest.id}
                                  onChange={(event) => {
                                    setReturnReviewReasons({
                                      ...returnReviewReasons,
                                      [returnRequest.id]: event.target.value,
                                    });
                                    if (returnActionFeedback[returnRequest.id]?.error) {
                                      setReturnActionFeedback((current) => ({
                                        ...current,
                                        [returnRequest.id]: {},
                                      }));
                                    }
                                  }}
                                />
                              </label>
                              <button
                                className="text-button"
                                type="button"
                                disabled={workingOrderItemId !== ""}
                                onClick={() =>
                                  void decideReturn(
                                    order.id,
                                    returnRequest.id,
                                    "ACCEPTED",
                                  )
                                }
                              >
                                {workingOrderItemId === returnRequest.id
                                  ? "Accepting…"
                                  : "Accept return"}
                              </button>
                              <button
                                className="text-button"
                                type="button"
                                disabled={workingOrderItemId !== ""}
                                onClick={() =>
                                  void decideReturn(
                                    order.id,
                                    returnRequest.id,
                                    "REJECTED",
                                  )
                                }
                              >
                                {workingOrderItemId === returnRequest.id
                                  ? "Saving rejection…"
                                  : "Reject return"}
                              </button>
                            </div>
                          )}
                        {returnActionFeedback[returnRequest.id]?.error && (
                          <p className="form-message form-error" role="alert">
                            {returnActionFeedback[returnRequest.id].error}
                          </p>
                        )}
                        {returnActionFeedback[returnRequest.id]?.success && (
                          <p className="form-message form-notice" role="status">
                            {returnActionFeedback[returnRequest.id].success}
                          </p>
                        )}
                        {returnRequest.sellerReviewedAt &&
                          Number.isFinite(Date.parse(returnRequest.sellerReviewedAt)) && (
                            <p>
                              Decision recorded:{" "}
                              <time dateTime={returnRequest.sellerReviewedAt}>
                                {new Date(returnRequest.sellerReviewedAt).toLocaleString()}
                              </time>
                              {returnRequest.decisionSource === "SYSTEM_AUTO_ACCEPTED" ||
                              returnRequest.sellerReviewStatus === "SYSTEM_AUTO_ACCEPTED"
                                ? " · SYSTEM_AUTO_ACCEPTED"
                                : ""}
                            </p>
                          )}
                        <p>
                          Refund status: not processed.
                        </p>
                      </section>
                    ))}
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

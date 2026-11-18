export const ROLES = ["customer", "seller", "super_admin"] as const;
export type Role = (typeof ROLES)[number];

export interface UserRecord {
  id: string;
  email?: string;
  mobileNumber?: string;
  passwordHash?: string;
  roles: Role[];
  createdAt: string;
  storeId?: string;
}

export interface CustomerOtpRecord {
  mobileNumber: string;
  codeHash: string;
  issuedAt: number;
  expiresAt: number;
  attemptsRemaining: number;
  consumed?: boolean;
}

export interface SellerStore {
  id: string;
  ownerUserId: string;
  name: string;
  status: "pending" | "approved" | "rejected" | "suspended";
  createdAt: string;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

export interface ProductImage {
  url: string;
  altText: string;
}

export interface ProductRecord {
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
  images: ProductImage[];
  specifications: Record<string, string>;
  status: "draft" | "rejected" | "active" | "archived";
  archivedFromStatus?: "draft" | "rejected" | "active";
  createdAt: string;
  updatedAt: string;
}

export type CatalogSort = "newest" | "price_asc" | "price_desc";

export interface CatalogPage {
  items: ProductRecord[];
  nextCursor: string | null;
}

export interface SellerStorePage {
  items: SellerStore[];
  nextCursor: string | null;
}

export type SellerBusinessType =
  | "PROPRIETORSHIP"
  | "PARTNERSHIP"
  | "LLP"
  | "COMPANY"
  | "OTHER";

export type SellerGstRegistration = "REGISTERED" | "NOT_REQUIRED";

export type SellerVerificationStatus =
  | "NOT_SUBMITTED"
  | "PENDING_REVIEW"
  | "NEEDS_CORRECTION"
  | "APPROVED"
  | "REJECTED";

export interface SellerVerificationDetails {
  legalName: string;
  tradeName: string;
  businessType: SellerBusinessType;
  gstRegistration: SellerGstRegistration;
  gstin: string | null;
  pan: string;
  address: string;
  state: string;
  city: string;
  pinCode: string;
}

export interface SellerVerificationDocument {
  id: string;
  kind: "BUSINESS_PROOF" | "GST_CERTIFICATE";
  objectKey: string;
  contentType: "image/webp" | "application/pdf";
  createdAt: string;
}

export interface SellerVerificationReview {
  status: Exclude<SellerVerificationStatus, "NOT_SUBMITTED" | "PENDING_REVIEW">;
  reviewerUserId: string;
  reason?: string;
  createdAt: string;
}

export interface SellerVerificationAuditEntry {
  status: Exclude<SellerVerificationStatus, "NOT_SUBMITTED">;
  actorUserId: string;
  reason?: string;
  createdAt: string;
}

export interface SellerVerificationRecord {
  storeId: string;
  ownerUserId: string;
  status: Exclude<SellerVerificationStatus, "NOT_SUBMITTED">;
  encryptedData: string;
  documents: SellerVerificationDocument[];
  history: SellerVerificationAuditEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface SellerVerificationSummary {
  storeId: string;
  status: SellerVerificationStatus;
  updatedAt?: string;
}

export interface CartItemInput {
  productId: string;
  quantity: number;
  size?: string;
}

export function validateCartItemForProduct(
  product: Pick<ProductRecord, "category" | "stock" | "specifications">,
  item: CartItemInput,
): void {
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
    throw new MarketplaceError(400, "Quantity must be between 1 and 99.");
  }
  if (item.quantity > product.stock) {
    throw new MarketplaceError(409, `Only ${product.stock} units are available.`);
  }
  const footwear = /shoe|footwear|sneaker|boot|sandal/i.test(product.category);
  if (footwear) {
    const listedSizes = Object.entries(product.specifications).find(([name]) =>
      /^(available\s+)?(shoe\s*)?sizes?$/i.test(name.trim()),
    )?.[1];
    const parsedSizes = listedSizes
      ?.split(/[,;|\/]/)
      .map((size) => size.trim())
      .filter(Boolean);
    const availableSizes =
      parsedSizes?.length ? parsedSizes : ["5", "6", "7", "8", "9", "10", "11", "12"];
    if (!item.size || !availableSizes.includes(item.size)) {
      throw new MarketplaceError(400, "Choose an available shoe size before continuing.");
    }
  }
  if (!footwear && item.size) {
    throw new MarketplaceError(400, "A size can only be selected for footwear.");
  }
}

export interface CartRecord {
  userId: string;
  items: CartItemInput[];
  updatedAt: string;
  revision: string;
}

export interface DeliveryDetails {
  recipientName: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pinCode: string;
}

export interface OrderItemRecord {
  id: string;
  productId: string;
  sellerId: string;
  storeId: string;
  title: string;
  brand: string;
  imageUrl: string | null;
  quantity: number;
  size?: string;
  sellerStatus?: OrderStatus;
  sellerStatusHistory?: OrderStatusHistoryRecord[];
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED";
export interface OrderStatusHistoryRecord {
  status: OrderStatus;
  updatedAt: string;
}
export type OrderDeliveryStatus = "NOT_DELIVERED" | "LOCAL_TEST_DELIVERED";
export type OrderReturnStatus = "REQUESTED" | "ACCEPTED" | "REJECTED";
export type SimulatedRefundStatus = "NOT_APPLICABLE" | "LOCAL_SIMULATED_NOT_PROCESSED";

const orderStatusTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransitionOrderStatus(
  current: OrderStatus,
  next: OrderStatus,
): boolean {
  return orderStatusTransitions[current].includes(next);
}

export interface OrderReturnRecord {
  id: string;
  orderItemId: string;
  productId: string;
  customerId: string;
  reason: string;
  status: OrderReturnStatus;
  refundStatus: SimulatedRefundStatus;
  images: OrderReturnImageRecord[];
  createdAt: string;
  updatedAt: string;
  sellerResponseDeadlineAt?: string;
  sellerReviewStatus:
    | "PENDING"
    | "ACCEPTED"
    | "REJECTED"
    | "SYSTEM_AUTO_ACCEPTED"
    | "FORWARDED";
  sellerRecommendation?: "ACCEPTED" | "REJECTED";
  decisionSource?: "SELLER" | "SYSTEM_AUTO_ACCEPTED";
  sellerReviewedByUserId?: string;
  sellerReviewReason?: string;
  sellerReviewedAt?: string;
  adminReviewAvailableAt?: string;
  reviewedByUserId?: string;
  reviewReason?: string;
}

export interface OrderReturnImageRecord {
  id: string;
  objectKey: string;
  contentType: "image/webp";
  createdAt: string;
}

export interface OrderRecord {
  id: string;
  customerId: string;
  items: OrderItemRecord[];
  delivery: DeliveryDetails;
  subtotalMinor: number;
  totalMinor: number;
  currency: "INR";
  status: OrderStatus;
  paymentResult: "NOT_CONFIGURED" | "LOCAL_SIMULATED_SUCCESS";
  deliveryStatus: OrderDeliveryStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  returns: OrderReturnRecord[];
}

export function sellerOrderForStore(
  order: OrderRecord,
  storeId: string,
  sellerId: string,
): OrderRecord | null {
  const items = order.items.filter(
    (item) => item.storeId === storeId && item.sellerId === sellerId,
  );
  if (items.length === 0) return null;
  return customerOrderForTracking({
    ...order,
    items: items.map((item) => ({
      ...item,
      sellerStatus: item.sellerStatus ?? order.status,
    })),
    returns: order.returns.filter((entry) =>
      items.some((item) => item.id === entry.orderItemId),
    ),
  });
}

export function customerOrderForTracking(order: OrderRecord): OrderRecord {
  const items = order.items.map((item) => ({
    ...item,
    sellerStatus: item.sellerStatus ?? order.status,
  }));
  const activeStatuses = items
    .map((item) => item.sellerStatus ?? order.status)
    .filter((status) => status !== "CANCELLED");
  let status = order.status;
  if (order.status === "PENDING") {
    if (activeStatuses.length === 0) {
      status = "CANCELLED";
    } else {
      const progress: OrderStatus[] = [
        "PENDING",
        "CONFIRMED",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
      ];
      status = activeStatuses.reduce((leastAdvanced, current) =>
        progress.indexOf(current) < progress.indexOf(leastAdvanced)
          ? current
          : leastAdvanced,
      );
    }
  }
  return { ...order, status, items };
}

export interface AuthRepository {
  createUser(user: UserRecord): Promise<void>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserByMobileNumber(mobileNumber: string): Promise<UserRecord | null>;
  getUserById(userId: string): Promise<UserRecord | null>;
  saveCustomerOtp(record: CustomerOtpRecord, resendAfter: number): Promise<boolean>;
  verifyCustomerOtp(
    mobileNumber: string,
    codeHash: string,
    now: number,
  ): Promise<"verified" | "invalid" | "expired" | "locked" | "missing">;
  createSession(session: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  createSellerStore(store: SellerStore): Promise<void>;
  getSellerStore(storeId: string): Promise<SellerStore | null>;
  getSellerVerification(storeId: string): Promise<SellerVerificationRecord | null>;
  saveSellerVerification(record: SellerVerificationRecord): Promise<void>;
  listPendingSellerVerifications(
    limit: number,
    cursor: string | null,
  ): Promise<{ items: SellerVerificationSummary[]; nextCursor: string | null }>;
  reviewSellerVerification(
    storeId: string,
    reviewerUserId: string,
    status: SellerVerificationReview["status"],
    reason?: string,
  ): Promise<void>;
  approveSellerStore(storeId: string, approvedByUserId: string): Promise<void>;
  createProduct(product: ProductRecord): Promise<void>;
  getProduct(productId: string): Promise<ProductRecord | null>;
  listSellerProducts(
    storeId: string,
    limit: number,
    cursor: string | null,
  ): Promise<CatalogPage>;
  listCatalog(
    filters: {
      category?: string;
      brand?: string;
      search?: string;
      minPrice?: number;
      maxPrice?: number;
      sort: CatalogSort;
    },
    limit: number,
    cursor: string | null,
  ): Promise<CatalogPage>;
  updateDraftProduct(
    product: ProductRecord,
    expectedStoreId: string,
  ): Promise<void>;
  archiveProduct(productId: string, storeId: string): Promise<void>;
  restoreProduct(productId: string, storeId: string): Promise<void>;
  listPendingStores(limit: number, cursor: string | null): Promise<SellerStorePage>;
  listPendingProducts(limit: number, cursor: string | null): Promise<CatalogPage>;
  rejectSellerStore(
    storeId: string,
    rejectedByUserId: string,
    reason: string,
  ): Promise<void>;
  approveProduct(productId: string, approvedByUserId: string): Promise<void>;
  rejectProduct(
    productId: string,
    rejectedByUserId: string,
    reason: string,
  ): Promise<void>;
  getCart(userId: string): Promise<CartRecord>;
  saveCart(userId: string, items: CartItemInput[], updatedAt: string): Promise<CartRecord>;
  checkout(
    userId: string,
    delivery: DeliveryDetails,
    idempotencyKey: string,
    now: string,
    items?: CartItemInput[],
  ): Promise<OrderRecord>;
  cancelOrder(orderId: string, customerId: string, now: string): Promise<OrderRecord>;
  getOrder(orderId: string): Promise<OrderRecord | null>;
  listCustomerOrders(userId: string): Promise<OrderRecord[]>;
  listAdminOrders(): Promise<OrderRecord[]>;
  listSellerOrders(storeId: string, sellerId: string): Promise<OrderRecord[]>;
  updateSellerOrderItemStatus(
    orderId: string,
    itemId: string,
    storeId: string,
    sellerId: string,
    status: OrderStatus,
    now: string,
  ): Promise<OrderRecord>;
  updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    adminUserId: string,
    now: string,
  ): Promise<OrderRecord>;
  requestOrderItemReturn(
    orderId: string,
    itemId: string,
    customerId: string,
    reason: string,
    images: OrderReturnImageRecord[],
    now: string,
    sellerResponseDeadlineAt: string,
  ): Promise<OrderReturnRecord>;
  decideOrderItemReturn(
    orderId: string,
    returnId: string,
    storeId: string,
    sellerId: string,
    decision: "ACCEPTED" | "REJECTED",
    reason: string,
    now: string,
  ): Promise<OrderReturnRecord>;
  processExpiredReturnRequests(now: string): Promise<number>;
}

export class MarketplaceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLES.includes(value as Role);
}

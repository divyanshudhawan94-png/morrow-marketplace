import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  MarketplaceError,
  canTransitionOrderStatus,
  customerOrderForTracking,
  isRole,
  type AuthRepository,
  type CatalogPage,
  type CatalogSort,
  type CartItemInput,
  type CartRecord,
  type CustomerOtpRecord,
  type DeliveryDetails,
  type OrderRecord,
  type OrderReturnRecord,
  type OrderStatus,
  type ProductRecord,
  type Role,
  type SellerStore,
  type SellerStorePage,
  type SellerVerificationRecord,
  type SellerVerificationReview,
  type SellerVerificationSummary,
  type SessionRecord,
  type UserRecord,
  sellerOrderForStore,
  validateCartItemForProduct,
} from "./repository.js";
import {
  normalizeSearchText,
  rankCatalogProducts,
  searchTermAlternatives,
  searchTermMatch,
  searchIndexSignatures,
  searchTerms,
} from "./catalog-search.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readUser(item: Record<string, unknown> | undefined): UserRecord | null {
  if (
    !item ||
    typeof item.id !== "string" ||
    (item.email !== undefined && typeof item.email !== "string") ||
    (item.mobileNumber !== undefined && typeof item.mobileNumber !== "string") ||
    (item.passwordHash !== undefined && typeof item.passwordHash !== "string") ||
    (typeof item.email !== "string" && typeof item.mobileNumber !== "string") ||
    typeof item.createdAt !== "string" ||
    !Array.isArray(item.roles)
  ) {
    return null;
  }

  const roles = item.roles.filter(isRole);
  return {
    id: item.id,
    ...(typeof item.email === "string" ? { email: item.email } : {}),
    ...(typeof item.mobileNumber === "string" ? { mobileNumber: item.mobileNumber } : {}),
    ...(typeof item.passwordHash === "string" ? { passwordHash: item.passwordHash } : {}),
    roles,
    createdAt: item.createdAt,
    ...(typeof item.storeId === "string" ? { storeId: item.storeId } : {}),
  };
}

function readStore(item: Record<string, unknown> | undefined): SellerStore | null {
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.ownerUserId !== "string" ||
    typeof item.name !== "string" ||
    typeof item.createdAt !== "string" ||
    (item.status !== "pending" &&
      item.status !== "approved" &&
      item.status !== "rejected" &&
      item.status !== "suspended")
  ) {
    return null;
  }

  return {
    id: item.id,
    ownerUserId: item.ownerUserId,
    name: item.name,
    status: item.status,
    createdAt: item.createdAt,
  };
}

function readProduct(item: Record<string, unknown> | undefined): ProductRecord | null {
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.sellerId !== "string" ||
    typeof item.storeId !== "string" ||
    typeof item.title !== "string" ||
    typeof item.description !== "string" ||
    typeof item.brand !== "string" ||
    typeof item.sku !== "string" ||
    typeof item.category !== "string" ||
    item.currency !== "INR" ||
    typeof item.priceMinor !== "number" ||
    typeof item.stock !== "number" ||
    !Array.isArray(item.images) ||
    !isRecord(item.specifications) ||
    (item.status !== "draft" &&
      item.status !== "rejected" &&
      item.status !== "active" &&
      item.status !== "archived") ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string"
  ) {
    return null;
  }

  const images = item.images.filter(
    (image): image is { url: string; altText: string } =>
      isRecord(image) &&
      typeof image.url === "string" &&
      typeof image.altText === "string",
  );
  const specifications: Record<string, string> = {};
  for (const [key, value] of Object.entries(item.specifications)) {
    if (typeof value !== "string") return null;
    specifications[key] = value;
  }

  return {
    id: item.id,
    sellerId: item.sellerId,
    storeId: item.storeId,
    title: item.title,
    description: item.description,
    brand: item.brand,
    sku: item.sku,
    category: item.category,
    currency: "INR",
    priceMinor: item.priceMinor,
    stock: item.stock,
    images,
    specifications,
    status: item.status,
    ...(item.archivedFromStatus === "draft" ||
    item.archivedFromStatus === "rejected" ||
    item.archivedFromStatus === "active"
      ? { archivedFromStatus: item.archivedFromStatus }
      : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function readSellerVerification(
  item: Record<string, unknown> | undefined,
): SellerVerificationRecord | null {
  if (
    !item ||
    typeof item.storeId !== "string" ||
    typeof item.ownerUserId !== "string" ||
    typeof item.encryptedData !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string" ||
    (item.status !== "PENDING_REVIEW" &&
      item.status !== "NEEDS_CORRECTION" &&
      item.status !== "APPROVED" &&
      item.status !== "REJECTED") ||
    !Array.isArray(item.documents) ||
    !Array.isArray(item.history)
  ) {
    return null;
  }
  const documents = item.documents.filter(
    (document): document is SellerVerificationRecord["documents"][number] =>
      isRecord(document) &&
      typeof document.id === "string" &&
      (document.kind === "BUSINESS_PROOF" || document.kind === "GST_CERTIFICATE") &&
      typeof document.objectKey === "string" &&
      (document.contentType === "image/webp" || document.contentType === "application/pdf") &&
      typeof document.createdAt === "string",
  );
  const history = item.history.filter(
    (entry): entry is SellerVerificationRecord["history"][number] =>
      isRecord(entry) &&
      (entry.status === "PENDING_REVIEW" ||
        entry.status === "NEEDS_CORRECTION" ||
        entry.status === "APPROVED" ||
        entry.status === "REJECTED") &&
      typeof entry.actorUserId === "string" &&
      typeof entry.createdAt === "string" &&
      (entry.reason === undefined || typeof entry.reason === "string"),
  );
  return {
    storeId: item.storeId,
    ownerUserId: item.ownerUserId,
    status: item.status,
    encryptedData: item.encryptedData,
    documents,
    history,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function readOrder(item: Record<string, unknown> | undefined): OrderRecord | null {
  const orderStatus =
    item?.status === "PLACED"
      ? item.deliveryStatus === "LOCAL_TEST_DELIVERED"
        ? "DELIVERED"
        : "PENDING"
      : item?.status;
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.customerId !== "string" ||
    !Array.isArray(item.items) ||
    !isRecord(item.delivery) ||
    typeof item.subtotalMinor !== "number" ||
    typeof item.totalMinor !== "number" ||
    item.currency !== "INR" ||
    !isOrderStatus(orderStatus) ||
    (item.paymentResult !== "NOT_CONFIGURED" &&
      item.paymentResult !== "LOCAL_SIMULATED_SUCCESS") ||
    (item.deliveryStatus !== "NOT_DELIVERED" &&
      item.deliveryStatus !== "LOCAL_TEST_DELIVERED") ||
    typeof item.idempotencyKey !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string"
  ) {
    return null;
  }
  const delivery = item.delivery;
  if (
    typeof delivery.recipientName !== "string" ||
    typeof delivery.phone !== "string" ||
    typeof delivery.address !== "string" ||
    typeof delivery.city !== "string" ||
    typeof delivery.state !== "string" ||
    typeof delivery.pinCode !== "string"
  ) {
    return null;
  }
  const items = item.items.filter(
    (entry): entry is OrderRecord["items"][number] =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      typeof entry.productId === "string" &&
      typeof entry.sellerId === "string" &&
      typeof entry.storeId === "string" &&
      typeof entry.title === "string" &&
      typeof entry.brand === "string" &&
      (typeof entry.imageUrl === "string" || entry.imageUrl === null) &&
      (entry.size === undefined || typeof entry.size === "string") &&
      (entry.sellerStatus === undefined ||
        isOrderStatus(entry.sellerStatus)) &&
      (entry.sellerStatusHistory === undefined ||
        (Array.isArray(entry.sellerStatusHistory) &&
          entry.sellerStatusHistory.every(
            (history) =>
              isRecord(history) &&
              isOrderStatus(history.status) &&
              typeof history.updatedAt === "string",
          ))) &&
      Number.isSafeInteger(entry.quantity) &&
      typeof entry.quantity === "number" &&
      Number.isSafeInteger(entry.unitPriceMinor) &&
      typeof entry.unitPriceMinor === "number" &&
      Number.isSafeInteger(entry.lineTotalMinor) &&
      typeof entry.lineTotalMinor === "number",
  );
  if (items.length !== item.items.length) return null;
  return {
    id: item.id,
    customerId: item.customerId,
    items,
    delivery: {
      recipientName: delivery.recipientName,
      phone: delivery.phone,
      address: delivery.address,
      city: delivery.city,
      state: delivery.state,
      pinCode: delivery.pinCode,
    },
    subtotalMinor: item.subtotalMinor,
    totalMinor: item.totalMinor,
    currency: "INR",
    status: orderStatus,
    paymentResult: item.paymentResult,
    deliveryStatus: item.deliveryStatus,
    idempotencyKey: item.idempotencyKey,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    returns: [],
  };
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    value === "PENDING" ||
    value === "CONFIRMED" ||
    value === "SHIPPED" ||
    value === "OUT_FOR_DELIVERY" ||
    value === "DELIVERED" ||
    value === "CANCELLED"
  );
}

function readOrderReturn(
  item: Record<string, unknown> | undefined,
): OrderReturnRecord | null {
  const images = item?.images;
  const sellerReviewStatus = item?.sellerReviewStatus ?? "PENDING";
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.orderItemId !== "string" ||
    typeof item.productId !== "string" ||
    typeof item.customerId !== "string" ||
    typeof item.reason !== "string" ||
    (item.status !== "REQUESTED" && item.status !== "ACCEPTED" && item.status !== "REJECTED") ||
    (item.refundStatus !== "NOT_APPLICABLE" &&
      item.refundStatus !== "LOCAL_SIMULATED_NOT_PROCESSED") ||
    (sellerReviewStatus !== "PENDING" &&
      sellerReviewStatus !== "ACCEPTED" &&
      sellerReviewStatus !== "FORWARDED" &&
      sellerReviewStatus !== "REJECTED" &&
      sellerReviewStatus !== "SYSTEM_AUTO_ACCEPTED") ||
    (images !== undefined &&
      (!Array.isArray(images) ||
        !images.every(
          (image) =>
            isRecord(image) &&
            typeof image.id === "string" &&
            typeof image.objectKey === "string" &&
            image.contentType === "image/webp" &&
            typeof image.createdAt === "string",
        ))) ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string" ||
    (item.reviewedByUserId !== undefined && typeof item.reviewedByUserId !== "string") ||
    (item.reviewReason !== undefined && typeof item.reviewReason !== "string")
  ) {
    return null;
  }
  return {
    id: item.id,
    orderItemId: item.orderItemId,
    productId: item.productId,
    customerId: item.customerId,
    reason: item.reason,
    status: item.status,
    refundStatus: item.refundStatus,
    images: (images as OrderReturnRecord["images"] | undefined) ?? [],
    sellerReviewStatus,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(typeof item.reviewedByUserId === "string"
      ? { reviewedByUserId: item.reviewedByUserId }
      : {}),
    ...(typeof item.reviewReason === "string"
      ? { reviewReason: item.reviewReason }
      : {}),
    ...(typeof item.sellerResponseDeadlineAt === "string"
      ? { sellerResponseDeadlineAt: item.sellerResponseDeadlineAt }
      : {}),
    ...(item.decisionSource === "SELLER" ||
    item.decisionSource === "SYSTEM_AUTO_ACCEPTED"
      ? { decisionSource: item.decisionSource }
      : {}),
    ...(item.sellerRecommendation === "ACCEPTED" ||
    item.sellerRecommendation === "REJECTED"
      ? { sellerRecommendation: item.sellerRecommendation }
      : {}),
    ...(typeof item.sellerReviewedByUserId === "string"
      ? { sellerReviewedByUserId: item.sellerReviewedByUserId }
      : {}),
    ...(typeof item.sellerReviewReason === "string"
      ? { sellerReviewReason: item.sellerReviewReason }
      : {}),
    ...(typeof item.sellerReviewedAt === "string"
      ? { sellerReviewedAt: item.sellerReviewedAt }
      : {}),
    ...(typeof item.adminReviewAvailableAt === "string"
      ? { adminReviewAvailableAt: item.adminReviewAvailableAt }
      : {}),
  };
}

interface CursorKey extends Record<string, string> {
  PK: string;
  SK: string;
}

function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeCursor(
  value: string | null,
  expectedPartition: string,
  indexPartitionKey:
    | "GSI1PK"
    | "GSI2PK"
    | "GSI3PK"
    | "GSI4PK"
    | "GSI5PK",
): CursorKey | undefined {
  if (!value) return undefined;
  if (value.length > 2048) {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !isRecord(parsed) ||
      typeof parsed.PK !== "string" ||
      typeof parsed.SK !== "string" ||
      parsed[indexPartitionKey] !== expectedPartition ||
      Object.entries(parsed).some(
        ([key, entry]) =>
          /^GSI[1-5](PK|SK)$/.test(key) && typeof entry !== "string",
      )
    ) {
      throw new Error("Invalid pagination cursor.");
    }
    return parsed as CursorKey;
  } catch {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }
}

function decodeSellerCursor(
  value: string | null,
  expectedPartition: string,
): CursorKey | undefined {
  if (!value) return undefined;
  if (value.length > 2048) {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !isRecord(parsed) ||
      parsed.PK !== expectedPartition ||
      typeof parsed.SK !== "string" ||
      !parsed.SK.startsWith("PRODUCT#")
    ) {
      throw new Error("Invalid pagination cursor.");
    }
    return parsed as CursorKey;
  } catch {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }
}

interface CatalogSearchCursor {
  search: string;
  sort: CatalogSort;
  category?: string;
  brand?: string;
  minPrice?: number;
  maxPrice?: number;
  offset: number;
}

function encodeCatalogSearchCursor(cursor: CatalogSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCatalogSearchOffset(
  value: string | null,
  filters: {
    search: string;
    sort: CatalogSort;
    category?: string;
    brand?: string;
    minPrice?: number;
    maxPrice?: number;
  },
): number {
  if (!value) return 0;
  if (value.length > 2048) {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isRecord(parsed) ||
      parsed.search !== filters.search ||
      parsed.sort !== filters.sort ||
      parsed.category !== filters.category ||
      parsed.brand !== filters.brand ||
      parsed.minPrice !== filters.minPrice ||
      parsed.maxPrice !== filters.maxPrice ||
      !Number.isSafeInteger(parsed.offset) ||
      typeof parsed.offset !== "number" ||
      parsed.offset < 0
    ) {
      throw new Error("Search cursor does not match the catalog query.");
    }
    return parsed.offset;
  } catch {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }
}

function decodeVerificationCursor(value: string | null): CursorKey | undefined {
  if (!value) return undefined;
  if (value.length > 2048) {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !isRecord(parsed) ||
      parsed.PK !== "KYC_QUEUE#PENDING_REVIEW" ||
      typeof parsed.SK !== "string" ||
      !parsed.SK.startsWith("STORE#")
    ) {
      throw new Error("Invalid pagination cursor.");
    }
    return parsed as CursorKey;
  } catch {
    throw new MarketplaceError(400, "Pagination cursor is invalid.");
  }
}

function productItem(product: ProductRecord) {
  return {
    PK: `PRODUCT#${product.id}`,
    SK: "PROFILE",
    ...product,
    titleLower: product.title.toLocaleLowerCase("en"),
    brandLower: product.brand.toLocaleLowerCase("en"),
    ...(product.status === "active"
      ? {
          GSI1PK: "CATALOG#ACTIVE",
          GSI1SK: `${product.createdAt}#${product.id}`,
          GSI2PK: `CATALOG#CATEGORY#${product.category}`,
          GSI2SK: `${product.createdAt}#${product.id}`,
          GSI3PK: `CATALOG#CATEGORY#${product.category}`,
          GSI3SK: `${String(product.priceMinor).padStart(16, "0")}#${product.id}`,
        }
      : {}),
    ...(product.status === "draft"
      ? {
          GSI4PK: "PRODUCTS#DRAFT",
          GSI4SK: `${product.createdAt}#${product.id}`,
        }
      : {}),
  };
}

type CatalogSearchField = "title" | "brand" | "category";

function catalogSearchDocuments(product: ProductRecord): Record<string, unknown>[] {
  const fields: Array<{ name: CatalogSearchField; value: string }> = [
    { name: "title", value: product.title },
    { name: "brand", value: product.brand },
    { name: "category", value: product.category },
  ];
  const documents: Record<string, unknown>[] = [];
  for (const field of fields) {
    for (const token of new Set(searchTerms(field.value))) {
      for (const signature of searchIndexSignatures(token)) {
        documents.push({
          PK: `CATALOG_SEARCH#${product.id}`,
          SK: `${field.name}#${signature}#${token}`,
          productId: product.id,
          field: field.name,
          token,
          GSI6PK: `CATALOG#SEARCH#${signature}`,
          GSI6SK: `${product.id}#${field.name}#${token}`,
        });
      }
    }
  }
  return documents;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function catalogSortSettings(
  filters: { category?: string; sort: CatalogSort },
): {
  indexName: string;
  partitionKey: "GSI1PK" | "GSI2PK" | "GSI3PK";
  partitionValue: string;
  sortKey: "GSI1SK" | "GSI2SK" | "GSI3SK";
  scanIndexForward: boolean;
} {
  if (filters.sort === "newest" && filters.category) {
    return {
      indexName: "GSI2",
      partitionKey: "GSI2PK",
      partitionValue: `CATALOG#CATEGORY#${filters.category}`,
      sortKey: "GSI2SK",
      scanIndexForward: false,
    };
  }
  if (filters.sort === "newest") {
    return {
      indexName: "GSI1",
      partitionKey: "GSI1PK",
      partitionValue: "CATALOG#ACTIVE",
      sortKey: "GSI1SK",
      scanIndexForward: false,
    };
  }
  if (!filters.category) {
    throw new MarketplaceError(400, "A category is required for price sorting.");
  }
  return {
    indexName: "GSI3",
    partitionKey: "GSI3PK",
    partitionValue: `CATALOG#CATEGORY#${filters.category}`,
    sortKey: "GSI3SK",
    scanIndexForward: filters.sort === "price_asc",
  };
}

export class DynamoAuthRepository implements AuthRepository {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    region = process.env.AWS_REGION ?? "ap-south-1",
    endpoint = process.env.DYNAMODB_ENDPOINT,
  ) {
    const baseClient = new DynamoDBClient({
      region,
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: "local",
              secretAccessKey: "local",
            },
          }
        : {}),
    });

    this.client = DynamoDBDocumentClient.from(baseClient, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createUser(user: UserRecord): Promise<void> {
    if (!user.email && !user.mobileNumber) {
      throw new Error("A user must have an email address or mobile number.");
    }
    const transactItems: TransactWriteCommandInput["TransactItems"] = [
      {
        Put: {
          TableName: this.tableName,
          Item: { PK: `USER#${user.id}`, SK: "PROFILE", ...user },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ];
    if (user.email) {
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: {
            PK: `EMAIL#${user.email}`,
            SK: "IDENTITY",
            userId: user.id,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    }
    if (user.mobileNumber) {
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: {
            PK: `MOBILE#${user.mobileNumber}`,
            SK: "IDENTITY",
            userId: user.id,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(
          409,
          user.mobileNumber
            ? "An account with this mobile number already exists."
            : "An account with this email already exists.",
        );
      }
      throw error;
    }
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const identity = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `EMAIL#${email}`, SK: "IDENTITY" },
        ConsistentRead: true,
      }),
    );
    if (typeof identity.Item?.userId !== "string") return null;
    return this.getUserById(identity.Item.userId);
  }

  async getUserByMobileNumber(mobileNumber: string): Promise<UserRecord | null> {
    const identity = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `MOBILE#${mobileNumber}`, SK: "IDENTITY" },
        ConsistentRead: true,
      }),
    );
    if (typeof identity.Item?.userId !== "string") return null;
    return this.getUserById(identity.Item.userId);
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `USER#${userId}`, SK: "PROFILE" },
        ConsistentRead: true,
      }),
    );
    return readUser(result.Item);
  }

  async saveCustomerOtp(record: CustomerOtpRecord, resendAfter: number): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `CUSTOMER_OTP#${record.mobileNumber}`,
            SK: "RECORD",
            ...record,
            ttl: record.expiresAt,
          },
          ConditionExpression:
            "attribute_not_exists(PK) OR issuedAt <= :resendBefore OR expiresAt <= :now",
          ExpressionAttributeValues: {
            ":resendBefore": resendAfter,
            ":now": record.issuedAt,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isRecord(error) && error.name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  }

  async verifyCustomerOtp(
    mobileNumber: string,
    codeHash: string,
    now: number,
  ): Promise<"verified" | "invalid" | "expired" | "locked" | "missing"> {
    const key = { PK: `CUSTOMER_OTP#${mobileNumber}`, SK: "RECORD" };
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }),
    );
    const record = result.Item;
    if (
      typeof record?.codeHash !== "string" ||
      typeof record.expiresAt !== "number" ||
      typeof record.attemptsRemaining !== "number" ||
      typeof record.issuedAt !== "number"
    ) {
      return "missing";
    }
    if (record.expiresAt <= now) return "expired";
    if (record.consumed === true || record.attemptsRemaining <= 0) return "locked";

    const storedHash = Buffer.from(record.codeHash, "hex");
    const submittedHash = Buffer.from(codeHash, "hex");
    const matches =
      storedHash.length === submittedHash.length &&
      timingSafeEqual(storedHash, submittedHash);
    if (matches) {
      try {
        await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: key,
            UpdateExpression: "SET attemptsRemaining = :zero, consumed = :true",
            ConditionExpression:
              "codeHash = :codeHash AND expiresAt > :now AND attemptsRemaining > :zero",
            ExpressionAttributeValues: {
              ":codeHash": record.codeHash,
              ":now": now,
              ":zero": 0,
              ":true": true,
            },
          }),
        );
        return "verified";
      } catch (error) {
        if (isRecord(error) && error.name === "ConditionalCheckFailedException") {
          return "missing";
        }
        throw error;
      }
    }
    try {
      const updated = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: "SET attemptsRemaining = attemptsRemaining - :one",
          ConditionExpression:
            "codeHash = :codeHash AND expiresAt > :now AND attemptsRemaining > :zero",
          ExpressionAttributeValues: {
            ":codeHash": record.codeHash,
            ":now": now,
            ":zero": 0,
            ":one": 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return updated.Attributes?.attemptsRemaining === 0 ? "locked" : "invalid";
    } catch (error) {
      if (isRecord(error) && error.name === "ConditionalCheckFailedException") {
        return "missing";
      }
      throw error;
    }
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: `SESSION#${session.tokenHash}`,
                SK: "RECORD",
                tokenHash: session.tokenHash,
                userId: session.userId,
                expiresAt: session.expiresAt,
                ttl: session.expiresAt,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `SESSION#${tokenHash}`, SK: "RECORD" },
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    if (
      typeof item?.tokenHash !== "string" ||
      typeof item.userId !== "string" ||
      typeof item.expiresAt !== "number"
    ) {
      return null;
    }
    return {
      tokenHash: item.tokenHash,
      userId: item.userId,
      expiresAt: item.expiresAt,
    };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: `SESSION#${tokenHash}`, SK: "RECORD" },
      }),
    );
  }

  async createSellerStore(store: SellerStore): Promise<void> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `STORE#${store.id}`,
                  SK: "PROFILE",
                  ...store,
                  GSI5PK: "STORES#PENDING",
                  GSI5SK: `${store.createdAt}#${store.id}`,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `USER#${store.ownerUserId}`, SK: "PROFILE" },
                UpdateExpression: "SET storeId = :storeId",
                ConditionExpression:
                  "attribute_exists(PK) AND attribute_not_exists(storeId)",
                ExpressionAttributeValues: { ":storeId": store.id },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "A store application already exists.");
      }
      throw error;
    }
  }

  async getSellerStore(storeId: string): Promise<SellerStore | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `STORE#${storeId}`, SK: "PROFILE" },
        ConsistentRead: true,
      }),
    );
    return readStore(result.Item);
  }

  async getSellerVerification(
    storeId: string,
  ): Promise<SellerVerificationRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `SELLER_VERIFICATION#${storeId}`, SK: "RECORD" },
        ConsistentRead: true,
      }),
    );
    return readSellerVerification(result.Item);
  }

  async saveSellerVerification(record: SellerVerificationRecord): Promise<void> {
    const submittedAt = record.updatedAt;
    const auditId = randomUUID();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `SELLER_VERIFICATION#${record.storeId}`,
                  SK: "RECORD",
                  ...record,
                },
                ConditionExpression:
                  "attribute_not_exists(PK) OR #status IN (:correction, :rejected)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":correction": "NEEDS_CORRECTION",
                  ":rejected": "REJECTED",
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: "KYC_QUEUE#PENDING_REVIEW",
                  SK: `STORE#${record.storeId}`,
                  storeId: record.storeId,
                  createdAt: submittedAt,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#SELLER_VERIFICATION#${record.storeId}`,
                  SK: `AT#${submittedAt}#${auditId}`,
                  actorUserId: record.ownerUserId,
                  targetStoreId: record.storeId,
                  action: "seller.verification.submitted",
                  status: "PENDING_REVIEW",
                  createdAt: submittedAt,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Verification is already under review or unavailable.");
      }
      throw error;
    }
  }

  async listPendingSellerVerifications(
    limit: number,
    cursor: string | null,
  ): Promise<{ items: SellerVerificationSummary[]; nextCursor: string | null }> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :partition",
        ExpressionAttributeValues: { ":partition": "KYC_QUEUE#PENDING_REVIEW" },
        ExclusiveStartKey: decodeVerificationCursor(cursor),
        Limit: limit,
        ScanIndexForward: true,
      }),
    );
    return {
      items: (result.Items ?? [])
        .filter(
          (item): item is typeof item & { storeId: string } =>
            typeof item.storeId === "string",
        )
        .map((item) => ({
          storeId: item.storeId,
          status: "PENDING_REVIEW" as const,
          updatedAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
        })),
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  async reviewSellerVerification(
    storeId: string,
    reviewerUserId: string,
    status: SellerVerificationReview["status"],
    reason?: string,
  ): Promise<void> {
    const current = await this.getSellerVerification(storeId);
    if (
      !current ||
      current.status !== "PENDING_REVIEW" ||
      current.ownerUserId === reviewerUserId
    ) {
      throw new MarketplaceError(409, "Verification is unavailable for review.");
    }
    const createdAt = new Date().toISOString();
    const auditId = randomUUID();
    const reviewEntry = {
      status,
      actorUserId: reviewerUserId,
      ...(reason ? { reason } : {}),
      createdAt,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `SELLER_VERIFICATION#${storeId}`, SK: "RECORD" },
                UpdateExpression:
                  "SET #status = :status, updatedAt = :createdAt, history = list_append(if_not_exists(history, :empty), :entry)",
                ConditionExpression:
                  "#status = :pending AND ownerUserId <> :reviewerUserId",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":status": status,
                  ":pending": "PENDING_REVIEW",
                  ":createdAt": createdAt,
                  ":reviewerUserId": reviewerUserId,
                  ":empty": [],
                  ":entry": [reviewEntry],
                },
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: {
                  PK: "KYC_QUEUE#PENDING_REVIEW",
                  SK: `STORE#${storeId}`,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#SELLER_VERIFICATION#${storeId}`,
                  SK: `AT#${createdAt}#${auditId}`,
                  actorUserId: reviewerUserId,
                  targetStoreId: storeId,
                  action: `seller.verification.${status.toLowerCase()}`,
                  status,
                  ...(reason ? { reason } : {}),
                  createdAt,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Verification changed while it was being reviewed.");
      }
      throw error;
    }
  }

  async approveSellerStore(
    storeId: string,
    approvedByUserId: string,
  ): Promise<void> {
    const store = await this.getSellerStore(storeId);
    if (!store || store.status !== "pending") {
      throw new MarketplaceError(409, "Store is unavailable or is not awaiting approval.");
    }
    if (store.ownerUserId === approvedByUserId) {
      throw new MarketplaceError(403, "A seller cannot approve their own store.");
    }
    const verification = await this.getSellerVerification(storeId);
    if (!verification || verification.status !== "APPROVED") {
      throw new MarketplaceError(409, "Business verification must be approved before store approval.");
    }

    try {
      const approvedAt = new Date().toISOString();
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { PK: `SELLER_VERIFICATION#${storeId}`, SK: "RECORD" },
                ConditionExpression: "#status = :verified",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":verified": "APPROVED" },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `STORE#${storeId}`, SK: "PROFILE" },
                UpdateExpression: "SET #status = :approved REMOVE GSI5PK, GSI5SK",
                ConditionExpression: "#status = :pending",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":pending": "pending",
                  ":approved": "approved",
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `USER#${store.ownerUserId}`, SK: "PROFILE" },
                UpdateExpression:
                  "SET #roles = list_append(if_not_exists(#roles, :empty), :seller)",
                ConditionExpression:
                  "storeId = :storeId AND (attribute_not_exists(#roles) OR NOT contains(#roles, :sellerRole))",
                ExpressionAttributeNames: {
                  "#roles": "roles",
                },
                ExpressionAttributeValues: {
                  ":storeId": storeId,
                  ":empty": [] as Role[],
                  ":seller": ["seller"] as Role[],
                  ":sellerRole": "seller",
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#STORE#${storeId}`,
                  SK: `AT#${approvedAt}#${randomUUID()}`,
                  actorUserId: approvedByUserId,
                  action: "seller.store.approved",
                  targetStoreId: storeId,
                  createdAt: approvedAt,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Store is unavailable or is not awaiting approval.");
      }
      throw error;
    }
  }

  async createProduct(product: ProductRecord): Promise<void> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: productItem(product),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: `STORE#${product.storeId}`,
                SK: `PRODUCT#${product.createdAt}#${product.id}`,
                ...product,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: `STORE#${product.storeId}`,
                SK: `SKU#${product.sku}`,
                productId: product.id,
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Product ID or SKU already exists.");
      }
      throw error;
    }
  }

  async getProduct(productId: string): Promise<ProductRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `PRODUCT#${productId}`, SK: "PROFILE" },
        ConsistentRead: true,
      }),
    );
    return readProduct(result.Item);
  }

  async listSellerProducts(
    storeId: string,
    limit: number,
    cursor: string | null,
  ): Promise<CatalogPage> {
    const partition = `STORE#${storeId}`;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": partition, ":prefix": "PRODUCT#" },
        ExclusiveStartKey: decodeSellerCursor(cursor, partition),
        Limit: limit,
        ScanIndexForward: false,
      }),
    );

    return {
      items: (result.Items ?? [])
        .map((item) => readProduct(item))
        .filter((item): item is ProductRecord => item !== null),
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  async listCatalog(
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
  ): Promise<CatalogPage> {
    if (filters.search) {
      const offset = decodeCatalogSearchOffset(cursor, {
        search: filters.search,
        sort: filters.sort,
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.brand ? { brand: filters.brand } : {}),
        ...(filters.minPrice !== undefined ? { minPrice: filters.minPrice } : {}),
        ...(filters.maxPrice !== undefined ? { maxPrice: filters.maxPrice } : {}),
      });
      const terms = searchTerms(filters.search);
      if (terms.length === 0) return { items: [], nextCursor: null };
      const termMatches = await Promise.all(
        terms.map((term) => this.matchingProductIdsForTerm(term)),
      );
      if (termMatches.some((ids) => ids.size === 0)) {
        return { items: [], nextCursor: null };
      }
      const candidateIds = [...termMatches[0]!].filter((productId) =>
        termMatches.every((ids) => ids.has(productId)),
      );
      if (candidateIds.length === 0) return { items: [], nextCursor: null };

      const candidates = (await this.getProductsByIds(candidateIds)).filter((product) =>
        (!filters.category || product.category === filters.category) &&
        (!filters.brand ||
          normalizeSearchText(product.brand) === normalizeSearchText(filters.brand!)) &&
        (filters.minPrice === undefined || product.priceMinor >= filters.minPrice) &&
        (filters.maxPrice === undefined || product.priceMinor <= filters.maxPrice),
      );

      const rankedProducts = rankCatalogProducts(
        candidates,
        filters.search,
        filters.sort,
      );
      const items = rankedProducts.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        items,
        nextCursor:
          nextOffset < rankedProducts.length
            ? encodeCatalogSearchCursor({
                search: filters.search,
                sort: filters.sort,
                ...(filters.category ? { category: filters.category } : {}),
                ...(filters.brand ? { brand: filters.brand } : {}),
                ...(filters.minPrice !== undefined ? { minPrice: filters.minPrice } : {}),
                ...(filters.maxPrice !== undefined ? { maxPrice: filters.maxPrice } : {}),
                offset: nextOffset,
              })
            : null,
      };
    }

    const sort = catalogSortSettings(filters);
    const values: Record<string, unknown> = {
      ":partition": sort.partitionValue,
      ":active": "active",
    };
    const names: Record<string, string> = { "#status": "status" };
    const conditions = ["#status = :active"];

    if (filters.category && sort.partitionKey === "GSI1PK") {
      values[":category"] = filters.category;
      names["#category"] = "category";
      conditions.push("#category = :category");
    }
    if (filters.brand) {
      values[":brandLower"] = filters.brand.toLocaleLowerCase("en");
      names["#brandLower"] = "brandLower";
      conditions.push("#brandLower = :brandLower");
    }
    if (filters.minPrice !== undefined) {
      values[":minPrice"] = filters.minPrice;
      names["#priceMinor"] = "priceMinor";
      conditions.push("#priceMinor >= :minPrice");
    }
    if (filters.maxPrice !== undefined) {
      values[":maxPrice"] = filters.maxPrice;
      names["#priceMinor"] = "priceMinor";
      conditions.push("#priceMinor <= :maxPrice");
    }

    const query: QueryCommandInput = {
      TableName: this.tableName,
      IndexName: sort.indexName,
      KeyConditionExpression: `${sort.partitionKey} = :partition`,
      FilterExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ExclusiveStartKey: decodeCursor(
        cursor,
        sort.partitionValue,
        sort.partitionKey,
      ),
      Limit: limit,
      ScanIndexForward: sort.scanIndexForward,
    };
    const result = await this.client.send(new QueryCommand(query));

    return {
      items: (result.Items ?? [])
        .map((item) => readProduct(item))
        .filter((item): item is ProductRecord => item !== null),
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  async updateDraftProduct(
    product: ProductRecord,
    expectedStoreId: string,
  ): Promise<void> {
    const item = productItem(product);
    const storeProduct = {
      PK: `STORE#${product.storeId}`,
      SK: `PRODUCT#${product.createdAt}#${product.id}`,
      ...product,
    };
    const existing = await this.getProduct(product.id);
    if (
      !existing ||
      existing.storeId !== expectedStoreId ||
      (existing.status !== "draft" && existing.status !== "rejected")
    ) {
      throw new MarketplaceError(409, "Product is no longer editable.");
    }
    const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression:
            "storeId = :storeId AND (#status = :draft OR #status = :rejected)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":storeId": expectedStoreId,
            ":draft": "draft",
            ":rejected": "rejected",
          },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: storeProduct,
          ConditionExpression:
            "attribute_exists(PK) AND (#status = :draft OR #status = :rejected)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":draft": "draft",
            ":rejected": "rejected",
          },
        },
      },
    ];
    if (existing.sku !== product.sku) {
      transactItems.push(
        {
          Delete: {
            TableName: this.tableName,
            Key: {
              PK: `STORE#${expectedStoreId}`,
              SK: `SKU#${existing.sku}`,
            },
            ConditionExpression: "productId = :productId",
            ExpressionAttributeValues: { ":productId": product.id },
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              PK: `STORE#${expectedStoreId}`,
              SK: `SKU#${product.sku}`,
              productId: product.id,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      );
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Product is no longer editable.");
      }
      throw error;
    }
  }

  async archiveProduct(productId: string, storeId: string): Promise<void> {
    const product = await this.getProduct(productId);
    if (!product || product.storeId !== storeId) {
      throw new MarketplaceError(404, "Product was not found.");
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `PRODUCT#${productId}`, SK: "PROFILE" },
                UpdateExpression:
                  "SET #status = :archived, archivedFromStatus = :previousStatus, updatedAt = :updatedAt REMOVE GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK, GSI4PK, GSI4SK",
                ConditionExpression:
                  "storeId = :storeId AND #status <> :archived",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":storeId": storeId,
                  ":archived": "archived",
                  ":previousStatus": product.status,
                  ":updatedAt": new Date().toISOString(),
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  PK: `STORE#${storeId}`,
                  SK: `PRODUCT#${product.createdAt}#${productId}`,
                },
                UpdateExpression:
                  "SET #status = :archived, archivedFromStatus = :previousStatus",
                ConditionExpression: "attribute_exists(PK)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":archived": "archived",
                  ":previousStatus": product.status,
                },
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: { PK: `STORE#${storeId}`, SK: `SKU#${product.sku}` },
                ConditionExpression: "productId = :productId",
                ExpressionAttributeValues: { ":productId": productId },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(404, "Product was not found.");
      }
      throw error;
    }
  }

  async restoreProduct(productId: string, storeId: string): Promise<void> {
    const product = await this.getProduct(productId);
    if (!product || product.storeId !== storeId) {
      throw new MarketplaceError(404, "Product was not found.");
    }
    if (product.status !== "archived") {
      throw new MarketplaceError(409, "Product is not archived.");
    }

    const status = product.archivedFromStatus ?? "active";
    if (status === "active") {
      await this.putCatalogSearchDocuments([product]);
    }
    const updatedAt = new Date().toISOString();
    const activeIndexValues =
      status === "active"
        ? {
            GSI1PK: "CATALOG#ACTIVE",
            GSI1SK: `${product.createdAt}#${product.id}`,
            GSI2PK: `CATALOG#CATEGORY#${product.category}`,
            GSI2SK: `${product.createdAt}#${product.id}`,
            GSI3PK: `CATALOG#CATEGORY#${product.category}`,
            GSI3SK: `${String(product.priceMinor).padStart(16, "0")}#${product.id}`,
          }
        : status === "draft"
          ? {
              GSI4PK: "PRODUCTS#DRAFT",
              GSI4SK: `${product.createdAt}#${product.id}`,
            }
          : {};
    const indexSetExpression = Object.keys(activeIndexValues)
      .map((key) => `${key} = :${key}`)
      .join(", ");
    const baseSetExpression = [
      "#status = :restoredStatus",
      "updatedAt = :updatedAt",
      indexSetExpression,
    ]
      .filter(Boolean)
      .join(", ");
    const removeIndexExpression =
      status === "active"
        ? "REMOVE archivedFromStatus, GSI4PK, GSI4SK"
        : status === "draft"
          ? "REMOVE archivedFromStatus, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK"
          : "REMOVE archivedFromStatus, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK, GSI4PK, GSI4SK";
    const commonExpressionAttributeValues = {
      ":storeId": storeId,
      ":productId": productId,
      ":archived": "archived",
      ":restoredStatus": status,
      ":updatedAt": updatedAt,
    };
    const expressionAttributeValues = {
      ...commonExpressionAttributeValues,
      ...Object.fromEntries(
        Object.entries(activeIndexValues).map(([key, value]) => [`:${key}`, value]),
      ),
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `PRODUCT#${productId}`, SK: "PROFILE" },
                UpdateExpression: `SET ${baseSetExpression} ${removeIndexExpression}`,
                ConditionExpression:
                  "storeId = :storeId AND id = :productId AND #status = :archived",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: expressionAttributeValues,
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  PK: `STORE#${storeId}`,
                  SK: `PRODUCT#${product.createdAt}#${productId}`,
                },
                UpdateExpression:
                  "SET #status = :restoredStatus, updatedAt = :updatedAt REMOVE archivedFromStatus",
                ConditionExpression:
                  "storeId = :storeId AND id = :productId AND #status = :archived",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: commonExpressionAttributeValues,
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `STORE#${storeId}`,
                  SK: `SKU#${product.sku}`,
                  productId,
                },
                ConditionExpression:
                  "attribute_not_exists(PK) OR productId = :productId",
                ExpressionAttributeValues: { ":productId": productId },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(
          409,
          "Product could not be restored; check that its SKU is still available.",
        );
      }
      throw error;
    }
  }

  async listPendingStores(
    limit: number,
    cursor: string | null,
  ): Promise<SellerStorePage> {
    const partition = "STORES#PENDING";
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI5",
        KeyConditionExpression: "GSI5PK = :partition",
        ExpressionAttributeValues: { ":partition": partition },
        ExclusiveStartKey: decodeCursor(cursor, partition, "GSI5PK"),
        Limit: limit,
        ScanIndexForward: true,
      }),
    );
    return {
      items: (result.Items ?? [])
        .map((item) => readStore(item))
        .filter((item): item is SellerStore => item !== null),
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  async listPendingProducts(
    limit: number,
    cursor: string | null,
  ): Promise<CatalogPage> {
    const partition = "PRODUCTS#DRAFT";
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI4",
        KeyConditionExpression: "GSI4PK = :partition",
        ExpressionAttributeValues: { ":partition": partition },
        ExclusiveStartKey: decodeCursor(cursor, partition, "GSI4PK"),
        Limit: limit,
        ScanIndexForward: true,
      }),
    );
    return {
      items: (result.Items ?? [])
        .map((item) => readProduct(item))
        .filter((item): item is ProductRecord => item !== null),
      nextCursor: encodeCursor(result.LastEvaluatedKey),
    };
  }

  private async putCatalogSearchDocuments(
    products: readonly ProductRecord[],
  ): Promise<void> {
    const requests: NonNullable<BatchWriteCommandInput["RequestItems"]>[string] =
      products.flatMap((product) =>
        catalogSearchDocuments(product).map((Item) => ({ PutRequest: { Item } })),
      );
    for (let offset = 0; offset < requests.length; offset += 25) {
      let pending = requests.slice(offset, offset + 25);
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        const result = await this.client.send(
          new BatchWriteCommand({
            RequestItems: { [this.tableName]: pending },
          }),
        );
        pending = result.UnprocessedItems?.[this.tableName] ?? [];
        if (pending.length > 0) {
          if (attempt >= 7) {
            throw new Error("DynamoDB did not process all catalog search index writes.");
          }
          await wait(50 * 2 ** attempt);
        }
      }
    }
  }

  private async queryCatalogSearchPartition(
    signature: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI6",
          KeyConditionExpression: "GSI6PK = :partition",
          ExpressionAttributeValues: {
            ":partition": `CATALOG#SEARCH#${signature}`,
          },
          ExclusiveStartKey: exclusiveStartKey,
          Limit: 100,
        }),
      );
      for (const item of result.Items ?? []) {
        if (isRecord(item)) items.push(item);
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  private async matchingProductIdsForTerm(term: string): Promise<Set<string>> {
    const prefixSignatures = new Set(
      searchTermAlternatives(term).map(
        (alternative) => `P#${alternative.slice(0, 4)}`,
      ),
    );
    const prefixItems = (
      await Promise.all(
        [...prefixSignatures].map((signature) =>
          this.queryCatalogSearchPartition(signature),
        ),
      )
    ).flat();
    const productIds = new Set<string>();
    for (const item of prefixItems) {
      if (
        typeof item.productId === "string" &&
        typeof item.token === "string" &&
        searchTermMatch(term, item.token)
      ) {
        productIds.add(item.productId);
      }
    }
    if (productIds.size > 0 || term.length < 5) return productIds;

    const gramSignatures = searchIndexSignatures(term).filter((entry) =>
      entry.startsWith("G#"),
    );
    const gramItems = (
      await Promise.all(
        gramSignatures.map((signature) =>
          this.queryCatalogSearchPartition(signature),
        ),
      )
    ).flat();
    for (const item of gramItems) {
      if (
        typeof item.productId === "string" &&
        typeof item.token === "string" &&
        searchTermMatch(term, item.token) === "fuzzy"
      ) {
        productIds.add(item.productId);
      }
    }
    return productIds;
  }

  private async getProductsByIds(productIds: readonly string[]): Promise<ProductRecord[]> {
    const products: ProductRecord[] = [];
    for (let offset = 0; offset < productIds.length; offset += 100) {
      let keys: Array<Record<string, unknown>> = productIds.slice(offset, offset + 100).map((productId) => ({
        PK: `PRODUCT#${productId}`,
        SK: "PROFILE",
      }));
      for (let attempt = 0; keys.length > 0; attempt += 1) {
        const result = await this.client.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: { Keys: keys, ConsistentRead: true },
            },
          }),
        );
        for (const item of result.Responses?.[this.tableName] ?? []) {
          const product = readProduct(item);
          if (product?.status === "active") products.push(product);
        }
        keys = result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
        if (keys.length > 0) {
          if (attempt >= 7) {
            throw new Error("DynamoDB did not process all catalog product reads.");
          }
          await wait(50 * 2 ** attempt);
        }
      }
    }
    return products;
  }

  async backfillCatalogSearchIndex(): Promise<number> {
    let indexedProducts = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :partition",
          ExpressionAttributeValues: { ":partition": "CATALOG#ACTIVE" },
          ExclusiveStartKey: exclusiveStartKey,
          Limit: 100,
          ScanIndexForward: false,
        }),
      );
      const products = (result.Items ?? [])
        .map((item) => readProduct(item))
        .filter((product): product is ProductRecord => product?.status === "active");
      await this.putCatalogSearchDocuments(products);
      indexedProducts += products.length;
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return indexedProducts;
  }

  async approveProduct(productId: string, approvedByUserId: string): Promise<void> {
    const product = await this.getProduct(productId);
    if (!product || product.status !== "draft") {
      throw new MarketplaceError(409, "Product is unavailable for review.");
    }
    if (product.images.length === 0) {
      throw new MarketplaceError(400, "A product needs reviewed images before publication.");
    }
    const store = await this.getSellerStore(product.storeId);
    if (!store || store.status !== "approved" || store.ownerUserId !== product.sellerId) {
      throw new MarketplaceError(409, "The product's store is not approved.");
    }
    const verification = await this.getSellerVerification(product.storeId);
    if (!verification || verification.status !== "APPROVED") {
      throw new MarketplaceError(409, "The product's business verification is not approved.");
    }

    await this.putCatalogSearchDocuments([product]);
    const approvedAt = new Date().toISOString();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `PRODUCT#${productId}`, SK: "PROFILE" },
                UpdateExpression:
                  "SET #status = :active, updatedAt = :approvedAt, GSI1PK = :allActive, GSI1SK = :createdKey, GSI2PK = :categoryPartition, GSI2SK = :createdKey, GSI3PK = :categoryPartition, GSI3SK = :priceKey REMOVE GSI4PK, GSI4SK",
                ConditionExpression:
                  "storeId = :storeId AND sellerId = :sellerId AND #status = :draft AND size(images) > :zero",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":active": "active",
                  ":draft": "draft",
                  ":approvedAt": approvedAt,
                  ":storeId": product.storeId,
                  ":sellerId": product.sellerId,
                  ":allActive": "CATALOG#ACTIVE",
                  ":createdKey": `${product.createdAt}#${product.id}`,
                  ":categoryPartition": `CATALOG#CATEGORY#${product.category}`,
                  ":priceKey": `${String(product.priceMinor).padStart(16, "0")}#${product.id}`,
                  ":zero": 0,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: {
                  PK: `SELLER_VERIFICATION#${product.storeId}`,
                  SK: "RECORD",
                },
                ConditionExpression: "#status = :verified",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":verified": "APPROVED" },
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { PK: `STORE#${product.storeId}`, SK: "PROFILE" },
                ConditionExpression:
                  "#status = :approved AND ownerUserId = :sellerId",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":approved": "approved",
                  ":sellerId": product.sellerId,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  PK: `STORE#${product.storeId}`,
                  SK: `PRODUCT#${product.createdAt}#${product.id}`,
                },
                UpdateExpression: "SET #status = :active",
                ConditionExpression: "#status = :draft",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":draft": "draft",
                  ":active": "active",
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#PRODUCT#${productId}`,
                  SK: `AT#${approvedAt}#${randomUUID()}`,
                  actorUserId: approvedByUserId,
                  action: "catalog.product.approved",
                  targetProductId: productId,
                  targetStoreId: product.storeId,
                  imageReviewCompleted: true,
                  createdAt: approvedAt,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Product or store changed while it was being reviewed.");
      }
      throw error;
    }
  }

  async rejectProduct(
    productId: string,
    rejectedByUserId: string,
    reason: string,
  ): Promise<void> {
    const product = await this.getProduct(productId);
    if (!product || product.status !== "draft") {
      throw new MarketplaceError(409, "Product is unavailable for review.");
    }
    const rejectedAt = new Date().toISOString();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `PRODUCT#${productId}`, SK: "PROFILE" },
                UpdateExpression:
                  "SET #status = :rejected, updatedAt = :rejectedAt REMOVE GSI4PK, GSI4SK",
                ConditionExpression: "#status = :draft",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":draft": "draft",
                  ":rejected": "rejected",
                  ":rejectedAt": rejectedAt,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  PK: `STORE#${product.storeId}`,
                  SK: `PRODUCT#${product.createdAt}#${product.id}`,
                },
                UpdateExpression: "SET #status = :rejected",
                ConditionExpression: "#status = :draft",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":draft": "draft",
                  ":rejected": "rejected",
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#PRODUCT#${productId}`,
                  SK: `AT#${rejectedAt}#${randomUUID()}`,
                  actorUserId: rejectedByUserId,
                  action: "catalog.product.rejected",
                  targetProductId: productId,
                  targetStoreId: product.storeId,
                  reason,
                  createdAt: rejectedAt,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Product changed while it was being reviewed.");
      }
      throw error;
    }
  }

  async rejectSellerStore(
    storeId: string,
    rejectedByUserId: string,
    reason: string,
  ): Promise<void> {
    const store = await this.getSellerStore(storeId);
    if (!store || store.status !== "pending") {
      throw new MarketplaceError(409, "Store is unavailable for review.");
    }
    const rejectedAt = new Date().toISOString();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `STORE#${storeId}`, SK: "PROFILE" },
                UpdateExpression: "SET #status = :rejected REMOVE GSI5PK, GSI5SK",
                ConditionExpression: "#status = :pending",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":pending": "pending",
                  ":rejected": "rejected",
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#STORE#${storeId}`,
                  SK: `AT#${rejectedAt}#${randomUUID()}`,
                  actorUserId: rejectedByUserId,
                  action: "seller.store.rejected",
                  targetStoreId: storeId,
                  reason,
                  createdAt: rejectedAt,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Store changed while it was being reviewed.");
      }
      throw error;
    }
  }

  async getCart(userId: string): Promise<CartRecord> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `CART#${userId}`, SK: "RECORD" },
        ConsistentRead: true,
      }),
    );
    const item = result.Item;
    if (
      !item ||
      typeof item.updatedAt !== "string" ||
      !Array.isArray(item.items)
    ) {
      return { userId, items: [], updatedAt: "", revision: "" };
    }
    const items = item.items.filter(
      (entry): entry is CartItemInput =>
        isRecord(entry) &&
        typeof entry.productId === "string" &&
        Number.isSafeInteger(entry.quantity) &&
        typeof entry.quantity === "number" &&
        entry.quantity > 0 &&
        (entry.size === undefined || typeof entry.size === "string"),
    );
    return {
      userId,
      items,
      updatedAt: item.updatedAt,
      revision: typeof item.revision === "string" ? item.revision : "",
    };
  }

  async saveCart(
    userId: string,
    items: CartItemInput[],
    updatedAt: string,
  ): Promise<CartRecord> {
    for (const cartItem of items) {
      const product = await this.getProduct(cartItem.productId);
      if (!product || product.status !== "active") {
        throw new MarketplaceError(404, "One or more products are no longer available.");
      }
      validateCartItemForProduct(product, cartItem);
    }
    const revision = randomUUID();
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: `CART#${userId}`,
                SK: "RECORD",
                userId,
                items,
                updatedAt,
                revision,
              },
            },
          },
        ],
      }),
    );
    return { userId, items, updatedAt, revision };
  }

  async checkout(
    userId: string,
    delivery: DeliveryDetails,
    idempotencyKey: string,
    now: string,
    requestedItems?: CartItemInput[],
  ): Promise<OrderRecord> {
    const existingOrder = await this.getOrderByIdempotencyKey(userId, idempotencyKey);
    if (existingOrder) return existingOrder;
    const cart = await this.getCart(userId);
    const checkoutItems = requestedItems ?? cart.items;
    if (
      checkoutItems.length === 0 ||
      (!requestedItems && (!cart.updatedAt || !cart.revision))
    ) {
      throw new MarketplaceError(400, "Add available products to your cart before checkout.");
    }
    if (checkoutItems.length > 6) {
      throw new MarketplaceError(400, "A local test order can include at most six distinct products.");
    }

    const products = await Promise.all(
      checkoutItems.map(async (cartItem) => {
        const product = await this.getProduct(cartItem.productId);
        if (!product || product.status !== "active") {
          throw new MarketplaceError(409, "A cart product is no longer available.");
        }
        validateCartItemForProduct(product, cartItem);
        const store = await this.getSellerStore(product.storeId);
        const verification = await this.getSellerVerification(product.storeId);
        if (
          !store ||
          store.status !== "approved" ||
          store.ownerUserId !== product.sellerId ||
          !verification ||
          verification.status !== "APPROVED"
        ) {
          throw new MarketplaceError(409, "A cart product's seller is not eligible.");
        }
        const user = await this.getUserById(product.sellerId);
        if (user?.id === userId) {
          throw new MarketplaceError(400, "You cannot order products from your own store.");
        }
        const lineTotalMinor = product.priceMinor * cartItem.quantity;
        if (!Number.isSafeInteger(lineTotalMinor)) {
          throw new MarketplaceError(400, "Order total is outside the supported range.");
        }
        return {
          product,
          quantity: cartItem.quantity,
          size: cartItem.size,
          lineTotalMinor,
        };
      }),
    );
    const stockByProduct = new Map<
      string,
      { product: ProductRecord; quantity: number }
    >();
    for (const { product, quantity } of products) {
      const current = stockByProduct.get(product.id);
      const totalQuantity = (current?.quantity ?? 0) + quantity;
      if (!Number.isSafeInteger(totalQuantity) || totalQuantity > product.stock) {
        throw new MarketplaceError(
          409,
          `Only ${product.stock} units are available.`,
        );
      }
      stockByProduct.set(product.id, { product, quantity: totalQuantity });
    }
    const subtotalMinor = products.reduce(
      (total, entry) => total + entry.lineTotalMinor,
      0,
    );
    if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor <= 0) {
      throw new MarketplaceError(400, "Order total is outside the supported range.");
    }
    const orderId = randomUUID();
    const order: OrderRecord = {
      id: orderId,
      customerId: userId,
      items: products.map(({ product, quantity, size, lineTotalMinor }) => ({
        id: randomUUID(),
        productId: product.id,
        sellerId: product.sellerId,
        storeId: product.storeId,
        title: product.title,
        brand: product.brand,
        imageUrl: product.images[0]?.url ?? null,
        quantity,
        ...(size ? { size } : {}),
        sellerStatus: "PENDING" as const,
        unitPriceMinor: product.priceMinor,
        lineTotalMinor,
      })),
      delivery,
      subtotalMinor,
      totalMinor: subtotalMinor,
      currency: "INR",
      status: "PENDING",
      paymentResult: "NOT_CONFIGURED",
      deliveryStatus: "NOT_DELIVERED",
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
      returns: [],
    };
    const transactItems: TransactWriteCommandInput["TransactItems"] = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            PK: `ORDER#${orderId}`,
            SK: "PROFILE",
            ...order,
            returns: undefined,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            PK: `CUSTOMER#${userId}`,
            SK: `ORDER#${now}#${orderId}`,
            orderId,
            createdAt: now,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            PK: `ORDER_IDEMPOTENCY#${userId}`,
            SK: `KEY#${idempotencyKey}`,
            orderId,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      ...(!requestedItems
        ? [{
        Delete: {
          TableName: this.tableName,
          Key: { PK: `CART#${userId}`, SK: "RECORD" },
          ConditionExpression: "revision = :revision",
          ExpressionAttributeValues: { ":revision": cart.revision },
        },
      }]
        : []),
      ...[...stockByProduct.values()].flatMap(({ product, quantity }) => [
        {
          Update: {
            TableName: this.tableName,
            Key: { PK: `PRODUCT#${product.id}`, SK: "PROFILE" },
            UpdateExpression: "SET stock = stock - :quantity, updatedAt = :now",
            ConditionExpression:
              "#status = :active AND stock >= :quantity AND sellerId = :sellerId AND storeId = :storeId",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":quantity": quantity,
              ":active": "active",
              ":sellerId": product.sellerId,
              ":storeId": product.storeId,
              ":now": now,
            },
          },
        },
        {
          Update: {
            TableName: this.tableName,
            Key: {
              PK: `STORE#${product.storeId}`,
              SK: `PRODUCT#${product.createdAt}#${product.id}`,
            },
            UpdateExpression: "SET stock = stock - :quantity, updatedAt = :now",
            ConditionExpression:
              "#status = :active AND stock >= :quantity AND sellerId = :sellerId AND storeId = :storeId",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":quantity": quantity,
              ":active": "active",
              ":sellerId": product.sellerId,
              ":storeId": product.storeId,
              ":now": now,
            },
          },
        },
      ]),
      ...[
        ...new Map(
          products.map(({ product }) => [
            product.storeId,
            { storeId: product.storeId, sellerId: product.sellerId },
          ]),
        ).values(),
      ].flatMap(({ storeId, sellerId }) => [
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: { PK: `STORE#${storeId}`, SK: "PROFILE" },
            ConditionExpression: "#status = :approved AND ownerUserId = :sellerId",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":approved": "approved",
              ":sellerId": sellerId,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: {
              PK: `SELLER_VERIFICATION#${storeId}`,
              SK: "RECORD",
            },
            ConditionExpression: "#status = :verified",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":verified": "APPROVED" },
          },
        },
      ]),
    ];
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        }),
      );
    } catch (error) {
      const duplicate = await this.getOrderByIdempotencyKey(userId, idempotencyKey);
      if (duplicate) return duplicate;
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Cart changed or inventory is insufficient; review your cart and try again.");
      }
      throw error;
    }
    return order;
  }

  async cancelOrder(
    orderId: string,
    customerId: string,
    now: string,
  ): Promise<OrderRecord> {
    const order = await this.getOrder(orderId);
    if (!order || order.customerId !== customerId) {
      throw new MarketplaceError(404, "Order was not found.");
    }
    if (
      order.status !== "PENDING" &&
      order.status !== "CONFIRMED"
    ) {
      throw new MarketplaceError(
        409,
        "Only pending or confirmed orders can be cancelled.",
      );
    }
    if (order.returns.length > 0) {
      throw new MarketplaceError(
        409,
        "An order with a return request cannot be cancelled.",
      );
    }

    const stockByProduct = new Map<
      string,
      {
        productId: string;
        storeId: string;
        sellerId: string;
        createdAt: string;
        quantity: number;
      }
    >();
    for (const [index, item] of order.items.entries()) {
      const currentStatus = item.sellerStatus ?? order.status;
      if (currentStatus !== "PENDING" && currentStatus !== "CONFIRMED") {
        throw new MarketplaceError(
          409,
          "An order containing a shipped, delivered, returned, or cancelled item cannot be cancelled.",
        );
      }
      const product = await this.getProduct(item.productId);
      if (
        !product ||
        product.storeId !== item.storeId ||
        product.sellerId !== item.sellerId
      ) {
        throw new MarketplaceError(
          409,
          "Order inventory could not be verified; contact support.",
        );
      }
      const previous = stockByProduct.get(item.productId);
      const quantity = (previous?.quantity ?? 0) + item.quantity;
      if (!Number.isSafeInteger(quantity)) {
        throw new MarketplaceError(409, "Order inventory is outside the supported range.");
      }
      stockByProduct.set(item.productId, {
        productId: product.id,
        storeId: product.storeId,
        sellerId: product.sellerId,
        createdAt: product.createdAt,
        quantity,
      });
    }

    const expressionAttributeNames: Record<string, string> = {
      "#status": "status",
      "#items": "items",
      "#itemId": "id",
      "#sellerStatus": "sellerStatus",
      "#sellerStatusHistory": "sellerStatusHistory",
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ":customerId": customerId,
      ":pending": "PENDING",
      ":confirmed": "CONFIRMED",
      ":cancelled": "CANCELLED",
      ":now": now,
      ":emptyHistory": [],
      ":legacyPlaced": "PLACED",
      ":notDelivered": "NOT_DELIVERED",
    };
    const setExpressions = [
      "#status = :cancelled",
      "updatedAt = :now",
    ];
    const itemConditions: string[] = [];
    const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> = [];

    for (const [index, item] of order.items.entries()) {
      const itemStatusPath = `#items[${index}].#sellerStatus`;
      const itemIdPath = `#items[${index}].#itemId`;
      const historyPath = `#items[${index}].#sellerStatusHistory`;
      const historyValue = `:history${index}`;
      const itemIdValue = `:itemId${index}`;
      expressionAttributeValues[itemIdValue] = item.id;
      expressionAttributeValues[historyValue] = [{ status: "CANCELLED", updatedAt: now }];
      setExpressions.push(
        `${itemStatusPath} = :cancelled`,
        `${historyPath} = list_append(if_not_exists(${historyPath}, :emptyHistory), ${historyValue})`,
      );
      itemConditions.push(
        `${itemIdPath} = ${itemIdValue} AND (` +
          `${itemStatusPath} = :pending OR ${itemStatusPath} = :confirmed OR (` +
          `attribute_not_exists(${itemStatusPath}) AND (` +
          `#status = :pending OR #status = :confirmed OR ` +
          `(#status = :legacyPlaced AND deliveryStatus = :notDelivered))))`,
      );
      transactItems.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: { PK: `ORDER#${orderId}`, SK: `RETURN#${item.id}` },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: {
            PK: `AUDIT#ORDER#${orderId}`,
            SK: `AT#${now}#${randomUUID()}`,
            actorUserId: customerId,
            action: "order.item.customer_cancelled",
            orderItemId: item.id,
            previousStatus: item.sellerStatus ?? order.status,
            status: "CANCELLED",
            createdAt: now,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    }

    transactItems.unshift({
      Update: {
        TableName: this.tableName,
        Key: { PK: `ORDER#${orderId}`, SK: "PROFILE" },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ConditionExpression:
          "customerId = :customerId AND (" +
          "#status = :pending OR #status = :confirmed OR " +
          "(#status = :legacyPlaced AND deliveryStatus = :notDelivered)) AND " +
          itemConditions.join(" AND "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      },
    });

    for (const {
      productId,
      storeId,
      sellerId,
      createdAt,
      quantity,
    } of stockByProduct.values()) {
      transactItems.push(
        {
          Update: {
            TableName: this.tableName,
            Key: { PK: `PRODUCT#${productId}`, SK: "PROFILE" },
            UpdateExpression: "SET stock = stock + :quantity, updatedAt = :now",
            ConditionExpression:
              "id = :productId AND storeId = :storeId AND sellerId = :sellerId",
            ExpressionAttributeValues: {
              ":productId": productId,
              ":storeId": storeId,
              ":sellerId": sellerId,
              ":quantity": quantity,
              ":now": now,
            },
          },
        },
        {
          Update: {
            TableName: this.tableName,
            Key: {
              PK: `STORE#${storeId}`,
              SK: `PRODUCT#${createdAt}#${productId}`,
            },
            UpdateExpression: "SET stock = stock + :quantity, updatedAt = :now",
            ConditionExpression:
              "id = :productId AND storeId = :storeId AND sellerId = :sellerId",
            ExpressionAttributeValues: {
              ":productId": productId,
              ":storeId": storeId,
              ":sellerId": sellerId,
              ":quantity": quantity,
              ":now": now,
            },
          },
        },
      );
    }

    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(
          409,
          "Order status changed or the order can no longer be cancelled.",
        );
      }
      throw error;
    }
    const cancelledOrder = await this.getOrder(orderId);
    if (!cancelledOrder) throw new Error("Cancelled order could not be loaded.");
    return customerOrderForTracking(cancelledOrder);
  }

  async getOrder(orderId: string): Promise<OrderRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: `ORDER#${orderId}`, SK: "PROFILE" },
        ConsistentRead: true,
      }),
    );
    const order = readOrder(result.Item);
    if (!order) return null;
    const [returns, audit] = await Promise.all([
      this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `ORDER#${orderId}`,
            ":prefix": "RETURN#",
          },
          ConsistentRead: true,
        }),
      ),
      this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": `AUDIT#ORDER#${orderId}` },
          ConsistentRead: true,
        }),
      ),
    ]);
    order.returns = (returns.Items ?? [])
      .map((item) => readOrderReturn(item))
      .filter((entry): entry is OrderReturnRecord => entry !== null);
    const sellerStatusHistory = new Map<
      string,
      NonNullable<OrderRecord["items"][number]["sellerStatusHistory"]>
    >();
    for (const entry of audit.Items ?? []) {
      if (
        (entry.action !== "order.item.seller_status_updated" &&
          entry.action !== "order.item.customer_cancelled") ||
        typeof entry.orderItemId !== "string" ||
        !isOrderStatus(entry.status) ||
        typeof entry.createdAt !== "string"
      ) {
        continue;
      }
      const history = sellerStatusHistory.get(entry.orderItemId) ?? [];
      history.push({ status: entry.status, updatedAt: entry.createdAt });
      sellerStatusHistory.set(entry.orderItemId, history);
    }
    order.items = order.items.map((entry) => {
      const history = sellerStatusHistory.get(entry.id);
      return history ? { ...entry, sellerStatusHistory: history } : entry;
    });
    return order;
  }

  async listCustomerOrders(userId: string): Promise<OrderRecord[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `CUSTOMER#${userId}`,
          ":prefix": "ORDER#",
        },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: 50,
      }),
    );
    const orders = await Promise.all(
      (result.Items ?? [])
        .map((item) => item.orderId)
        .filter((orderId): orderId is string => typeof orderId === "string")
        .map((orderId) => this.getOrder(orderId)),
    );
    return orders.filter(
      (order): order is OrderRecord => order !== null && order.customerId === userId,
    ).map(customerOrderForTracking);
  }

  async listAdminOrders(): Promise<OrderRecord[]> {
    const orderIds: string[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "begins_with(PK, :orderPrefix) AND SK = :profile",
          ExpressionAttributeValues: {
            ":orderPrefix": "ORDER#",
            ":profile": "PROFILE",
          },
          ExclusiveStartKey: exclusiveStartKey,
          Limit: 100,
          ConsistentRead: true,
        }),
      );
      orderIds.push(
        ...(result.Items ?? [])
          .map((item) => item.PK)
          .filter(
            (partitionKey): partitionKey is string =>
              typeof partitionKey === "string" &&
              partitionKey.startsWith("ORDER#"),
          )
          .map((partitionKey) => partitionKey.slice("ORDER#".length)),
      );
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    const orders = await Promise.all(orderIds.map((orderId) => this.getOrder(orderId)));
    return orders.filter((order): order is OrderRecord => order !== null);
  }

  async listSellerOrders(storeId: string, sellerId: string): Promise<OrderRecord[]> {
    const orders = await this.listAdminOrders();
    return orders
      .map((order) => sellerOrderForStore(order, storeId, sellerId))
      .filter((order): order is OrderRecord => order !== null);
  }

  async updateSellerOrderItemStatus(
    orderId: string,
    itemId: string,
    storeId: string,
    sellerId: string,
    status: OrderStatus,
    now: string,
  ): Promise<OrderRecord> {
    const order = await this.getOrder(orderId);
    if (!order) throw new MarketplaceError(404, "Order was not found.");
    const itemIndex = order.items.findIndex(
      (item) =>
        item.id === itemId &&
        item.storeId === storeId &&
        item.sellerId === sellerId,
    );
    if (itemIndex < 0) throw new MarketplaceError(404, "Order item was not found.");
    const currentStatus = order.items[itemIndex].sellerStatus ?? order.status;
    if (!canTransitionOrderStatus(currentStatus, status)) {
      throw new MarketplaceError(
        409,
        `Order item status cannot transition from ${currentStatus} to ${status}.`,
      );
    }
    const isLegacyPending = currentStatus === "PENDING";

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `ORDER#${orderId}`, SK: "PROFILE" },
                UpdateExpression:
                  `SET #items[${itemIndex}].#sellerStatus = :nextStatus, updatedAt = :now`,
                ConditionExpression:
                  `#items[${itemIndex}].#itemId = :itemId AND ` +
                  `#items[${itemIndex}].#sellerId = :sellerId AND ` +
                  `#items[${itemIndex}].#storeId = :storeId AND (` +
                  `#items[${itemIndex}].#sellerStatus = :currentStatus OR (` +
                  `attribute_not_exists(#items[${itemIndex}].#sellerStatus) AND (` +
                  `#status = :currentStatus` +
                  (isLegacyPending
                    ? " OR (#status = :legacyPlaced AND #deliveryStatus = :notDelivered)"
                    : "") +
                  `)))`,
                ExpressionAttributeNames: {
                  "#items": "items",
                  "#itemId": "id",
                  "#sellerId": "sellerId",
                  "#storeId": "storeId",
                  "#sellerStatus": "sellerStatus",
                  "#status": "status",
                  ...(isLegacyPending ? { "#deliveryStatus": "deliveryStatus" } : {}),
                },
                ExpressionAttributeValues: {
                  ":itemId": itemId,
                  ":sellerId": sellerId,
                  ":storeId": storeId,
                  ":currentStatus": currentStatus,
                  ":nextStatus": status,
                  ":now": now,
                  ...(isLegacyPending
                    ? {
                        ":legacyPlaced": "PLACED",
                        ":notDelivered": "NOT_DELIVERED",
                      }
                    : {}),
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#ORDER#${orderId}`,
                  SK: `AT#${now}#${randomUUID()}`,
                  actorUserId: sellerId,
                  action: "order.item.seller_status_updated",
                  orderItemId: itemId,
                  previousStatus: currentStatus,
                  status,
                  createdAt: now,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(
          409,
          "Order item status changed before this update could be saved. Refresh and try again.",
        );
      }
      throw error;
    }
    const updated = await this.getOrder(orderId);
    if (!updated) throw new Error("Updated order could not be loaded.");
    const sellerOrder = sellerOrderForStore(updated, storeId, sellerId);
    if (!sellerOrder) {
      throw new MarketplaceError(409, "Updated order item is no longer available.");
    }
    return sellerOrder;
  }

  async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    adminUserId: string,
    now: string,
  ): Promise<OrderRecord> {
    const order = await this.getOrder(orderId);
    if (!order) throw new MarketplaceError(404, "Order was not found.");
    if (!canTransitionOrderStatus(order.status, status)) {
      throw new MarketplaceError(
        409,
        `Order status cannot transition from ${order.status} to ${status}.`,
      );
    }

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `ORDER#${orderId}`, SK: "PROFILE" },
                UpdateExpression:
                  "SET #status = :nextStatus, updatedAt = :now",
                ConditionExpression: order.status === "PENDING"
                  ? "#status = :currentStatus OR (#status = :legacyPlaced AND deliveryStatus = :notDelivered)"
                  : "#status = :currentStatus",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":currentStatus": order.status,
                  ":nextStatus": status,
                  ":now": now,
                  ...(order.status === "PENDING"
                    ? {
                        ":notDelivered": "NOT_DELIVERED",
                        ":legacyPlaced": "PLACED",
                      }
                    : {}),
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#ORDER#${orderId}`,
                  SK: `AT#${now}#${randomUUID()}`,
                  actorUserId: adminUserId,
                  action: "order.status_updated",
                  previousStatus: order.status,
                  status,
                  createdAt: now,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(
          409,
          "Order status changed before this update could be saved. Refresh and try again.",
        );
      }
      throw error;
    }
    const updated = await this.getOrder(orderId);
    if (!updated) throw new Error("Updated order could not be loaded.");
    return updated;
  }

  async requestOrderItemReturn(
    orderId: string,
    itemId: string,
    customerId: string,
    reason: string,
    images: OrderReturnRecord["images"],
    now: string,
    sellerResponseDeadlineAt: string,
  ): Promise<OrderReturnRecord> {
    const order = await this.getOrder(orderId);
    if (!order || order.customerId !== customerId) {
      throw new MarketplaceError(404, "Order was not found.");
    }
    const orderItemIndex = order.items.findIndex((item) => item.id === itemId);
    if (orderItemIndex < 0) throw new MarketplaceError(404, "Order item was not found.");
    const orderItem = order.items[orderItemIndex];
    if (order.status !== "DELIVERED" && orderItem.sellerStatus !== "DELIVERED") {
      throw new MarketplaceError(409, "Returns are available only after an order is delivered.");
    }
    if (order.returns.some((entry) => entry.orderItemId === itemId)) {
      throw new MarketplaceError(409, "A return has already been requested for this item.");
    }
    const record: OrderReturnRecord = {
      id: randomUUID(),
      orderItemId: itemId,
      productId: orderItem.productId,
      customerId,
      reason,
      status: "REQUESTED",
      refundStatus: "NOT_APPLICABLE",
      images,
      sellerReviewStatus: "PENDING",
      sellerResponseDeadlineAt,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { PK: `ORDER#${orderId}`, SK: `RETURN#${itemId}`, ...record },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { PK: `ORDER#${orderId}`, SK: "PROFILE" },
                ConditionExpression:
                  `customerId = :customerId AND (` +
                  `#status = :delivered OR (#status = :legacyPlaced AND deliveryStatus = :legacyDelivered) OR ` +
                  `#items[${orderItemIndex}].#sellerStatus = :delivered)`,
                ExpressionAttributeNames: {
                  "#status": "status",
                  "#items": "items",
                  "#sellerStatus": "sellerStatus",
                },
                ExpressionAttributeValues: {
                  ":customerId": customerId,
                  ":delivered": "DELIVERED",
                  ":legacyPlaced": "PLACED",
                  ":legacyDelivered": "LOCAL_TEST_DELIVERED",
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "A return already exists or the order changed.");
      }
      throw error;
    }
    return record;
  }

  async decideOrderItemReturn(
    orderId: string,
    returnId: string,
    storeId: string,
    sellerId: string,
    decision: "ACCEPTED" | "REJECTED",
    reason: string,
    now: string,
  ): Promise<OrderReturnRecord> {
    const order = await this.getOrder(orderId);
    const entry = order?.returns.find((candidate) => candidate.id === returnId);
    const item = order?.items.find(
      (candidate) =>
        candidate.id === entry?.orderItemId &&
        candidate.storeId === storeId &&
        candidate.sellerId === sellerId,
    );
    if (!order || !entry || !item) {
      throw new MarketplaceError(404, "Return request was not found.");
    }
    if (entry.status !== "REQUESTED" || entry.sellerReviewStatus !== "PENDING") {
      throw new MarketplaceError(409, "Return request is unavailable for seller review.");
    }
    const derivedDeadline = entry.sellerResponseDeadlineAt ??
      new Date(Date.parse(entry.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    if (Date.parse(derivedDeadline) <= Date.parse(now)) {
      throw new MarketplaceError(409, "The seller response deadline has passed.");
    }
    const sellerRejected = decision === "REJECTED";
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  PK: `ORDER#${orderId}`,
                  SK: `RETURN#${entry.orderItemId}`,
                },
                UpdateExpression: sellerRejected
                  ? "SET #status = :rejected, sellerReviewStatus = :sellerRejected, decisionSource = :decisionSource, sellerReviewedByUserId = :seller, sellerReviewReason = :reason, sellerReviewedAt = :now, sellerResponseDeadlineAt = :deadline, updatedAt = :now REMOVE adminReviewAvailableAt"
                  : "SET #status = :accepted, sellerReviewStatus = :sellerAccepted, decisionSource = :decisionSource, sellerReviewedByUserId = :seller, sellerReviewedAt = :now, sellerResponseDeadlineAt = :deadline, updatedAt = :now REMOVE sellerReviewReason, adminReviewAvailableAt",
                ConditionExpression:
                  "#status = :requested AND (attribute_not_exists(sellerReviewStatus) OR sellerReviewStatus = :pending) AND (sellerResponseDeadlineAt > :now OR (attribute_not_exists(sellerResponseDeadlineAt) AND createdAt > :legacyCutoff))",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":requested": "REQUESTED",
                  ":pending": "PENDING",
                  ...(sellerRejected
                    ? {
                        ":rejected": "REJECTED",
                        ":sellerRejected": "REJECTED",
                        ":reason": reason,
                      }
                    : {
                        ":accepted": "ACCEPTED",
                        ":sellerAccepted": "ACCEPTED",
                      }),
                  ":decisionSource": "SELLER",
                  ":seller": sellerId,
                  ":now": now,
                  ":deadline": derivedDeadline,
                  ":legacyCutoff": new Date(
                    Date.parse(now) - 24 * 60 * 60 * 1000,
                  ).toISOString(),
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  PK: `AUDIT#ORDER#${orderId}`,
                  SK: `AT#${now}#${randomUUID()}`,
                  actorUserId: sellerId,
                  action: sellerRejected
                    ? "order.return.seller_rejected"
                    : "order.return.seller_accepted",
                  returnId,
                  decision,
                  ...(reason ? { reason } : {}),
                  createdAt: now,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isRecord(error) && error.name === "TransactionCanceledException") {
        throw new MarketplaceError(409, "Return request changed or its response deadline passed.");
      }
      throw error;
    }
    const updated = await this.getOrder(orderId);
    const reviewed = updated?.returns.find((candidate) => candidate.id === returnId);
    if (!reviewed) throw new Error("Seller-decided return request could not be loaded.");
    return reviewed;
  }

  async processExpiredReturnRequests(now: string): Promise<number> {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("Return processing timestamp is invalid.");
    const legacyCutoff = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    let processed = 0;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression:
            "(#status = :requested AND (sellerReviewStatus = :pending OR attribute_not_exists(sellerReviewStatus)) AND ((sellerResponseDeadlineAt <= :now) OR (attribute_not_exists(sellerResponseDeadlineAt) AND createdAt <= :legacyCutoff))) OR (#status = :requested AND sellerReviewStatus = :forwarded AND sellerRecommendation = :accepted)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":requested": "REQUESTED",
            ":pending": "PENDING",
            ":now": now,
            ":legacyCutoff": legacyCutoff,
            ":forwarded": "FORWARDED",
            ":accepted": "ACCEPTED",
          },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      for (const candidate of page.Items ?? []) {
        const orderKey = candidate.PK;
        const returnKey = candidate.SK;
        const isLegacySellerAcceptance =
          candidate.sellerReviewStatus === "FORWARDED" &&
          candidate.sellerRecommendation === "ACCEPTED";
        if (
          typeof orderKey !== "string" ||
          !orderKey.startsWith("ORDER#") ||
          typeof returnKey !== "string" ||
          !returnKey.startsWith("RETURN#") ||
          typeof candidate.id !== "string" ||
          typeof candidate.orderItemId !== "string"
        ) {
          continue;
        }
        const orderId = orderKey.slice("ORDER#".length);
        const updateNow = now;
        const updateExpression = isLegacySellerAcceptance
          ? "SET #status = :accepted, sellerReviewStatus = :sellerAccepted, decisionSource = :sellerSource, updatedAt = :now"
          : "SET #status = :accepted, sellerReviewStatus = :autoAccepted, decisionSource = :autoSource, sellerReviewedAt = :now, updatedAt = :now";
        const conditionExpression = isLegacySellerAcceptance
          ? "#status = :requested AND sellerReviewStatus = :forwarded AND sellerRecommendation = :sellerRecommendation"
          : "#status = :requested AND (sellerReviewStatus = :pending OR attribute_not_exists(sellerReviewStatus)) AND ((sellerResponseDeadlineAt <= :now) OR (attribute_not_exists(sellerResponseDeadlineAt) AND createdAt <= :legacyCutoff))";
        try {
          await this.client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Update: {
                    TableName: this.tableName,
                    Key: { PK: orderKey, SK: returnKey },
                    UpdateExpression: updateExpression,
                    ConditionExpression: conditionExpression,
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ...(isLegacySellerAcceptance
                        ? {
                            ":requested": "REQUESTED",
                            ":accepted": "ACCEPTED",
                            ":sellerAccepted": "ACCEPTED",
                            ":sellerSource": "SELLER",
                            ":now": updateNow,
                            ":forwarded": "FORWARDED",
                            ":sellerRecommendation": "ACCEPTED",
                          }
                        : {
                            ":requested": "REQUESTED",
                            ":accepted": "ACCEPTED",
                            ":now": updateNow,
                            ":legacyCutoff": legacyCutoff,
                            ":pending": "PENDING",
                            ":autoAccepted": "SYSTEM_AUTO_ACCEPTED",
                            ":autoSource": "SYSTEM_AUTO_ACCEPTED",
                          }),
                    },
                  },
                },
                {
                  Put: {
                    TableName: this.tableName,
                    Item: {
                      PK: `AUDIT#ORDER#${orderId}`,
                      SK: `AT#${now}#${randomUUID()}`,
                      actorUserId: isLegacySellerAcceptance ? candidate.sellerReviewedByUserId ?? "SYSTEM_MIGRATION" : "SYSTEM",
                      action: isLegacySellerAcceptance
                        ? "order.return.legacy_seller_acceptance_finalized"
                        : "order.return.system_auto_accepted",
                      returnId: candidate.id,
                      decisionSource: isLegacySellerAcceptance ? "SELLER" : "SYSTEM_AUTO_ACCEPTED",
                      createdAt: now,
                    },
                    ConditionExpression: "attribute_not_exists(PK)",
                  },
                },
              ],
            }),
          );
          processed += 1;
        } catch (error) {
          if (isRecord(error) && error.name === "TransactionCanceledException") {
            continue;
          }
          throw error;
        }
      }
      lastEvaluatedKey = page.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    return processed;
  }

  private async getOrderByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<OrderRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `ORDER_IDEMPOTENCY#${userId}`,
          SK: `KEY#${idempotencyKey}`,
        },
        ConsistentRead: true,
      }),
    );
    return typeof result.Item?.orderId === "string"
      ? this.getOrder(result.Item.orderId)
      : null;
  }
}

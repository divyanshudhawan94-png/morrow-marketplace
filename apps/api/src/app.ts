import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createSessionToken,
  generateCustomerOtp,
  hashCustomerOtp,
  hashPassword,
  hashSessionToken,
  SESSION_TTL_SECONDS,
  verifyPassword,
} from "./auth.js";
import {
  MarketplaceError,
  type CatalogSort,
  type AuthRepository,
  type CustomerOtpRecord,
  type ProductImage,
  type ProductRecord,
  type OrderRecord,
  type OrderReturnRecord,
  type Role,
  type SellerVerificationDetails,
  type SellerVerificationRecord,
  type SellerVerificationStatus,
  type SellerStore,
  type UserRecord,
} from "./repository.js";
import type { ProductImageStorage } from "./product-image-storage.js";
import { LocalFilesystemProductImageStorage } from "./product-image-storage.js";
import {
  MAX_PRODUCT_IMAGE_BYTES,
  normalizeProductImage,
} from "./product-image-validation.js";
import {
  MAX_RETURN_DAMAGE_IMAGE_BYTES,
  normalizeReturnDamagePhoto,
} from "./return-photo-validation.js";
import {
  normalizeSellerDocument,
  parseSellerVerificationDetails,
  ManualSellerVerificationProvider,
  type PrivateSellerDocumentStorage,
  type SellerVerificationProtector,
  type SellerVerificationProvider,
} from "./seller-verification.js";

const SESSION_COOKIE = "marketplace_session";

export interface PublicUser {
  id: string;
  email?: string;
  mobileNumber?: string;
  roles: Role[];
  createdAt: string;
  storeId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: PublicUser | null;
  }
}

interface CreateAppOptions {
  repository: AuthRepository;
  webOrigin: string;
  secureCookies?: boolean;
  allowedImageHosts?: string[];
  productImageStorage?: ProductImageStorage;
  sellerDocumentStorage?: PrivateSellerDocumentStorage;
  sellerVerificationProtector?: SellerVerificationProtector;
  sellerVerificationProvider?: SellerVerificationProvider;
  localWorkflowTesting?: boolean;
  localCheckoutTesting?: boolean;
  localProductImageStorage?: LocalFilesystemProductImageStorage;
  customerOtpEnabled?: boolean;
  customerOtpHmacSecret?: string;
  customerOtpLogger?: (mobileNumber: string, otp: string) => void;
}

const MAX_RETURN_DAMAGE_IMAGES = 5;
const SELLER_RETURN_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;

const registrationSchema = z
  .object({
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    password: z
      .string()
      .min(12)
      .max(128)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 128),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();

const customerOtpRequestSchema = z
  .object({
    mobileNumber: z.string().regex(/^[6-9]\d{9}$/),
  })
  .strict();

const customerOtpVerifySchema = customerOtpRequestSchema.extend({
  otp: z.string().regex(/^\d{6}$/),
}).strict();

const sellerApplicationSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
  })
  .strict();

const productSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().min(10).max(5000),
    brand: z.string().trim().min(1).max(80),
    sku: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/).transform((value) => value.toUpperCase()),
    category: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60),
    priceMinor: z.number().int().min(1).max(1_000_000_000_000),
    stock: z.number().int().min(0).max(1_000_000),
    images: z
      .array(
        z
          .object({
            url: z.string().url().max(2048).refine((value) => {
              try {
                return ["https:", "http:"].includes(new URL(value).protocol);
              } catch {
                return false;
              }
            }),
            altText: z.string().trim().min(3).max(180),
          })
          .strict(),
      )
      .max(5)
      .default([]),
    specifications: z
      .record(z.string().trim().min(1).max(60), z.string().trim().min(1).max(240))
      .refine((specs) => Object.keys(specs).length <= 30),
  })
  .strict();

const catalogQuerySchema = z
  .object({
    category: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60).optional(),
    brand: z.string().trim().min(1).max(80).optional(),
    q: z.string().trim().min(1).max(80).optional(),
    minPrice: z.coerce.number().int().min(0).max(1_000_000_000_000).optional(),
    maxPrice: z.coerce.number().int().min(0).max(1_000_000_000_000).optional(),
    sort: z.enum(["newest", "price_asc", "price_desc"]).default("newest"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

const sellerProductsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

const moderationReasonSchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();

const cartItemsSchema = z
  .array(
    z
      .object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(99),
        size: z.string().trim().min(1).max(20).optional(),
      })
      .strict(),
  )
  .max(6)
  .refine(
    (items) =>
      new Set(items.map((item) => `${item.productId}:${item.size ?? ""}`)).size ===
      items.length,
  );

const cartSchema = z.object({ items: cartItemsSchema }).strict();

const checkoutSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    items: cartItemsSchema.optional(),
    delivery: z
      .object({
        recipientName: z.string().trim().min(2).max(100),
        phone: z.string().trim().regex(/^\+?[1-9][0-9]{9,14}$/),
        address: z.string().trim().min(5).max(300),
        city: z.string().trim().min(2).max(80),
        state: z.string().trim().min(2).max(80),
        pinCode: z.string().trim().regex(/^[1-9][0-9]{5}$/),
      })
      .strict(),
  })
  .strict();

const returnRequestSchema = z
  .object({ reason: z.string().trim().min(5).max(500) })
  .strict();

const orderStatusSchema = z
  .object({
    status: z.enum([
      "PENDING",
      "CONFIRMED",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "CANCELLED",
    ]),
  })
  .strict();

const sellerReturnReviewSchema = z
  .object({
    decision: z.enum(["ACCEPTED", "REJECTED"]),
    reason: z.string().trim().min(5).max(500).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.decision === "REJECTED" && !input.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason is required to reject a return.",
      });
    }
  });

function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(user.mobileNumber ? { mobileNumber: user.mobileNumber } : {}),
    roles: user.roles,
    createdAt: user.createdAt,
    ...(user.storeId ? { storeId: user.storeId } : {}),
  };
}

function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new MarketplaceError(400, "Request body is invalid.");
  }
  return result.data;
}

function publicReturnRequest(orderId: string, entry: OrderReturnRecord) {
  const { images, ...record } = entry;
  return {
    ...record,
    images: images.map(({ id, createdAt }) => ({
      id,
      createdAt,
      url: `/orders/${encodeURIComponent(orderId)}/returns/${encodeURIComponent(entry.id)}/images/${encodeURIComponent(id)}`,
    })),
  };
}

function publicOrder(order: OrderRecord) {
  return {
    ...order,
    returns: order.returns.map((entry) => publicReturnRequest(order.id, entry)),
  };
}

function requireUser(request: FastifyRequest): PublicUser {
  if (!request.authUser) {
    throw new MarketplaceError(401, "Authentication is required.");
  }
  return request.authUser;
}

function requireRole(user: PublicUser, role: Role): void {
  if (!user.roles.includes(role)) {
    throw new MarketplaceError(403, "You do not have permission to perform this action.");
  }
}

async function requireApprovedSeller(
  user: PublicUser,
  repository: AuthRepository,
): Promise<SellerStore> {
  requireRole(user, "seller");
  if (!user.storeId) {
    throw new MarketplaceError(403, "An approved seller store is required.");
  }
  const store = await repository.getSellerStore(user.storeId);
  if (
    !store ||
    store.ownerUserId !== user.id ||
    store.status !== "approved"
  ) {
    throw new MarketplaceError(403, "An approved seller store is required.");
  }
  const verification = await repository.getSellerVerification(store.id);
  if (!verification || verification.status !== "APPROVED") {
    throw new MarketplaceError(403, "Approved business verification is required for seller actions.");
  }
  return store;
}

function publicProduct(product: ProductRecord) {
  return {
    id: product.id,
    storeId: product.storeId,
    title: product.title,
    description: product.description,
    brand: product.brand,
    category: product.category,
    currency: product.currency,
    priceMinor: product.priceMinor,
    stock: product.stock,
    images: product.images,
    specifications: product.specifications,
    createdAt: product.createdAt,
  };
}

export function createApp({
  repository,
  webOrigin,
  allowedImageHosts = (process.env.PRODUCT_IMAGE_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
  secureCookies =
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test",
  productImageStorage,
  sellerDocumentStorage,
  sellerVerificationProtector,
  sellerVerificationProvider = new ManualSellerVerificationProvider(),
  localWorkflowTesting = false,
  localCheckoutTesting = false,
  localProductImageStorage,
  customerOtpEnabled = process.env.NODE_ENV === "development",
  customerOtpHmacSecret = randomBytes(32).toString("hex"),
  customerOtpLogger,
}: CreateAppOptions) {
  if (customerOtpEnabled && process.env.NODE_ENV === "production") {
    throw new Error("Customer terminal OTP login cannot be enabled in production.");
  }
  if (customerOtpEnabled && Buffer.byteLength(customerOtpHmacSecret, "utf8") < 32) {
    throw new Error("Customer OTP HMAC secret must contain at least 32 bytes.");
  }
  const app = Fastify({
    logger: true,
    trustProxy: false,
    bodyLimit: 16 * 1024,
  });

  app.register(helmet);
  app.register(cookie);
  app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: MAX_RETURN_DAMAGE_IMAGES,
      fields: 1,
      parts: MAX_RETURN_DAMAGE_IMAGES + 1,
    },
  });
  app.register(cors, {
    origin: webOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  });
  app.register(rateLimit, { global: false });
  app.decorateRequest("authUser", null);
  app.addHook("onClose", async () => {
    productImageStorage?.destroy?.();
    sellerDocumentStorage?.destroy?.();
  });
  let lastReturnSweepAt = 0;
  let returnSweepPromise: Promise<number> | null = null;
  const processExpiredReturns = (now: string) => {
    if (returnSweepPromise) return returnSweepPromise;
    if (Date.now() - lastReturnSweepAt < 30_000) return Promise.resolve(0);
    returnSweepPromise = repository.processExpiredReturnRequests(now).finally(() => {
      lastReturnSweepAt = Date.now();
      returnSweepPromise = null;
    });
    return returnSweepPromise;
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      if (request.headers.origin !== webOrigin) {
        throw new MarketplaceError(403, "Request origin is not allowed.");
      }
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const tokenHash = hashSessionToken(token);
    const session = await repository.getSession(tokenHash);
    if (!session) return;

    if (session.expiresAt <= Math.floor(Date.now() / 1000)) {
      await repository.deleteSession(tokenHash);
      reply.clearCookie(SESSION_COOKIE, {
        path: "/",
        secure: secureCookies,
        sameSite: "lax",
      });
      return;
    }

    const user = await repository.getUserById(session.userId);
    if (!user) {
      await repository.deleteSession(tokenHash);
      reply.clearCookie(SESSION_COOKIE, {
        path: "/",
        secure: secureCookies,
        sameSite: "lax",
      });
      return;
    }

    request.authUser = publicUser(user);
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MarketplaceError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }

    const errorStatus =
      error instanceof Error && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode =
      typeof errorStatus === "number" &&
      errorStatus >= 400 &&
      errorStatus < 500
        ? errorStatus
        : 500;
    if (statusCode === 500) {
      request.log.error({ err: error }, "Unhandled API error");
    }
    return reply.status(statusCode).send({
      error:
        statusCode === 500
          ? "An unexpected error occurred."
          : error instanceof Error
            ? error.message
            : "Request failed.",
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "marketplace-api",
  }));

  app.get<{ Params: { imageName: string } }>(
    "/local-product-images/:imageName",
    async (request, reply) => {
      if (!localProductImageStorage) {
        throw new MarketplaceError(404, "Image was not found.");
      }
      if (!/^[0-9a-f-]{36}\.webp$/.test(request.params.imageName)) {
        throw new MarketplaceError(404, "Image was not found.");
      }
      const image = await localProductImageStorage.getObject(
        `products/${request.params.imageName}`,
      );
      if (!image) throw new MarketplaceError(404, "Image was not found.");
      return reply
        .type(image.contentType)
        .header("Cross-Origin-Resource-Policy", "same-site")
        .header("X-Content-Type-Options", "nosniff")
        .send(image.body);
    },
  );

  app.post(
    "/auth/register",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const input = parseBody(registrationSchema, request.body);
      const user: UserRecord = {
        id: randomUUID(),
        email: input.email,
        passwordHash: await hashPassword(input.password),
        roles: ["customer"],
        createdAt: new Date().toISOString(),
      };
      await repository.createUser(user);
      const token = await createAndPersistSession(repository, user.id);

      reply.setCookie(SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        maxAge: SESSION_TTL_SECONDS,
      });
      return reply.status(201).send({ user: publicUser(user) });
    },
  );

  app.post(
    "/auth/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const input = parseBody(loginSchema, request.body);
      const user = await repository.getUserByEmail(input.email);
      let passwordMatches = false;
      if (user?.passwordHash) {
        passwordMatches = await verifyPassword(input.password, user.passwordHash);
      } else {
        await hashPassword(input.password);
      }
      if (!user || !passwordMatches) {
        throw new MarketplaceError(401, "Email or password is incorrect.");
      }

      const token = await createAndPersistSession(repository, user.id);
      reply.setCookie(SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        maxAge: SESSION_TTL_SECONDS,
      });
      return { user: publicUser(user) };
    },
  );

  app.post(
    "/auth/customer-otp",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request) => {
      if (!customerOtpEnabled) {
        throw new MarketplaceError(404, "Customer mobile login is unavailable.");
      }
      const { mobileNumber } = parseBody(customerOtpRequestSchema, request.body);
      const existingUser = await repository.getUserByMobileNumber(mobileNumber);
      if (
        existingUser &&
        (!existingUser.roles.includes("customer") ||
          existingUser.roles.includes("super_admin"))
      ) {
        return {
          message: "If this number can use customer mobile login, a code has been issued.",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }

      const issuedAt = Math.floor(Date.now() / 1000);
      const otp = generateCustomerOtp();
      const record: CustomerOtpRecord = {
        mobileNumber,
        codeHash: hashCustomerOtp(mobileNumber, otp, customerOtpHmacSecret),
        issuedAt,
        expiresAt: issuedAt + 5 * 60,
        attemptsRemaining: 5,
      };
      const saved = await repository.saveCustomerOtp(record, issuedAt - 60);
      if (!saved) {
        throw new MarketplaceError(429, "Wait a minute before requesting another code.");
      }

      if (customerOtpLogger) {
        customerOtpLogger(mobileNumber, otp);
      } else {
        request.log.info({ mobileNumber, otp }, "Local customer login OTP");
      }
      return {
        message: "If this number can use customer mobile login, a code has been issued.",
        expiresAt: new Date(record.expiresAt * 1000).toISOString(),
        resendAvailableAt: new Date((issuedAt + 60) * 1000).toISOString(),
      };
    },
  );

  app.post(
    "/auth/customer-otp/verify",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!customerOtpEnabled) {
        throw new MarketplaceError(404, "Customer mobile login is unavailable.");
      }
      const { mobileNumber, otp } = parseBody(customerOtpVerifySchema, request.body);
      const result = await repository.verifyCustomerOtp(
        mobileNumber,
        hashCustomerOtp(mobileNumber, otp, customerOtpHmacSecret),
        Math.floor(Date.now() / 1000),
      );
      if (result !== "verified") {
        throw new MarketplaceError(401, "The code is invalid, expired, or has been used.");
      }

      let user = await repository.getUserByMobileNumber(mobileNumber);
      if (!user) {
        const newUser: UserRecord = {
          id: randomUUID(),
          mobileNumber,
          roles: ["customer"],
          createdAt: new Date().toISOString(),
        };
        try {
          await repository.createUser(newUser);
          user = newUser;
        } catch (cause) {
          if (!(cause instanceof MarketplaceError) || cause.statusCode !== 409) {
            throw cause;
          }
          user = await repository.getUserByMobileNumber(mobileNumber);
        }
      }
      if (
        !user ||
        !user.roles.includes("customer") ||
        user.roles.includes("super_admin")
      ) {
        throw new MarketplaceError(401, "The code is invalid, expired, or has been used.");
      }

      const token = await createAndPersistSession(repository, user.id);
      reply.setCookie(SESSION_COOKIE, token, {
        path: "/",
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        maxAge: SESSION_TTL_SECONDS,
      });
      return { user: publicUser(user) };
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await repository.deleteSession(hashSessionToken(token));
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/", secure: secureCookies, sameSite: "lax" });
    return reply.status(204).send();
  });

  app.get("/auth/me", async (request) => ({
    user: requireUser(request),
  }));

  app.get("/seller/application", async (request) => {
    const user = requireUser(request);
    requireRole(user, "customer");
    if (!user.storeId) return { store: null };

    const store = await repository.getSellerStore(user.storeId);
    if (!store || store.ownerUserId !== user.id) {
      throw new MarketplaceError(404, "Store application was not found.");
    }
    return { store };
  });

  app.post("/seller/application", async (request, reply) => {
    const user = requireUser(request);
    requireRole(user, "customer");
    const input = parseBody(sellerApplicationSchema, request.body);
    const store: SellerStore = {
      id: randomUUID(),
      ownerUserId: user.id,
      name: input.name,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await repository.createSellerStore(store);
    return reply.status(201).send({ store });
  });

  app.get("/seller/verification", async (request) => {
    const user = requireUser(request);
    if (!user.storeId) {
      return {
        status: "NOT_SUBMITTED" satisfies SellerVerificationStatus,
        submissionAvailable: false,
        providerStatus: sellerVerificationProvider.status,
      };
    }
    const store = await repository.getSellerStore(user.storeId);
    if (!store || store.ownerUserId !== user.id) {
      throw new MarketplaceError(404, "Store application was not found.");
    }
    const verification = await repository.getSellerVerification(store.id);
    if (!verification) {
      return {
        status: "NOT_SUBMITTED" satisfies SellerVerificationStatus,
        submissionAvailable: Boolean(sellerDocumentStorage && sellerVerificationProtector),
        providerStatus: sellerVerificationProvider.status,
        storeStatus: store.status,
      };
    }
    const latestReview = verification.history.at(-1);
    return {
      status: verification.status,
      storeStatus: store.status,
      submissionAvailable:
        verification.status === "NEEDS_CORRECTION" ||
        verification.status === "REJECTED"
          ? Boolean(sellerDocumentStorage && sellerVerificationProtector)
          : false,
      providerStatus: sellerVerificationProvider.status,
      reason:
        latestReview?.status === "NEEDS_CORRECTION" ||
        latestReview?.status === "REJECTED"
          ? latestReview.reason
          : undefined,
      documents: verification.documents.map(({ id, kind, createdAt }) => ({
        id,
        kind,
        createdAt,
      })),
    };
  });

  app.post(
    "/seller/verification",
    { bodyLimit: 20 * 1024 * 1024 + 64 * 1024 },
    async (request) => {
      const user = requireUser(request);
      if (!user.storeId) {
        throw new MarketplaceError(403, "Apply for a store before submitting business verification.");
      }
      const store = await repository.getSellerStore(user.storeId);
      if (!store || store.ownerUserId !== user.id) {
        throw new MarketplaceError(404, "Store application was not found.");
      }
      if (!sellerDocumentStorage || !sellerVerificationProtector) {
        throw new MarketplaceError(
          503,
          "Private business verification storage is not configured.",
        );
      }
      if (!request.isMultipart()) {
        throw new MarketplaceError(400, "Submit verification using multipart form data.");
      }

      let detailsValue: unknown;
      const incomingDocuments = new Map<
        "BUSINESS_PROOF" | "GST_CERTIFICATE",
        { body: Buffer; contentType: string }
      >();
      for await (const part of request.parts()) {
        if (part.type === "file") {
          const kind =
            part.fieldname === "businessProof"
              ? "BUSINESS_PROOF"
              : part.fieldname === "gstCertificate"
                ? "GST_CERTIFICATE"
                : undefined;
          if (!kind || incomingDocuments.has(kind)) {
            throw new MarketplaceError(400, "Upload one business proof and at most one GST certificate.");
          }
          incomingDocuments.set(kind, {
            body: await part.toBuffer(),
            contentType: part.mimetype,
          });
        } else if (part.fieldname === "details" && detailsValue === undefined) {
          try {
            detailsValue = JSON.parse(String(part.value));
          } catch {
            throw new MarketplaceError(400, "Business verification details are invalid.");
          }
        } else {
          throw new MarketplaceError(400, "Only business details and verification documents are accepted.");
        }
      }

      if (!detailsValue || !incomingDocuments.has("BUSINESS_PROOF")) {
        throw new MarketplaceError(400, "Business details and a business proof document are required.");
      }
      const details = parseSellerVerificationDetails(detailsValue);
      if (
        details.gstRegistration === "REGISTERED" &&
        !incomingDocuments.has("GST_CERTIFICATE")
      ) {
        throw new MarketplaceError(400, "Upload the GST registration certificate.");
      }
      if (
        details.gstRegistration === "NOT_REQUIRED" &&
        incomingDocuments.has("GST_CERTIFICATE")
      ) {
        throw new MarketplaceError(400, "A GST certificate is not accepted when registration is not required.");
      }

      const previous = await repository.getSellerVerification(store.id);
      if (
        previous &&
        previous.status !== "NEEDS_CORRECTION" &&
        previous.status !== "REJECTED"
      ) {
        throw new MarketplaceError(409, "Verification is already submitted or approved.");
      }
      const createdAt = new Date().toISOString();
      const storedDocuments: SellerVerificationRecord["documents"] = [];
      const uploadedKeys: string[] = [];
      try {
        for (const [kind, incoming] of incomingDocuments) {
          const normalized = await normalizeSellerDocument(
            incoming.body,
            incoming.contentType,
          );
          const objectKey = `seller-verification/${randomUUID()}`;
          await sellerDocumentStorage.put(
            objectKey,
            normalized.body,
            normalized.contentType,
          );
          uploadedKeys.push(objectKey);
          storedDocuments.push({
            id: randomUUID(),
            kind,
            objectKey,
            contentType: normalized.contentType,
            createdAt,
          });
        }
        const history: SellerVerificationRecord["history"] = [
          ...(previous?.history ?? []),
          {
            status: "PENDING_REVIEW",
            actorUserId: user.id,
            createdAt,
          },
        ];
        await repository.saveSellerVerification({
          storeId: store.id,
          ownerUserId: user.id,
          status: "PENDING_REVIEW",
          encryptedData: sellerVerificationProtector.encrypt(details),
          documents: storedDocuments,
          history,
          createdAt: previous?.createdAt ?? createdAt,
          updatedAt: createdAt,
        });
      } catch (error) {
        for (const key of uploadedKeys) {
          try {
            await sellerDocumentStorage.delete(key);
          } catch {
            request.log.error("Failed to clean up an unattached private verification document.");
          }
        }
        throw error;
      }
      if (previous) {
        for (const document of previous.documents) {
          try {
            await sellerDocumentStorage.delete(document.objectKey);
          } catch {
            request.log.error("Failed to remove a superseded private verification document.");
          }
        }
      }
      return {
        status: "PENDING_REVIEW" satisfies SellerVerificationStatus,
        providerStatus: sellerVerificationProvider.status,
      };
    },
  );

  app.get("/admin/seller-verifications/pending", async (request) => {
    const user = requireUser(request);
    requireRole(user, "super_admin");
    const query = parseBody(sellerProductsQuerySchema, request.query);
    return repository.listPendingSellerVerifications(
      query.limit,
      query.cursor ?? null,
    );
  });

  app.get<{ Params: { storeId: string } }>(
    "/admin/seller-verifications/:storeId",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      const store = await repository.getSellerStore(request.params.storeId);
      const verification = await repository.getSellerVerification(request.params.storeId);
      if (
        !store ||
        !verification ||
        store.ownerUserId === user.id
      ) {
        throw new MarketplaceError(404, "Seller verification was not found.");
      }
      if (!sellerVerificationProtector) {
        throw new MarketplaceError(503, "Business verification data protection is not configured.");
      }
      const details: SellerVerificationDetails =
        sellerVerificationProtector.decrypt(verification.encryptedData);
      return {
        store: { id: store.id, name: store.name, status: store.status },
        status: verification.status,
        business: details,
        documents: verification.documents.map(
          ({ id, kind, contentType, createdAt }) => ({
            id,
            kind,
            contentType,
            createdAt,
          }),
        ),
        history: verification.history,
        providerStatus: sellerVerificationProvider.status,
      };
    },
  );

  app.get<{ Params: { storeId: string; documentId: string } }>(
    "/admin/seller-verifications/:storeId/documents/:documentId",
    async (request, reply) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      if (!sellerDocumentStorage) {
        throw new MarketplaceError(503, "Private business document storage is not configured.");
      }
      const store = await repository.getSellerStore(request.params.storeId);
      const verification = await repository.getSellerVerification(request.params.storeId);
      const document = verification?.documents.find(
        (candidate) => candidate.id === request.params.documentId,
      );
      if (!store || store.ownerUserId === user.id || !document) {
        throw new MarketplaceError(404, "Private verification document was not found.");
      }
      const stored = await sellerDocumentStorage.get(document.objectKey);
      return reply
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `attachment; filename="verification-${document.id}.${document.contentType === "application/pdf" ? "pdf" : "webp"}"`)
        .type(document.contentType)
        .send(stored.body);
    },
  );

  app.post<{ Params: { storeId: string } }>(
    "/admin/seller-verifications/:storeId/review",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      const reviewSchema = z
        .object({
          status: z.enum(["APPROVED", "NEEDS_CORRECTION", "REJECTED"]),
          reason: z.string().trim().min(5).max(500).optional(),
        })
        .strict();
      const input = parseBody(reviewSchema, request.body);
      if (input.status !== "APPROVED" && !input.reason) {
        throw new MarketplaceError(400, "A reason is required for corrections or rejection.");
      }
      await repository.reviewSellerVerification(
        request.params.storeId,
        user.id,
        input.status,
        input.reason,
      );
      return { status: input.status };
    },
  );

  app.get<{ Params: { storeId: string } }>(
    "/seller/stores/:storeId",
    async (request) => {
      const user = requireUser(request);
      const store = await requireApprovedSeller(user, repository);
      if (request.params.storeId !== store.id) {
        throw new MarketplaceError(404, "Store was not found.");
      }
      return { store };
    },
  );

  app.post<{ Params: { storeId: string } }>(
    "/admin/stores/:storeId/approve",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      await repository.approveSellerStore(request.params.storeId, user.id);
      return { status: "approved" };
    },
  );

  app.get("/admin/stores/pending", async (request) => {
    const user = requireUser(request);
    requireRole(user, "super_admin");
    const query = parseBody(sellerProductsQuerySchema, request.query);
    return repository.listPendingStores(query.limit, query.cursor ?? null);
  });

  app.post<{ Params: { storeId: string } }>(
    "/admin/stores/:storeId/reject",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      const { reason } = parseBody(moderationReasonSchema, request.body);
      await repository.rejectSellerStore(
        request.params.storeId,
        user.id,
        reason,
      );
      return { status: "rejected" };
    },
  );

  app.get("/admin/products/pending", async (request) => {
    const user = requireUser(request);
    requireRole(user, "super_admin");
    const query = parseBody(sellerProductsQuerySchema, request.query);
    return repository.listPendingProducts(query.limit, query.cursor ?? null);
  });

  app.post<{ Params: { productId: string } }>(
    "/admin/products/:productId/approve",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      await repository.approveProduct(request.params.productId, user.id);
      return { status: "approved" };
    },
  );

  app.post<{ Params: { productId: string } }>(
    "/admin/products/:productId/reject",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      const { reason } = parseBody(moderationReasonSchema, request.body);
      await repository.rejectProduct(request.params.productId, user.id, reason);
      return { status: "rejected" };
    },
  );

  app.post<{ Params: { productId: string } }>(
    "/admin/products/:productId/restore",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      const product = await repository.getProduct(request.params.productId);
      if (!product) throw new MarketplaceError(404, "Product was not found.");
      await repository.restoreProduct(product.id, product.storeId);
      return { status: product.archivedFromStatus ?? "active" };
    },
  );

  app.post("/seller/products", async (request, reply) => {
    const user = requireUser(request);
    const store = await requireApprovedSeller(user, repository);
    const input = parseBody(productSchema, request.body);
    validateProductImageHosts(
      input.images,
      allowedImageHosts,
      localWorkflowTesting || Boolean(localProductImageStorage),
    );
    const now = new Date().toISOString();
    const product: ProductRecord = {
      ...input,
      id: randomUUID(),
      sellerId: user.id,
      storeId: store.id,
      currency: "INR",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    await repository.createProduct(product);
    return reply.status(201).send({ product });
  });

  app.post<{ Params: { productId: string } }>(
    "/seller/products/:productId/images",
    {
      bodyLimit: MAX_PRODUCT_IMAGE_BYTES + 16 * 1024,
    },
    async (request) => {
      const user = requireUser(request);
      const store = await requireApprovedSeller(user, repository);
      const product = await repository.getProduct(request.params.productId);
      if (
        !product ||
        product.storeId !== store.id ||
        product.sellerId !== user.id
      ) {
        throw new MarketplaceError(404, "Product was not found.");
      }
      if (product.status !== "draft" && product.status !== "rejected") {
        throw new MarketplaceError(409, "Only draft or rejected products can receive images.");
      }
      if (product.images.length >= 5) {
        throw new MarketplaceError(400, "A product can have at most five images.");
      }
      if (!productImageStorage) {
        throw new MarketplaceError(503, "Product image uploads are not configured.");
      }
      if (!request.isMultipart()) {
        throw new MarketplaceError(400, "Upload an image using multipart form data.");
      }

      let imageBuffer: Buffer | undefined;
      let mimeType = "";
      let altText = "";
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "image" || imageBuffer) {
            throw new MarketplaceError(400, "Upload exactly one image file.");
          }
          imageBuffer = await part.toBuffer();
          mimeType = part.mimetype;
        } else if (part.fieldname === "altText" && !altText) {
          altText = String(part.value).trim();
        } else {
          throw new MarketplaceError(400, "Only an image and its alt text are accepted.");
        }
      }
      if (!imageBuffer) {
        throw new MarketplaceError(400, "Choose an image file to upload.");
      }
      if (altText.length < 3 || altText.length > 180) {
        throw new MarketplaceError(400, "Image alt text must be between 3 and 180 characters.");
      }

      const normalizedImage = await normalizeProductImage(imageBuffer, mimeType);
      const key = `products/${randomUUID()}.webp`;
      const image: ProductImage = {
        url: productImageStorage.publicUrl(key),
        altText,
      };
      validateProductImageHosts(
        [...product.images, image],
        allowedImageHosts,
        localWorkflowTesting || Boolean(localProductImageStorage),
      );

      await productImageStorage.putObject(key, normalizedImage, "image/webp");
      try {
        await repository.updateDraftProduct(
          {
            ...product,
            images: [...product.images, image],
            status: "draft",
            updatedAt: new Date().toISOString(),
          },
          store.id,
        );
      } catch (error) {
        try {
          await productImageStorage.deleteObject(key);
        } catch (cleanupError) {
          request.log.error({ err: cleanupError, key }, "Failed to clean up an unattached product image");
        }
        throw error;
      }
      return { image };
    },
  );

  app.get("/seller/products", async (request) => {
    const user = requireUser(request);
    const store = await requireApprovedSeller(user, repository);
    const query = parseBody(
      sellerProductsQuerySchema,
      request.query,
    );
    const page = await repository.listSellerProducts(
      store.id,
      query.limit,
      query.cursor ?? null,
    );
    return { ...page, items: page.items };
  });

  app.patch<{ Params: { productId: string } }>(
    "/seller/products/:productId",
    async (request) => {
      const user = requireUser(request);
      const store = await requireApprovedSeller(user, repository);
      const existing = await repository.getProduct(request.params.productId);
      if (!existing || existing.storeId !== store.id || existing.sellerId !== user.id) {
        throw new MarketplaceError(404, "Product was not found.");
      }
      if (existing.status !== "draft" && existing.status !== "rejected") {
        throw new MarketplaceError(409, "Only draft or rejected products can be edited.");
      }

      const input = parseBody(productSchema, request.body);
      validateProductImageHosts(
        input.images,
        allowedImageHosts,
        localWorkflowTesting || Boolean(localProductImageStorage),
      );
      const product: ProductRecord = {
        ...input,
        id: existing.id,
        sellerId: existing.sellerId,
        storeId: existing.storeId,
        currency: "INR",
        status: "draft",
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await repository.updateDraftProduct(product, store.id);
      return { product };
    },
  );

  app.get("/cart", async (request) => {
    const user = requireUser(request);
    requireRole(user, "customer");
    return { cart: await repository.getCart(user.id) };
  });

  app.put("/cart", async (request) => {
    const user = requireUser(request);
    requireRole(user, "customer");
    const input = parseBody(cartSchema, request.body);
    const cart = await repository.saveCart(
      user.id,
      input.items,
      new Date().toISOString(),
    );
    return { cart };
  });

  app.post("/checkout", async (request) => {
    const user = requireUser(request);
    requireRole(user, "customer");
    if (!localWorkflowTesting && !localCheckoutTesting) {
      throw new MarketplaceError(
        503,
        "Checkout is unavailable: payment is not configured. Test checkout is limited to local development.",
      );
    }
    const input = parseBody(checkoutSchema, request.body);
    const order = await repository.checkout(
      user.id,
      input.delivery,
      input.idempotencyKey,
      new Date().toISOString(),
      input.items,
    );
    return { order };
  });

  app.get("/orders", async (request) => {
    const user = requireUser(request);
    requireRole(user, "customer");
    await processExpiredReturns(new Date().toISOString());
    return {
      orders: (await repository.listCustomerOrders(user.id)).map(publicOrder),
      returnTestingEnabled: localWorkflowTesting || localCheckoutTesting,
    };
  });

  app.post<{ Params: { orderId: string } }>(
    "/orders/:orderId/cancel",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "customer");
      const order = await repository.cancelOrder(
        request.params.orderId,
        user.id,
        new Date().toISOString(),
      );
      return { order: publicOrder(order) };
    },
  );

  app.get("/seller/orders", async (request) => {
    const user = requireUser(request);
    const store = await requireApprovedSeller(user, repository);
    await processExpiredReturns(new Date().toISOString());
    return {
      orders: (await repository.listSellerOrders(store.id, user.id)).map(publicOrder),
    };
  });

  app.patch<{ Params: { orderId: string; itemId: string } }>(
    "/seller/orders/:orderId/items/:itemId/status",
    async (request) => {
      const user = requireUser(request);
      const store = await requireApprovedSeller(user, repository);
      const input = parseBody(orderStatusSchema, request.body);
      const order = await repository.updateSellerOrderItemStatus(
        request.params.orderId,
        request.params.itemId,
        store.id,
        user.id,
        input.status,
        new Date().toISOString(),
      );
      return { order: publicOrder(order) };
    },
  );

  app.post<{ Params: { orderId: string; itemId: string } }>(
    "/orders/:orderId/items/:itemId/returns",
    {
      bodyLimit:
        MAX_RETURN_DAMAGE_IMAGES * MAX_RETURN_DAMAGE_IMAGE_BYTES + 64 * 1024,
    },
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "customer");
      let reasonValue: unknown;
      const incomingImages: Buffer[] = [];
      if (request.isMultipart()) {
        try {
          for await (const part of request.parts()) {
            if (part.type === "file") {
              if (
                part.fieldname !== "images" ||
                incomingImages.length >= MAX_RETURN_DAMAGE_IMAGES
              ) {
                throw new MarketplaceError(
                  400,
                  `Upload no more than ${MAX_RETURN_DAMAGE_IMAGES} damage photos.`,
                );
              }
              const body = await part.toBuffer();
              if (body.byteLength > MAX_RETURN_DAMAGE_IMAGE_BYTES) {
                throw new MarketplaceError(413, "Each damage photo must be 5 MB or smaller.");
              }
              incomingImages.push(body);
            } else if (part.fieldname === "reason" && reasonValue === undefined) {
              reasonValue = part.value;
            } else {
              throw new MarketplaceError(400, "Only a return reason and damage photos are accepted.");
            }
          }
        } catch (error) {
          const multipartErrorCode =
            error instanceof Error && "code" in error ? error.code : undefined;
          if (
            multipartErrorCode === "FST_FILES_LIMIT" ||
            multipartErrorCode === "FST_PARTS_LIMIT"
          ) {
            throw new MarketplaceError(
              400,
              `Upload no more than ${MAX_RETURN_DAMAGE_IMAGES} damage photos.`,
            );
          }
          if (multipartErrorCode === "FST_REQ_FILE_TOO_LARGE") {
            throw new MarketplaceError(413, "Each damage photo must be 5 MB or smaller.");
          }
          throw error;
        }
      } else {
        const jsonInput = returnRequestSchema.safeParse(request.body);
        if (!jsonInput.success) {
          throw new MarketplaceError(400, "Request body is invalid.");
        }
        reasonValue = jsonInput.data.reason;
      }
      const input = parseBody(returnRequestSchema, { reason: reasonValue });
      if (incomingImages.length > 0 && !sellerDocumentStorage) {
        throw new MarketplaceError(503, "Private return photo storage is not configured.");
      }
      const createdAt = new Date().toISOString();
      const storedImages: OrderReturnRecord["images"] = [];
      const uploadedKeys: string[] = [];
      try {
        for (const incoming of incomingImages) {
          const normalizedBody = await normalizeReturnDamagePhoto(incoming);
          const image = {
            id: randomUUID(),
            objectKey: `return-damage/${randomUUID()}`,
            contentType: "image/webp",
            createdAt,
          } as const;
          await sellerDocumentStorage!.put(
            image.objectKey,
            normalizedBody,
            image.contentType,
          );
          uploadedKeys.push(image.objectKey);
          storedImages.push(image);
        }
        const returnRequest = await repository.requestOrderItemReturn(
          request.params.orderId,
          request.params.itemId,
          user.id,
          input.reason,
          storedImages,
          createdAt,
          new Date(Date.parse(createdAt) + SELLER_RETURN_RESPONSE_WINDOW_MS).toISOString(),
        );
        return { returnRequest: publicReturnRequest(request.params.orderId, returnRequest) };
      } catch (error) {
        for (const key of uploadedKeys) {
          try {
            await sellerDocumentStorage?.delete(key);
          } catch {
            request.log.error("Failed to clean up an unattached private return photo.");
          }
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { orderId: string; returnId: string; imageId: string } }>(
    "/orders/:orderId/returns/:returnId/images/:imageId",
    async (request, reply) => {
      const user = requireUser(request);
      const order = await repository.getOrder(request.params.orderId);
      const returnRecord = order?.returns.find(
        (entry) => entry.id === request.params.returnId,
      );
      const image = returnRecord?.images.find(
        (entry) => entry.id === request.params.imageId,
      );
      if (!order || !returnRecord || !image || !sellerDocumentStorage) {
        throw new MarketplaceError(404, "Return photo was not found.");
      }
      if (order.customerId !== user.id && !user.roles.includes("super_admin")) {
        const store = await repository.getSellerStore(user.storeId ?? "");
        const verification = store
          ? await repository.getSellerVerification(store.id)
          : null;
        const ownsItem = order.items.some(
          (item) =>
            item.id === returnRecord.orderItemId &&
            item.sellerId === user.id &&
            item.storeId === store?.id &&
            store?.ownerUserId === user.id &&
            store.status === "approved" &&
            verification?.status === "APPROVED",
        );
        if (!ownsItem) throw new MarketplaceError(404, "Return photo was not found.");
      }
      const object = await sellerDocumentStorage.get(image.objectKey);
      return reply
        .type(object.contentType)
        .header("Cache-Control", "private, no-store")
        .send(object.body);
    },
  );

  app.patch<{ Params: { orderId: string; returnId: string } }>(
    "/seller/orders/:orderId/returns/:returnId/review",
    async (request) => {
      const user = requireUser(request);
      const store = await requireApprovedSeller(user, repository);
      const input = parseBody(sellerReturnReviewSchema, request.body);
      const now = new Date().toISOString();
      await processExpiredReturns(now);
      const returnRequest = await repository.decideOrderItemReturn(
        request.params.orderId,
        request.params.returnId,
        store.id,
        user.id,
        input.decision,
        input.reason ?? "",
        now,
      );
      return {
        returnRequest: publicReturnRequest(request.params.orderId, returnRequest),
      };
    },
  );

  app.get("/admin/orders", async (request) => {
    const user = requireUser(request);
    requireRole(user, "super_admin");
    await processExpiredReturns(new Date().toISOString());
    return {
      orders: (await repository.listAdminOrders()).map(publicOrder),
      returnTestingEnabled: localWorkflowTesting || localCheckoutTesting,
    };
  });

  app.patch<{ Params: { orderId: string } }>(
    "/admin/orders/:orderId/status",
    async (request) => {
      const user = requireUser(request);
      requireRole(user, "super_admin");
      const input = parseBody(orderStatusSchema, request.body);
      const order = await repository.updateOrderStatus(
        request.params.orderId,
        input.status,
        user.id,
        new Date().toISOString(),
      );
      return { order };
    },
  );

  app.post<{ Params: { productId: string } }>(
    "/seller/products/:productId/archive",
    async (request) => {
      const user = requireUser(request);
      const store = await requireApprovedSeller(user, repository);
      await repository.archiveProduct(request.params.productId, store.id);
      return { status: "archived" };
    },
  );

  app.post<{ Params: { productId: string } }>(
    "/seller/products/:productId/restore",
    async (request) => {
      const user = requireUser(request);
      const store = await requireApprovedSeller(user, repository);
      await repository.restoreProduct(request.params.productId, store.id);
      return { status: "restored" };
    },
  );

  app.get("/catalog", async (request) => {
    const query = parseBody(catalogQuerySchema, request.query);
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new MarketplaceError(400, "Minimum price cannot exceed maximum price.");
    }
    if (query.sort !== "newest" && !query.category && !query.q) {
      throw new MarketplaceError(400, "A category is required for price sorting.");
    }
    const filters: {
      category?: string;
      brand?: string;
      search?: string;
      minPrice?: number;
      maxPrice?: number;
      sort: CatalogSort;
    } = { sort: query.sort };
    if (query.category) filters.category = query.category;
    if (query.brand) filters.brand = query.brand;
    if (query.q) filters.search = query.q;
    if (query.minPrice !== undefined) filters.minPrice = query.minPrice;
    if (query.maxPrice !== undefined) filters.maxPrice = query.maxPrice;
    const page = await repository.listCatalog(
      filters,
      query.limit,
      query.cursor ?? null,
    );
    return { ...page, items: page.items.map(publicProduct) };
  });

  app.get<{ Params: { productId: string } }>(
    "/catalog/:productId",
    async (request) => {
      const product = await repository.getProduct(request.params.productId);
      if (!product || product.status !== "active") {
        throw new MarketplaceError(404, "Product was not found.");
      }
      return { product: publicProduct(product) };
    },
  );

  return app;
}

function validateProductImageHosts(
  images: ProductImage[],
  allowedHosts: string[],
  localWorkflowTesting = false,
): void {
  for (const image of images) {
    const url = new URL(image.url);
    const hostname = url.hostname.toLowerCase();
    const trustedHttps =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      allowedHosts.includes(hostname);
    const trustedLocalImage =
      localWorkflowTesting &&
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      hostname === "localhost" &&
      url.port === "4000" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/local-product-images\/[0-9a-f-]{36}\.webp$/.test(url.pathname) &&
      allowedHosts.includes(hostname);
    if (!trustedHttps && !trustedLocalImage) {
      throw new MarketplaceError(
        400,
        "Product images must use a configured trusted media host.",
      );
    }
  }
}

async function createAndPersistSession(
  repository: AuthRepository,
  userId: string,
): Promise<string> {
  const token = createSessionToken();
  await repository.createSession({
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  });
  return token;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { createApp } from "./app.js";
import {
  rankCatalogProducts,
  scoreCatalogProduct,
  searchTermMatch,
} from "./catalog-search.js";
import { hashCustomerOtp, hashPassword, hashSessionToken } from "./auth.js";
import { DynamoAuthRepository } from "./dynamodb-repository.js";
import {
  createLocalKycConfig,
  createLocalWorkflowConfig,
  isLocalDevelopmentCustomerOtpEnabled,
  isLocalDevelopmentCheckoutEnabled,
} from "./local-workflow.js";
import sharp from "sharp";
import {
  MarketplaceError,
  canTransitionOrderStatus,
  customerOrderForTracking,
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
  type SellerVerificationRecord,
  type SellerVerificationReview,
  type SellerVerificationSummary,
  type SellerStore,
  type SessionRecord,
  type UserRecord,
  sellerOrderForStore,
  validateCartItemForProduct,
} from "./repository.js";
import {
  createLocalDevelopmentProductImageStorage,
  LocalFilesystemProductImageStorage,
  createR2ProductImageStorage,
  type ProductImageStorage,
} from "./product-image-storage.js";
import {
  AesGcmSellerVerificationProtector,
  LocalFilesystemSellerDocumentStorage,
  createPrivateSellerDocumentStorage,
  createLocalSellerVerificationProtector,
  createSellerVerificationProtector,
  type PrivateSellerDocumentStorage,
} from "./seller-verification.js";

const dynamodbTestEndpoint =
  process.env.DYNAMODB_TEST_ENDPOINT ?? process.env.DYNAMODB_ENDPOINT;

test("catalog search ranks exact and related matches without irrelevant fallbacks", () => {
  const createdAt = "2026-11-02T00:00:00.000Z";
  const product = (
    id: string,
    title: string,
    brand: string,
    category: string,
  ): ProductRecord => ({
    id,
    title,
    brand,
    category,
    sellerId: "seller",
    storeId: "store",
    description: "Search fixture",
    sku: id,
    currency: "INR",
    priceMinor: 10000,
    stock: 5,
    images: [],
    specifications: {},
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  const exact = product("exact", "Nike Shoes", "Nike", "footwear");
  const related = product("related", "Nike Air Running Sneakers", "Nike", "footwear");
  const runningShoe = product("running-shoe", "Stride Running Shoe", "Stride", "footwear");
  const unrelatedBrand = product("unrelated-brand", "Nike Cotton Shirt", "Nike", "clothing");
  const unrelatedCategory = product("unrelated-category", "Leather Loafers", "Morrow", "footwear");
  const products = [related, runningShoe, unrelatedBrand, unrelatedCategory, exact];

  assert.ok(
    (scoreCatalogProduct(exact, "Nike Shoes") ?? 0) >
      (scoreCatalogProduct(related, "Nike Shoes") ?? 0),
    `Exact title score must lead: ${scoreCatalogProduct(exact, "Nike Shoes")} vs ${scoreCatalogProduct(related, "Nike Shoes")}.`,
  );
  assert.deepEqual(
    rankCatalogProducts(products, "Nike Shoes").map((entry) => entry.id),
    ["exact", "related"],
    `Rank scores: ${JSON.stringify(products.map((entry) => [entry.id, scoreCatalogProduct(entry, "Nike Shoes")]))}`,
  );
  assert.deepEqual(
    new Set(rankCatalogProducts(products, "running shoes").map((entry) => entry.id)),
    new Set(["related", "running-shoe"]),
  );
  assert.deepEqual(
    rankCatalogProducts(products, "nik sho").map((entry) => entry.id),
    ["exact", "related"],
  );
  assert.equal(searchTermMatch("sneekers", "sneakers"), "fuzzy");
  assert.deepEqual(
    rankCatalogProducts(products, "sneekers").map((entry) => entry.id),
    ["related"],
  );
  assert.deepEqual(rankCatalogProducts(products, "ceramic dragonfly"), []);
  assert.deepEqual(rankCatalogProducts(products, ""), []);
});

test(
  "DynamoDB store approval grants seller role and rejects unavailable stores",
  { skip: !dynamodbTestEndpoint },
  async () => {
    const endpoint = new URL(dynamodbTestEndpoint!);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname),
      "DYNAMODB_TEST_ENDPOINT must use a loopback address.",
    );

    const tableName = `marketplace-approval-test-${randomUUID()}`;
    const client = new DynamoDBClient({
      endpoint: endpoint.toString(),
      region: "ap-south-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    let tableCreated = false;
    let approvalApp: ReturnType<typeof createApp> | undefined;

    try {
      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }, { AttributeName: "SK", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
        }),
      );
      tableCreated = true;

      let tableActive = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const description = await client.send(
          new DescribeTableCommand({ TableName: tableName }),
        );
        if (description.Table?.TableStatus === "ACTIVE") {
          tableActive = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(tableActive, "The isolated approval test table did not become active.");

      const repository = new DynamoAuthRepository(
        tableName,
        "ap-south-1",
        endpoint.toString(),
      );
      approvalApp = createApp({
        repository,
        webOrigin: origin,
        secureCookies: false,
      });
      await approvalApp.ready();

      const admin: UserRecord = {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        passwordHash: await hashPassword(testPassword),
        roles: ["super_admin"],
        createdAt: new Date().toISOString(),
      };
      const owner: UserRecord = {
        id: randomUUID(),
        email: `${randomUUID()}@example.test`,
        passwordHash: await hashPassword(testPassword),
        roles: ["customer"],
        createdAt: new Date().toISOString(),
      };
      const store: SellerStore = {
        id: randomUUID(),
        ownerUserId: owner.id,
        name: "Approval test store",
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      await repository.createUser(admin);
      await repository.createUser(owner);
      await repository.createSellerStore(store);
      const submittedAt = new Date().toISOString();
      await repository.saveSellerVerification({
        storeId: store.id,
        ownerUserId: owner.id,
        status: "PENDING_REVIEW",
        encryptedData: "test-encrypted-payload",
        documents: [],
        history: [{
          status: "PENDING_REVIEW",
          actorUserId: owner.id,
          createdAt: submittedAt,
        }],
        createdAt: submittedAt,
        updatedAt: submittedAt,
      });
      await repository.reviewSellerVerification(
        store.id,
        admin.id,
        "NEEDS_CORRECTION",
        "Update the business registration proof.",
      );
      const correctedAt = new Date().toISOString();
      const correctedRecord = await repository.getSellerVerification(store.id);
      assert.ok(correctedRecord);
      await repository.saveSellerVerification({
        ...correctedRecord,
        status: "PENDING_REVIEW",
        history: [
          ...correctedRecord.history,
          {
            status: "PENDING_REVIEW",
            actorUserId: owner.id,
            createdAt: correctedAt,
          },
        ],
        updatedAt: correctedAt,
      });
      await repository.reviewSellerVerification(store.id, admin.id, "APPROVED");

      const ownerLogin = await approvalApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin },
        payload: { email: owner.email, password: testPassword },
      });
      assert.equal(ownerLogin.statusCode, 200);
      const unauthorizedApproval = await approvalApp.inject({
        method: "POST",
        url: `/admin/stores/${store.id}/approve`,
        headers: { origin, cookie: cookieFrom(ownerLogin) },
      });
      assert.equal(unauthorizedApproval.statusCode, 403);

      const adminLogin = await approvalApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin },
        payload: { email: admin.email, password: testPassword },
      });
      assert.equal(adminLogin.statusCode, 200);
      const adminCookie = cookieFrom(adminLogin);
      const approval = await approvalApp.inject({
        method: "POST",
        url: `/admin/stores/${store.id}/approve`,
        headers: { origin, cookie: adminCookie },
      });
      assert.equal(approval.statusCode, 200);
      assert.deepEqual(approval.json(), { status: "approved" });

      assert.equal((await repository.getSellerStore(store.id))?.status, "approved");
      assert.deepEqual((await repository.getUserById(owner.id))?.roles, [
        "customer",
        "seller",
      ]);
      const repeatedApproval = await approvalApp.inject({
        method: "POST",
        url: `/admin/stores/${store.id}/approve`,
        headers: { origin, cookie: adminCookie },
      });
      assert.equal(repeatedApproval.statusCode, 409);
      const missingStoreApproval = await approvalApp.inject({
        method: "POST",
        url: `/admin/stores/${randomUUID()}/approve`,
        headers: { origin, cookie: adminCookie },
      });
      assert.equal(missingStoreApproval.statusCode, 409);
    } finally {
      if (approvalApp) await approvalApp.close();
      if (tableCreated) {
        await client.send(new DeleteTableCommand({ TableName: tableName }));
      }
      client.destroy();
    }
  },
);

test(
  "DynamoDB checkout atomically decrements stock and deduplicates simultaneous orders",
  { skip: !dynamodbTestEndpoint },
  async () => {
    const endpoint = new URL(dynamodbTestEndpoint!);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname),
      "DYNAMODB_TEST_ENDPOINT must use a loopback address.",
    );
    const tableName = `marketplace-order-test-${randomUUID()}`;
    const client = new DynamoDBClient({
      endpoint: endpoint.toString(),
      region: "ap-south-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    let tableCreated = false;
    let workflowApp: ReturnType<typeof createApp> | undefined;
    let regressionApp: ReturnType<typeof createApp> | undefined;
    try {
      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "PK", AttributeType: "S" },
            { AttributeName: "SK", AttributeType: "S" },
            { AttributeName: "GSI1PK", AttributeType: "S" },
            { AttributeName: "GSI1SK", AttributeType: "S" },
            { AttributeName: "GSI6PK", AttributeType: "S" },
            { AttributeName: "GSI6SK", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "PK", KeyType: "HASH" },
            { AttributeName: "SK", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "GSI1",
              KeySchema: [
                { AttributeName: "GSI1PK", KeyType: "HASH" },
                { AttributeName: "GSI1SK", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
            {
              IndexName: "GSI6",
              KeySchema: [
                { AttributeName: "GSI6PK", KeyType: "HASH" },
                { AttributeName: "GSI6SK", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
      );
      tableCreated = true;
      let tableActive = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const description = await client.send(
          new DescribeTableCommand({ TableName: tableName }),
        );
        if (description.Table?.TableStatus === "ACTIVE") {
          tableActive = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(tableActive, "The isolated order test table did not become active.");

      const dynamoRepository = new DynamoAuthRepository(
        tableName,
        "ap-south-1",
        endpoint.toString(),
      );
      const dynamoDocumentClient = DynamoDBDocumentClient.from(client);
      workflowApp = createApp({
        repository: dynamoRepository,
        webOrigin: origin,
        secureCookies: false,
        localWorkflowTesting: true,
      });
      await workflowApp.ready();
      const passwordHash = await hashPassword(testPassword);
      const timestamp = new Date().toISOString();
      const customer = (id: string): UserRecord => ({
        id,
        email: `${id}@example.test`,
        passwordHash,
        roles: ["customer"],
        createdAt: timestamp,
      });
      const admin: UserRecord = {
        ...customer(`admin-${randomUUID()}`),
        roles: ["super_admin"],
      };
      const seller: UserRecord = customer(`seller-${randomUUID()}`);
      const firstCustomer = customer(`customer-${randomUUID()}`);
      const secondCustomer = customer(`customer-${randomUUID()}`);
      await Promise.all([
        dynamoRepository.createUser(admin),
        dynamoRepository.createUser(seller),
        dynamoRepository.createUser(firstCustomer),
        dynamoRepository.createUser(secondCustomer),
      ]);
      const store: SellerStore = {
        id: randomUUID(),
        ownerUserId: seller.id,
        name: "Dynamo local test store",
        status: "pending",
        createdAt: timestamp,
      };
      await dynamoRepository.createSellerStore(store);
      await dynamoRepository.saveSellerVerification({
        storeId: store.id,
        ownerUserId: seller.id,
        status: "PENDING_REVIEW",
        encryptedData: "test-only-encrypted-payload",
        documents: [],
        history: [{ status: "PENDING_REVIEW", actorUserId: seller.id, createdAt: timestamp }],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await dynamoRepository.reviewSellerVerification(store.id, admin.id, "APPROVED");
      await dynamoRepository.approveSellerStore(store.id, admin.id);
      const product: ProductRecord = {
        id: randomUUID(),
        sellerId: seller.id,
        storeId: store.id,
        title: "Dynamo transaction test item",
        description: "An isolated fixture used only to test atomic local order writes.",
        brand: "Test fixture",
        sku: `TEST-${randomUUID()}`,
        category: "home",
        currency: "INR",
        priceMinor: 1200,
        stock: 1,
        images: [{
          url: "https://media.example.test/test-item.webp",
          altText: "Test-only item image fixture",
        }],
        specifications: { material: "Cotton", availableColors: "Blue, Green" },
        status: "draft",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await dynamoRepository.createProduct(product);
      await dynamoRepository.approveProduct(product.id, admin.id);
      const catalogSearch = await workflowApp.inject({
        method: "GET",
        url: "/catalog?q=fixture",
      });
      assert.equal(catalogSearch.statusCode, 200);
      assert.ok(
        catalogSearch.json().items.some(
          (entry: ProductRecord) => entry.id === product.id,
        ),
      );

      const login = async (user: UserRecord) => {
        const response = await workflowApp!.inject({
          method: "POST",
          url: "/auth/login",
          headers: { origin },
          payload: { email: user.email, password: testPassword },
        });
        assert.equal(response.statusCode, 200);
        return cookieFrom(response);
      };
      const [firstCookie, secondCookie] = await Promise.all([
        login(firstCustomer),
        login(secondCustomer),
      ]);
      const sellerCookie = await login(seller);
      const adminCookie = await login(admin);
      for (const cookie of [firstCookie, secondCookie]) {
        const cartResponse: { statusCode: number } = await workflowApp!.inject({
          method: "PUT",
          url: "/cart",
          headers: { origin, cookie },
          payload: { items: [{ productId: product.id, quantity: 1 }] },
        });
        assert.equal(cartResponse.statusCode, 200);
      }
      const checkoutKey = randomUUID();
      const delivery = {
        recipientName: "Local test recipient",
        phone: "+919876543210",
        address: "12 Local Test Road",
        city: "Mumbai",
        state: "Maharashtra",
        pinCode: "400001",
      };
      const checkout = (cookie: string, idempotencyKey: string) =>
        workflowApp!.inject({
          method: "POST",
          url: "/checkout",
          headers: { origin, cookie },
          payload: { idempotencyKey, delivery },
        });
      const attempts = await Promise.all([
        checkout(firstCookie, checkoutKey),
        checkout(secondCookie, randomUUID()),
      ]);
      assert.deepEqual(attempts.map((response) => response.statusCode).sort(), [200, 409]);
      const successfulIndex = attempts.findIndex((response) => response.statusCode === 200);
      const successfulCookie = successfulIndex === 0 ? firstCookie : secondCookie;
      const successfulResponse = attempts[successfulIndex];
      const order = successfulResponse?.json().order as OrderRecord;
      assert.deepEqual(order.delivery, delivery);
      assert.equal(order.status, "PENDING");
      assert.equal(order.items[0]?.productId, product.id);
      assert.equal(order.items[0]?.sellerId, seller.id);
      assert.equal(order.items[0]?.storeId, store.id);
      assert.equal(order.items[0]?.quantity, 1);
      assert.equal(order.items[0]?.title, product.title);
      assert.equal(order.items[0]?.imageUrl, product.images[0]?.url);
      assert.equal(order.items[0]?.unitPriceMinor, product.priceMinor);
      assert.equal((await dynamoRepository.getProduct(product.id))?.stock, 0);
      assert.equal((await dynamoRepository.getProduct(product.id))?.status, "active");
      assert.equal((await dynamoRepository.listAdminOrders()).length, 1);
      const sellerOrdersAfterCheckout = await workflowApp.inject({
        method: "GET",
        url: "/seller/orders",
        headers: { cookie: sellerCookie },
      });
      assert.equal(sellerOrdersAfterCheckout.statusCode, 200);
      assert.equal(sellerOrdersAfterCheckout.json().orders.length, 1);
      assert.equal(sellerOrdersAfterCheckout.json().orders[0].id, order.id);
      assert.equal(
        sellerOrdersAfterCheckout.json().orders[0].items[0].imageUrl,
        product.images[0]?.url,
      );
      assert.equal(
        sellerOrdersAfterCheckout.json().orders[0].items[0].quantity,
        1,
      );
      const sellerProductAfterCheckout = (
        await dynamoRepository.listSellerProducts(store.id, 20, null)
      ).items.find((entry) => entry.id === product.id);
      assert.equal(sellerProductAfterCheckout?.stock, 0);
      assert.equal(sellerProductAfterCheckout?.status, "active");

      const archivedProductResponse = await workflowApp.inject({
        method: "POST",
        url: `/seller/products/${product.id}/archive`,
        headers: { origin, cookie: sellerCookie },
      });
      assert.equal(archivedProductResponse.statusCode, 200);
      assert.equal((await dynamoRepository.getProduct(product.id))?.status, "archived");
      const restoredProductResponse = await workflowApp.inject({
        method: "POST",
        url: `/seller/products/${product.id}/restore`,
        headers: { origin, cookie: sellerCookie },
      });
      assert.equal(restoredProductResponse.statusCode, 200);
      const restoredProduct = await dynamoRepository.getProduct(product.id);
      assert.ok(restoredProduct);
      assert.equal(restoredProduct.status, "active");
      assert.equal(restoredProduct.stock, product.stock - 1);
      assert.equal(restoredProduct.title, product.title);
      assert.equal(restoredProduct.description, product.description);
      assert.equal(restoredProduct.brand, product.brand);
      assert.equal(restoredProduct.sku, product.sku);
      assert.equal(restoredProduct.priceMinor, product.priceMinor);
      assert.deepEqual(restoredProduct.images, product.images);
      assert.deepEqual(restoredProduct.specifications, product.specifications);

      const duplicate = await checkout(successfulCookie, order.idempotencyKey);
      assert.equal(duplicate.statusCode, 200);
      assert.equal(duplicate.json().order.id, order.id);
      assert.equal((await dynamoRepository.getProduct(product.id))?.stock, 0);

      const rawOrderResult = await dynamoDocumentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { PK: `ORDER#${order.id}`, SK: "PROFILE" },
          ConsistentRead: true,
        }),
      );
      assert.ok(rawOrderResult.Item);
      const legacyItems = [...(rawOrderResult.Item.items as OrderRecord["items"])];
      delete legacyItems[0].sellerStatus;
      delete legacyItems[0].sellerStatusHistory;
      await dynamoDocumentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...rawOrderResult.Item,
            status: "PLACED",
            items: legacyItems,
          },
        }),
      );
      const legacySellerOrders = await workflowApp.inject({
        method: "GET",
        url: "/seller/orders",
        headers: { cookie: sellerCookie },
      });
      assert.equal(legacySellerOrders.statusCode, 200);
      assert.equal(legacySellerOrders.json().orders[0].status, "PENDING");
      assert.equal(
        legacySellerOrders.json().orders[0].items[0].sellerStatus,
        "PENDING",
      );
      const customerOrdersBeforeLegacyUpdate = await workflowApp.inject({
        method: "GET",
        url: "/orders",
        headers: { cookie: successfulCookie },
      });
      assert.equal(customerOrdersBeforeLegacyUpdate.statusCode, 200);
      assert.equal(customerOrdersBeforeLegacyUpdate.json().orders[0].status, "PENDING");
      assert.equal(
        customerOrdersBeforeLegacyUpdate.json().orders[0].items[0].sellerStatus,
        "PENDING",
      );
      const legacyConfirm = await workflowApp.inject({
        method: "PATCH",
        url: `/seller/orders/${order.id}/items/${order.items[0].id}/status`,
        headers: { origin, cookie: sellerCookie },
        payload: { status: "CONFIRMED" },
      });
      assert.equal(legacyConfirm.statusCode, 200);
      assert.equal(
        legacyConfirm.json().order.items[0].sellerStatus,
        "CONFIRMED",
      );
      assert.equal(
        (await dynamoRepository.getOrder(order.id))?.items[0].sellerStatus,
        "CONFIRMED",
      );
      const customerOrdersAfterLegacyUpdate = await workflowApp.inject({
        method: "GET",
        url: "/orders",
        headers: { cookie: successfulCookie },
      });
      assert.equal(customerOrdersAfterLegacyUpdate.statusCode, 200);
      assert.equal(
        customerOrdersAfterLegacyUpdate.json().orders[0].status,
        "CONFIRMED",
      );
      assert.equal(
        customerOrdersAfterLegacyUpdate.json().orders[0].items[0].sellerStatus,
        "CONFIRMED",
      );
      assert.deepEqual(
        customerOrdersAfterLegacyUpdate.json().orders[0].items[0].sellerStatusHistory,
        [{ status: "CONFIRMED", updatedAt: legacyConfirm.json().order.updatedAt }],
      );

      const updatedOrder = await dynamoRepository.updateOrderStatus(
        order.id,
        "CONFIRMED",
        admin.id,
        new Date().toISOString(),
      );
      assert.equal(updatedOrder.status, "CONFIRMED");
      assert.equal((await dynamoRepository.getOrder(order.id))?.status, "CONFIRMED");

      for (const status of ["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
        const fulfillmentResponse: { statusCode: number } = await workflowApp.inject({
          method: "PATCH",
          url: `/seller/orders/${order.id}/items/${order.items[0].id}/status`,
          headers: { origin, cookie: sellerCookie },
          payload: { status },
        });
        assert.equal(fulfillmentResponse.statusCode, 200);
      }
      const sellerRejectedRequest = await workflowApp.inject({
        method: "POST",
        url: `/orders/${order.id}/items/${order.items[0].id}/returns`,
        headers: { origin, cookie: successfulCookie },
        payload: { reason: "The delivered item needs a return review" },
      });
      assert.equal(sellerRejectedRequest.statusCode, 200);
      const sellerRejectedReturn = await workflowApp.inject({
        method: "PATCH",
        url: `/seller/orders/${order.id}/returns/${sellerRejectedRequest.json().returnRequest.id}/review`,
        headers: { origin, cookie: sellerCookie },
        payload: {
          decision: "REJECTED",
          reason: "The item does not meet the return policy",
        },
      });
      assert.equal(sellerRejectedReturn.statusCode, 200, sellerRejectedReturn.body);
      const persistedSellerRejection = await dynamoRepository.getOrder(order.id);
      assert.equal(persistedSellerRejection?.returns[0]?.status, "REJECTED");
      assert.equal(persistedSellerRejection?.returns[0]?.sellerReviewStatus, "REJECTED");

      const secondProduct: ProductRecord = {
        ...product,
        id: randomUUID(),
        sku: `TEST-${randomUUID()}`,
        stock: 1,
      };
      await dynamoRepository.createProduct(secondProduct);
      await dynamoRepository.approveProduct(secondProduct.id, admin.id);
      const secondCart = await workflowApp.inject({
        method: "PUT",
        url: "/cart",
        headers: { origin, cookie: successfulCookie },
        payload: { items: [{ productId: secondProduct.id, quantity: 1 }] },
      });
      assert.equal(secondCart.statusCode, 200);
      const secondCheckout = await workflowApp.inject({
        method: "POST",
        url: "/checkout",
        headers: { origin, cookie: successfulCookie },
        payload: {
          idempotencyKey: randomUUID(),
          delivery,
        },
      });
      assert.equal(secondCheckout.statusCode, 200, secondCheckout.body);
      const secondOrderId = secondCheckout.json().order.id as string;
      const secondItemId = secondCheckout.json().order.items[0].id as string;
      for (const status of [
        "CONFIRMED",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
      ] as const) {
        const secondFulfillmentResponse: { statusCode: number } = await workflowApp.inject({
          method: "PATCH",
          url: `/seller/orders/${secondOrderId}/items/${secondItemId}/status`,
          headers: { origin, cookie: sellerCookie },
          payload: { status },
        });
        assert.equal(secondFulfillmentResponse.statusCode, 200);
      }
      const secondReturnRequest = await workflowApp.inject({
        method: "POST",
        url: `/orders/${secondOrderId}/items/${secondItemId}/returns`,
        headers: { origin, cookie: successfulCookie },
        payload: { reason: "The second delivered item needs review" },
      });
      assert.equal(secondReturnRequest.statusCode, 200);
      const secondReturnId = secondReturnRequest.json().returnRequest.id as string;
      const sellerApprovedReturn = await workflowApp.inject({
        method: "PATCH",
        url: `/seller/orders/${secondOrderId}/returns/${secondReturnId}/review`,
        headers: { origin, cookie: sellerCookie },
        payload: { decision: "ACCEPTED" },
      });
      assert.equal(sellerApprovedReturn.statusCode, 200, sellerApprovedReturn.body);
      assert.equal(sellerApprovedReturn.json().returnRequest.status, "ACCEPTED");
      const adminApprovedReturn = await workflowApp.inject({
        method: "POST",
        url: `/admin/orders/${secondOrderId}/returns/${secondReturnId}/review`,
        headers: { origin, cookie: adminCookie },
        payload: { status: "ACCEPTED" },
      });
      assert.equal(adminApprovedReturn.statusCode, 404);
      assert.equal(
        (await dynamoRepository.getOrder(secondOrderId))?.returns[0]?.status,
        "ACCEPTED",
      );

      const thirdProduct: ProductRecord = {
        ...product,
        id: randomUUID(),
        sku: `TEST-${randomUUID()}`,
        stock: 1,
      };
      await dynamoRepository.createProduct(thirdProduct);
      await dynamoRepository.approveProduct(thirdProduct.id, admin.id);
      const thirdCart = await workflowApp.inject({
        method: "PUT",
        url: "/cart",
        headers: { origin, cookie: successfulCookie },
        payload: { items: [{ productId: thirdProduct.id, quantity: 1 }] },
      });
      assert.equal(thirdCart.statusCode, 200);
      const thirdCheckout = await workflowApp.inject({
        method: "POST",
        url: "/checkout",
        headers: { origin, cookie: successfulCookie },
        payload: { idempotencyKey: randomUUID(), delivery },
      });
      assert.equal(thirdCheckout.statusCode, 200, thirdCheckout.body);
      const thirdOrderId = thirdCheckout.json().order.id as string;
      const thirdItemId = thirdCheckout.json().order.items[0].id as string;
      for (const status of [
        "CONFIRMED",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
      ] as const) {
        const fulfillmentResponse: { statusCode: number } =
          await workflowApp.inject({
            method: "PATCH",
            url: `/seller/orders/${thirdOrderId}/items/${thirdItemId}/status`,
            headers: { origin, cookie: sellerCookie },
            payload: { status },
          });
        assert.equal(fulfillmentResponse.statusCode, 200);
      }
      const thirdReturn = await workflowApp.inject({
        method: "POST",
        url: `/orders/${thirdOrderId}/items/${thirdItemId}/returns`,
        headers: { origin, cookie: successfulCookie },
        payload: { reason: "A third delivered item needs a return review" },
      });
      assert.equal(thirdReturn.statusCode, 200);
      const thirdReturnId = thirdReturn.json().returnRequest.id as string;
      const sellerApprovalForRejection = await workflowApp.inject({
        method: "PATCH",
        url: `/seller/orders/${thirdOrderId}/returns/${thirdReturnId}/review`,
        headers: { origin, cookie: sellerCookie },
        payload: { decision: "ACCEPTED" },
      });
      assert.equal(sellerApprovalForRejection.statusCode, 200);
      assert.equal(sellerApprovalForRejection.json().returnRequest.status, "ACCEPTED");
      const adminRejectedReturn = await workflowApp.inject({
        method: "POST",
        url: `/admin/orders/${thirdOrderId}/returns/${thirdReturnId}/review`,
        headers: { origin, cookie: adminCookie },
        payload: { status: "REJECTED", reason: "Admin rejected the return request" },
      });
      assert.equal(adminRejectedReturn.statusCode, 404);
      assert.equal(
        (await dynamoRepository.getOrder(thirdOrderId))?.returns[0]?.status,
        "ACCEPTED",
      );

      const cancellationProduct: ProductRecord = {
        ...product,
        id: randomUUID(),
        sku: `TEST-${randomUUID()}`,
        category: "footwear",
        stock: 3,
        specifications: { availableSizes: "7, 8" },
      };
      await dynamoRepository.createProduct(cancellationProduct);
      await dynamoRepository.approveProduct(cancellationProduct.id, admin.id);
      const cancellationCart = await workflowApp.inject({
        method: "PUT",
        url: "/cart",
        headers: { origin, cookie: successfulCookie },
        payload: {
          items: [
            { productId: cancellationProduct.id, quantity: 1, size: "7" },
            { productId: cancellationProduct.id, quantity: 1, size: "8" },
          ],
        },
      });
      assert.equal(cancellationCart.statusCode, 200);
      const cancellationCheckout = await workflowApp.inject({
        method: "POST",
        url: "/checkout",
        headers: { origin, cookie: successfulCookie },
        payload: { idempotencyKey: randomUUID(), delivery },
      });
      assert.equal(cancellationCheckout.statusCode, 200);
      const cancellationOrderId = cancellationCheckout.json().order.id as string;
      assert.equal(cancellationCheckout.json().order.items.length, 2);
      assert.equal((await dynamoRepository.getProduct(cancellationProduct.id))?.stock, 1);
      const nonOwnerCookie =
        successfulCookie === firstCookie ? secondCookie : firstCookie;
      const nonOwnerCancellation = await workflowApp.inject({
        method: "POST",
        url: `/orders/${cancellationOrderId}/cancel`,
        headers: { origin, cookie: nonOwnerCookie },
      });
      assert.equal(nonOwnerCancellation.statusCode, 404);
      const cancellationResponse = await workflowApp.inject({
        method: "POST",
        url: `/orders/${cancellationOrderId}/cancel`,
        headers: { origin, cookie: successfulCookie },
      });
      assert.equal(cancellationResponse.statusCode, 200, cancellationResponse.body);
      assert.equal(cancellationResponse.json().order.status, "CANCELLED");
      assert.equal(
        cancellationResponse.json().order.items.every(
          (item: OrderRecord["items"][number]) =>
            item.sellerStatus === "CANCELLED",
        ),
        true,
      );
      assert.equal((await dynamoRepository.getProduct(cancellationProduct.id))?.stock, 3);
      const cancelledSellerProduct = (
        await dynamoRepository.listSellerProducts(store.id, 50, null)
      ).items.find((entry) => entry.id === cancellationProduct.id);
      assert.equal(cancelledSellerProduct?.stock, 3);
      const cancelledSellerOrderResponse = await workflowApp.inject({
        method: "GET",
        url: "/seller/orders",
        headers: { cookie: sellerCookie },
      });
      const cancelledSellerOrder = cancelledSellerOrderResponse
        .json()
        .orders.find((entry: OrderRecord) => entry.id === cancellationOrderId);
      assert.equal(cancelledSellerOrder.status, "CANCELLED");
      assert.equal(cancelledSellerOrder.items[0].sellerStatus, "CANCELLED");
      const duplicateCancellation = await workflowApp.inject({
        method: "POST",
        url: `/orders/${cancellationOrderId}/cancel`,
        headers: { origin, cookie: successfulCookie },
      });
      assert.equal(duplicateCancellation.statusCode, 409);
      assert.equal((await dynamoRepository.getProduct(cancellationProduct.id))?.stock, 3);

      const additionalOrderIds = Array.from({ length: 105 }, () => randomUUID());
      await Promise.all(
        additionalOrderIds.map((id, index) =>
          dynamoDocumentClient.send(
            new PutCommand({
              TableName: tableName,
              Item: {
                PK: `ORDER#${id}`,
                SK: "PROFILE",
                ...order,
                id,
                customerId: `legacy-customer-${index}`,
                idempotencyKey: id,
                createdAt: new Date(Date.now() + index).toISOString(),
                updatedAt: new Date(Date.now() + index).toISOString(),
                items: order.items.map((item) => ({
                  ...item,
                  id: randomUUID(),
                })),
              },
            }),
          ),
        ),
      );
      const pagedSellerOrders = await dynamoRepository.listSellerOrders(
        store.id,
        seller.id,
      );
      const pagedOrderIds = new Set(pagedSellerOrders.map((entry) => entry.id));
      for (const id of additionalOrderIds) {
        assert.ok(pagedOrderIds.has(id), `Seller order ${id} was not returned.`);
      }

      regressionApp = createApp({
        repository: dynamoRepository,
        webOrigin: origin,
        secureCookies: false,
        localWorkflowTesting: true,
      });
      await regressionApp.ready();
      const returnItem = order.items[0];
      assert.ok(returnItem);
      const legacyReturnId = randomUUID();
      await dynamoDocumentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `ORDER#${order.id}`,
            SK: `RETURN#${legacyReturnId}`,
            id: legacyReturnId,
            orderItemId: returnItem.id,
            productId: returnItem.productId,
            customerId: order.customerId,
            reason: "Legacy seller acceptance awaiting finalization",
            status: "REQUESTED",
            refundStatus: "NOT_APPLICABLE",
            images: [],
            sellerReviewStatus: "FORWARDED",
            sellerRecommendation: "ACCEPTED",
            sellerReviewedByUserId: seller.id,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        }),
      );
      const sellerOrdersWithLegacyReturn = await regressionApp.inject({
        method: "GET",
        url: "/seller/orders",
        headers: { cookie: sellerCookie },
      });
      assert.equal(sellerOrdersWithLegacyReturn.statusCode, 200);
      const legacyReturnOrder = sellerOrdersWithLegacyReturn
        .json()
        .orders.find((entry: OrderRecord) => entry.id === order.id);
      assert.ok(legacyReturnOrder);
      const finalizedLegacyReturn = legacyReturnOrder.returns.find(
        (entry: OrderReturnRecord) => entry.id === legacyReturnId,
      );
      assert.equal(finalizedLegacyReturn.status, "ACCEPTED");
      assert.equal(finalizedLegacyReturn.sellerReviewStatus, "ACCEPTED");
      assert.equal(finalizedLegacyReturn.decisionSource, "SELLER");
      assert.equal(finalizedLegacyReturn.refundStatus, "NOT_APPLICABLE");
    } finally {
      if (regressionApp) await regressionApp.close();
      if (workflowApp) await workflowApp.close();
      if (tableCreated) {
        await client.send(new DeleteTableCommand({ TableName: tableName }));
      }
      client.destroy();
    }
  },
);

class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly emails = new Map<string, string>();
  private readonly mobileNumbers = new Map<string, string>();
  private readonly customerOtps = new Map<string, CustomerOtpRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly stores = new Map<string, SellerStore>();
  private readonly verifications = new Map<string, SellerVerificationRecord>();
  private readonly products = new Map<string, ProductRecord>();
  private readonly carts = new Map<string, CartRecord>();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly idempotency = new Map<string, string>();
  readonly returnAuditEvents: Array<{
    orderId: string;
    returnId: string;
    actor: string;
    action: string;
  }> = [];
  private orderLock: Promise<void> = Promise.resolve();
  readonly auditEvents: Array<{ actorUserId: string; storeId: string }> = [];
  readonly moderationEvents: Array<{
    actorUserId: string;
    targetId: string;
    action: string;
    reason?: string;
  }> = [];

  async createUser(user: UserRecord): Promise<void> {
    if (
      (user.email && this.emails.has(user.email)) ||
      (user.mobileNumber && this.mobileNumbers.has(user.mobileNumber))
    ) {
      throw new MarketplaceError(409, "An account with this identity already exists.");
    }
    this.users.set(user.id, { ...user, roles: [...user.roles] });
    if (user.email) this.emails.set(user.email, user.id);
    if (user.mobileNumber) this.mobileNumbers.set(user.mobileNumber, user.id);
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const userId = this.emails.get(email);
    return userId ? this.getUserById(userId) : null;
  }

  async getUserByMobileNumber(mobileNumber: string): Promise<UserRecord | null> {
    const userId = this.mobileNumbers.get(mobileNumber);
    return userId ? this.getUserById(userId) : null;
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    const user = this.users.get(userId);
    return user ? { ...user, roles: [...user.roles] } : null;
  }

  async saveCustomerOtp(record: CustomerOtpRecord, resendAfter: number): Promise<boolean> {
    const current = this.customerOtps.get(record.mobileNumber);
    if (current && current.issuedAt > resendAfter && current.expiresAt > record.issuedAt) {
      return false;
    }
    this.customerOtps.set(record.mobileNumber, { ...record });
    return true;
  }

  async verifyCustomerOtp(
    mobileNumber: string,
    codeHash: string,
    now: number,
  ): Promise<"verified" | "invalid" | "expired" | "locked" | "missing"> {
    const current = this.customerOtps.get(mobileNumber);
    if (!current) return "missing";
    if (current.expiresAt <= now) return "expired";
    if (current.consumed || current.attemptsRemaining <= 0) return "locked";
    if (current.codeHash === codeHash) {
      current.consumed = true;
      current.attemptsRemaining = 0;
      return "verified";
    }
    current.attemptsRemaining -= 1;
    return current.attemptsRemaining === 0 ? "locked" : "invalid";
  }

  expireCustomerOtp(mobileNumber: string): void {
    const record = this.customerOtps.get(mobileNumber);
    if (record) record.expiresAt = 0;
  }

  setReturnDeadline(orderId: string, returnId: string, deadline: string): void {
    const returnRecord = this.orders.get(orderId)?.returns.find(
      (entry) => entry.id === returnId,
    );
    if (!returnRecord) throw new Error("Cannot seed a missing return.");
    returnRecord.sellerResponseDeadlineAt = deadline;
  }

  seedCustomerOtp(record: CustomerOtpRecord): void {
    this.customerOtps.set(record.mobileNumber, { ...record });
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async createSellerStore(store: SellerStore): Promise<void> {
    const owner = this.users.get(store.ownerUserId);
    if (!owner || owner.storeId) {
      throw new MarketplaceError(409, "A store application already exists.");
    }
    this.stores.set(store.id, store);
    owner.storeId = store.id;
  }

  seedStore(store: SellerStore): void {
    this.stores.set(store.id, structuredClone(store));
  }

  removeSellerStatusesFromOrder(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error("Cannot seed a missing order.");
    for (const item of order.items) {
      delete item.sellerStatus;
      delete item.sellerStatusHistory;
    }
  }

  setUserRoles(userId: string, roles: UserRecord["roles"]): void {
    const user = this.users.get(userId);
    if (user) user.roles = [...roles];
  }

  async getSellerStore(storeId: string): Promise<SellerStore | null> {
    return this.stores.get(storeId) ?? null;
  }

  async getSellerVerification(storeId: string): Promise<SellerVerificationRecord | null> {
    const verification = this.verifications.get(storeId);
    return verification ? structuredClone(verification) : null;
  }

  async saveSellerVerification(record: SellerVerificationRecord): Promise<void> {
    const current = this.verifications.get(record.storeId);
    if (
      current &&
      current.status !== "NEEDS_CORRECTION" &&
      current.status !== "REJECTED"
    ) {
      throw new MarketplaceError(409, "Verification is already submitted or approved.");
    }
    this.verifications.set(record.storeId, structuredClone(record));
  }

  async listPendingSellerVerifications(
    limit: number,
    cursor: string | null,
  ): Promise<{ items: SellerVerificationSummary[]; nextCursor: string | null }> {
    const pending = [...this.verifications.values()]
      .filter((verification) => verification.status === "PENDING_REVIEW")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const offset = this.readOffset(cursor);
    const items = pending.slice(offset, offset + limit).map((verification) => ({
      storeId: verification.storeId,
      status: verification.status,
      updatedAt: verification.updatedAt,
    }));
    return {
      items,
      nextCursor: offset + limit < pending.length ? this.cursor(offset + limit) : null,
    };
  }

  async reviewSellerVerification(
    storeId: string,
    reviewerUserId: string,
    status: SellerVerificationReview["status"],
    reason?: string,
  ): Promise<void> {
    const verification = this.verifications.get(storeId);
    if (
      !verification ||
      verification.status !== "PENDING_REVIEW" ||
      verification.ownerUserId === reviewerUserId
    ) {
      throw new MarketplaceError(409, "Verification is unavailable for review.");
    }
    const createdAt = new Date().toISOString();
    verification.status = status;
    verification.updatedAt = createdAt;
    verification.history.push({
      status,
      actorUserId: reviewerUserId,
      ...(reason ? { reason } : {}),
      createdAt,
    });
    this.moderationEvents.push({
      actorUserId: reviewerUserId,
      targetId: storeId,
      action: `seller.verification.${status.toLowerCase()}`,
      ...(reason ? { reason } : {}),
    });
  }

  seedSellerVerification(verification: SellerVerificationRecord): void {
    this.verifications.set(verification.storeId, structuredClone(verification));
  }

  async approveSellerStore(storeId: string, approvedByUserId: string): Promise<void> {
    const store = this.stores.get(storeId);
    const owner = store ? this.users.get(store.ownerUserId) : undefined;
    if (!store || store.status !== "pending" || !owner) {
      throw new MarketplaceError(409, "Store is unavailable or is not awaiting approval.");
    }
    if (store.ownerUserId === approvedByUserId) {
      throw new MarketplaceError(403, "A seller cannot approve their own store.");
    }
    if (this.verifications.get(storeId)?.status !== "APPROVED") {
      throw new MarketplaceError(409, "Business verification must be approved before store approval.");
    }
    store.status = "approved";
    if (!owner.roles.includes("seller")) owner.roles.push("seller");
    this.auditEvents.push({ actorUserId: approvedByUserId, storeId });
  }

  async rejectSellerStore(
    storeId: string,
    rejectedByUserId: string,
    reason: string,
  ): Promise<void> {
    const store = this.stores.get(storeId);
    if (!store || store.status !== "pending") {
      throw new MarketplaceError(409, "Store is unavailable for review.");
    }
    store.status = "rejected";
    this.moderationEvents.push({
      actorUserId: rejectedByUserId,
      targetId: storeId,
      action: "seller.store.rejected",
      reason,
    });
  }

  async getCart(userId: string): Promise<CartRecord> {
    return structuredClone(
      this.carts.get(userId) ?? { userId, items: [], updatedAt: "", revision: "" },
    );
  }

  async saveCart(
    userId: string,
    items: CartItemInput[],
    updatedAt: string,
  ): Promise<CartRecord> {
    for (const item of items) {
      const product = this.products.get(item.productId);
      if (product?.status !== "active") {
        throw new MarketplaceError(404, "One or more products are no longer available.");
      }
      validateCartItemForProduct(product, item);
    }
    const cart = { userId, items: structuredClone(items), updatedAt, revision: randomUUID() };
    this.carts.set(userId, cart);
    return structuredClone(cart);
  }

  async checkout(
    userId: string,
    delivery: DeliveryDetails,
    idempotencyKey: string,
    now: string,
    requestedItems?: CartItemInput[],
  ): Promise<OrderRecord> {
    let release!: () => void;
    const previous = this.orderLock;
    this.orderLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const existingId = this.idempotency.get(`${userId}#${idempotencyKey}`);
      if (existingId) return structuredClone(this.orders.get(existingId)!);
      const cart = this.carts.get(userId);
      const checkoutItems = requestedItems ?? cart?.items ?? [];
      if (!checkoutItems.length) {
        throw new MarketplaceError(400, "Add available products to your cart before checkout.");
      }
      const products = checkoutItems.map((item) => {
        const product = this.products.get(item.productId);
        const store = product ? this.stores.get(product.storeId) : undefined;
        const verification = product ? this.verifications.get(product.storeId) : undefined;
        if (
          !product ||
          product.status !== "active" ||
          product.stock < item.quantity ||
          !store ||
          store.ownerUserId !== product.sellerId ||
          store.status !== "approved" ||
          verification?.status !== "APPROVED"
        ) {
          throw new MarketplaceError(409, "A cart product is no longer available or eligible.");
        }
        validateCartItemForProduct(product, item);
        if (product.sellerId === userId) {
          throw new MarketplaceError(400, "You cannot order products from your own store.");
        }
        return { product, quantity: item.quantity, size: item.size };
      });
      const quantitiesByProduct = new Map<string, number>();
      for (const { product, quantity } of products) {
        const totalQuantity =
          (quantitiesByProduct.get(product.id) ?? 0) + quantity;
        if (!Number.isSafeInteger(totalQuantity) || totalQuantity > product.stock) {
          throw new MarketplaceError(
            409,
            `Only ${product.stock} units are available.`,
          );
        }
        quantitiesByProduct.set(product.id, totalQuantity);
      }
      const items = products.map(({ product, quantity, size }) => ({
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
        sellerStatusHistory: [{ status: "PENDING" as const, updatedAt: now }],
        unitPriceMinor: product.priceMinor,
        lineTotalMinor: product.priceMinor * quantity,
      }));
      const subtotalMinor = items.reduce((total, item) => total + item.lineTotalMinor, 0);
      if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor <= 0) {
        throw new MarketplaceError(400, "Order total is outside the supported range.");
      }
      const order: OrderRecord = {
        id: randomUUID(),
        customerId: userId,
        items,
        delivery: structuredClone(delivery),
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
      for (const { product, quantity } of products) {
        const totalQuantity = quantitiesByProduct.get(product.id);
        if (totalQuantity === undefined) continue;
        product.stock -= totalQuantity;
        quantitiesByProduct.delete(product.id);
      }
      this.orders.set(order.id, order);
      this.idempotency.set(`${userId}#${idempotencyKey}`, order.id);
      if (!requestedItems) this.carts.delete(userId);
      return structuredClone(order);
    } finally {
      release();
    }
  }

  async cancelOrder(
    orderId: string,
    customerId: string,
    now: string,
  ): Promise<OrderRecord> {
    const order = this.orders.get(orderId);
    if (!order || order.customerId !== customerId) {
      throw new MarketplaceError(404, "Order was not found.");
    }
    if (order.status !== "PENDING" && order.status !== "CONFIRMED") {
      throw new MarketplaceError(409, "Only pending or confirmed orders can be cancelled.");
    }
    if (order.returns.length > 0) {
      throw new MarketplaceError(409, "An order with a return request cannot be cancelled.");
    }
    for (const item of order.items) {
      const currentStatus = item.sellerStatus ?? order.status;
      if (currentStatus !== "PENDING" && currentStatus !== "CONFIRMED") {
        throw new MarketplaceError(
          409,
          "An order containing a shipped, delivered, returned, or cancelled item cannot be cancelled.",
        );
      }
      const product = this.products.get(item.productId);
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
    }

    const quantitiesByProduct = new Map<string, number>();
    for (const item of order.items) {
      quantitiesByProduct.set(
        item.productId,
        (quantitiesByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }
    for (const [productId, quantity] of quantitiesByProduct) {
      const product = this.products.get(productId);
      if (!product) throw new Error("Validated cancellation inventory disappeared.");
      product.stock += quantity;
    }
    order.status = "CANCELLED";
    order.updatedAt = now;
    order.items = order.items.map((item) => ({
      ...item,
      sellerStatus: "CANCELLED",
      sellerStatusHistory: [
        ...(item.sellerStatusHistory ?? []),
        { status: "CANCELLED", updatedAt: now },
      ],
    }));
    return structuredClone(order);
  }

  async getOrder(orderId: string): Promise<OrderRecord | null> {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : null;
  }

  async listCustomerOrders(userId: string): Promise<OrderRecord[]> {
    return [...this.orders.values()]
      .filter((order) => order.customerId === userId)
      .map((order) => customerOrderForTracking(structuredClone(order)));
  }

  async listAdminOrders(): Promise<OrderRecord[]> {
    return [...this.orders.values()].map((order) => structuredClone(order));
  }

  async listSellerOrders(storeId: string, sellerId: string): Promise<OrderRecord[]> {
    return [...this.orders.values()]
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
    const order = this.orders.get(orderId);
    if (!order) throw new MarketplaceError(404, "Order was not found.");
    const item = order.items.find(
      (candidate) =>
        candidate.id === itemId &&
        candidate.storeId === storeId &&
        candidate.sellerId === sellerId,
    );
    if (!item) throw new MarketplaceError(404, "Order item was not found.");
    const currentStatus = item.sellerStatus ?? order.status;
    if (!canTransitionOrderStatus(currentStatus, status)) {
      throw new MarketplaceError(
        409,
        `Order item status cannot transition from ${currentStatus} to ${status}.`,
      );
    }
    item.sellerStatus = status;
    item.sellerStatusHistory = [
      ...(item.sellerStatusHistory ?? []),
      { status, updatedAt: now },
    ];
    order.updatedAt = now;
    return sellerOrderForStore(structuredClone(order), storeId, sellerId)!;
  }

  async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    adminUserId: string,
    now: string,
  ): Promise<OrderRecord> {
    const order = this.orders.get(orderId);
    if (!order) throw new MarketplaceError(404, "Order was not found.");
    if (!canTransitionOrderStatus(order.status, status)) {
      throw new MarketplaceError(
        409,
        `Order status cannot transition from ${order.status} to ${status}.`,
      );
    }
    order.status = status;
    order.updatedAt = now;
    this.moderationEvents.push({
      actorUserId: adminUserId,
      targetId: orderId,
      action: "order.status_updated",
    });
    return structuredClone(order);
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
    const order = this.orders.get(orderId);
    if (!order || order.customerId !== customerId) {
      throw new MarketplaceError(404, "Order was not found.");
    }
    const item = order.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new MarketplaceError(404, "Order item was not found.");
    if (order.status !== "DELIVERED" && item.sellerStatus !== "DELIVERED") {
      throw new MarketplaceError(409, "Returns are available only after an order is delivered.");
    }
    if (order.returns.some((entry) => entry.orderItemId === itemId)) {
      throw new MarketplaceError(409, "A return has already been requested for this item.");
    }
    const record: OrderReturnRecord = {
      id: randomUUID(),
      orderItemId: itemId,
      productId: item.productId,
      customerId,
      reason,
      status: "REQUESTED",
      refundStatus: "NOT_APPLICABLE",
      images: structuredClone(images),
      sellerReviewStatus: "PENDING",
      sellerResponseDeadlineAt,
      createdAt: now,
      updatedAt: now,
    };
    order.returns.push(record);
    return structuredClone(record);
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
    await this.processExpiredReturnRequests(now);
    const order = this.orders.get(orderId);
    const returnRecord = order?.returns.find((entry) => entry.id === returnId);
    const item = order?.items.find(
      (candidate) =>
        candidate.id === returnRecord?.orderItemId &&
        candidate.storeId === storeId &&
        candidate.sellerId === sellerId,
    );
    if (!returnRecord || !item) {
      throw new MarketplaceError(404, "Return request was not found.");
    }
    if (returnRecord.status !== "REQUESTED" || returnRecord.sellerReviewStatus !== "PENDING") {
      throw new MarketplaceError(409, "Return request is unavailable for seller review.");
    }
    const deadline = returnRecord.sellerResponseDeadlineAt ??
      new Date(Date.parse(returnRecord.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    if (Date.parse(deadline) <= Date.parse(now)) {
      throw new MarketplaceError(409, "The seller response deadline has passed.");
    }
    returnRecord.status = decision;
    returnRecord.sellerReviewStatus = decision;
    returnRecord.decisionSource = "SELLER";
    returnRecord.sellerReviewedByUserId = sellerId;
    if (decision === "REJECTED") returnRecord.sellerReviewReason = reason;
    else delete returnRecord.sellerReviewReason;
    returnRecord.sellerReviewedAt = now;
    returnRecord.sellerResponseDeadlineAt = deadline;
    returnRecord.updatedAt = now;
    this.returnAuditEvents.push({
      orderId,
      returnId,
      actor: sellerId,
      action: decision === "ACCEPTED"
        ? "order.return.seller_accepted"
        : "order.return.seller_rejected",
    });
    return structuredClone(returnRecord);
  }

  async processExpiredReturnRequests(now: string): Promise<number> {
    const nowTime = Date.parse(now);
    if (!Number.isFinite(nowTime)) {
      throw new Error("Return processing timestamp is invalid.");
    }
    let processed = 0;
    for (const [orderId, order] of this.orders) {
      for (const returnRecord of order.returns) {
        const legacySellerAccepted =
          returnRecord.status === "REQUESTED" &&
          returnRecord.sellerReviewStatus === "FORWARDED" &&
          returnRecord.sellerRecommendation === "ACCEPTED";
        const deadline = returnRecord.sellerResponseDeadlineAt ??
          new Date(Date.parse(returnRecord.createdAt) + 24 * 60 * 60 * 1000).toISOString();
        const due =
          returnRecord.status === "REQUESTED" &&
          (returnRecord.sellerReviewStatus === "PENDING" ||
            returnRecord.sellerReviewStatus === undefined) &&
          Date.parse(deadline) <= nowTime;
        if (!legacySellerAccepted && !due) continue;

        if (legacySellerAccepted) {
          returnRecord.status = "ACCEPTED";
          returnRecord.sellerReviewStatus = "ACCEPTED";
          returnRecord.decisionSource = "SELLER";
          returnRecord.sellerReviewedAt ??= now;
          this.returnAuditEvents.push({
            orderId,
            returnId: returnRecord.id,
            actor: returnRecord.sellerReviewedByUserId ?? "SYSTEM_MIGRATION",
            action: "order.return.legacy_seller_acceptance_finalized",
          });
        } else {
          returnRecord.status = "ACCEPTED";
          returnRecord.sellerReviewStatus = "SYSTEM_AUTO_ACCEPTED";
          returnRecord.decisionSource = "SYSTEM_AUTO_ACCEPTED";
          returnRecord.sellerReviewedAt = now;
          this.returnAuditEvents.push({
            orderId,
            returnId: returnRecord.id,
            actor: "SYSTEM",
            action: "order.return.system_auto_accepted",
          });
        }
        returnRecord.sellerResponseDeadlineAt = deadline;
        returnRecord.updatedAt = now;
        processed += 1;
      }
    }
    return processed;
  }

  async createProduct(product: ProductRecord): Promise<void> {
    if (this.products.has(product.id)) {
      throw new MarketplaceError(409, "Product already exists.");
    }
    if (
      [...this.products.values()].some(
        (existing) =>
          existing.storeId === product.storeId &&
          existing.sku === product.sku &&
          existing.status !== "archived",
      )
    ) {
      throw new MarketplaceError(409, "SKU already exists in this store.");
    }
    this.products.set(product.id, structuredClone(product));
  }

  async getProduct(productId: string): Promise<ProductRecord | null> {
    const product = this.products.get(productId);
    return product ? structuredClone(product) : null;
  }

  async listSellerProducts(
    storeId: string,
    limit: number,
    cursor: string | null,
  ): Promise<CatalogPage> {
    const products = [...this.products.values()]
      .filter((product) => product.storeId === storeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = this.readOffset(cursor);
    const items = products.slice(offset, offset + limit).map((item) => structuredClone(item));
    return {
      items,
      nextCursor: offset + limit < products.length ? this.cursor(offset + limit) : null,
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
    let products = [...this.products.values()].filter((product) => {
      if (product.status !== "active") return false;
      if (filters.category && product.category !== filters.category) return false;
      if (filters.brand && product.brand.toLowerCase() !== filters.brand.toLowerCase()) return false;
      if (filters.minPrice !== undefined && product.priceMinor < filters.minPrice) return false;
      if (filters.maxPrice !== undefined && product.priceMinor > filters.maxPrice) return false;
      return true;
    });
    if (filters.search) {
      products = rankCatalogProducts(products, filters.search, filters.sort);
    } else {
      products.sort((left, right) => {
        if (filters.sort === "price_asc") return left.priceMinor - right.priceMinor;
        if (filters.sort === "price_desc") return right.priceMinor - left.priceMinor;
        return right.createdAt.localeCompare(left.createdAt);
      });
    }
    const offset = this.readOffset(cursor);
    const items = products.slice(offset, offset + limit).map((item) => structuredClone(item));
    return {
      items,
      nextCursor: offset + limit < products.length ? this.cursor(offset + limit) : null,
    };
  }

  async listPendingStores(
    limit: number,
    cursor: string | null,
  ): Promise<{ items: SellerStore[]; nextCursor: string | null }> {
    const stores = [...this.stores.values()]
      .filter((store) => store.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const offset = this.readOffset(cursor);
    const items = stores.slice(offset, offset + limit).map((item) => structuredClone(item));
    return {
      items,
      nextCursor: offset + limit < stores.length ? this.cursor(offset + limit) : null,
    };
  }

  async listPendingProducts(
    limit: number,
    cursor: string | null,
  ): Promise<CatalogPage> {
    const products = [...this.products.values()]
      .filter((product) => product.status === "draft")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const offset = this.readOffset(cursor);
    const items = products.slice(offset, offset + limit).map((item) => structuredClone(item));
    return {
      items,
      nextCursor: offset + limit < products.length ? this.cursor(offset + limit) : null,
    };
  }

  async approveProduct(productId: string, approvedByUserId: string): Promise<void> {
    const product = this.products.get(productId);
    const store = product ? this.stores.get(product.storeId) : undefined;
    if (!product || product.status !== "draft") {
      throw new MarketplaceError(409, "Product is unavailable for review.");
    }
    if (product.images.length === 0) {
      throw new MarketplaceError(400, "A product needs reviewed images before publication.");
    }
    if (!store || store.status !== "approved" || store.ownerUserId !== product.sellerId) {
      throw new MarketplaceError(409, "The product's store is not approved.");
    }
    if (this.verifications.get(product.storeId)?.status !== "APPROVED") {
      throw new MarketplaceError(409, "The product's business verification is not approved.");
    }
    product.status = "active";
    this.moderationEvents.push({
      actorUserId: approvedByUserId,
      targetId: productId,
      action: "catalog.product.approved",
    });
  }

  async rejectProduct(
    productId: string,
    rejectedByUserId: string,
    reason: string,
  ): Promise<void> {
    const product = this.products.get(productId);
    if (!product || product.status !== "draft") {
      throw new MarketplaceError(409, "Product is unavailable for review.");
    }
    product.status = "rejected";
    this.moderationEvents.push({
      actorUserId: rejectedByUserId,
      targetId: productId,
      action: "catalog.product.rejected",
      reason,
    });
  }

  async updateDraftProduct(product: ProductRecord, expectedStoreId: string): Promise<void> {
    const current = this.products.get(product.id);
    if (
      !current ||
      current.storeId !== expectedStoreId ||
      (current.status !== "draft" && current.status !== "rejected") ||
      product.storeId !== expectedStoreId ||
      [...this.products.values()].some(
        (existing) =>
          existing.id !== product.id &&
          existing.storeId === expectedStoreId &&
          existing.sku === product.sku &&
          existing.status !== "archived",
      )
    ) {
      throw new MarketplaceError(409, "Product is no longer editable.");
    }
    this.products.set(product.id, structuredClone(product));
  }

  async archiveProduct(productId: string, storeId: string): Promise<void> {
    const product = this.products.get(productId);
    if (!product || product.storeId !== storeId) {
      throw new MarketplaceError(404, "Product was not found.");
    }
    if (product.status === "archived") {
      throw new MarketplaceError(409, "Product is already archived.");
    }
    product.archivedFromStatus = product.status;
    product.status = "archived";
  }

  async restoreProduct(productId: string, storeId: string): Promise<void> {
    const product = this.products.get(productId);
    if (!product || product.storeId !== storeId) {
      throw new MarketplaceError(404, "Product was not found.");
    }
    if (product.status !== "archived") {
      throw new MarketplaceError(409, "Product is not archived.");
    }
    product.status = product.archivedFromStatus ?? "active";
    delete product.archivedFromStatus;
  }

  private cursor(offset: number): string {
    return Buffer.from(JSON.stringify({ offset })).toString("base64url");
  }

  private readOffset(cursor: string | null): number {
    if (!cursor) return 0;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("offset" in parsed) ||
        typeof parsed.offset !== "number" ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0
      ) throw new Error("Invalid cursor");
      return parsed.offset;
    } catch {
      throw new MarketplaceError(400, "Pagination cursor is invalid.");
    }
  }
}

class MemoryProductImageStorage implements ProductImageStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  publicUrl(key: string): string {
    return `https://media.example.test/${key}`;
  }
}

class MemoryPrivateSellerDocumentStorage implements PrivateSellerDocumentStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const document = this.objects.get(key);
    if (!document) throw new Error("Document not found.");
    return { body: Buffer.from(document.body), contentType: document.contentType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const verificationProtector = new AesGcmSellerVerificationProtector(
  Buffer.alloc(32, 7),
);

const validVerificationDetails = {
  legalName: "Test proprietor",
  tradeName: "Test shop",
  businessType: "PROPRIETORSHIP",
  gstRegistration: "NOT_REQUIRED",
  gstin: null,
  pan: "ABCDE1234F",
  address: "12 Market Road",
  state: "Maharashtra",
  city: "Mumbai",
  pinCode: "400001",
  consent: true,
};

async function multipartImage(
  bytes: Buffer,
  mimeType: string,
  altText = "A real test image",
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData();
  form.set("image", new Blob([Uint8Array.from(bytes)], { type: mimeType }), "upload");
  form.set("altText", altText);
  const request = new Request("http://localhost/upload", {
    method: "POST",
    body: form,
  });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "",
  };
}

async function multipartVerification(
  details: Record<string, unknown>,
  documents: Array<{ field: string; bytes: Buffer; mimeType: string }> = [
    { field: "businessProof", bytes: Buffer.from("not an image"), mimeType: "image/png" },
  ],
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData();
  form.set("details", JSON.stringify(details));
  for (const document of documents) {
    form.set(
      document.field,
      new Blob([Uint8Array.from(document.bytes)], { type: document.mimeType }),
      "verification-document",
    );
  }
  const request = new Request("http://localhost/verification", {
    method: "POST",
    body: form,
  });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "",
  };
}

async function multipartReturn(
  reason: string,
  images: Array<{ bytes: Buffer; mimeType: string }> = [],
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData();
  form.set("reason", reason);
  for (const image of images) {
    form.append(
      "images",
      new Blob([Uint8Array.from(image.bytes)], { type: image.mimeType }),
      "damage-photo",
    );
  }
  const request = new Request("http://localhost/return", {
    method: "POST",
    body: form,
  });
  return {
    payload: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "",
  };
}

async function uploadProductImage(
  app: ReturnType<typeof createApp>,
  productId: string,
  cookie: string | undefined,
  bytes: Buffer,
  mimeType: string,
  altText?: string,
) {
  const multipart = await multipartImage(bytes, mimeType, altText);
  return app.inject({
    method: "POST",
    url: `/seller/products/${productId}/images`,
    headers: {
      origin,
      "content-type": multipart.contentType,
      ...(cookie ? { cookie } : {}),
    },
    payload: multipart.payload,
  });
}

const origin = "http://localhost:3000";
const repository = new MemoryAuthRepository();
const imageStorage = new MemoryProductImageStorage();
const privateDocumentStorage = new MemoryPrivateSellerDocumentStorage();
const app = createApp({
  repository,
  webOrigin: origin,
  secureCookies: false,
  allowedImageHosts: ["media.example.test"],
  productImageStorage: imageStorage,
  sellerDocumentStorage: privateDocumentStorage,
  sellerVerificationProtector: verificationProtector,
});
const testPassword = "test-password-with-enough-length";
let adminCookie = "";
let otherSellerCookie = "";
let pendingSellerCookie = "";
let sellerCookie = "";
let sellerStoreId = "";

function cookieFrom(response: { headers: OutgoingHttpHeaders }): string {
  const setCookie = response.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof value !== "string") {
    throw new Error("Expected the response to set a session cookie.");
  }
  return value.split(";")[0] ?? "";
}

async function createLocalWorkflowFixture(
  stock: number,
  options: {
    localWorkflowTesting?: boolean;
    localCheckoutTesting?: boolean;
    category?: string;
    images?: ProductRecord["images"];
  } = {},
) {
  const workflowRepository = new MemoryAuthRepository();
  const privateDocumentStorage = new MemoryPrivateSellerDocumentStorage();
  const workflowApp = createApp({
    repository: workflowRepository,
    webOrigin: origin,
    secureCookies: false,
    localWorkflowTesting: options.localWorkflowTesting ?? true,
    localCheckoutTesting: options.localCheckoutTesting ?? false,
    allowedImageHosts: ["media.example.test", "localhost"],
    sellerDocumentStorage: privateDocumentStorage,
  });
  const createdAt = new Date().toISOString();
  const passwordHash = await hashPassword(testPassword);
  const customer: UserRecord = {
    id: randomUUID(),
    email: `${randomUUID()}@customer.example.test`,
    passwordHash,
    roles: ["customer"],
    createdAt,
  };
  const secondCustomer: UserRecord = {
    id: randomUUID(),
    email: `${randomUUID()}@customer.example.test`,
    passwordHash,
    roles: ["customer"],
    createdAt,
  };
  const seller: UserRecord = {
    id: randomUUID(),
    email: `${randomUUID()}@seller.example.test`,
    passwordHash,
    roles: ["seller"],
    storeId: randomUUID(),
    createdAt,
  };
  const secondSeller: UserRecord = {
    id: randomUUID(),
    email: `${randomUUID()}@seller.example.test`,
    passwordHash,
    roles: ["seller"],
    storeId: randomUUID(),
    createdAt,
  };
  const admin: UserRecord = {
    id: randomUUID(),
    email: `${randomUUID()}@admin.example.test`,
    passwordHash,
    roles: ["super_admin"],
    createdAt,
  };
  await Promise.all([
    workflowRepository.createUser(customer),
    workflowRepository.createUser(secondCustomer),
    workflowRepository.createUser(seller),
    workflowRepository.createUser(secondSeller),
    workflowRepository.createUser(admin),
  ]);
  const storeId = seller.storeId!;
  workflowRepository.seedStore({
    id: storeId,
    ownerUserId: seller.id,
    name: "Local workflow test store",
    status: "approved",
    createdAt,
  });
  workflowRepository.seedSellerVerification({
    storeId,
    ownerUserId: seller.id,
    status: "APPROVED",
    encryptedData: verificationProtector.encrypt({
      legalName: "Test-only seller",
      tradeName: "Local test shop",
      businessType: "PROPRIETORSHIP",
      gstRegistration: "NOT_REQUIRED",
      gstin: null,
      pan: "ZZZZZ0000Z",
      address: "12 Test Market Road",
      state: "Maharashtra",
      city: "Mumbai",
      pinCode: "400001",
    }),
    documents: [],
    history: [{ status: "APPROVED", actorUserId: admin.id, createdAt }],
    createdAt,
    updatedAt: createdAt,
  });
  workflowRepository.seedStore({
    id: secondSeller.storeId!,
    ownerUserId: secondSeller.id,
    name: "Second local test store",
    status: "approved",
    createdAt,
  });
  workflowRepository.seedSellerVerification({
    storeId: secondSeller.storeId!,
    ownerUserId: secondSeller.id,
    status: "APPROVED",
    encryptedData: verificationProtector.encrypt({
      legalName: "Second test seller",
      tradeName: "Second test shop",
      businessType: "PROPRIETORSHIP",
      gstRegistration: "NOT_REQUIRED",
      gstin: null,
      pan: "ZZZZZ0000Z",
      address: "12 Test Market Road",
      state: "Maharashtra",
      city: "Mumbai",
      pinCode: "400001",
    }),
    documents: [],
    history: [{ status: "APPROVED", actorUserId: admin.id, createdAt }],
    createdAt,
    updatedAt: createdAt,
  });
  const product: ProductRecord = {
    id: randomUUID(),
    sellerId: seller.id,
    storeId,
    title: "Test-owned catalog product",
    description: "Test-only product fixture for local order workflow checks.",
    brand: "Test fixture",
    sku: `TEST-${randomUUID()}`,
    category: options.category ?? "home",
    currency: "INR",
    priceMinor: 12500,
    stock,
    images: options.images ?? [
      { url: "https://media.example.test/test.webp", altText: "Test-only fixture" },
    ],
    specifications: {},
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
  await workflowRepository.createProduct(product);
  await workflowApp.ready();
  const signIn = async (user: UserRecord) => {
    const response = await workflowApp.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin },
      payload: { email: user.email, password: testPassword },
    });
    assert.equal(response.statusCode, 200);
    return cookieFrom(response);
  };
  const [
    customerCookie,
    secondCustomerCookie,
    sellerCookie,
    secondSellerCookie,
    adminCookie,
  ] =
    await Promise.all([
      signIn(customer),
      signIn(secondCustomer),
      signIn(seller),
      signIn(secondSeller),
      signIn(admin),
    ]);
  return {
    app: workflowApp,
    repository: workflowRepository,
    privateDocumentStorage,
    customer,
    secondCustomer,
    seller,
    secondSeller,
    admin,
    product,
    customerCookie,
    secondCustomerCookie,
    sellerCookie,
    secondSellerCookie,
    adminCookie,
  };
}

before(async () => {
  await app.ready();
  const passwordHash = await hashPassword(testPassword);
  await repository.createUser({
    id: "admin-user",
    email: "admin@example.test",
    passwordHash,
    roles: ["super_admin"],
    createdAt: new Date().toISOString(),
  });
  await repository.createUser({
    id: "other-seller",
    email: "other-seller@example.test",
    passwordHash,
    roles: ["seller"],
    createdAt: new Date().toISOString(),
    storeId: "another-store",
  });
  repository.seedStore({
    id: "another-store",
    ownerUserId: "other-seller",
    name: "Other Seller Store",
    status: "approved",
    createdAt: new Date().toISOString(),
  });
  const otherVerificationAt = new Date().toISOString();
  repository.seedSellerVerification({
    storeId: "another-store",
    ownerUserId: "other-seller",
    status: "APPROVED",
    encryptedData: verificationProtector.encrypt({
      legalName: "Other seller",
      tradeName: "Other shop",
      businessType: "PROPRIETORSHIP",
      gstRegistration: "NOT_REQUIRED",
      gstin: null,
      pan: "ABCDE1234F",
      address: "12 Market Road",
      state: "Maharashtra",
      city: "Mumbai",
      pinCode: "400001",
    }),
    documents: [],
    history: [{
      status: "APPROVED",
      actorUserId: "admin-user",
      createdAt: otherVerificationAt,
    }],
    createdAt: otherVerificationAt,
    updatedAt: otherVerificationAt,
  });
  await repository.createUser({
    id: "pending-seller",
    email: "pending-seller@example.test",
    passwordHash,
    roles: ["seller"],
    createdAt: new Date().toISOString(),
    storeId: "pending-store",
  });
  repository.seedStore({
    id: "pending-store",
    ownerUserId: "pending-seller",
    name: "Pending Seller Store",
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  const adminLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { origin },
    payload: { email: "admin@example.test", password: testPassword },
  });
  assert.equal(adminLogin.statusCode, 200);
  adminCookie = cookieFrom(adminLogin);

  const sellerLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { origin },
    payload: { email: "other-seller@example.test", password: testPassword },
  });
  assert.equal(sellerLogin.statusCode, 200);
  otherSellerCookie = cookieFrom(sellerLogin);

  const pendingSellerLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { origin },
    payload: { email: "pending-seller@example.test", password: testPassword },
  });
  assert.equal(pendingSellerLogin.statusCode, 200);
  pendingSellerCookie = cookieFrom(pendingSellerLogin);
});

after(async () => {
  await app.close();
});

test("health endpoint reports the service as ready", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "marketplace-api",
  });
});

test("R2 image storage requires complete configuration and an allowlisted public hostname", () => {
  const config = {
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_ACCESS_KEY_ID: "local-test-access-key",
    R2_SECRET_ACCESS_KEY: "local-test-secret-key",
    R2_BUCKET_NAME: "marketplace-test",
    R2_PUBLIC_BASE_URL: "https://images.example.test",
  };
  assert.throws(
    () => createR2ProductImageStorage({ R2_ACCOUNT_ID: config.R2_ACCOUNT_ID }, ["images.example.test"]),
    /configuration is incomplete/,
  );
  assert.throws(
    () => createR2ProductImageStorage(config, ["other.example.test"]),
    /must be included in PRODUCT_IMAGE_HOSTS/,
  );
  const storage = createR2ProductImageStorage(config, ["images.example.test"]);
  assert.ok(storage);
  assert.equal(
    storage.publicUrl("products/test-id.webp"),
    "https://images.example.test/products/test-id.webp",
  );
  storage.destroy();
});

test("KYC storage configuration stays private and encryption keys are validated", () => {
  assert.equal(createPrivateSellerDocumentStorage({}), undefined);
  assert.throws(
    () => createSellerVerificationProtector({ KYC_DATA_ENCRYPTION_KEY: "not-a-key" }),
    /32-byte hexadecimal key/,
  );
  assert.equal(createSellerVerificationProtector({}), undefined);
  const storage = createPrivateSellerDocumentStorage({
    KYC_DOCUMENT_BUCKET: "private-verification-documents",
    AWS_REGION: "ap-south-1",
  });
  assert.ok(storage);
  storage.destroy?.();
});

test("local workflow configuration requires the dedicated table, loopback services, and test key", () => {
  const validEnvironment: NodeJS.ProcessEnv = {
    LOCAL_WORKFLOW_TESTING: "true",
    NODE_ENV: "development",
    DYNAMODB_TABLE: "marketplace-workflow-test",
    DYNAMODB_ENDPOINT: "http://localhost:8000",
    PORT: "4000",
    WEB_ORIGIN: "http://localhost:3000",
    NEXT_PUBLIC_API_URL: "http://localhost:4000",
    LOCAL_KYC_TEST_KEY: "a".repeat(64),
  };
  const configuration = createLocalWorkflowConfig(validEnvironment);
  assert.ok(configuration);
  assert.equal(configuration.imagePublicBaseUrl, "http://localhost:4000");
  assert.ok(configuration.dataDirectory.endsWith(".local-workflow-data"));
  assert.throws(
    () =>
      createLocalWorkflowConfig({
        ...validEnvironment,
        DYNAMODB_TABLE: "marketplace-local",
      }),
    /dedicated marketplace-workflow-test/,
  );
  assert.throws(
    () =>
      createLocalWorkflowConfig({
        ...validEnvironment,
        DYNAMODB_ENDPOINT: "https://dynamodb.example.test",
      }),
    /loopback HTTP address/,
  );
  assert.throws(
    () =>
      createLocalWorkflowConfig({
        ...validEnvironment,
        KYC_DATA_ENCRYPTION_KEY: "b".repeat(64),
      }),
    /do not load the production KYC key/,
  );
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  assert.ok(
    path.relative(path.join(projectRoot, "apps", "web", "public"), configuration.dataDirectory)
      .startsWith(".."),
  );
  assert.equal(createLocalWorkflowConfig({ NODE_ENV: "development" }), undefined);
  assert.throws(
    () =>
      createLocalWorkflowConfig({
        NODE_ENV: "development",
        LOCAL_KYC_TEST_KEY: "a".repeat(64),
      }),
    /requires LOCAL_KYC_STORAGE=true or LOCAL_WORKFLOW_TESTING=true/,
  );
  assert.equal(
    createLocalSellerVerificationProtector({
      LOCAL_KYC_TEST_KEY: "a".repeat(64),
    })?.decrypt(
      createLocalSellerVerificationProtector({
        LOCAL_KYC_TEST_KEY: "a".repeat(64),
      })!.encrypt({
        legalName: "Local test",
        tradeName: "Local test shop",
        businessType: "PROPRIETORSHIP",
        gstRegistration: "NOT_REQUIRED",
        gstin: null,
        pan: "ZZZZZ0000Z",
        address: "Test-only address",
        state: "Maharashtra",
        city: "Mumbai",
        pinCode: "400001",
      }),
    ).pan,
    "ZZZZZ0000Z",
  );
});

test("local development checkout is restricted to marketplace-local loopback development", () => {
  const validEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    DYNAMODB_TABLE: "marketplace-local",
    DYNAMODB_ENDPOINT: "http://localhost:8000",
    PORT: "4000",
    WEB_ORIGIN: "http://localhost:3000",
    NEXT_PUBLIC_API_URL: "http://localhost:4000",
  };
  assert.equal(isLocalDevelopmentCheckoutEnabled(validEnvironment), true);
  assert.equal(isLocalDevelopmentCustomerOtpEnabled(validEnvironment), true);
  assert.equal(
    isLocalDevelopmentCustomerOtpEnabled({
      ...validEnvironment,
      DYNAMODB_TABLE: "marketplace-workflow-test",
    }),
    true,
  );
  assert.equal(
    isLocalDevelopmentCustomerOtpEnabled({
      ...validEnvironment,
      PORT: "5000",
    }),
    false,
  );
  assert.equal(
    isLocalDevelopmentCheckoutEnabled({
      ...validEnvironment,
      NODE_ENV: "production",
    }),
    false,
  );
  assert.equal(
    isLocalDevelopmentCustomerOtpEnabled({
      ...validEnvironment,
      NODE_ENV: "production",
    }),
    false,
  );
  assert.equal(
    isLocalDevelopmentCheckoutEnabled({
      ...validEnvironment,
      DYNAMODB_TABLE: "marketplace-workflow-test",
    }),
    false,
  );
  assert.equal(
    isLocalDevelopmentCheckoutEnabled({
      ...validEnvironment,
      DYNAMODB_ENDPOINT: "https://dynamodb.example.test",
    }),
    false,
  );
});

test("customer cart and test checkout work outside the dedicated workflow without enabling production checkout", async () => {
  const fixture = await createLocalWorkflowFixture(4, {
    localWorkflowTesting: false,
    localCheckoutTesting: true,
  });
  const productionLikeApp = createApp({
    repository: fixture.repository,
    webOrigin: origin,
    secureCookies: false,
  });
  try {
    await productionLikeApp.ready();
    const savedCart = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 2 }] },
    });
    assert.equal(savedCart.statusCode, 200);
    const cartRead = await productionLikeApp.inject({
      method: "GET",
      url: "/cart",
      headers: { cookie: fixture.customerCookie },
    });
    assert.equal(cartRead.statusCode, 200);
    assert.equal(cartRead.json().cart.items[0].quantity, 2);

    const delivery = {
      recipientName: "Local test recipient",
      phone: "+919876543210",
      address: "12 Local Test Road",
      city: "Mumbai",
      state: "Maharashtra",
      pinCode: "400001",
    };
    const blockedCheckout = await productionLikeApp.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { idempotencyKey: randomUUID(), delivery },
    });
    assert.equal(blockedCheckout.statusCode, 503);
    assert.match(blockedCheckout.json().error, /payment is not configured/i);

    const localCheckout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { idempotencyKey: randomUUID(), delivery },
    });
    assert.equal(localCheckout.statusCode, 200);
    const order = localCheckout.json().order as OrderRecord;
    assert.equal(order.paymentResult, "NOT_CONFIGURED");
    assert.equal(order.totalMinor, fixture.product.priceMinor * 2);
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 2);
    const orders = await productionLikeApp.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.customerCookie },
    });
    assert.equal(orders.statusCode, 200);
    assert.equal(orders.json().orders[0].id, order.id);
  } finally {
    await productionLikeApp.close();
    await fixture.app.close();
  }
});

test("local KYC storage is restricted to marketplace-local and loopback development", () => {
  const validEnvironment: NodeJS.ProcessEnv = {
    LOCAL_KYC_STORAGE: "true",
    LOCAL_KYC_TEST_KEY: "c".repeat(64),
    LOCAL_WORKFLOW_TESTING: "false",
    NODE_ENV: "development",
    DYNAMODB_TABLE: "marketplace-local",
    DYNAMODB_ENDPOINT: "http://localhost:8000",
    PORT: "4000",
    WEB_ORIGIN: "http://localhost:3000",
    NEXT_PUBLIC_API_URL: "http://localhost:4000",
  };
  const configuration = createLocalKycConfig(validEnvironment);
  assert.ok(configuration);
  assert.ok(configuration.documentDirectory.endsWith(
    path.join(".local-workflow-data", "kyc-documents"),
  ));
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  assert.ok(
    path.relative(
      path.join(projectRoot, "apps", "web", "public"),
      configuration.documentDirectory,
    ).startsWith(".."),
  );
  assert.equal(createLocalKycConfig({ NODE_ENV: "development" }), undefined);
  assert.throws(
    () =>
      createLocalKycConfig({
        ...validEnvironment,
        DYNAMODB_TABLE: "marketplace-workflow-test",
      }),
    /existing marketplace-local/,
  );
  assert.throws(
    () =>
      createLocalKycConfig({
        ...validEnvironment,
        DYNAMODB_ENDPOINT: "https://dynamodb.example.test",
      }),
    /loopback HTTP address/,
  );
  assert.throws(
    () =>
      createLocalKycConfig({
        ...validEnvironment,
        NODE_ENV: "production",
      }),
    /only when NODE_ENV=development/,
  );
  assert.throws(
    () =>
      createLocalKycConfig({
        ...validEnvironment,
        KYC_DATA_ENCRYPTION_KEY: "d".repeat(64),
      }),
    /cannot be combined with private AWS KYC settings/,
  );
  assert.throws(
    () =>
      createLocalKycConfig({
        ...validEnvironment,
        LOCAL_WORKFLOW_TESTING: "true",
      }),
    /cannot be combined with LOCAL_WORKFLOW_TESTING/,
  );
});

test("local filesystem adapters keep private keys constrained and images on the local route", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "morrow-local-workflow-test-"),
  );
  try {
    const imageStorage = new LocalFilesystemProductImageStorage(
      path.join(temporaryDirectory, "product-images"),
      "http://localhost:4000",
    );
    const imageKey = `products/${randomUUID()}.webp`;
    const imageBytes = Buffer.from("LOCAL TEST IMAGE CONTENT");
    await imageStorage.putObject(imageKey, imageBytes, "image/webp");
    const imageName = imageKey.slice("products/".length);
    assert.equal(
      imageStorage.publicUrl(imageKey),
      `http://localhost:4000/local-product-images/${imageName}`,
    );
    assert.deepEqual((await imageStorage.getObject(imageKey))?.body, imageBytes);
    await assert.rejects(
      imageStorage.putObject("../outside.webp", imageBytes, "image/webp"),
      /object key is invalid/,
    );
    await assert.rejects(
      imageStorage.putObject(`products/${randomUUID()}.webp`, imageBytes, "image/png"),
      /only accepts normalized WebP/,
    );
    await imageStorage.deleteObject(imageKey);
    assert.equal(await imageStorage.getObject(imageKey), null);

    const documentStorage = new LocalFilesystemSellerDocumentStorage(
      path.join(temporaryDirectory, "private-kyc"),
    );
    const documentKey = `seller-verification/${randomUUID()}`;
    const document = Buffer.from("LOCAL TEST ONLY - NOT A LEGAL DOCUMENT");
    await documentStorage.put(documentKey, document, "application/pdf");
    const storedDocument = await documentStorage.get(documentKey);
    assert.deepEqual(storedDocument.body, document);
    assert.equal(storedDocument.contentType, "application/pdf");
    await assert.rejects(
      documentStorage.get("../outside"),
      /object key is invalid/,
    );
    await documentStorage.delete(documentKey);
    await assert.rejects(documentStorage.get(documentKey), /ENOENT/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("local KYC documents can be submitted and reviewed only by a Super Admin", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "morrow-local-kyc-review-test-"),
  );
  const localKey = "e".repeat(64);
  const documentStorage = new LocalFilesystemSellerDocumentStorage(
    path.join(temporaryDirectory, "kyc-documents"),
  );
  const localProtector = createLocalSellerVerificationProtector({
    LOCAL_KYC_TEST_KEY: localKey,
  });
  assert.ok(localProtector);

  const testRepository = new MemoryAuthRepository();
  const createdAt = new Date().toISOString();
  const passwordHash = await hashPassword(testPassword);
  const seller: UserRecord = {
    id: randomUUID(),
    email: `${randomUUID()}@seller.example.test`,
    passwordHash,
    roles: ["customer"],
    storeId: randomUUID(),
    createdAt,
  };
  const admin: UserRecord = {
    id: randomUUID(),
    email: `${randomUUID()}@admin.example.test`,
    passwordHash,
    roles: ["super_admin"],
    createdAt,
  };
  await Promise.all([
    testRepository.createUser(seller),
    testRepository.createUser(admin),
  ]);
  testRepository.seedStore({
    id: seller.storeId!,
    ownerUserId: seller.id,
    name: "Synthetic test store",
    status: "pending",
    createdAt,
  });

  const testApp = createApp({
    repository: testRepository,
    webOrigin: origin,
    secureCookies: false,
    sellerDocumentStorage: documentStorage,
    sellerVerificationProtector: localProtector,
  });
  try {
    await testApp.ready();
    const signIn = async (user: UserRecord) => {
      const response = await testApp.inject({
        method: "POST",
        url: "/auth/login",
        headers: { origin },
        payload: { email: user.email, password: testPassword },
      });
      assert.equal(response.statusCode, 200);
      return cookieFrom(response);
    };
    const [sellerSession, adminSession] = await Promise.all([
      signIn(seller),
      signIn(admin),
    ]);
    const proofImage = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 90, g: 120, b: 80 },
      },
    }).png().toBuffer();
    const multipart = await multipartVerification(
      {
        ...validVerificationDetails,
        legalName: "Synthetic test seller",
        tradeName: "Synthetic test shop",
        pan: "ZZZZZ0000Z",
        address: "12 Synthetic Test Road",
        consent: true,
      },
      [{ field: "businessProof", bytes: proofImage, mimeType: "image/png" }],
    );
    const submission = await testApp.inject({
      method: "POST",
      url: "/seller/verification",
      headers: {
        origin,
        cookie: sellerSession,
        "content-type": multipart.contentType,
      },
      payload: multipart.payload,
    });
    assert.equal(submission.statusCode, 200);
    assert.equal(submission.json().status, "PENDING_REVIEW");

    const verification = await testRepository.getSellerVerification(seller.storeId!);
    assert.ok(verification);
    assert.equal(verification.encryptedData.includes("ZZZZZ0000Z"), false);
    const storedDocument = await documentStorage.get(
      verification.documents[0]!.objectKey,
    );
    assert.equal(storedDocument.contentType, "image/webp");
    assert.ok(storedDocument.body.length > 0);

    const sellerDocumentAccess = await testApp.inject({
      method: "GET",
      url: `/admin/seller-verifications/${seller.storeId}/documents/${verification.documents[0]!.id}`,
      headers: { cookie: sellerSession },
    });
    assert.equal(sellerDocumentAccess.statusCode, 403);
    const adminDocumentAccess = await testApp.inject({
      method: "GET",
      url: `/admin/seller-verifications/${seller.storeId}/documents/${verification.documents[0]!.id}`,
      headers: { cookie: adminSession },
    });
    assert.equal(adminDocumentAccess.statusCode, 200);
    assert.deepEqual(adminDocumentAccess.rawPayload, storedDocument.body);

    const sellerReview = await testApp.inject({
      method: "POST",
      url: `/admin/seller-verifications/${seller.storeId}/review`,
      headers: { origin, cookie: sellerSession },
      payload: { status: "APPROVED" },
    });
    assert.equal(sellerReview.statusCode, 403);
    const adminReview = await testApp.inject({
      method: "POST",
      url: `/admin/seller-verifications/${seller.storeId}/review`,
      headers: { origin, cookie: adminSession },
      payload: { status: "APPROVED" },
    });
    assert.equal(adminReview.statusCode, 200);
    assert.equal(
      (await testRepository.getSellerVerification(seller.storeId!))?.status,
      "APPROVED",
    );
    assert.equal(
      (await testRepository.getUserById(seller.id))?.roles.includes("seller"),
      false,
    );
  } finally {
    await testApp.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("local product-image upload stays behind approved seller ownership and URL allowlists", async () => {
  const fixture = await createLocalWorkflowFixture(3);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "morrow-local-image-test-"),
  );
  const imageStorage = new LocalFilesystemProductImageStorage(
    path.join(temporaryDirectory, "images"),
    "http://localhost:4000",
  );
  const workflowApp = createApp({
    repository: fixture.repository,
    webOrigin: origin,
    secureCookies: false,
    allowedImageHosts: ["localhost"],
    productImageStorage: imageStorage,
    localProductImageStorage: imageStorage,
    localWorkflowTesting: true,
  });
  try {
    await workflowApp.ready();
    await fixture.repository.createProduct({
      ...fixture.product,
      id: randomUUID(),
      sku: `DRAFT-${randomUUID()}`,
      images: [],
      status: "draft",
    });
    const draft = (await fixture.repository.listSellerProducts(
      fixture.product.storeId,
      20,
      null,
    )).items.find((item) => item.status === "draft");
    assert.ok(draft);
    const sampleImage = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 3,
        background: { r: 120, g: 150, b: 100 },
      },
    }).png().toBuffer();
    const unauthorized = await uploadProductImage(
      workflowApp,
      draft.id,
      undefined,
      sampleImage,
      "image/png",
    );
    assert.equal(unauthorized.statusCode, 401);
    const upload = await uploadProductImage(
      workflowApp,
      draft.id,
      fixture.sellerCookie,
      sampleImage,
      "image/png",
      "A generated local test image",
    );
    assert.equal(upload.statusCode, 200);
    const imageUrl = upload.json().image.url as string;
    assert.match(
      imageUrl,
      /^http:\/\/localhost:4000\/local-product-images\/[0-9a-f-]{36}\.webp$/,
    );
    const imageResponse = await workflowApp.inject({
      method: "GET",
      url: new URL(imageUrl).pathname,
    });
    assert.equal(imageResponse.statusCode, 200);
    assert.equal(imageResponse.headers["content-type"], "image/webp");
    assert.ok(imageResponse.rawPayload.length > 0);
    const missingImage = await workflowApp.inject({
      method: "GET",
      url: "/local-product-images/../outside.webp",
    });
    assert.equal(missingImage.statusCode, 404);
  } finally {
    await workflowApp.close();
    await fixture.app.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("local development image fallback uploads validated images without enabling production storage", async () => {
  const projectRoot = await mkdtemp(
    path.join(os.tmpdir(), "morrow-local-product-images-test-"),
  );
  const localEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    DYNAMODB_TABLE: "marketplace-local",
    DYNAMODB_ENDPOINT: "http://localhost:8000",
    PORT: "4000",
    WEB_ORIGIN: "http://localhost:3000",
    NEXT_PUBLIC_API_URL: "http://localhost:4000",
  };
  const imageStorage = createLocalDevelopmentProductImageStorage(
    localEnvironment,
    projectRoot,
  );
  assert.ok(imageStorage);
  assert.equal(
    createLocalDevelopmentProductImageStorage(
      { ...localEnvironment, NODE_ENV: "production" },
      projectRoot,
    ),
    undefined,
  );
  assert.equal(
    createLocalDevelopmentProductImageStorage(
      { ...localEnvironment, DYNAMODB_TABLE: "marketplace-workflow-test" },
      projectRoot,
    ),
    undefined,
  );
  assert.equal(
    createLocalDevelopmentProductImageStorage(
      { ...localEnvironment, R2_ACCOUNT_ID: "partial-configuration" },
      projectRoot,
    ),
    undefined,
  );

  const fixture = await createLocalWorkflowFixture(3);
  const localImageApp = createApp({
    repository: fixture.repository,
    webOrigin: origin,
    secureCookies: false,
    allowedImageHosts: ["localhost"],
    productImageStorage: imageStorage,
    localProductImageStorage: imageStorage,
  });
  try {
    await localImageApp.ready();
    const draftId = randomUUID();
    await fixture.repository.createProduct({
      ...fixture.product,
      id: draftId,
      sku: `LOCAL-${randomUUID()}`,
      images: [],
      status: "draft",
    });
    const generatedImage = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 3,
        background: { r: 120, g: 150, b: 100 },
      },
    }).png().toBuffer();
    const malformedUpload = await uploadProductImage(
      localImageApp,
      draftId,
      fixture.sellerCookie,
      Buffer.from("not an image"),
      "image/png",
      "Synthetic local image",
    );
    assert.equal(malformedUpload.statusCode, 400);
    const unauthorizedUpload = await uploadProductImage(
      localImageApp,
      draftId,
      undefined,
      generatedImage,
      "image/png",
      "Generated local test image",
    );
    assert.equal(unauthorizedUpload.statusCode, 401);
    const upload = await uploadProductImage(
      localImageApp,
      draftId,
      fixture.sellerCookie,
      generatedImage,
      "image/png",
      "Generated local test image",
    );
    assert.equal(upload.statusCode, 200);
    const imageUrl = upload.json().image.url as string;
    assert.match(
      imageUrl,
      /^http:\/\/localhost:4000\/local-product-images\/[0-9a-f-]{36}\.webp$/,
    );
    const savedDraft = await fixture.repository.getProduct(draftId);
    assert.equal(savedDraft?.images[0]?.url, imageUrl);
    const imageResponse = await localImageApp.inject({
      method: "GET",
      url: new URL(imageUrl).pathname,
    });
    assert.equal(imageResponse.statusCode, 200);
    assert.equal(imageResponse.headers["content-type"], "image/webp");
    assert.equal(
      imageResponse.headers["cross-origin-resource-policy"],
      "same-site",
    );
    assert.ok(imageResponse.rawPayload.length > 0);
    const traversalAttempt = await localImageApp.inject({
      method: "GET",
      url: "/local-product-images/../outside.webp",
    });
    assert.equal(traversalAttempt.statusCode, 404);
  } finally {
    await localImageApp.close();
    await fixture.app.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("seller actions require both approved store and approved business verification", async () => {
  const pendingStoreAccess = await app.inject({
    method: "GET",
    url: "/seller/products?limit=20",
    headers: { cookie: pendingSellerCookie },
  });
  assert.equal(pendingStoreAccess.statusCode, 403);

  const approvedStore = await repository.getSellerStore("another-store");
  const approvedVerification = await repository.getSellerVerification("another-store");
  assert.ok(approvedStore);
  assert.ok(approvedVerification);
  repository.seedSellerVerification({
    ...approvedVerification,
    status: "NEEDS_CORRECTION",
  });
  const unverifiedSellerAccess = await app.inject({
    method: "GET",
    url: "/seller/products?limit=20",
    headers: { cookie: otherSellerCookie },
  });
  assert.equal(unverifiedSellerAccess.statusCode, 403);
  repository.seedSellerVerification(approvedVerification);
});

test("customer mobile OTP creates unique customer accounts and enforces expiry and attempt limits", async () => {
  const otpRepository = new MemoryAuthRepository();
  const issuedCodes: Array<{ mobileNumber: string; otp: string }> = [];
  const otpApp = createApp({
    repository: otpRepository,
    webOrigin: origin,
    secureCookies: false,
    customerOtpEnabled: true,
    customerOtpHmacSecret: "customer-otp-test-secret-with-at-least-32-bytes",
    customerOtpLogger: (mobileNumber, otp) => issuedCodes.push({ mobileNumber, otp }),
  });
  try {
    const invalidNumber = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp",
      headers: { origin },
      payload: { mobileNumber: "12345" },
    });
    assert.equal(invalidNumber.statusCode, 400);
    assert.equal(issuedCodes.length, 0);

    const wrongAttemptNumber = "9876543210";
    const wrongAttemptRequest = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp",
      headers: { origin },
      payload: { mobileNumber: wrongAttemptNumber },
    });
    assert.equal(wrongAttemptRequest.statusCode, 200);
    const issued = issuedCodes.find((entry) => entry.mobileNumber === wrongAttemptNumber);
    assert.ok(issued);
    const expiresAt = Date.parse(wrongAttemptRequest.json().expiresAt);
    assert.ok(expiresAt > Date.now() + 4 * 60_000);
    assert.ok(expiresAt <= Date.now() + 5 * 60_000 + 1000);
    assert.equal(JSON.stringify(wrongAttemptRequest.json()).includes(issued.otp), false);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const invalidCode = await otpApp.inject({
        method: "POST",
        url: "/auth/customer-otp/verify",
        headers: { origin },
        payload: { mobileNumber: wrongAttemptNumber, otp: "000000" },
      });
      assert.equal(invalidCode.statusCode, 401);
    }
    const exhaustedCode = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp/verify",
      headers: { origin },
      payload: { mobileNumber: wrongAttemptNumber, otp: issued.otp },
    });
    assert.equal(exhaustedCode.statusCode, 401);

    const expiredNumber = "9123456789";
    const expiredRequest = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp",
      headers: { origin },
      payload: { mobileNumber: expiredNumber },
    });
    assert.equal(expiredRequest.statusCode, 200);
    const expiredCode = issuedCodes.find((entry) => entry.mobileNumber === expiredNumber);
    assert.ok(expiredCode);
    otpRepository.expireCustomerOtp(expiredNumber);
    const expiredVerification = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp/verify",
      headers: { origin },
      payload: { mobileNumber: expiredNumber, otp: expiredCode.otp },
    });
    assert.equal(expiredVerification.statusCode, 401);

    const mobileNumber = "9987654321";
    const request = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp",
      headers: { origin },
      payload: { mobileNumber },
    });
    assert.equal(request.statusCode, 200);
    const code = issuedCodes.find((entry) => entry.mobileNumber === mobileNumber);
    assert.ok(code);
    const verification = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp/verify",
      headers: { origin },
      payload: { mobileNumber, otp: code.otp },
    });
    assert.equal(verification.statusCode, 200);
    assert.deepEqual(verification.json().user.roles, ["customer"]);
    assert.equal(verification.json().user.mobileNumber, mobileNumber);
    assert.equal("passwordHash" in verification.json().user, false);
    assert.match(String(verification.headers["set-cookie"]), /HttpOnly/i);
    const userId = verification.json().user.id;
    const session = await otpApp.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: cookieFrom(verification) },
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().user.id, userId);

    const replay = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp/verify",
      headers: { origin },
      payload: { mobileNumber, otp: code.otp },
    });
    assert.equal(replay.statusCode, 401);
    const resend = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp",
      headers: { origin },
      payload: { mobileNumber },
    });
    assert.equal(resend.statusCode, 429);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const returningCode = "345678";
    otpRepository.seedCustomerOtp({
      mobileNumber,
      codeHash: hashCustomerOtp(
        mobileNumber,
        returningCode,
        "customer-otp-test-secret-with-at-least-32-bytes",
      ),
      issuedAt: nowSeconds - 61,
      expiresAt: nowSeconds + 240,
      attemptsRemaining: 5,
    });
    const returningLogin = await otpApp.inject({
      method: "POST",
      url: "/auth/customer-otp/verify",
      headers: { origin },
      payload: { mobileNumber, otp: returningCode },
    });
    assert.equal(returningLogin.statusCode, 200);
    assert.equal(returningLogin.json().user.id, userId);

    await assert.rejects(
      otpRepository.createUser({
        id: randomUUID(),
        mobileNumber,
        roles: ["customer"],
        createdAt: new Date().toISOString(),
      }),
      (error: unknown) =>
        error instanceof MarketplaceError && error.statusCode === 409,
    );
    const disabledApp = createApp({
      repository: new MemoryAuthRepository(),
      webOrigin: origin,
      secureCookies: false,
      customerOtpEnabled: false,
    });
    try {
      const disabled = await disabledApp.inject({
        method: "POST",
        url: "/auth/customer-otp",
        headers: { origin },
        payload: { mobileNumber: "9876543210" },
      });
      assert.equal(disabled.statusCode, 404);
    } finally {
      await disabledApp.close();
    }
  } finally {
    await otpApp.close();
  }
});

test("existing and newly registered customer accounts can log in across server restarts", async () => {
  const authRepository = new MemoryAuthRepository();
  const existingCustomer: UserRecord = {
    id: randomUUID(),
    email: "existing-customer@example.test",
    passwordHash: await hashPassword(testPassword),
    roles: ["customer"],
    createdAt: new Date().toISOString(),
  };
  await authRepository.createUser(existingCustomer);

  let firstApp: ReturnType<typeof createApp> | undefined = createApp({
    repository: authRepository,
    webOrigin: origin,
    secureCookies: false,
    customerOtpEnabled: false,
  });
  let restartedApp: ReturnType<typeof createApp> | undefined;
  try {
    await firstApp.ready();
    const incorrectExistingPassword = await firstApp.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin },
      payload: {
        email: "  EXISTING-CUSTOMER@example.test ",
        password: `${testPassword}-incorrect`,
      },
    });
    assert.equal(incorrectExistingPassword.statusCode, 401);
    assert.equal(
      incorrectExistingPassword.json().error,
      "Email or password is incorrect.",
    );
    assert.equal(incorrectExistingPassword.headers["set-cookie"], undefined);

    const existingLogin = await firstApp.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin },
      payload: {
        email: "  EXISTING-CUSTOMER@example.test ",
        password: testPassword,
      },
    });
    assert.equal(existingLogin.statusCode, 200, existingLogin.body);
    assert.equal(existingLogin.json().user.id, existingCustomer.id);
    const existingCookie = cookieFrom(existingLogin);
    const existingSession = await authRepository.getSession(
      hashSessionToken(existingCookie.split("=")[1] ?? ""),
    );
    assert.ok(existingSession);
    assert.ok(existingSession.expiresAt > Math.floor(Date.now() / 1000));

    const registration = await firstApp.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin },
      payload: {
        email: "  registered-customer@example.test ",
        password: testPassword,
      },
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const registeredCustomerId = registration.json().user.id as string;
    assert.deepEqual(registration.json().user.roles, ["customer"]);

    await firstApp.close();
    firstApp = undefined;
    restartedApp = createApp({
      repository: authRepository,
      webOrigin: origin,
      secureCookies: false,
      customerOtpEnabled: false,
    });
    await restartedApp.ready();

    const restoredSession = await restartedApp.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: existingCookie },
    });
    assert.equal(restoredSession.statusCode, 200, restoredSession.body);
    assert.equal(restoredSession.json().user.id, existingCustomer.id);

    const registeredCustomerLogin = await restartedApp.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin },
      payload: {
        email: "REGISTERED-CUSTOMER@example.test",
        password: testPassword,
      },
    });
    assert.equal(registeredCustomerLogin.statusCode, 200, registeredCustomerLogin.body);
    assert.equal(registeredCustomerLogin.json().user.id, registeredCustomerId);
  } finally {
    if (restartedApp) await restartedApp.close();
    if (firstApp) await firstApp.close();
  }
});

test("registration, sessions, bodyless super-admin store approval, and tenant access are enforced", async () => {
  const noOrigin = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "blocked@example.test", password: testPassword },
  });
  assert.equal(noOrigin.statusCode, 403);

  const registration = await app.inject({
    method: "POST",
    url: "/auth/register",
    headers: { origin },
    payload: { email: "  seller@example.test ", password: testPassword },
  });
  assert.equal(registration.statusCode, 201);
  assert.deepEqual(registration.json().user.roles, ["customer"]);
  assert.equal("passwordHash" in registration.json().user, false);

  sellerCookie = cookieFrom(registration);
  assert.match(String(registration.headers["set-cookie"]), /HttpOnly/i);
  assert.match(String(registration.headers["set-cookie"]), /SameSite=Lax/i);

  const me = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: sellerCookie },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, "seller@example.test");
  assert.equal(me.headers["cache-control"], "no-store");

  const wrongPassword = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { origin },
    payload: { email: "seller@example.test", password: "incorrect-password" },
  });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(wrongPassword.json().error, "Email or password is incorrect.");

  const application = await app.inject({
    method: "POST",
    url: "/seller/application",
    headers: { origin, cookie: sellerCookie },
    payload: { name: "Thoughtful Goods" },
  });
  assert.equal(application.statusCode, 201);
  assert.equal(application.json().store.status, "pending");
  const storeId = application.json().store.id as string;
  sellerStoreId = storeId;

  const applicationStatus = await app.inject({
    method: "GET",
    url: "/seller/application",
    headers: { cookie: sellerCookie },
  });
  assert.equal(applicationStatus.statusCode, 200);
  assert.equal(applicationStatus.json().store.id, storeId);

  const notSubmittedVerification = await app.inject({
    method: "GET",
    url: "/seller/verification",
    headers: { cookie: sellerCookie },
  });
  assert.equal(notSubmittedVerification.statusCode, 200);
  assert.equal(notSubmittedVerification.json().status, "NOT_SUBMITTED");
  assert.equal(notSubmittedVerification.json().providerStatus, "NOT_CONFIGURED");
  assert.equal(notSubmittedVerification.json().submissionAvailable, true);

  const unconfiguredKycApp = createApp({
    repository,
    webOrigin: origin,
    secureCookies: false,
  });
  await unconfiguredKycApp.ready();
  try {
    const unavailableStatus = await unconfiguredKycApp.inject({
      method: "GET",
      url: "/seller/verification",
      headers: { cookie: sellerCookie },
    });
    assert.equal(unavailableStatus.statusCode, 200);
    assert.equal(unavailableStatus.json().submissionAvailable, false);
    const unavailableSubmission = await unconfiguredKycApp.inject({
      method: "POST",
      url: "/seller/verification",
      headers: { origin, cookie: sellerCookie },
      payload: {},
    });
    assert.equal(unavailableSubmission.statusCode, 503);
  } finally {
    await unconfiguredKycApp.close();
  }

  const pendingSellerProductAttempt = await app.inject({
    method: "POST",
    url: "/seller/products",
    headers: { origin, cookie: sellerCookie },
    payload: {},
  });
  assert.equal(pendingSellerProductAttempt.statusCode, 403);

  const validProofImage = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 90, g: 120, b: 80 },
    },
  }).png().toBuffer();
  const invalidKycDetails = await multipartVerification(
    { ...validVerificationDetails, pan: "not-a-pan" },
    [{ field: "businessProof", bytes: validProofImage, mimeType: "image/png" }],
  );
  const invalidKycSubmission = await app.inject({
    method: "POST",
    url: "/seller/verification",
    headers: {
      origin,
      cookie: sellerCookie,
      "content-type": invalidKycDetails.contentType,
    },
    payload: invalidKycDetails.payload,
  });
  assert.equal(invalidKycSubmission.statusCode, 400);

  const invalidGstin = await multipartVerification(
    { ...validVerificationDetails, gstRegistration: "REGISTERED", gstin: "NOT-A-GSTIN" },
    [{ field: "businessProof", bytes: validProofImage, mimeType: "image/png" }],
  );
  const invalidGstinSubmission = await app.inject({
    method: "POST",
    url: "/seller/verification",
    headers: {
      origin,
      cookie: sellerCookie,
      "content-type": invalidGstin.contentType,
    },
    payload: invalidGstin.payload,
  });
  assert.equal(invalidGstinSubmission.statusCode, 400);

  const missingGstCertificate = await multipartVerification(
    { ...validVerificationDetails, gstRegistration: "REGISTERED", gstin: "27ABCDE1234F1Z5" },
    [{ field: "businessProof", bytes: validProofImage, mimeType: "image/png" }],
  );
  const missingGstCertificateSubmission = await app.inject({
    method: "POST",
    url: "/seller/verification",
    headers: {
      origin,
      cookie: sellerCookie,
      "content-type": missingGstCertificate.contentType,
    },
    payload: missingGstCertificate.payload,
  });
  assert.equal(missingGstCertificateSubmission.statusCode, 400);

  const invalidDocument = await multipartVerification(
    validVerificationDetails,
    [{ field: "businessProof", bytes: Buffer.from("not a document"), mimeType: "image/png" }],
  );
  const invalidDocumentSubmission = await app.inject({
    method: "POST",
    url: "/seller/verification",
    headers: {
      origin,
      cookie: sellerCookie,
      "content-type": invalidDocument.contentType,
    },
    payload: invalidDocument.payload,
  });
  assert.equal(invalidDocumentSubmission.statusCode, 400);
  assert.equal(privateDocumentStorage.objects.size, 0);

  const prematureStoreApproval = await app.inject({
    method: "POST",
    url: `/admin/stores/${storeId}/approve`,
    headers: { origin, cookie: adminCookie },
  });
  assert.equal(prematureStoreApproval.statusCode, 409);

  const initialVerification = await multipartVerification(
    validVerificationDetails,
    [{ field: "businessProof", bytes: validProofImage, mimeType: "image/png" }],
  );
  const unauthenticatedKyc = await app.inject({
    method: "POST",
    url: "/seller/verification",
    headers: {
      origin,
      "content-type": initialVerification.contentType,
    },
    payload: initialVerification.payload,
  });
  assert.equal(unauthenticatedKyc.statusCode, 401);
  const submittedVerification = await app.inject({
    method: "POST",
    url: "/seller/verification",
    headers: {
      origin,
      cookie: sellerCookie,
      "content-type": initialVerification.contentType,
    },
    payload: initialVerification.payload,
  });
  assert.equal(submittedVerification.statusCode, 200);
  assert.equal(submittedVerification.json().status, "PENDING_REVIEW");
  assert.equal(privateDocumentStorage.objects.size, 1);
  const storedVerification = await repository.getSellerVerification(storeId);
  assert.ok(storedVerification);
  assert.equal(storedVerification.encryptedData.includes("ABCDE1234F"), false);
  assert.equal(storedVerification.documents[0]?.contentType, "image/webp");

  const sellerSelfReview = await app.inject({
    method: "POST",
    url: `/admin/seller-verifications/${storeId}/review`,
    headers: { origin, cookie: sellerCookie },
    payload: { status: "APPROVED" },
  });
  assert.equal(sellerSelfReview.statusCode, 403);
  const sellerUserId = registration.json().user.id as string;
  repository.setUserRoles(sellerUserId, ["customer", "super_admin"]);
  const superAdminOwnerSelfReview = await app.inject({
    method: "POST",
    url: `/admin/seller-verifications/${storeId}/review`,
    headers: { origin, cookie: sellerCookie },
    payload: { status: "APPROVED" },
  });
  assert.equal(superAdminOwnerSelfReview.statusCode, 409);
  repository.setUserRoles(sellerUserId, ["customer"]);
  await assert.rejects(
    repository.reviewSellerVerification(storeId, sellerUserId, "APPROVED"),
    /unavailable for review/,
  );

  const adminVerificationQueue = await app.inject({
    method: "GET",
    url: "/admin/seller-verifications/pending",
    headers: { cookie: adminCookie },
  });
  assert.equal(adminVerificationQueue.statusCode, 200);
  assert.ok(adminVerificationQueue.json().items.some(
    (item: SellerVerificationSummary) => item.storeId === storeId,
  ));
  const sellerCannotSeeVerificationQueue = await app.inject({
    method: "GET",
    url: "/admin/seller-verifications/pending",
    headers: { cookie: sellerCookie },
  });
  assert.equal(sellerCannotSeeVerificationQueue.statusCode, 403);
  const adminVerificationDetails = await app.inject({
    method: "GET",
    url: `/admin/seller-verifications/${storeId}`,
    headers: { cookie: adminCookie },
  });
  assert.equal(adminVerificationDetails.statusCode, 200);
  assert.equal(adminVerificationDetails.json().business.pan, "ABCDE1234F");
  assert.equal(adminVerificationDetails.json().providerStatus, "NOT_CONFIGURED");
  const privateDocumentId = adminVerificationDetails.json().documents[0].id as string;
  const sellerPrivateDocumentAttempt = await app.inject({
    method: "GET",
    url: `/admin/seller-verifications/${storeId}/documents/${privateDocumentId}`,
    headers: { cookie: sellerCookie },
  });
  assert.equal(sellerPrivateDocumentAttempt.statusCode, 403);
  const adminPrivateDocument = await app.inject({
    method: "GET",
    url: `/admin/seller-verifications/${storeId}/documents/${privateDocumentId}`,
    headers: { cookie: adminCookie },
  });
  assert.equal(adminPrivateDocument.statusCode, 200);
  assert.equal(adminPrivateDocument.headers["x-content-type-options"], "nosniff");
  assert.match(String(adminPrivateDocument.headers["content-disposition"]), /attachment/);

  const correctionRequest = await app.inject({
    method: "POST",
    url: `/admin/seller-verifications/${storeId}/review`,
    headers: { origin, cookie: adminCookie },
    payload: {
      status: "NEEDS_CORRECTION",
      reason: "Provide the correct GST registration certificate.",
    },
  });
  assert.equal(correctionRequest.statusCode, 200);
  const sellerCorrectionStatus = await app.inject({
    method: "GET",
    url: "/seller/verification",
    headers: { cookie: sellerCookie },
  });
  assert.equal(sellerCorrectionStatus.json().status, "NEEDS_CORRECTION");
  assert.equal(
    sellerCorrectionStatus.json().reason,
    "Provide the correct GST registration certificate.",
  );

  const registeredBusinessDetails = {
    ...validVerificationDetails,
    gstRegistration: "REGISTERED",
    gstin: "27ABCDE1234F1Z5",
  };
  const resubmission = await multipartVerification(
    registeredBusinessDetails,
    [
      { field: "businessProof", bytes: validProofImage, mimeType: "image/png" },
      { field: "gstCertificate", bytes: validProofImage, mimeType: "image/png" },
    ],
  );
  const resubmittedVerification = await app.inject({
    method: "POST",
    url: "/seller/verification",
    headers: {
      origin,
      cookie: sellerCookie,
      "content-type": resubmission.contentType,
    },
    payload: resubmission.payload,
  });
  assert.equal(resubmittedVerification.statusCode, 200);
  assert.equal(privateDocumentStorage.objects.size, 2);

  const verifyBusiness = await app.inject({
    method: "POST",
    url: `/admin/seller-verifications/${storeId}/review`,
    headers: { origin, cookie: adminCookie },
    payload: { status: "APPROVED" },
  });
  assert.equal(verifyBusiness.statusCode, 200);
  assert.deepEqual((await repository.getUserById(sellerUserId))?.roles, ["customer"]);
  assert.deepEqual(
    (await repository.getSellerVerification(storeId))?.history.map((entry) => entry.status),
    ["PENDING_REVIEW", "NEEDS_CORRECTION", "PENDING_REVIEW", "APPROVED"],
  );
  assert.equal(
    (await repository.getSellerVerification(storeId))?.history.at(-1)?.actorUserId,
    "admin-user",
  );
  assert.ok((await repository.getSellerVerification(storeId))?.history.at(-1)?.createdAt);

  const sellerCannotSeeAdminQueue = await app.inject({
    method: "GET",
    url: "/admin/stores/pending",
    headers: { cookie: sellerCookie },
  });
  assert.equal(sellerCannotSeeAdminQueue.statusCode, 403);

  const adminStoreQueue = await app.inject({
    method: "GET",
    url: "/admin/stores/pending",
    headers: { cookie: adminCookie },
  });
  assert.equal(adminStoreQueue.statusCode, 200);
  assert.ok(adminStoreQueue.json().items.some((store: SellerStore) => store.id === storeId));

  const duplicateApplication = await app.inject({
    method: "POST",
    url: "/seller/application",
    headers: { origin, cookie: sellerCookie },
    payload: { name: "Another Store" },
  });
  assert.equal(duplicateApplication.statusCode, 409);

  const customerAdminAttempt = await app.inject({
    method: "POST",
    url: `/admin/stores/${storeId}/approve`,
    headers: { origin, cookie: sellerCookie },
  });
  assert.equal(customerAdminAttempt.statusCode, 403);

  const notApprovedYet = await app.inject({
    method: "GET",
    url: `/seller/stores/${storeId}`,
    headers: { cookie: sellerCookie },
  });
  assert.equal(notApprovedYet.statusCode, 403);

  repository.setUserRoles(sellerUserId, ["customer", "super_admin"]);
  const superAdminOwnerStoreApproval = await app.inject({
    method: "POST",
    url: `/admin/stores/${storeId}/approve`,
    headers: { origin, cookie: sellerCookie },
  });
  assert.equal(superAdminOwnerStoreApproval.statusCode, 403);
  repository.setUserRoles(sellerUserId, ["customer"]);

  const approvalHeaders = { origin, cookie: adminCookie };
  assert.equal("content-type" in approvalHeaders, false);
  const approval = await app.inject({
    method: "POST",
    url: `/admin/stores/${storeId}/approve`,
    headers: approvalHeaders,
  });
  assert.equal(approval.statusCode, 200);
  assert.deepEqual(repository.auditEvents.at(-1), {
    actorUserId: "admin-user",
    storeId,
  });

  const ownStore = await app.inject({
    method: "GET",
    url: `/seller/stores/${storeId}`,
    headers: { cookie: sellerCookie },
  });
  assert.equal(ownStore.statusCode, 200);
  assert.equal(ownStore.json().store.ownerUserId, registration.json().user.id);

  const otherTenantStore = await app.inject({
    method: "GET",
    url: `/seller/stores/${storeId}`,
    headers: { cookie: otherSellerCookie },
  });
  assert.equal(otherTenantStore.statusCode, 404);

  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { origin, cookie: sellerCookie },
  });
  assert.equal(logout.statusCode, 204);

  const afterLogout = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: sellerCookie },
  });
  assert.equal(afterLogout.statusCode, 401);
});

test("seller product ownership, draft lifecycle, catalog filters, and pagination work", async () => {
  const editPreflight = await app.inject({
    method: "OPTIONS",
    url: "/seller/products/example-product",
    headers: {
      origin,
      "access-control-request-method": "PATCH",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(editPreflight.statusCode, 204);
  assert.match(
    String(editPreflight.headers["access-control-allow-methods"]),
    /\bPATCH\b/,
  );

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { origin },
    payload: { email: "seller@example.test", password: testPassword },
  });
  assert.equal(login.statusCode, 200);
  sellerCookie = cookieFrom(login);

  const productPayload = (sku: string, title = "Handmade cotton tote") => ({
    title,
    description: "A durable everyday tote from an independent maker.",
    brand: "Morrow Maker",
    sku,
    category: "accessories",
    priceMinor: 159900,
    stock: 12,
    images: [
      {
        url: "https://media.example.test/catalog/tote-front.webp",
        altText: "Front view of the tote bag",
      },
    ],
    specifications: { material: "Cotton", color: "Natural" },
  });

  const invalidImage = await app.inject({
    method: "POST",
    url: "/seller/products",
    headers: { origin, cookie: sellerCookie },
    payload: { ...productPayload("TOTE-INVALID"), images: [{ url: "http://example.test/image.jpg", altText: "Product image" }] },
  });
  assert.equal(invalidImage.statusCode, 400);
  const untrustedImageHost = await app.inject({
    method: "POST",
    url: "/seller/products",
    headers: { origin, cookie: sellerCookie },
    payload: {
      ...productPayload("TOTE-UNTRUSTED"),
      images: [{ url: "https://untrusted.example.test/image.jpg", altText: "Product image" }],
    },
  });
  assert.equal(untrustedImageHost.statusCode, 400);

  const firstDraft = await app.inject({
    method: "POST",
    url: "/seller/products",
    headers: { origin, cookie: sellerCookie },
    payload: productPayload("tote-001"),
  });
  assert.equal(firstDraft.statusCode, 201);
  assert.equal(firstDraft.json().product.status, "draft");
  assert.equal(firstDraft.json().product.sku, "TOTE-001");
  const productId = firstDraft.json().product.id as string;

  const unauthenticatedImage = await uploadProductImage(
    app, productId, undefined, Buffer.from("not an image"), "image/png",
  );
  assert.equal(unauthenticatedImage.statusCode, 401);

  const otherSellerImage = await uploadProductImage(
    app, productId, otherSellerCookie, Buffer.from("not an image"), "image/png",
  );
  assert.equal(otherSellerImage.statusCode, 404);

  const pendingSellerImage = await uploadProductImage(
    app, productId, pendingSellerCookie, Buffer.from("not an image"), "image/png",
  );
  assert.equal(pendingSellerImage.statusCode, 403);

  const invalidImageContent = await uploadProductImage(
    app, productId, sellerCookie, Buffer.from("not an image"), "image/png",
  );
  assert.equal(invalidImageContent.statusCode, 400);
  const oversizedImage = await uploadProductImage(
    app,
    productId,
    sellerCookie,
    Buffer.alloc(5 * 1024 * 1024 + 1),
    "image/png",
  );
  assert.equal(oversizedImage.statusCode, 413);
  assert.equal(imageStorage.objects.size, 0);

  const realPngBytes = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 120, g: 90, b: 60 },
    },
  }).png().toBuffer();
  const mismatchedMimeType = await uploadProductImage(
    app, productId, sellerCookie, realPngBytes, "image/jpeg",
  );
  assert.equal(mismatchedMimeType.statusCode, 400);
  assert.equal(imageStorage.objects.size, 0);

  const successfulUpload = await uploadProductImage(
    app, productId, sellerCookie, realPngBytes, "image/png", "A genuine PNG test image",
  );
  assert.equal(successfulUpload.statusCode, 200);
  assert.equal(
    successfulUpload.json().image.url.startsWith("https://media.example.test/products/"),
    true,
  );
  assert.equal(successfulUpload.json().image.altText, "A genuine PNG test image");
  assert.equal(imageStorage.objects.size, 1);
  const [storedKey] = imageStorage.objects.keys();
  assert.match(storedKey ?? "", /^products\/[0-9a-f-]+\.webp$/);
  const [storedImage] = imageStorage.objects.values();
  assert.equal(storedImage?.contentType, "image/webp");
  assert.equal((await sharp(storedImage?.body).metadata()).format, "webp");
  assert.equal(
    (await repository.getProduct(productId))?.images.at(-1)?.url,
    successfulUpload.json().image.url,
  );
  assert.equal(
    (await repository.getProduct(productId))?.images.at(-1)?.altText,
    "A genuine PNG test image",
  );

  const realJpegBytes = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 35, g: 100, b: 180 },
    },
  }).jpeg().toBuffer();
  const realWebpBytes = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 180, g: 100, b: 35 },
    },
  }).webp().toBuffer();
  const additionalUploads = [
    await uploadProductImage(
      app, productId, sellerCookie, realJpegBytes, "image/jpeg", "Side view of the tote",
    ),
    await uploadProductImage(
      app, productId, sellerCookie, realWebpBytes, "image/webp", "Close-up of the weave",
    ),
    await uploadProductImage(
      app, productId, sellerCookie, realPngBytes, "image/png", "Interior detail of the tote",
    ),
  ];
  assert.ok(additionalUploads.every((upload) => upload.statusCode === 200));
  assert.equal(imageStorage.objects.size, 4);
  const fifthImageUpload = await uploadProductImage(
    app, productId, sellerCookie, realPngBytes, "image/png", "Another product detail",
  );
  assert.equal(fifthImageUpload.statusCode, 400);
  const uploadedProduct = await repository.getProduct(productId);
  assert.equal(uploadedProduct?.images.length, 5);
  const reorderedImages = [...(uploadedProduct?.images ?? [])].reverse();
  const reorderedDraft = await app.inject({
    method: "PATCH",
    url: `/seller/products/${productId}`,
    headers: { origin, cookie: sellerCookie },
    payload: {
      ...productPayload("TOTE-001"),
      images: reorderedImages,
    },
  });
  assert.equal(reorderedDraft.statusCode, 200);
  assert.deepEqual(
    reorderedDraft.json().product.images.map((image: { url: string }) => image.url),
    reorderedImages.map((image) => image.url),
  );
  const oversizedProductGallery = await app.inject({
    method: "PATCH",
    url: `/seller/products/${productId}`,
    headers: { origin, cookie: sellerCookie },
    payload: {
      ...productPayload("TOTE-001"),
      images: [...reorderedImages, reorderedImages[0]],
    },
  });
  assert.equal(oversizedProductGallery.statusCode, 400);

  const secondDraftImages = [
    { url: "https://media.example.test/catalog/tote-front.webp", altText: "Front of the tote" },
    { url: "https://media.example.test/catalog/tote-back.webp", altText: "Back of the tote" },
    { url: "https://media.example.test/catalog/tote-side.webp", altText: "Side of the tote" },
  ];
  const secondDraft = await app.inject({
    method: "POST",
    url: "/seller/products",
    headers: { origin, cookie: sellerCookie },
    payload: {
      ...productPayload("tote-002", "Woven market bag"),
      images: secondDraftImages,
    },
  });
  assert.equal(secondDraft.statusCode, 201);

  const sellerCannotSeeProductQueue = await app.inject({
    method: "GET",
    url: "/admin/products/pending",
    headers: { cookie: sellerCookie },
  });
  assert.equal(sellerCannotSeeProductQueue.statusCode, 403);

  const adminProductQueue = await app.inject({
    method: "GET",
    url: "/admin/products/pending",
    headers: { cookie: adminCookie },
  });
  assert.equal(adminProductQueue.statusCode, 200);
  assert.ok(adminProductQueue.json().items.some(
    (product: ProductRecord) => product.id === secondDraft.json().product.id,
  ));
  assert.deepEqual(
    adminProductQueue.json().items.find(
      (product: ProductRecord) => product.id === productId,
    )?.images.map((image: { url: string }) => image.url),
    reorderedImages.map((image) => image.url),
  );

  const sellerCannotPublish = await app.inject({
    method: "POST",
    url: `/admin/products/${secondDraft.json().product.id}/approve`,
    headers: { origin, cookie: sellerCookie },
  });
  assert.equal(sellerCannotPublish.statusCode, 403);

  const publication = await app.inject({
    method: "POST",
    url: `/admin/products/${secondDraft.json().product.id}/approve`,
    headers: { origin, cookie: adminCookie },
  });
  assert.equal(publication.statusCode, 200);
  assert.deepEqual(repository.moderationEvents.at(-1), {
    actorUserId: "admin-user",
    targetId: secondDraft.json().product.id,
    action: "catalog.product.approved",
  });
  const publicProduct = await app.inject({
    method: "GET",
    url: `/catalog/${secondDraft.json().product.id}`,
  });
  assert.equal(publicProduct.statusCode, 200);
  assert.equal(
    publicProduct.json().product.images[0].url,
    "https://media.example.test/catalog/tote-front.webp",
  );
  assert.deepEqual(publicProduct.json().product.images, secondDraftImages);
  const publicCatalog = await app.inject({
    method: "GET",
    url: "/catalog?q=Woven%20market%20bag",
  });
  assert.equal(publicCatalog.statusCode, 200);
  assert.equal(publicCatalog.json().items[0].id, secondDraft.json().product.id);
  assert.equal(
    publicCatalog.json().items[0].images[0].url,
    "https://media.example.test/catalog/tote-front.webp",
  );
  assert.deepEqual(publicCatalog.json().items[0].images, secondDraftImages);
  const categorySearch = await app.inject({
    method: "GET",
    url: "/catalog?q=accessories",
  });
  assert.equal(categorySearch.statusCode, 200);
  assert.ok(categorySearch.json().items.some(
    (product: ProductRecord) => product.id === secondDraft.json().product.id,
  ));

  const searchFixtures = [
    { title: "Nike Shoes", brand: "Nike", category: "footwear" },
    { title: "Nike Air Running Sneakers", brand: "Nike", category: "footwear" },
    { title: "Stride Running Shoe", brand: "Stride", category: "footwear" },
    { title: "Nike Cotton Shirt", brand: "Nike", category: "clothing" },
    { title: "Leather Loafers", brand: "Morrow", category: "footwear" },
  ];
  for (const fixture of searchFixtures) {
    const draft = await app.inject({
      method: "POST",
      url: "/seller/products",
      headers: { origin, cookie: sellerCookie },
      payload: {
        ...productPayload(`SEARCH-${randomUUID()}`),
        title: fixture.title,
        brand: fixture.brand,
        category: fixture.category,
      },
    });
    assert.equal(draft.statusCode, 201);
    const approved = await app.inject({
      method: "POST",
      url: `/admin/products/${draft.json().product.id}/approve`,
      headers: { origin, cookie: adminCookie },
    });
    assert.equal(approved.statusCode, 200);
  }
  const exactSearch = await app.inject({
    method: "GET",
    url: "/catalog?q=Nike%20Shoes&limit=10",
  });
  assert.equal(exactSearch.statusCode, 200);
  assert.deepEqual(
    exactSearch.json().items.map((product: ProductRecord) => product.title),
    ["Nike Shoes", "Nike Air Running Sneakers"],
  );
  const relatedSearch = await app.inject({
    method: "GET",
    url: "/catalog?q=running%20shoes&limit=10",
  });
  assert.equal(relatedSearch.statusCode, 200);
  assert.deepEqual(
    new Set(relatedSearch.json().items.map((product: ProductRecord) => product.title)),
    new Set(["Nike Air Running Sneakers", "Stride Running Shoe"]),
  );
  const noMatchSearch = await app.inject({
    method: "GET",
    url: "/catalog?q=ceramic%20dragonfly",
  });
  assert.equal(noMatchSearch.statusCode, 200);
  assert.deepEqual(noMatchSearch.json().items, []);
  const suggestions = await app.inject({
    method: "GET",
    url: "/catalog?q=Nike&limit=5",
  });
  assert.equal(suggestions.statusCode, 200);
  assert.ok(suggestions.json().items.length > 0);
  assert.ok(
    suggestions.json().items.every((product: ProductRecord) =>
      `${product.title} ${product.brand}`.toLowerCase().includes("nike"),
    ),
  );
  const firstSearchPage = await app.inject({
    method: "GET",
    url: "/catalog?q=Nike%20Shoes&limit=1",
  });
  assert.equal(firstSearchPage.statusCode, 200);
  assert.equal(firstSearchPage.json().items[0].title, "Nike Shoes");
  assert.ok(firstSearchPage.json().nextCursor);
  const secondSearchPage = await app.inject({
    method: "GET",
    url: `/catalog?q=Nike%20Shoes&limit=1&cursor=${encodeURIComponent(firstSearchPage.json().nextCursor)}`,
  });
  assert.equal(secondSearchPage.statusCode, 200);
  assert.equal(secondSearchPage.json().items[0].title, "Nike Air Running Sneakers");

  const noImageDraft = await app.inject({
    method: "POST",
    url: "/seller/products",
    headers: { origin, cookie: sellerCookie },
    payload: { ...productPayload("no-image"), images: [] },
  });
  assert.equal(noImageDraft.statusCode, 201);
  const noImageApproval = await app.inject({
    method: "POST",
    url: `/admin/products/${noImageDraft.json().product.id}/approve`,
    headers: { origin, cookie: adminCookie },
  });
  assert.equal(noImageApproval.statusCode, 400);

  const rejected = await app.inject({
    method: "POST",
    url: `/admin/products/${noImageDraft.json().product.id}/reject`,
    headers: { origin, cookie: adminCookie },
    payload: { reason: "Add a clear product image." },
  });
  assert.equal(rejected.statusCode, 200);
  const rejectedDraftUpdate = await app.inject({
    method: "PATCH",
    url: `/seller/products/${noImageDraft.json().product.id}`,
    headers: { origin, cookie: sellerCookie },
    payload: productPayload("NO-IMAGE-FIXED"),
  });
  assert.equal(rejectedDraftUpdate.statusCode, 200);
  assert.equal(rejectedDraftUpdate.json().product.status, "draft");

  const publicDrafts = await app.inject({
    method: "GET",
    url: "/catalog",
  });
  assert.equal(publicDrafts.statusCode, 200);
  const publishedProductIds = publicDrafts.json().items.map(
    (product: { id: string }) => product.id,
  );
  assert.ok(publishedProductIds.includes(secondDraft.json().product.id));
  assert.ok(!publishedProductIds.includes(productId));
  assert.ok(!publishedProductIds.includes(noImageDraft.json().product.id));

  const hiddenDraft = await app.inject({
    method: "GET",
    url: `/catalog/${productId}`,
  });
  assert.equal(hiddenDraft.statusCode, 404);

  const resubmittedQueue = await app.inject({
    method: "GET",
    url: "/admin/products/pending",
    headers: { cookie: adminCookie },
  });
  assert.ok(resubmittedQueue.json().items.some(
    (product: ProductRecord) => product.id === noImageDraft.json().product.id,
  ));

  const resubmissionApproval = await app.inject({
    method: "POST",
    url: `/admin/products/${noImageDraft.json().product.id}/approve`,
    headers: { origin, cookie: adminCookie },
  });
  assert.equal(resubmissionApproval.statusCode, 200);

  const reapprovedProduct = await app.inject({
    method: "GET",
    url: `/catalog/${noImageDraft.json().product.id}`,
  });
  assert.equal(reapprovedProduct.statusCode, 200);
  assert.equal(
    reapprovedProduct.json().product.images[0].url,
    "https://media.example.test/catalog/tote-front.webp",
  );

  const customerCannotCreateDraft = await app.inject({
    method: "POST",
    url: "/seller/products",
    headers: { origin, cookie: adminCookie },
    payload: productPayload("admin-001"),
  });
  assert.equal(customerCannotCreateDraft.statusCode, 403);

  const sellerList = await app.inject({
    method: "GET",
    url: "/seller/products?limit=1",
    headers: { cookie: sellerCookie },
  });
  assert.equal(sellerList.statusCode, 200);
  assert.equal(sellerList.json().items.length, 1);
  assert.ok(sellerList.json().nextCursor);

  const nextSellerPage = await app.inject({
    method: "GET",
    url: `/seller/products?limit=1&cursor=${encodeURIComponent(sellerList.json().nextCursor)}`,
    headers: { cookie: sellerCookie },
  });
  assert.equal(nextSellerPage.statusCode, 200);
  assert.equal(nextSellerPage.json().items.length, 1);

  const invalidCursor = await app.inject({
    method: "GET",
    url: "/seller/products?cursor=not-a-valid-cursor",
    headers: { cookie: sellerCookie },
  });
  assert.equal(invalidCursor.statusCode, 400);

  const editDraft = await app.inject({
    method: "PATCH",
    url: `/seller/products/${productId}`,
    headers: { origin, cookie: sellerCookie },
    payload: { ...productPayload("tote-003"), title: "Updated handmade tote" },
  });
  assert.equal(editDraft.statusCode, 200);
  assert.equal(editDraft.json().product.title, "Updated handmade tote");

  const otherSellerCannotEdit = await app.inject({
    method: "PATCH",
    url: `/seller/products/${productId}`,
    headers: { origin, cookie: otherSellerCookie },
    payload: productPayload("TOTE-OTHER"),
  });
  assert.equal(otherSellerCannotEdit.statusCode, 404);

  const activeFixture = (id: string, priceMinor: number): ProductRecord => ({
    id,
    sellerId: "other-seller",
    storeId: "another-store",
    title: `Catalog test item ${id}`,
    description: "Test-only listing for catalog query behavior.",
    brand: "Test Maker",
    sku: `TEST-${id}`,
    category: "home-goods",
    currency: "INR",
    priceMinor,
    stock: 2,
    images: [{ url: "https://media.example.test/test-item.webp", altText: "Test item image" }],
    specifications: {},
    status: "active",
    createdAt: `2026-01-0${priceMinor === 10000 ? 1 : 2}T00:00:00.000Z`,
    updatedAt: new Date().toISOString(),
  });
  await repository.createProduct(activeFixture("catalog-low", 10000));
  await repository.createProduct(activeFixture("catalog-high", 20000));

  const catalog = await app.inject({
    method: "GET",
    url: "/catalog?category=home-goods&q=Catalog%20test&sort=price_asc&limit=1",
  });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().items.length, 1);
  assert.equal(catalog.json().items[0].id, "catalog-low");
  assert.equal("sellerId" in catalog.json().items[0], false);
  assert.ok(catalog.json().nextCursor);

  const nextCatalogPage = await app.inject({
    method: "GET",
    url: `/catalog?category=home-goods&q=Catalog%20test&sort=price_asc&limit=1&cursor=${encodeURIComponent(catalog.json().nextCursor)}`,
  });
  assert.equal(nextCatalogPage.statusCode, 200);
  assert.equal(nextCatalogPage.json().items[0].id, "catalog-high");

  const badSort = await app.inject({
    method: "GET",
    url: "/catalog?sort=price_asc",
  });
  assert.equal(badSort.statusCode, 400);

  const invalidPriceRange = await app.inject({
    method: "GET",
    url: "/catalog?minPrice=20000&maxPrice=10000",
  });
  assert.equal(invalidPriceRange.statusCode, 400);

  const productBeforeArchive = await repository.getProduct(productId);
  assert.ok(productBeforeArchive);
  const archived = await app.inject({
    method: "POST",
    url: `/seller/products/${productId}/archive`,
    headers: { origin, cookie: sellerCookie },
  });
  assert.equal(archived.statusCode, 200);

  const archivedEdit = await app.inject({
    method: "PATCH",
    url: `/seller/products/${productId}`,
    headers: { origin, cookie: sellerCookie },
    payload: productPayload("TOTE-004"),
  });
  assert.equal(archivedEdit.statusCode, 409);

  const otherSellerRestore = await app.inject({
    method: "POST",
    url: `/seller/products/${productId}/restore`,
    headers: { origin, cookie: otherSellerCookie },
  });
  assert.equal(otherSellerRestore.statusCode, 404);
  const adminRestore = await app.inject({
    method: "POST",
    url: `/admin/products/${productId}/restore`,
    headers: { origin, cookie: adminCookie },
  });
  assert.equal(adminRestore.statusCode, 200);
  assert.deepEqual(adminRestore.json(), { status: "draft" });
  const restoredDraft = await repository.getProduct(productId);
  assert.equal(restoredDraft?.status, "draft");
  assert.equal(restoredDraft?.sku, productBeforeArchive.sku);
  assert.equal(restoredDraft?.priceMinor, productBeforeArchive.priceMinor);
  assert.equal(restoredDraft?.stock, productBeforeArchive.stock);
  assert.equal(restoredDraft?.description, productBeforeArchive.description);
  assert.deepEqual(restoredDraft?.images, productBeforeArchive.images);
  assert.deepEqual(restoredDraft?.specifications, productBeforeArchive.specifications);
});

test("local checkout validates delivery, persists orders, and prevents duplicate orders", async () => {
  const primaryImageUrl = "https://media.example.test/checkout-primary.webp";
  const fixture = await createLocalWorkflowFixture(5, {
    images: [
      { url: primaryImageUrl, altText: "Primary product image" },
      { url: "https://media.example.test/checkout-back.webp", altText: "Back of product" },
      { url: "https://media.example.test/checkout-side.webp", altText: "Side of product" },
    ],
  });
  try {
    const {
      app: workflowApp,
      repository: workflowRepository,
      product,
      customerCookie,
      sellerCookie: workflowSellerCookie,
      adminCookie: workflowAdminCookie,
    } = fixture;
    const noSession = await workflowApp.inject({ method: "GET", url: "/cart" });
    assert.equal(noSession.statusCode, 401);
    const sellerCannotUseCustomerCart = await workflowApp.inject({
      method: "GET",
      url: "/cart",
      headers: { cookie: workflowSellerCookie },
    });
    assert.equal(sellerCannotUseCustomerCart.statusCode, 403);
    const adminCannotUseCustomerCart = await workflowApp.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: workflowAdminCookie },
      payload: { items: [] },
    });
    assert.equal(adminCannotUseCustomerCart.statusCode, 403);

    const invalidDuplicateCart = await workflowApp.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: customerCookie },
      payload: {
        items: [
          { productId: product.id, quantity: 1 },
          { productId: product.id, quantity: 2 },
        ],
      },
    });
    assert.equal(invalidDuplicateCart.statusCode, 400);
    const savedCart = await workflowApp.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: customerCookie },
      payload: { items: [{ productId: product.id, quantity: 2 }] },
    });
    assert.equal(savedCart.statusCode, 200);

    const invalidDelivery = await workflowApp.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery: {
          recipientName: "Local Customer",
          phone: "not-a-phone",
          address: "12 Test Road",
          city: "Mumbai",
          state: "Maharashtra",
          pinCode: "400001",
        },
      },
    });
    assert.equal(invalidDelivery.statusCode, 400);
    const idempotencyKey = randomUUID();
    const delivery = {
      recipientName: "Local Customer",
      phone: "+919876543210",
      address: "12 Test Road, Sample Neighborhood",
      city: "Mumbai",
      state: "Maharashtra",
      pinCode: "400001",
    };
    const checkout = await workflowApp.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: customerCookie },
      payload: { idempotencyKey, delivery },
    });
    assert.equal(checkout.statusCode, 200);
    const order = checkout.json().order as OrderRecord;
    assert.equal(order.paymentResult, "NOT_CONFIGURED");
    assert.equal(order.status, "PENDING");
    assert.equal(order.deliveryStatus, "NOT_DELIVERED");
    assert.deepEqual(order.delivery, delivery);
    assert.equal(order.items[0]?.quantity, 2);
    assert.equal(order.items[0]?.imageUrl, primaryImageUrl);
    assert.equal(order.items[0]?.title, product.title);
    assert.equal(order.items[0]?.brand, product.brand);
    assert.equal(order.items[0]?.unitPriceMinor, product.priceMinor);
    assert.equal(order.subtotalMinor, product.priceMinor * 2);
    assert.equal((await workflowRepository.getProduct(product.id))?.stock, 3);
    assert.equal((await workflowRepository.getProduct(product.id))?.status, "active");
    assert.deepEqual((await workflowRepository.getCart(fixture.customer.id)).items, []);
    const ownOrders = await workflowApp.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: customerCookie },
    });
    assert.equal(ownOrders.statusCode, 200);
    assert.equal(ownOrders.json().orders[0].status, "PENDING");
    assert.equal(ownOrders.json().orders[0].items[0].imageUrl, primaryImageUrl);
    assert.equal(ownOrders.json().orders[0].items[0].quantity, 2);
    assert.equal(ownOrders.json().orders[0].items[0].unitPriceMinor, product.priceMinor);
    assert.equal(ownOrders.json().returnTestingEnabled, true);
    const sellerOrders = await workflowApp.inject({
      method: "GET",
      url: "/seller/orders",
      headers: { cookie: workflowSellerCookie },
    });
    assert.equal(sellerOrders.statusCode, 200);
    assert.equal(sellerOrders.json().orders.length, 1);
    assert.equal(sellerOrders.json().orders[0].id, order.id);
    assert.equal(sellerOrders.json().orders[0].items[0].productId, product.id);
    assert.equal(sellerOrders.json().orders[0].items[0].imageUrl, primaryImageUrl);
    assert.equal(sellerOrders.json().orders[0].items[0].quantity, 2);
    assert.equal(sellerOrders.json().orders[0].items[0].unitPriceMinor, product.priceMinor);
    const customerCannotListAdminOrders = await workflowApp.inject({
      method: "GET",
      url: "/admin/orders",
      headers: { cookie: customerCookie },
    });
    assert.equal(customerCannotListAdminOrders.statusCode, 403);

    const duplicateCheckout = await workflowApp.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: customerCookie },
      payload: { idempotencyKey, delivery },
    });
    assert.equal(duplicateCheckout.statusCode, 200);
    assert.equal(duplicateCheckout.json().order.id, order.id);
    assert.equal((await workflowRepository.listCustomerOrders(fixture.customer.id)).length, 1);
    const notOtherCustomersOrder = await workflowApp.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.secondCustomerCookie },
    });
    assert.deepEqual(notOtherCustomersOrder.json().orders, []);
  } finally {
    await fixture.app.close();
  }
});

test("direct checkout purchases requested items without changing the saved cart", async () => {
  const fixture = await createLocalWorkflowFixture(4, { category: "footwear" });
  try {
    const missingShoeSize = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 1 }] },
    });
    assert.equal(missingShoeSize.statusCode, 400);
    const unavailableQuantity = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 5, size: "7" }] },
    });
    assert.equal(unavailableQuantity.statusCode, 409);

    const savedCart = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 1, size: "7" }] },
    });
    assert.equal(savedCart.statusCode, 200);

    const delivery = {
      recipientName: "Test Customer",
      phone: "+919876543210",
      address: "12 Test Road, Sample Neighborhood",
      city: "Mumbai",
      state: "Maharashtra",
      pinCode: "400001",
    };
    const idempotencyKey = randomUUID();
    const checkout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey,
        delivery,
        items: [{ productId: fixture.product.id, quantity: 2, size: "9" }],
      },
    });
    assert.equal(checkout.statusCode, 200);
    assert.equal(checkout.json().order.items[0].quantity, 2);
    assert.equal(checkout.json().order.items[0].size, "9");
    const customerOrders = await fixture.app.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.customerCookie },
    });
    assert.equal(customerOrders.statusCode, 200);
    assert.equal(customerOrders.json().orders[0].id, checkout.json().order.id);
    assert.equal(customerOrders.json().orders[0].status, "PENDING");
    assert.equal(customerOrders.json().orders[0].items[0].productId, fixture.product.id);
    assert.equal(customerOrders.json().orders[0].items[0].title, fixture.product.title);
    assert.equal(customerOrders.json().orders[0].items[0].imageUrl, fixture.product.images[0]?.url);
    assert.equal(customerOrders.json().orders[0].items[0].quantity, 2);
    assert.equal(customerOrders.json().orders[0].items[0].size, "9");
    assert.equal(customerOrders.json().orders[0].items[0].unitPriceMinor, fixture.product.priceMinor);
    assert.deepEqual(
      (await fixture.repository.getCart(fixture.customer.id)).items,
      [{ productId: fixture.product.id, quantity: 1, size: "7" }],
    );
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 2);

    const splitVariantOverdraw = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery,
        items: [
          { productId: fixture.product.id, quantity: 1, size: "7" },
          { productId: fixture.product.id, quantity: 2, size: "8" },
        ],
      },
    });
    assert.equal(splitVariantOverdraw.statusCode, 409);
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 2);

    const splitVariantCheckout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery,
        items: [
          { productId: fixture.product.id, quantity: 1, size: "7" },
          { productId: fixture.product.id, quantity: 1, size: "8" },
        ],
      },
    });
    assert.equal(splitVariantCheckout.statusCode, 200);
    assert.equal(splitVariantCheckout.json().order.items.length, 2);
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 0);

    const outOfStock = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery,
        items: [{ productId: fixture.product.id, quantity: 3, size: "9" }],
      },
    });
    assert.equal(outOfStock.statusCode, 409);
    assert.match(outOfStock.json().error, /quantity|stock|available/i);
  } finally {
    await fixture.app.close();
  }
});

test("customer cancellation restores stock once and rejects ineligible orders", async () => {
  const fixture = await createLocalWorkflowFixture(5);
  try {
    const delivery = {
      recipientName: "Test Customer",
      phone: "+919876543210",
      address: "12 Test Road, Sample Neighborhood",
      city: "Mumbai",
      state: "Maharashtra",
      pinCode: "400001",
    };
    const placeOrder = async (product: ProductRecord) => {
      const cart = await fixture.app.inject({
        method: "PUT",
        url: "/cart",
        headers: { origin, cookie: fixture.customerCookie },
        payload: { items: [{ productId: product.id, quantity: 2 }] },
      });
      assert.equal(cart.statusCode, 200);
      const checkout = await fixture.app.inject({
        method: "POST",
        url: "/checkout",
        headers: { origin, cookie: fixture.customerCookie },
        payload: { idempotencyKey: randomUUID(), delivery },
      });
      assert.equal(checkout.statusCode, 200);
      return checkout.json().order as OrderRecord;
    };

    const pendingOrder = await placeOrder(fixture.product);
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 3);
    const otherCustomerCancellation = await fixture.app.inject({
      method: "POST",
      url: `/orders/${pendingOrder.id}/cancel`,
      headers: { origin, cookie: fixture.secondCustomerCookie },
    });
    assert.equal(otherCustomerCancellation.statusCode, 404);
    const cancelled = await fixture.app.inject({
      method: "POST",
      url: `/orders/${pendingOrder.id}/cancel`,
      headers: { origin, cookie: fixture.customerCookie },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().order.status, "CANCELLED");
    assert.equal(cancelled.json().order.items[0].sellerStatus, "CANCELLED");
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 5);
    const customerOrdersAfterCancellation = await fixture.app.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.customerCookie },
    });
    assert.equal(customerOrdersAfterCancellation.json().orders[0].status, "CANCELLED");
    const sellerOrdersAfterCancellation = await fixture.app.inject({
      method: "GET",
      url: "/seller/orders",
      headers: { cookie: fixture.sellerCookie },
    });
    assert.equal(sellerOrdersAfterCancellation.json().orders[0].status, "CANCELLED");
    assert.equal(
      sellerOrdersAfterCancellation.json().orders[0].items[0].sellerStatus,
      "CANCELLED",
    );
    const duplicateCancellation = await fixture.app.inject({
      method: "POST",
      url: `/orders/${pendingOrder.id}/cancel`,
      headers: { origin, cookie: fixture.customerCookie },
    });
    assert.equal(duplicateCancellation.statusCode, 409);
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 5);

    const confirmedOrder = await placeOrder(fixture.product);
    const confirmed = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${confirmedOrder.id}/items/${confirmedOrder.items[0].id}/status`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { status: "CONFIRMED" },
    });
    assert.equal(confirmed.statusCode, 200);
    const cancelledConfirmedOrder = await fixture.app.inject({
      method: "POST",
      url: `/orders/${confirmedOrder.id}/cancel`,
      headers: { origin, cookie: fixture.customerCookie },
    });
    assert.equal(cancelledConfirmedOrder.statusCode, 200);
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 5);

    const shippedProduct: ProductRecord = {
      ...fixture.product,
      id: randomUUID(),
      sku: `TEST-${randomUUID()}`,
      stock: 2,
    };
    await fixture.repository.createProduct(shippedProduct);
    const shippedOrder = await placeOrder(shippedProduct);
    for (const status of ["CONFIRMED", "SHIPPED"] as const) {
      const update = await fixture.app.inject({
        method: "PATCH",
        url: `/seller/orders/${shippedOrder.id}/items/${shippedOrder.items[0].id}/status`,
        headers: { origin, cookie: fixture.sellerCookie },
        payload: { status },
      });
      assert.equal(update.statusCode, 200);
    }
    const shippedCancellation = await fixture.app.inject({
      method: "POST",
      url: `/orders/${shippedOrder.id}/cancel`,
      headers: { origin, cookie: fixture.customerCookie },
    });
    assert.equal(shippedCancellation.statusCode, 409);
    assert.equal((await fixture.repository.getProduct(shippedProduct.id))?.stock, 0);
  } finally {
    await fixture.app.close();
  }
});

test("legacy seller orders default missing item status and remain scoped to owned items", async () => {
  const fixture = await createLocalWorkflowFixture(5);
  try {
    const secondSeller: UserRecord = {
      id: randomUUID(),
      email: `${randomUUID()}@seller.example.test`,
      passwordHash: await hashPassword(testPassword),
      roles: ["seller"],
      storeId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const secondStoreId = secondSeller.storeId!;
    const createdAt = new Date().toISOString();
    await fixture.repository.createUser(secondSeller);
    fixture.repository.seedStore({
      id: secondStoreId,
      ownerUserId: secondSeller.id,
      name: "Second approved test store",
      status: "approved",
      createdAt,
    });
    fixture.repository.seedSellerVerification({
      storeId: secondStoreId,
      ownerUserId: secondSeller.id,
      status: "APPROVED",
      encryptedData: verificationProtector.encrypt({
        legalName: "Second test seller",
        tradeName: "Second approved shop",
        businessType: "PROPRIETORSHIP",
        gstRegistration: "NOT_REQUIRED",
        gstin: null,
        pan: "ZZZZZ0000Z",
        address: "12 Test Market Road",
        state: "Maharashtra",
        city: "Mumbai",
        pinCode: "400001",
      }),
      documents: [],
      history: [{ status: "APPROVED", actorUserId: fixture.admin.id, createdAt }],
      createdAt,
      updatedAt: createdAt,
    });
    const secondProduct: ProductRecord = {
      ...structuredClone(fixture.product),
      id: randomUUID(),
      sellerId: secondSeller.id,
      storeId: secondStoreId,
      title: "Second seller test product",
      sku: `TEST-${randomUUID()}`,
      stock: 5,
    };
    await fixture.repository.createProduct(secondProduct);
    const secondSellerLogin = await fixture.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin },
      payload: { email: secondSeller.email, password: testPassword },
    });
    assert.equal(secondSellerLogin.statusCode, 200);
    const secondSellerCookie = cookieFrom(secondSellerLogin);

    const cart = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        items: [
          { productId: fixture.product.id, quantity: 1 },
          { productId: secondProduct.id, quantity: 1 },
        ],
      },
    });
    assert.equal(cart.statusCode, 200);
    const checkout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery: {
          recipientName: "Test Customer",
          phone: "+919876543210",
          address: "12 Test Road, Sample Neighborhood",
          city: "Mumbai",
          state: "Maharashtra",
          pinCode: "400001",
        },
      },
    });
    assert.equal(checkout.statusCode, 200);
    const orderId = checkout.json().order.id as string;
    const firstItemId = checkout.json().order.items.find(
      (item: OrderRecord["items"][number]) => item.sellerId === fixture.seller.id,
    ).id as string;
    const secondItemId = checkout.json().order.items.find(
      (item: OrderRecord["items"][number]) => item.sellerId === secondSeller.id,
    ).id as string;
    fixture.repository.removeSellerStatusesFromOrder(orderId);
    const persistedOrder = await fixture.repository.getOrder(orderId);
    const persistedProduct = await fixture.repository.getProduct(fixture.product.id);
    assert.ok(persistedOrder);
    assert.ok(persistedProduct);
    assert.equal(persistedProduct.status, "active");
    assert.equal(persistedOrder.items[0].sellerStatus, undefined);
    assert.equal(persistedOrder.items[0].sellerId, persistedProduct.sellerId);
    assert.equal(persistedOrder.items[0].storeId, persistedProduct.storeId);
    assert.equal(persistedProduct.storeId, fixture.seller.storeId);

    const sellerOrders = await fixture.app.inject({
      method: "GET",
      url: "/seller/orders",
      headers: { cookie: fixture.sellerCookie },
    });
    assert.equal(sellerOrders.statusCode, 200);
    assert.equal(sellerOrders.json().orders.length, 1);
    assert.deepEqual(
      sellerOrders.json().orders[0].items.map((item: { id: string }) => item.id),
      [firstItemId],
    );
    assert.equal(sellerOrders.json().orders[0].items[0].sellerStatus, "PENDING");
    const secondSellerOrders = await fixture.app.inject({
      method: "GET",
      url: "/seller/orders",
      headers: { cookie: secondSellerCookie },
    });
    assert.deepEqual(
      secondSellerOrders.json().orders[0].items.map((item: { id: string }) => item.id),
      [secondItemId],
    );
    assert.equal(secondSellerOrders.json().orders[0].items[0].sellerStatus, "PENDING");

    const crossSellerUpdate = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${orderId}/items/${firstItemId}/status`,
      headers: { origin, cookie: secondSellerCookie },
      payload: { status: "CONFIRMED" },
    });
    assert.equal(crossSellerUpdate.statusCode, 404);
    const skipPending = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${orderId}/items/${firstItemId}/status`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { status: "SHIPPED" },
    });
    assert.equal(skipPending.statusCode, 409);

    for (const status of [
      "CONFIRMED",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ] as const) {
      const updated = await fixture.app.inject({
        method: "PATCH",
        url: `/seller/orders/${orderId}/items/${firstItemId}/status`,
        headers: { origin, cookie: fixture.sellerCookie },
        payload: { status },
      });
      assert.equal(updated.statusCode, 200);
      assert.deepEqual(
        updated.json().order.items.map((item: { id: string }) => item.id),
        [firstItemId],
      );
      assert.equal(updated.json().order.status, status);
      assert.equal(updated.json().order.items[0].sellerStatus, status);
      const customerOrders = await fixture.app.inject({
        method: "GET",
        url: "/orders",
        headers: { cookie: fixture.customerCookie },
      });
      assert.equal(customerOrders.statusCode, 200);
      const visibleOrder = customerOrders.json().orders.find(
        (entry: OrderRecord) => entry.id === orderId,
      );
      assert.ok(visibleOrder);
      assert.equal(visibleOrder.items.find(
        (entry: OrderRecord["items"][number]) => entry.id === firstItemId,
      )?.sellerStatus, status);
      assert.equal(
        visibleOrder.items.find(
          (entry: OrderRecord["items"][number]) => entry.id === firstItemId,
        )?.sellerStatusHistory?.at(-1)?.status,
        status,
      );
    }

    for (const status of [
      "CONFIRMED",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ] as const) {
      const updated = await fixture.app.inject({
        method: "PATCH",
        url: `/seller/orders/${orderId}/items/${secondItemId}/status`,
        headers: { origin, cookie: secondSellerCookie },
        payload: { status },
      });
      assert.equal(updated.statusCode, 200);
      const customerOrders = await fixture.app.inject({
        method: "GET",
        url: "/orders",
        headers: { cookie: fixture.customerCookie },
      });
      const visibleOrder = customerOrders.json().orders.find(
        (entry: OrderRecord) => entry.id === orderId,
      );
      assert.equal(visibleOrder.status, status);
    }
    const sellerDeliveredReturn = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${firstItemId}/returns`,
      headers: { origin, cookie: fixture.customerCookie },
      payload: { reason: "Seller marked the item as delivered" },
    });
    assert.equal(sellerDeliveredReturn.statusCode, 200);

    const secondCart = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 1 }] },
    });
    assert.equal(secondCart.statusCode, 200);
    const secondCheckout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery: {
          recipientName: "Test Customer",
          phone: "+919876543210",
          address: "12 Test Road, Sample Neighborhood",
          city: "Mumbai",
          state: "Maharashtra",
          pinCode: "400001",
        },
      },
    });
    assert.equal(secondCheckout.statusCode, 200);
    const cancellableOrderId = secondCheckout.json().order.id as string;
    const cancellableItemId = secondCheckout.json().order.items[0].id as string;
    const cancelled = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${cancellableOrderId}/items/${cancellableItemId}/status`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { status: "CANCELLED" },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().order.items[0].sellerStatus, "CANCELLED");
    const cannotRevive = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${cancellableOrderId}/items/${cancellableItemId}/status`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { status: "CONFIRMED" },
    });
    assert.equal(cannotRevive.statusCode, 409);

    const adminOrders = await fixture.app.inject({
      method: "GET",
      url: "/admin/orders",
      headers: { cookie: fixture.adminCookie },
    });
    assert.equal(adminOrders.statusCode, 200);
    assert.equal(adminOrders.json().orders.length, 2);
    assert.equal(
      adminOrders.json().orders.find((order: OrderRecord) => order.id === orderId).items.length,
      2,
    );
  } finally {
    await fixture.app.close();
  }
});

test("local checkout decrements inventory safely when customers race for stock", async () => {
  const fixture = await createLocalWorkflowFixture(1);
  try {
    for (const cookie of [fixture.customerCookie, fixture.secondCustomerCookie]) {
      const cart = await fixture.app.inject({
        method: "PUT",
        url: "/cart",
        headers: { origin, cookie },
        payload: { items: [{ productId: fixture.product.id, quantity: 1 }] },
      });
      assert.equal(cart.statusCode, 200);
    }
    const checkout = (cookie: string) =>
      fixture.app.inject({
        method: "POST",
        url: "/checkout",
        headers: { origin, cookie },
        payload: {
          idempotencyKey: randomUUID(),
          delivery: {
            recipientName: "Test Customer",
            phone: "+919876543210",
            address: "12 Test Road, Sample Neighborhood",
            city: "Mumbai",
            state: "Maharashtra",
            pinCode: "400001",
          },
        },
      });
    const results = await Promise.all([
      checkout(fixture.customerCookie),
      checkout(fixture.secondCustomerCookie),
    ]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
    assert.equal((await fixture.repository.getProduct(fixture.product.id))?.stock, 0);
    const orders = [
      ...(await fixture.repository.listCustomerOrders(fixture.customer.id)),
      ...(await fixture.repository.listCustomerOrders(fixture.secondCustomer.id)),
    ];
    assert.equal(orders.length, 1);
  } finally {
    await fixture.app.close();
  }
});

test("local item return requests enforce ownership without issuing refunds", async () => {
  const fixture = await createLocalWorkflowFixture(4);
  try {
    const cart = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 1 }] },
    });
    assert.equal(cart.statusCode, 200);
    const checkout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery: {
          recipientName: "Test Customer",
          phone: "+919876543210",
          address: "12 Test Road, Sample Neighborhood",
          city: "Mumbai",
          state: "Maharashtra",
          pinCode: "400001",
        },
      },
    });
    assert.equal(checkout.statusCode, 200);
    const orderId = checkout.json().order.id as string;
    const itemId = checkout.json().order.items[0].id as string;

    const beforeDelivery = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: { origin, cookie: fixture.customerCookie },
      payload: { reason: "Changed my mind after delivery" },
    });
    assert.equal(beforeDelivery.statusCode, 409);
    const otherOwnerRequest = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: { origin, cookie: fixture.secondCustomerCookie },
      payload: { reason: "This is not my order" },
    });
    assert.equal(otherOwnerRequest.statusCode, 404);
    const sellerStatusAttempt = await fixture.app.inject({
      method: "PATCH",
      url: `/admin/orders/${orderId}/status`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { status: "CONFIRMED" },
    });
    assert.equal(sellerStatusAttempt.statusCode, 403);
    const customerStatusAttempt = await fixture.app.inject({
      method: "PATCH",
      url: `/admin/orders/${orderId}/status`,
      headers: { origin, cookie: fixture.customerCookie },
      payload: { status: "CONFIRMED" },
    });
    assert.equal(customerStatusAttempt.statusCode, 403);
    const invalidStatus = await fixture.app.inject({
      method: "PATCH",
      url: `/admin/orders/${orderId}/status`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "delivered" },
    });
    assert.equal(invalidStatus.statusCode, 400);
    const skippedTransition = await fixture.app.inject({
      method: "PATCH",
      url: `/admin/orders/${orderId}/status`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "DELIVERED" },
    });
    assert.equal(skippedTransition.statusCode, 409);

    for (const status of ["CONFIRMED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      const updated = await fixture.app.inject({
        method: "PATCH",
        url: `/admin/orders/${orderId}/status`,
        headers: { origin, cookie: fixture.adminCookie },
        payload: { status },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().order.status, status);
    }
    const repeatedStatus = await fixture.app.inject({
      method: "PATCH",
      url: `/admin/orders/${orderId}/status`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "CANCELLED" },
    });
    assert.equal(repeatedStatus.statusCode, 409);

    const secondCart = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 1 }] },
    });
    assert.equal(secondCart.statusCode, 200);
    const secondCheckout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery: {
          recipientName: "Test Customer",
          phone: "+919876543210",
          address: "12 Test Road, Sample Neighborhood",
          city: "Mumbai",
          state: "Maharashtra",
          pinCode: "400001",
        },
      },
    });
    assert.equal(secondCheckout.statusCode, 200);
    const cancelledOrderId = secondCheckout.json().order.id as string;
    const cancelled = await fixture.app.inject({
      method: "PATCH",
      url: `/admin/orders/${cancelledOrderId}/status`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "CANCELLED" },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().order.status, "CANCELLED");
    const cannotReviveCancelledOrder = await fixture.app.inject({
      method: "PATCH",
      url: `/admin/orders/${cancelledOrderId}/status`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "CONFIRMED" },
    });
    assert.equal(cannotReviveCancelledOrder.statusCode, 409);

    const damagePhoto = await sharp({
      create: {
        width: 3,
        height: 3,
        channels: 3,
        background: { r: 170, g: 25, b: 25 },
      },
    })
      .jpeg()
      .toBuffer();
    const pngDamagePhoto = await sharp(damagePhoto).png().toBuffer();
    const webpDamagePhoto = await sharp(damagePhoto).webp().toBuffer();
    const missingReturnReason = await fixture.app.inject({
    method: "POST",
    url: `/orders/${orderId}/items/${itemId}/returns`,
    headers: { origin, cookie: fixture.customerCookie },
    payload: {},
    });
    assert.equal(missingReturnReason.statusCode, 400);
    const invalidPhotoUpload = await multipartReturn(
      "The item arrived with a damaged edge",
      [{ bytes: Buffer.from("not actually an image"), mimeType: "image/jpeg" }],
    );
    const invalidPhotoResponse = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: {
        origin,
        cookie: fixture.customerCookie,
        "content-type": invalidPhotoUpload.contentType,
      },
      payload: invalidPhotoUpload.payload,
    });
    assert.equal(invalidPhotoResponse.statusCode, 400);
    assert.match(invalidPhotoResponse.json().error, /valid JPEG, PNG, or WebP/i);

    const oversizedPhotoUpload = await multipartReturn(
      "The item arrived with a damaged edge",
      [{ bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: "image/png" }],
    );
    const oversizedPhotoResponse = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: {
        origin,
        cookie: fixture.customerCookie,
        "content-type": oversizedPhotoUpload.contentType,
      },
      payload: oversizedPhotoUpload.payload,
    });
    assert.equal(oversizedPhotoResponse.statusCode, 413);
    assert.match(oversizedPhotoResponse.json().error, /5 MB or smaller/i);

    const tooManyPhotosUpload = await multipartReturn(
      "The item arrived with a damaged edge",
      Array.from({ length: 6 }, () => ({
        bytes: pngDamagePhoto,
        mimeType: "image/png",
      })),
    );
    const tooManyPhotosResponse = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: {
        origin,
        cookie: fixture.customerCookie,
        "content-type": tooManyPhotosUpload.contentType,
      },
      payload: tooManyPhotosUpload.payload,
    });
    assert.equal(tooManyPhotosResponse.statusCode, 400);
    assert.match(tooManyPhotosResponse.json().error, /no more than 5/i);

    const returnUpload = await multipartReturn(
      "The item arrived with a damaged edge",
      [
        { bytes: damagePhoto, mimeType: "image/png" },
        { bytes: pngDamagePhoto, mimeType: "image/jpeg" },
        { bytes: webpDamagePhoto, mimeType: "application/octet-stream" },
      ],
    );
    const returnResponse = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: {
        origin,
        cookie: fixture.customerCookie,
        "content-type": returnUpload.contentType,
      },
      payload: returnUpload.payload,
    });
    assert.equal(returnResponse.statusCode, 200);
    const returnId = returnResponse.json().returnRequest.id as string;
    assert.equal(returnResponse.json().returnRequest.status, "REQUESTED");
    assert.equal(returnResponse.json().returnRequest.refundStatus, "NOT_APPLICABLE");
    assert.equal(returnResponse.json().returnRequest.images.length, 3);
    assert.equal(
      "objectKey" in returnResponse.json().returnRequest.images[0],
      false,
    );
    const repeatedReturn = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: { origin, cookie: fixture.customerCookie },
      payload: { reason: "Submitting a second request" },
    });
    assert.equal(repeatedReturn.statusCode, 409);
    const sellerReview = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${orderId}/returns/${returnId}/review`,
      headers: { origin, cookie: fixture.secondSellerCookie },
      payload: {
        decision: "ACCEPTED",
        reason: "Not this seller's order item",
      },
    });
    assert.equal(sellerReview.statusCode, 404);
    const customerSellerReview = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${orderId}/returns/${returnId}/review`,
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        decision: "ACCEPTED",
        reason: "Customer cannot act as seller",
      },
    });
    assert.equal(customerSellerReview.statusCode, 403);
    const sellerReturns = await fixture.app.inject({
      method: "GET",
      url: "/seller/orders",
      headers: { cookie: fixture.sellerCookie },
    });
    const sellerReturn = sellerReturns
      .json()
      .orders.flatMap((entry: OrderRecord) => entry.returns)
      .find((entry: OrderReturnRecord) => entry.id === returnId);
    assert.ok(sellerReturn);
    assert.equal(sellerReturn.images.length, 3);
    for (const returnPhoto of sellerReturn.images) {
      const photoUrl = returnPhoto.url as string;
      for (const cookie of [
        fixture.customerCookie,
        fixture.sellerCookie,
        fixture.adminCookie,
      ]) {
        const photo = await fixture.app.inject({
          method: "GET",
          url: photoUrl,
          headers: { cookie },
        });
        assert.equal(photo.statusCode, 200);
        assert.equal(photo.headers["content-type"], "image/webp");
        assert.ok(photo.rawPayload.length > 0);
      }
    }
    const photoUrl = sellerReturn.images[0].url as string;
    const forbiddenPhoto = await fixture.app.inject({
      method: "GET",
      url: photoUrl,
      headers: { cookie: fixture.secondCustomerCookie },
    });
    assert.equal(forbiddenPhoto.statusCode, 404);

    const sellerAccept = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${orderId}/returns/${returnId}/review`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: {
        decision: "ACCEPTED",
      },
    });
    assert.equal(sellerAccept.statusCode, 200);
    assert.equal(sellerAccept.json().returnRequest.status, "ACCEPTED");
    assert.equal(sellerAccept.json().returnRequest.sellerReviewStatus, "ACCEPTED");
    assert.equal(sellerAccept.json().returnRequest.decisionSource, "SELLER");
    assert.equal(sellerAccept.json().returnRequest.refundStatus, "NOT_APPLICABLE");
    const repeatedSellerDecision = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${orderId}/returns/${returnId}/review`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: {
        decision: "REJECTED",
        reason: "Attempt a conflicting second decision",
      },
    });
    assert.equal(repeatedSellerDecision.statusCode, 409);

    const sellerCannotUseAdminReturnRoute = await fixture.app.inject({
      method: "POST",
      url: `/admin/orders/${orderId}/returns/${returnId}/review`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { status: "ACCEPTED", reason: "Unauthorized review attempt" },
    });
    assert.equal(sellerCannotUseAdminReturnRoute.statusCode, 404);
    const adminCannotDecideReturn = await fixture.app.inject({
      method: "POST",
      url: `/admin/orders/${orderId}/returns/${returnId}/review`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "REJECTED", reason: "Admin cannot decide returns" },
    });
    assert.equal(adminCannotDecideReturn.statusCode, 404);
    const customerOrders = await fixture.app.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.customerCookie },
    });
    assert.equal(customerOrders.json().orders[0].status, "DELIVERED");
    assert.equal(customerOrders.json().orders[0].returns[0].status, "ACCEPTED");
    assert.equal(
      customerOrders.json().orders[0].returns[0].sellerReviewStatus,
      "ACCEPTED",
    );
    assert.equal(
      customerOrders.json().orders[0].returns[0].refundStatus,
      "NOT_APPLICABLE",
    );
    const sellerAfterDecision = await fixture.app.inject({
      method: "GET",
      url: "/seller/orders",
      headers: { cookie: fixture.sellerCookie },
    });
    const acceptedSellerReturn = sellerAfterDecision
      .json()
      .orders.flatMap((entry: OrderRecord) => entry.returns)
      .find((entry: OrderReturnRecord) => entry.id === returnId);
    assert.equal(acceptedSellerReturn.status, "ACCEPTED");
    assert.equal(acceptedSellerReturn.decisionSource, "SELLER");
    assert.ok(acceptedSellerReturn.sellerReviewedAt);
    const adminOrdersWithReturn = await fixture.app.inject({
      method: "GET",
      url: "/admin/orders",
      headers: { cookie: fixture.adminCookie },
    });
    const adminReturn = adminOrdersWithReturn
      .json()
      .orders.flatMap((entry: OrderRecord) => entry.returns)
      .find((entry: OrderReturnRecord) => entry.id === returnId);
    assert.equal(adminReturn.status, "ACCEPTED");
    assert.equal(adminReturn.images.length, 3);
    const outsideWorkflow = await createApp({
      repository: fixture.repository,
      webOrigin: origin,
      secureCookies: false,
    });
    await outsideWorkflow.ready();
    try {
      const adminOrders = await outsideWorkflow.inject({
        method: "GET",
        url: "/admin/orders",
        headers: { origin, cookie: fixture.adminCookie },
      });
      assert.equal(adminOrders.statusCode, 200);
      assert.equal(adminOrders.json().returnTestingEnabled, false);
      assert.equal(adminOrders.json().orders[0].status, "DELIVERED");
      const localCartDisabled = await outsideWorkflow.inject({
        method: "PUT",
        url: "/cart",
        headers: { origin, cookie: fixture.customerCookie },
        payload: { items: [] },
      });
      assert.equal(localCartDisabled.statusCode, 200);
      assert.deepEqual(localCartDisabled.json().cart.items, []);
      const paymentNotConfigured = await outsideWorkflow.inject({
        method: "POST",
        url: "/checkout",
        headers: { origin, cookie: fixture.customerCookie },
        payload: {
          idempotencyKey: randomUUID(),
          delivery: {
            recipientName: "Test Customer",
            phone: "+919876543210",
            address: "12 Test Road, Sample Neighborhood",
            city: "Mumbai",
            state: "Maharashtra",
            pinCode: "400001",
          },
        },
      });
      assert.equal(paymentNotConfigured.statusCode, 503);
    } finally {
      await outsideWorkflow.close();
    }
  } finally {
    await fixture.app.close();
  }
});

test("seller rejection and acceptance are immediate; Super Admin is read-only", async () => {
  const fixture = await createLocalWorkflowFixture(4, {
  });
  try {
    const createDeliveredReturn = async () => {
      const cart = await fixture.app.inject({
        method: "PUT",
        url: "/cart",
        headers: { origin, cookie: fixture.customerCookie },
        payload: { items: [{ productId: fixture.product.id, quantity: 1 }] },
      });
      assert.equal(cart.statusCode, 200);
      const checkout = await fixture.app.inject({
        method: "POST",
        url: "/checkout",
        headers: { origin, cookie: fixture.customerCookie },
        payload: {
          idempotencyKey: randomUUID(),
          delivery: {
            recipientName: "Test Customer",
            phone: "+919876543210",
            address: "12 Test Road, Sample Neighborhood",
            city: "Mumbai",
            state: "Maharashtra",
            pinCode: "400001",
          },
        },
      });
      assert.equal(checkout.statusCode, 200, checkout.body);
      const orderId = checkout.json().order.id as string;
      const itemId = checkout.json().order.items[0].id as string;
      for (const status of [
        "CONFIRMED",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
      ] as const) {
        const update = await fixture.app.inject({
          method: "PATCH",
          url: `/seller/orders/${orderId}/items/${itemId}/status`,
          headers: { origin, cookie: fixture.sellerCookie },
          payload: { status },
        });
        assert.equal(update.statusCode, 200);
      }
      const requested = await fixture.app.inject({
        method: "POST",
        url: `/orders/${orderId}/items/${itemId}/returns`,
        headers: { origin, cookie: fixture.customerCookie },
        payload: { reason: "The delivered item needs a return review" },
      });
      assert.equal(requested.statusCode, 200);
      return {
        orderId,
        returnId: requested.json().returnRequest.id as string,
      };
    };

    const sellerRejected = await createDeliveredReturn();
    const returnedOrderCancellation = await fixture.app.inject({
      method: "POST",
      url: `/orders/${sellerRejected.orderId}/cancel`,
      headers: { origin, cookie: fixture.customerCookie },
    });
    assert.equal(returnedOrderCancellation.statusCode, 409);
    const unauthorizedSellerReview = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${sellerRejected.orderId}/returns/${sellerRejected.returnId}/review`,
      headers: { origin, cookie: fixture.secondSellerCookie },
      payload: { decision: "REJECTED", reason: "Not this seller's item" },
    });
    assert.equal(unauthorizedSellerReview.statusCode, 404);
    const missingRejectionReason = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${sellerRejected.orderId}/returns/${sellerRejected.returnId}/review`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { decision: "REJECTED" },
    });
    assert.equal(missingRejectionReason.statusCode, 400);
    const rejected = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${sellerRejected.orderId}/returns/${sellerRejected.returnId}/review`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: {
        decision: "REJECTED",
        reason: "The item does not meet the return policy",
      },
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().returnRequest.status, "REJECTED");
    assert.equal(rejected.json().returnRequest.sellerReviewStatus, "REJECTED");
    const customerAfterSellerRejection = await fixture.app.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.customerCookie },
    });
    const customerRejectedReturn = customerAfterSellerRejection
      .json()
      .orders.flatMap((order: OrderRecord) => order.returns)
      .find((entry: OrderReturnRecord) => entry.id === sellerRejected.returnId);
    assert.equal(customerRejectedReturn.status, "REJECTED");
    assert.equal(customerRejectedReturn.decisionSource, "SELLER");
    assert.equal(
      customerRejectedReturn.sellerReviewReason,
      "The item does not meet the return policy",
    );
    assert.ok(customerRejectedReturn.sellerReviewedAt);
    const adminAfterSellerRejection = await fixture.app.inject({
      method: "GET",
      url: "/admin/orders",
      headers: { cookie: fixture.adminCookie },
    });
    const adminSellerRejected = adminAfterSellerRejection
      .json()
      .orders.flatMap((order: OrderRecord) => order.returns)
      .find((entry: OrderReturnRecord) => entry.id === sellerRejected.returnId);
    assert.equal(adminSellerRejected.status, "REJECTED");
    assert.equal(adminSellerRejected.sellerReviewStatus, "REJECTED");
    const adminCannotReviewSellerRejection = await fixture.app.inject({
      method: "POST",
      url: `/admin/orders/${sellerRejected.orderId}/returns/${sellerRejected.returnId}/review`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "ACCEPTED" },
    });
    assert.equal(adminCannotReviewSellerRejection.statusCode, 404);

    const adminRejected = await createDeliveredReturn();
    const sellerApproval = await fixture.app.inject({
      method: "PATCH",
      url: `/seller/orders/${adminRejected.orderId}/returns/${adminRejected.returnId}/review`,
      headers: { origin, cookie: fixture.sellerCookie },
      payload: { decision: "ACCEPTED" },
    });
    assert.equal(sellerApproval.statusCode, 200);
    assert.equal(sellerApproval.json().returnRequest.status, "ACCEPTED");
    assert.equal(sellerApproval.json().returnRequest.sellerReviewStatus, "ACCEPTED");
    const adminCannotChangeAccepted = await fixture.app.inject({
      method: "POST",
      url: `/admin/orders/${adminRejected.orderId}/returns/${adminRejected.returnId}/review`,
      headers: { origin, cookie: fixture.adminCookie },
      payload: { status: "REJECTED", reason: "Admin cannot decide returns" },
    });
    assert.equal(adminCannotChangeAccepted.statusCode, 404);
    const customerAfterSellerAcceptance = await fixture.app.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.customerCookie },
    });
    const customerSellerAccepted = customerAfterSellerAcceptance
      .json()
      .orders.flatMap((order: OrderRecord) => order.returns)
      .find((entry: OrderReturnRecord) => entry.id === adminRejected.returnId);
    assert.equal(customerSellerAccepted.status, "ACCEPTED");
    assert.equal(customerSellerAccepted.decisionSource, "SELLER");
    assert.equal(customerSellerAccepted.refundStatus, "NOT_APPLICABLE");
    assert.ok(customerSellerAccepted.sellerReviewedAt);
    const adminOrders = await fixture.app.inject({
      method: "GET",
      url: "/admin/orders",
      headers: { cookie: fixture.adminCookie },
    });
    const adminCanMonitor = adminOrders
      .json()
      .orders.flatMap((order: OrderRecord) => order.returns)
      .find((entry: OrderReturnRecord) => entry.id === adminRejected.returnId);
    assert.equal(adminCanMonitor.status, "ACCEPTED");
  } finally {
    await fixture.app.close();
  }
});

test("expired seller return requests are automatically accepted once without refund", async () => {
  const fixture = await createLocalWorkflowFixture(2);
  try {
    const cart = await fixture.app.inject({
      method: "PUT",
      url: "/cart",
      headers: { origin, cookie: fixture.customerCookie },
      payload: { items: [{ productId: fixture.product.id, quantity: 1 }] },
    });
    assert.equal(cart.statusCode, 200);
    const checkout = await fixture.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { origin, cookie: fixture.customerCookie },
      payload: {
        idempotencyKey: randomUUID(),
        delivery: {
          recipientName: "Test Customer",
          phone: "+919876543210",
          address: "12 Test Road, Sample Neighborhood",
          city: "Mumbai",
          state: "Maharashtra",
          pinCode: "400001",
        },
      },
    });
    assert.equal(checkout.statusCode, 200, checkout.body);
    const orderId = checkout.json().order.id as string;
    const itemId = checkout.json().order.items[0].id as string;
    for (const status of [
      "CONFIRMED",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ] as const) {
      const update = await fixture.app.inject({
        method: "PATCH",
        url: `/seller/orders/${orderId}/items/${itemId}/status`,
        headers: { origin, cookie: fixture.sellerCookie },
        payload: { status },
      });
      assert.equal(update.statusCode, 200);
    }
    const request = await fixture.app.inject({
      method: "POST",
      url: `/orders/${orderId}/items/${itemId}/returns`,
      headers: { origin, cookie: fixture.customerCookie },
      payload: { reason: "The delivered product has a damaged seam" },
    });
    assert.equal(request.statusCode, 200);
    const returnId = request.json().returnRequest.id as string;
    const requestDeadline = Date.parse(request.json().returnRequest.sellerResponseDeadlineAt);
    assert.ok(requestDeadline >= Date.now() + 23 * 60 * 60 * 1000);
    assert.ok(requestDeadline <= Date.now() + 25 * 60 * 60 * 1000);
    fixture.repository.setReturnDeadline(
      orderId,
      returnId,
      new Date(Date.now() - 1000).toISOString(),
    );
    const processingNow = new Date().toISOString();
    assert.equal(
      await fixture.repository.processExpiredReturnRequests(processingNow),
      1,
    );
    assert.equal(
      await fixture.repository.processExpiredReturnRequests(processingNow),
      0,
    );
    assert.equal(
      fixture.repository.returnAuditEvents.filter(
        (event) => event.returnId === returnId &&
          event.action === "order.return.system_auto_accepted",
      ).length,
      1,
    );
    const customerOrders = await fixture.app.inject({
      method: "GET",
      url: "/orders",
      headers: { cookie: fixture.customerCookie },
    });
    const acceptedReturn = customerOrders.json().orders[0].returns[0];
    assert.equal(acceptedReturn.status, "ACCEPTED");
    assert.equal(acceptedReturn.sellerReviewStatus, "SYSTEM_AUTO_ACCEPTED");
    assert.equal(acceptedReturn.decisionSource, "SYSTEM_AUTO_ACCEPTED");
    assert.equal(acceptedReturn.refundStatus, "NOT_APPLICABLE");
    assert.ok(acceptedReturn.sellerReviewedAt);
  } finally {
    await fixture.app.close();
  }
});

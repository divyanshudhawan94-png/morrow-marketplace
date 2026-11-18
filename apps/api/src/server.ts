import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { DynamoAuthRepository } from "./dynamodb-repository.js";
import {
  createLocalDevelopmentProductImageStorage,
  createR2ProductImageStorage,
  LocalFilesystemProductImageStorage,
} from "./product-image-storage.js";
import {
  createLocalSellerVerificationProtector,
  createPrivateSellerDocumentStorage,
  createSellerVerificationProtector,
  LocalFilesystemSellerDocumentStorage,
} from "./seller-verification.js";
import {
  createLocalKycConfig,
  createLocalWorkflowConfig,
  isLocalDevelopmentCustomerOtpEnabled,
  isLocalDevelopmentCheckoutEnabled,
} from "./local-workflow.js";

const port = Number(process.env.PORT ?? 4000);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

try {
  const tableName = process.env.DYNAMODB_TABLE;
  const localWorkflow = createLocalWorkflowConfig(process.env);
  const localKyc = createLocalKycConfig(process.env);
  const localCheckoutTesting = isLocalDevelopmentCheckoutEnabled(process.env);
  const customerOtpEnabled = isLocalDevelopmentCustomerOtpEnabled(process.env);
  const webOrigin =
    process.env.WEB_ORIGIN ??
    (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000");

  if (!tableName) {
    throw new Error("DYNAMODB_TABLE must name the configured DynamoDB table.");
  }
  if (!webOrigin) {
    throw new Error("WEB_ORIGIN must be configured in production.");
  }

  const allowedImageHosts = (process.env.PRODUCT_IMAGE_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  let localProductImageStorage = localWorkflow
    ? new LocalFilesystemProductImageStorage(
        path.join(localWorkflow.dataDirectory, "product-images"),
        localWorkflow.imagePublicBaseUrl,
      )
    : undefined;
  const r2ProductImageStorage = localWorkflow
    ? undefined
    : createR2ProductImageStorage(process.env, allowedImageHosts);
  if (!localWorkflow && !r2ProductImageStorage) {
    localProductImageStorage = createLocalDevelopmentProductImageStorage(
      process.env,
      projectRoot,
    );
  }
  if (localProductImageStorage && !allowedImageHosts.includes("localhost")) {
    allowedImageHosts.push("localhost");
  }
  const productImageStorage =
    localProductImageStorage ?? r2ProductImageStorage;
  const sellerDocumentStorage = localWorkflow
    ? new LocalFilesystemSellerDocumentStorage(
        path.join(localWorkflow.dataDirectory, "kyc-documents"),
      )
    : localKyc
      ? new LocalFilesystemSellerDocumentStorage(localKyc.documentDirectory)
    : createPrivateSellerDocumentStorage(process.env);
  const sellerVerificationProtector = localWorkflow || localKyc
    ? createLocalSellerVerificationProtector(process.env)
    : createSellerVerificationProtector(process.env);
  const repository = new DynamoAuthRepository(tableName);
  const app = createApp({
    repository,
    webOrigin,
    allowedImageHosts,
    productImageStorage,
    sellerDocumentStorage,
    sellerVerificationProtector,
    localWorkflowTesting: Boolean(localWorkflow),
    localCheckoutTesting,
    localProductImageStorage,
    customerOtpEnabled,
  });
  await app.listen({
    host:
      localWorkflow ||
      localKyc ||
      localProductImageStorage ||
      localCheckoutTesting ||
      customerOtpEnabled
        ? "127.0.0.1"
        : "0.0.0.0",
    port,
  });
  let returnSweepRunning = false;
  const sweepExpiredReturns = async () => {
    if (returnSweepRunning) return;
    returnSweepRunning = true;
    try {
      const processed = await repository.processExpiredReturnRequests(
        new Date().toISOString(),
      );
      if (processed > 0) {
        app.log.info({ processed }, "Automatically accepted expired return requests");
      }
    } catch (error) {
      app.log.error({ err: error }, "Failed to process expired return requests");
    } finally {
      returnSweepRunning = false;
    }
  };
  void sweepExpiredReturns();
  const returnSweepTimer = setInterval(() => void sweepExpiredReturns(), 30_000);
  returnSweepTimer.unref();
} catch (error) {
  console.error("API startup failed:", error);
  process.exitCode = 1;
}

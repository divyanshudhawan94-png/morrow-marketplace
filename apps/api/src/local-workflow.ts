import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalWorkflowConfig {
  dataDirectory: string;
  imagePublicBaseUrl: string;
}

export interface LocalKycConfig {
  documentDirectory: string;
}

export function isLocalDevelopmentCustomerOtpEnabled(
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    env.NODE_ENV !== "development" ||
    !["marketplace-local", "marketplace-workflow-test"].includes(env.DYNAMODB_TABLE ?? "") ||
    env.PORT !== "4000" ||
    env.WEB_ORIGIN !== "http://localhost:3000" ||
    env.NEXT_PUBLIC_API_URL !== "http://localhost:4000"
  ) {
    return false;
  }
  try {
    const endpoint = new URL(env.DYNAMODB_ENDPOINT ?? "");
    return (
      endpoint.protocol === "http:" &&
      endpoint.port === "8000" &&
      endpoint.pathname === "/" &&
      !endpoint.search &&
      !endpoint.hash &&
      !endpoint.username &&
      !endpoint.password &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

export function isLocalDevelopmentCheckoutEnabled(
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    env.NODE_ENV !== "development" ||
    env.DYNAMODB_TABLE !== "marketplace-local" ||
    env.PORT !== "4000" ||
    env.WEB_ORIGIN !== "http://localhost:3000" ||
    env.NEXT_PUBLIC_API_URL !== "http://localhost:4000"
  ) {
    return false;
  }
  try {
    const endpoint = new URL(env.DYNAMODB_ENDPOINT ?? "");
    return (
      endpoint.protocol === "http:" &&
      endpoint.port === "8000" &&
      endpoint.pathname === "/" &&
      !endpoint.search &&
      !endpoint.hash &&
      !endpoint.username &&
      !endpoint.password &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

export function createLocalWorkflowConfig(
  env: NodeJS.ProcessEnv,
): LocalWorkflowConfig | undefined {
  const enabled = env.LOCAL_WORKFLOW_TESTING?.trim();
  const localKycStorage = env.LOCAL_KYC_STORAGE?.trim();
  if (localKycStorage && localKycStorage !== "true" && localKycStorage !== "false") {
    throw new Error("LOCAL_KYC_STORAGE must be true or false.");
  }
  const localOnlySettings =
    Boolean(env.LOCAL_KYC_TEST_KEY?.trim()) && localKycStorage !== "true";

  if (enabled !== "true") {
    if (localOnlySettings) {
      throw new Error(
        "LOCAL_KYC_TEST_KEY requires LOCAL_KYC_STORAGE=true or LOCAL_WORKFLOW_TESTING=true.",
      );
    }
    return undefined;
  }
  if (localKycStorage === "true") {
    throw new Error(
      "Use LOCAL_KYC_STORAGE only outside the full local workflow.",
    );
  }
  if (env.NODE_ENV !== "development") {
    throw new Error("The local workflow is available only when NODE_ENV=development.");
  }
  if (env.DYNAMODB_TABLE !== "marketplace-workflow-test") {
    throw new Error(
      "Local workflow requires the dedicated marketplace-workflow-test DynamoDB table.",
    );
  }
  if (env.PORT !== "4000") {
    throw new Error("The local workflow API must use port 4000.");
  }
  if (
    env.WEB_ORIGIN !== "http://localhost:3000" ||
    env.NEXT_PUBLIC_API_URL !== "http://localhost:4000"
  ) {
    throw new Error(
      "Local workflow requires the localhost web origin and API URL on ports 3000 and 4000.",
    );
  }
  if (env.KYC_DATA_ENCRYPTION_KEY?.trim()) {
    throw new Error(
      "Use LOCAL_KYC_TEST_KEY for local testing; do not load the production KYC key.",
    );
  }
  const localTestKey = env.LOCAL_KYC_TEST_KEY?.trim();
  if (!localTestKey || !/^[a-f0-9]{64}$/i.test(localTestKey)) {
    throw new Error(
      "LOCAL_KYC_TEST_KEY must be a dedicated 32-byte hexadecimal test key.",
    );
  }

  const endpointText = env.DYNAMODB_ENDPOINT?.trim();
  if (!endpointText) {
    throw new Error("Local workflow requires DYNAMODB_ENDPOINT for DynamoDB Local.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new Error("DYNAMODB_ENDPOINT must be a loopback HTTP URL for local testing.");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.port !== "8000" ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("DYNAMODB_ENDPOINT must use a loopback HTTP address.");
  }

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDirectory, "../../..");
  const dataDirectory = path.join(projectRoot, ".local-workflow-data");
  const publicDirectory = path.resolve(projectRoot, "apps/web/public");
  const relativeToPublic = path.relative(publicDirectory, dataDirectory);
  if (
    relativeToPublic === "" ||
    (!relativeToPublic.startsWith(`..${path.sep}`) &&
      relativeToPublic !== ".." &&
      !path.isAbsolute(relativeToPublic))
  ) {
    throw new Error("Local workflow data must be outside the web public directory.");
  }

  return {
    dataDirectory,
    imagePublicBaseUrl: "http://localhost:4000",
  };
}

export function createLocalKycConfig(
  env: NodeJS.ProcessEnv,
): LocalKycConfig | undefined {
  if (env.LOCAL_KYC_STORAGE?.trim() !== "true") return undefined;
  if (env.LOCAL_WORKFLOW_TESTING?.trim() === "true") {
    throw new Error(
      "LOCAL_KYC_STORAGE cannot be combined with LOCAL_WORKFLOW_TESTING.",
    );
  }
  if (env.NODE_ENV !== "development") {
    throw new Error("Local KYC storage is available only when NODE_ENV=development.");
  }
  if (env.DYNAMODB_TABLE !== "marketplace-local") {
    throw new Error(
      "Local KYC storage requires the existing marketplace-local DynamoDB table.",
    );
  }
  if (
    env.PORT !== "4000" ||
    env.WEB_ORIGIN !== "http://localhost:3000" ||
    env.NEXT_PUBLIC_API_URL !== "http://localhost:4000"
  ) {
    throw new Error(
      "Local KYC storage requires the localhost web origin and API URL on ports 3000 and 4000.",
    );
  }
  if (env.KYC_DATA_ENCRYPTION_KEY?.trim() || env.KYC_DOCUMENT_BUCKET?.trim()) {
    throw new Error(
      "Local KYC storage cannot be combined with private AWS KYC settings.",
    );
  }
  const localTestKey = env.LOCAL_KYC_TEST_KEY?.trim();
  if (!localTestKey || !/^[a-f0-9]{64}$/i.test(localTestKey)) {
    throw new Error(
      "LOCAL_KYC_TEST_KEY must be a dedicated 32-byte hexadecimal test key.",
    );
  }

  const endpointText = env.DYNAMODB_ENDPOINT?.trim();
  if (!endpointText) {
    throw new Error("Local KYC storage requires DYNAMODB_ENDPOINT for DynamoDB Local.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new Error("DYNAMODB_ENDPOINT must be a loopback HTTP URL for local KYC storage.");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.port !== "8000" ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("DYNAMODB_ENDPOINT must use a loopback HTTP address.");
  }

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDirectory, "../../..");
  const documentDirectory = path.join(
    projectRoot,
    ".local-workflow-data",
    "kyc-documents",
  );
  const publicDirectory = path.resolve(projectRoot, "apps/web/public");
  const relativeToPublic = path.relative(publicDirectory, documentDirectory);
  if (
    relativeToPublic === "" ||
    (!relativeToPublic.startsWith(`..${path.sep}`) &&
      relativeToPublic !== ".." &&
      !path.isAbsolute(relativeToPublic))
  ) {
    throw new Error("Local KYC documents must be stored outside the web public directory.");
  }

  return { documentDirectory };
}

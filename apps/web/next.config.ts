import type { NextConfig } from "next";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

const { combinedEnv } = loadEnvConfig(
  path.resolve(process.cwd(), "../.."),
  process.env.NODE_ENV === "development",
  undefined,
  true,
);

const imageHosts = (process.env.PRODUCT_IMAGE_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

const endpoint = (() => {
  try {
    return new URL(combinedEnv.DYNAMODB_ENDPOINT ?? "");
  } catch {
    return null;
  }
})();
const localWorkflowImagesEnabled =
  combinedEnv.LOCAL_WORKFLOW_TESTING === "true" &&
  combinedEnv.NODE_ENV === "development" &&
  combinedEnv.DYNAMODB_TABLE === "marketplace-workflow-test" &&
  combinedEnv.WEB_ORIGIN === "http://localhost:3000" &&
  combinedEnv.NEXT_PUBLIC_API_URL === "http://localhost:4000" &&
  !combinedEnv.KYC_DATA_ENCRYPTION_KEY?.trim() &&
  /^[a-f0-9]{64}$/i.test(combinedEnv.LOCAL_KYC_TEST_KEY ?? "") &&
  endpoint?.protocol === "http:" &&
  endpoint.port === "8000" &&
  endpoint.pathname === "/" &&
  !endpoint.search &&
  !endpoint.hash &&
  ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname) &&
  !endpoint.username &&
  !endpoint.password;
const r2ImageVariables = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_BASE_URL",
];
const localDevelopmentProductImagesEnabled =
  process.env.NODE_ENV === "development" &&
  combinedEnv.DYNAMODB_TABLE === "marketplace-local" &&
  combinedEnv.DYNAMODB_ENDPOINT === "http://localhost:8000" &&
  combinedEnv.PORT === "4000" &&
  combinedEnv.WEB_ORIGIN === "http://localhost:3000" &&
  combinedEnv.NEXT_PUBLIC_API_URL === "http://localhost:4000" &&
  r2ImageVariables.every((name) => !combinedEnv[name]?.trim());
const localProductImagesEnabled =
  localWorkflowImagesEnabled || localDevelopmentProductImagesEnabled;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "",
    NEXT_PUBLIC_LOCAL_WORKFLOW_TESTING: localWorkflowImagesEnabled ? "true" : "false",
  },
  images: {
    remotePatterns: [
      ...imageHosts.map((hostname) => ({
        protocol: "https" as const,
        hostname,
      })),
      ...(localProductImagesEnabled
        ? [{
            protocol: "http" as const,
            hostname: "localhost",
            port: "4000",
            pathname: "/local-product-images/**",
          }]
        : []),
    ],
  },
};

export default nextConfig;

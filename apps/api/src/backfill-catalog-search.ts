import { DynamoAuthRepository } from "./dynamodb-repository.js";

const endpoint = process.env.DYNAMODB_ENDPOINT;
const tableName = process.env.DYNAMODB_TABLE;
if (!tableName) {
  throw new Error("DYNAMODB_TABLE is required.");
}

const isLoopbackEndpoint = endpoint
  ? ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(endpoint).hostname)
  : false;
if (
  !isLoopbackEndpoint &&
  process.env.CATALOG_SEARCH_BACKFILL_CONFIRM !== tableName
) {
  throw new Error(
    "Set CATALOG_SEARCH_BACKFILL_CONFIRM to the exact table name before backfilling a non-local table.",
  );
}

const repository = new DynamoAuthRepository(
  tableName,
  process.env.AWS_REGION ?? "ap-south-1",
  endpoint,
);
const indexedProducts = await repository.backfillCatalogSearchIndex();
console.info(`Indexed ${indexedProducts} active products for catalog search.`);

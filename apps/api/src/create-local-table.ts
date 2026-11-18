import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";

const endpoint = process.env.DYNAMODB_ENDPOINT;
const tableName = process.env.DYNAMODB_TABLE;

if (!endpoint || !tableName) {
  throw new Error("DYNAMODB_ENDPOINT and DYNAMODB_TABLE are required.");
}

const endpointUrl = new URL(endpoint);
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpointUrl.hostname)) {
  throw new Error("The local table setup script only permits loopback endpoints.");
}

const client = new DynamoDBClient({
  endpoint,
  region: process.env.AWS_REGION ?? "ap-south-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

const indexes = [
  {
    name: "GSI1",
    partitionKey: "GSI1PK",
    sortKey: "GSI1SK",
  },
  {
    name: "GSI2",
    partitionKey: "GSI2PK",
    sortKey: "GSI2SK",
  },
  {
    name: "GSI3",
    partitionKey: "GSI3PK",
    sortKey: "GSI3SK",
  },
  {
    name: "GSI4",
    partitionKey: "GSI4PK",
    sortKey: "GSI4SK",
  },
  {
    name: "GSI5",
    partitionKey: "GSI5PK",
    sortKey: "GSI5SK",
  },
  {
    name: "GSI6",
    partitionKey: "GSI6PK",
    sortKey: "GSI6SK",
  },
] as const;

async function ensureCatalogIndexes(): Promise<void> {
  for (const index of indexes) {
    const description = await client.send(
      new DescribeTableCommand({ TableName: tableName }),
    );
    const existing = description.Table?.GlobalSecondaryIndexes?.find(
      (candidate) => candidate.IndexName === index.name,
    );
    if (existing?.IndexStatus === "ACTIVE") continue;
    if (!existing) {
      await client.send(
        new UpdateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [
            { AttributeName: index.partitionKey, AttributeType: "S" },
            { AttributeName: index.sortKey, AttributeType: "S" },
          ],
          GlobalSecondaryIndexUpdates: [
            {
              Create: {
                IndexName: index.name,
                KeySchema: [
                  { AttributeName: index.partitionKey, KeyType: "HASH" },
                  { AttributeName: index.sortKey, KeyType: "RANGE" },
                ],
                Projection: { ProjectionType: "ALL" },
              },
            },
          ],
        }),
      );
    }

    let active = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const current = await client.send(
        new DescribeTableCommand({ TableName: tableName }),
      );
      const status = current.Table?.GlobalSecondaryIndexes?.find(
        (candidate) => candidate.IndexName === index.name,
      )?.IndexStatus;
      if (status === "ACTIVE") {
        active = true;
        break;
      }
      if (status === "DELETING") {
        throw new Error(`DynamoDB index ${index.name} is being deleted.`);
      }
    }
    if (!active) {
      throw new Error(`Timed out while waiting for DynamoDB index ${index.name}.`);
    }
    console.info(`DynamoDB index "${index.name}" is ready.`);
  }
}

try {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          ...indexes.flatMap((index) => [
            { AttributeName: index.partitionKey, AttributeType: "S" as const },
            { AttributeName: index.sortKey, AttributeType: "S" as const },
          ]),
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: indexes.map((index) => ({
          IndexName: index.name,
          KeySchema: [
            { AttributeName: index.partitionKey, KeyType: "HASH" as const },
            { AttributeName: index.sortKey, KeyType: "RANGE" as const },
          ],
          Projection: { ProjectionType: "ALL" as const },
        })),
      }),
    );
    console.info(`Created local DynamoDB table "${tableName}".`);
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) {
      throw error;
    }
    console.info(`Local DynamoDB table "${tableName}" already exists.`);
  }
  await ensureCatalogIndexes();
} finally {
  client.destroy();
}

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { hashPassword } from "./auth.js";

const input = z.object({
  tableName: z.string().min(3).max(255),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z
    .string()
    .min(12)
    .max(128)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 128),
  region: z.string().min(1),
  endpoint: z.string().url().optional(),
}).safeParse({
  tableName: process.env.DYNAMODB_TABLE,
  email: process.env.BOOTSTRAP_ADMIN_EMAIL,
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  region: process.env.AWS_REGION ?? "ap-south-1",
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

if (!input.success) {
  throw new Error("Set valid DYNAMODB_TABLE, BOOTSTRAP_ADMIN_EMAIL, and BOOTSTRAP_ADMIN_PASSWORD values.");
}

const config = input.data;
if (
  config.endpoint &&
  !["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    new URL(config.endpoint).hostname,
  )
) {
  throw new Error("DYNAMODB_ENDPOINT is accepted only for a local bootstrap.");
}

const client = new DynamoDBClient({
  region: config.region,
  ...(config.endpoint
    ? {
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: "local",
          secretAccessKey: "local",
        },
      }
    : {}),
});
const documentClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

try {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const passwordHash = await hashPassword(config.password);
  await documentClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: config.tableName,
            Item: {
              PK: `USER#${id}`,
              SK: "PROFILE",
              id,
              email: config.email,
              passwordHash,
              roles: ["super_admin"],
              createdAt,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: config.tableName,
            Item: {
              PK: `EMAIL#${config.email}`,
              SK: "IDENTITY",
              userId: id,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: config.tableName,
            Item: {
              PK: "PLATFORM#BOOTSTRAP",
              SK: "SUPER_ADMIN",
              userId: id,
              createdAt,
            },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
    }),
  );
  console.info("Initial super-admin account created. Remove bootstrap credentials from the environment.");
} catch (error) {
  console.error("Super-admin bootstrap failed. The email may exist or bootstrap may already have been used.");
  throw error;
} finally {
  client.destroy();
}

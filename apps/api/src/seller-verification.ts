import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import {
  MarketplaceError,
  type SellerVerificationDetails,
} from "./repository.js";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export interface SellerVerificationProtector {
  encrypt(details: SellerVerificationDetails): string;
  decrypt(value: string): SellerVerificationDetails;
}

export class AesGcmSellerVerificationProtector implements SellerVerificationProtector {
  constructor(private readonly key: Buffer) {
    if (key.byteLength !== 32) {
      throw new Error("The seller verification encryption key must be 32 bytes.");
    }
  }

  encrypt(details: SellerVerificationDetails): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(details), "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(value: string): SellerVerificationDetails {
    const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(".");
    if (!version || !encodedIv || !encodedTag || !encodedCiphertext || version !== "v1") {
      throw new Error("Stored seller verification data cannot be decrypted.");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(encodedIv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      const value: unknown = JSON.parse(plaintext);
      const result = verificationDetailsSchema.safeParse(value);
      if (!result.success) throw new Error("Invalid encrypted data.");
      const { consent: _consent, ...details } = result.data;
      return details;
    } catch {
      throw new Error("Stored seller verification data cannot be decrypted.");
    }
  }
}

export interface PrivateSellerDocumentStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType: string }>;
  delete(key: string): Promise<void>;
  destroy?(): void;
}

export interface SellerVerificationProvider {
  readonly status: "NOT_CONFIGURED" | "CONFIGURED";
  verifyGstin(
    gstin: string,
  ): Promise<{ status: "NOT_CONFIGURED" | "VERIFIED" | "FAILED" }>;
  verifyPan(
    pan: string,
  ): Promise<{ status: "NOT_CONFIGURED" | "VERIFIED" | "FAILED" }>;
}

export class ManualSellerVerificationProvider implements SellerVerificationProvider {
  readonly status = "NOT_CONFIGURED" as const;

  async verifyGstin(): Promise<{ status: "NOT_CONFIGURED" }> {
    return { status: "NOT_CONFIGURED" };
  }

  async verifyPan(): Promise<{ status: "NOT_CONFIGURED" }> {
    return { status: "NOT_CONFIGURED" };
  }
}

export class PrivateS3SellerDocumentStorage implements PrivateSellerDocumentStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucketName: string,
    region: string,
  ) {
    this.client = new S3Client({ region });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
    if (!(result.Body instanceof Readable)) {
      throw new Error("Private document storage returned an invalid object body.");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return {
      body: Buffer.concat(chunks),
      contentType: result.ContentType ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}

export class LocalFilesystemSellerDocumentStorage
  implements PrivateSellerDocumentStorage
{
  constructor(private readonly rootDirectory: string) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const filePath = this.resolveObjectPath(key);
    if (contentType !== "image/webp" && contentType !== "application/pdf") {
      throw new Error("Local KYC storage received an unsupported document type.");
    }
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, body, { flag: "wx", mode: 0o600 });
    await writeFile(`${filePath}.content-type`, contentType, {
      flag: "wx",
      mode: 0o600,
    });
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const filePath = this.resolveObjectPath(key);
    const [body, contentType] = await Promise.all([
      readFile(filePath),
      readFile(`${filePath}.content-type`, "utf8"),
    ]);
    if (contentType !== "image/webp" && contentType !== "application/pdf") {
      throw new Error("Local KYC storage metadata is invalid.");
    }
    return { body, contentType };
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveObjectPath(key);
    await Promise.all([
      unlink(filePath).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      }),
      unlink(`${filePath}.content-type`).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      }),
    ]);
  }

  private resolveObjectPath(key: string): string {
    if (!/^(?:seller-verification|return-damage)\/[0-9a-f-]{36}$/.test(key)) {
      throw new Error("Local KYC object key is invalid.");
    }
    const root = path.resolve(this.rootDirectory);
    const filePath = path.resolve(root, key);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error("Local KYC object key is outside the private storage directory.");
    }
    return filePath;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const verificationDetailsSchema = z
  .object({
    legalName: z.string().trim().min(2).max(120),
    tradeName: z.string().trim().min(2).max(120),
    businessType: z.enum(["PROPRIETORSHIP", "PARTNERSHIP", "LLP", "COMPANY", "OTHER"]),
    gstRegistration: z.enum(["REGISTERED", "NOT_REQUIRED"]),
    gstin: z.string().trim().toUpperCase().max(15).nullable(),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
    address: z.string().trim().min(5).max(300),
    state: z.string().trim().min(2).max(80),
    city: z.string().trim().min(2).max(80),
    pinCode: z.string().trim().regex(/^[1-9][0-9]{5}$/),
    consent: z.literal(true).optional(),
  })
  .strict()
  .superRefine((details, context) => {
    if (details.gstRegistration === "REGISTERED") {
      if (
        !details.gstin ||
        !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[A-Z0-9]$/.test(details.gstin) ||
        details.gstin.slice(2, 12) !== details.pan
      ) {
        context.addIssue({
          code: "custom",
          path: ["gstin"],
          message: "Enter a valid GSTIN that matches the submitted PAN.",
        });
      }
    } else if (details.gstin) {
      context.addIssue({
        code: "custom",
        path: ["gstin"],
        message: "GSTIN must be blank when registration is not required.",
      });
    }
  });

export function parseSellerVerificationDetails(
  value: unknown,
): SellerVerificationDetails {
  const result = verificationDetailsSchema.safeParse(value);
  if (!result.success) {
    throw new MarketplaceError(400, "Business verification details are invalid.");
  }
  if (result.data.consent !== true) {
    throw new MarketplaceError(400, "Consent is required to submit business verification.");
  }
  const { consent: _consent, ...details } = result.data;
  return details;
}

export interface NormalizedSellerDocument {
  body: Buffer;
  contentType: "image/webp" | "application/pdf";
}

export async function normalizeSellerDocument(
  body: Buffer,
  declaredContentType: string,
): Promise<NormalizedSellerDocument> {
  if (body.length === 0 || body.length > 10 * 1024 * 1024) {
    throw new MarketplaceError(413, "Each verification document must be between 1 byte and 10 MB.");
  }
  if (declaredContentType === "application/pdf") {
    const header = body.subarray(0, 8).toString("ascii");
    const tail = body.subarray(Math.max(0, body.length - 2048)).toString("latin1");
    if (!header.startsWith("%PDF-") || !tail.includes("%%EOF")) {
      throw new MarketplaceError(400, "The uploaded PDF document is invalid.");
    }
    return { body, contentType: "application/pdf" };
  }
  if (declaredContentType !== "image/jpeg" && declaredContentType !== "image/png") {
    throw new MarketplaceError(400, "Upload a PDF, JPEG, or PNG verification document.");
  }
  try {
    const image = sharp(body, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    const expectedFormat = declaredContentType === "image/jpeg" ? "jpeg" : "png";
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8000 ||
      metadata.height > 8000 ||
      metadata.width * metadata.height > 40_000_000 ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error("Unsupported image contents.");
    }
    return {
      body: await image.rotate().webp({ quality: 85, effort: 4 }).toBuffer(),
      contentType: "image/webp",
    };
  } catch {
    throw new MarketplaceError(400, "The uploaded image document is invalid.");
  }
}

export function createSellerVerificationProtector(
  env: NodeJS.ProcessEnv,
): SellerVerificationProtector | undefined {
  const configuredKey = env.KYC_DATA_ENCRYPTION_KEY?.trim();
  if (!configuredKey) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(configuredKey)) {
    throw new Error("KYC_DATA_ENCRYPTION_KEY must be a 32-byte hexadecimal key.");
  }
  return new AesGcmSellerVerificationProtector(Buffer.from(configuredKey, "hex"));
}

export function createLocalSellerVerificationProtector(
  env: NodeJS.ProcessEnv,
): SellerVerificationProtector | undefined {
  const configuredKey = env.LOCAL_KYC_TEST_KEY?.trim();
  if (!configuredKey) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(configuredKey)) {
    throw new Error("LOCAL_KYC_TEST_KEY must be a dedicated 32-byte hexadecimal test key.");
  }
  return new AesGcmSellerVerificationProtector(Buffer.from(configuredKey, "hex"));
}

export function createPrivateSellerDocumentStorage(
  env: NodeJS.ProcessEnv,
): PrivateSellerDocumentStorage | undefined {
  const bucketName = env.KYC_DOCUMENT_BUCKET?.trim();
  if (!bucketName) return undefined;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) {
    throw new Error("KYC_DOCUMENT_BUCKET must be a valid private S3 bucket name.");
  }
  const region = env.AWS_REGION?.trim();
  if (!region) throw new Error("AWS_REGION is required for private KYC document storage.");
  return new PrivateS3SellerDocumentStorage(bucketName, region);
}

import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProductImageStorage {
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  publicUrl(key: string): string;
  destroy?(): void;
}

export class LocalFilesystemProductImageStorage implements ProductImageStorage {
  constructor(
    private readonly rootDirectory: string,
    private readonly publicBaseUrl: string,
  ) {}

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    if (contentType !== "image/webp") {
      throw new Error("Local product image storage only accepts normalized WebP images.");
    }
    const filePath = this.resolveObjectPath(key);
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await writeFile(filePath, body, { flag: "wx", mode: 0o600 });
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await unlink(this.resolveObjectPath(key));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async getObject(
    key: string,
  ): Promise<{ body: Buffer; contentType: "image/webp" } | null> {
    try {
      return {
        body: await readFile(this.resolveObjectPath(key)),
        contentType: "image/webp",
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  publicUrl(key: string): string {
    const fileName = this.resolveObjectPath(key).split(path.sep).at(-1);
    if (!fileName) throw new Error("Local product image object key is invalid.");
    return new URL(
      `/local-product-images/${encodeURIComponent(fileName)}`,
      this.publicBaseUrl,
    ).toString();
  }

  private resolveObjectPath(key: string): string {
    const match = /^products\/([0-9a-f-]{36}\.webp)$/.exec(key);
    if (!match) {
      throw new Error("Local product image object key is invalid.");
    }
    const root = path.resolve(this.rootDirectory);
    const filePath = path.resolve(root, match[1]);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new Error("Local product image key is outside the private storage directory.");
    }
    return filePath;
  }
}

export function createLocalDevelopmentProductImageStorage(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): LocalFilesystemProductImageStorage | undefined {
  const r2Settings = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_BASE_URL",
  ] as const;
  if (
    env.NODE_ENV !== "development" ||
    env.DYNAMODB_TABLE !== "marketplace-local" ||
    env.DYNAMODB_ENDPOINT !== "http://localhost:8000" ||
    env.PORT !== "4000" ||
    env.WEB_ORIGIN !== "http://localhost:3000" ||
    env.NEXT_PUBLIC_API_URL !== "http://localhost:4000" ||
    r2Settings.some((name) => Boolean(env[name]?.trim()))
  ) {
    return undefined;
  }
  return new LocalFilesystemProductImageStorage(
    path.join(projectRoot, ".local-workflow-data", "product-images"),
    "http://localhost:4000",
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export class R2ProductImageStorage implements ProductImageStorage {
  private readonly client: S3Client;
  private readonly publicBaseUrl: URL;

  constructor(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly bucketName: string,
    publicBaseUrl: string,
  ) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    this.publicBaseUrl = new URL(publicBaseUrl);
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
  }

  destroy(): void {
    this.client.destroy();
  }

  publicUrl(key: string): string {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const baseUrl = this.publicBaseUrl.toString().replace(/\/$/, "");
    return new URL(encodedKey, `${baseUrl}/`).toString();
  }
}

export function createR2ProductImageStorage(
  env: NodeJS.ProcessEnv,
  allowedImageHosts: string[],
): R2ProductImageStorage | undefined {
  const names = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
    "R2_PUBLIC_BASE_URL",
  ] as const;
  const configured = names.filter((name) => Boolean(env[name]?.trim()));
  if (configured.length === 0) return undefined;
  if (configured.length !== names.length) {
    const missing = names.filter((name) => !env[name]?.trim());
    throw new Error(`R2 image storage configuration is incomplete; missing ${missing.join(", ")}.`);
  }

  const accountId = env.R2_ACCOUNT_ID!.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID!.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY!.trim();
  const bucketName = env.R2_BUCKET_NAME!.trim();
  const publicBaseUrl = new URL(env.R2_PUBLIC_BASE_URL!.trim());
  if (
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName) ||
    publicBaseUrl.protocol !== "https:" ||
    publicBaseUrl.username ||
    publicBaseUrl.password ||
    publicBaseUrl.search ||
    publicBaseUrl.hash
  ) {
    throw new Error("R2 image storage configuration contains an invalid account, bucket, or public HTTPS URL.");
  }
  if (!allowedImageHosts.includes(publicBaseUrl.hostname.toLowerCase())) {
    throw new Error("R2_PUBLIC_BASE_URL hostname must be included in PRODUCT_IMAGE_HOSTS.");
  }

  return new R2ProductImageStorage(
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicBaseUrl.toString(),
  );
}

import {
  createHash,
  createHmac,
  randomInt,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);

  return `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, saltHex, keyHex] =
    encodedHash.split("$");

  if (
    algorithm !== "scrypt" ||
    cost !== "32768" ||
    blockSize !== "8" ||
    parallelism !== "1" ||
    !saltHex ||
    !keyHex ||
    !/^[a-f0-9]{32}$/i.test(saltHex) ||
    !/^[a-f0-9]{128}$/i.test(keyHex)
  ) {
    return false;
  }

  const expectedKey = Buffer.from(keyHex, "hex");
  const actualKey = await deriveKey(password, Buffer.from(saltHex, "hex"));

  return timingSafeEqual(actualKey, expectedKey);
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateCustomerOtp(): string {
  return String(randomInt(100_000, 1_000_000));
}

export function hashCustomerOtp(
  mobileNumber: string,
  otp: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${mobileNumber}:${otp}`)
    .digest("hex");
}

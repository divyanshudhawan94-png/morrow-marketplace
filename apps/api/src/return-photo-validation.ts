import sharp from "sharp";
import { MarketplaceError } from "./repository.js";

export const MAX_RETURN_DAMAGE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_RETURN_DAMAGE_IMAGE_PIXELS = 40_000_000;

type ReturnPhotoFormat = "jpeg" | "png" | "webp";

function detectReturnPhotoFormat(buffer: Buffer): ReturnPhotoFormat | undefined {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

export async function normalizeReturnDamagePhoto(buffer: Buffer): Promise<Buffer> {
  if (buffer.length === 0 || buffer.length > MAX_RETURN_DAMAGE_IMAGE_BYTES) {
    throw new MarketplaceError(413, "Each damage photo must be between 1 byte and 5 MB.");
  }
  const expectedFormat = detectReturnPhotoFormat(buffer);
  if (!expectedFormat) {
    throw new MarketplaceError(400, "Damage photos must be valid JPEG, PNG, or WebP images.");
  }

  try {
    const image = sharp(buffer, { limitInputPixels: MAX_RETURN_DAMAGE_IMAGE_PIXELS });
    const metadata = await image.metadata();
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8000 ||
      metadata.height > 8000 ||
      metadata.width * metadata.height > MAX_RETURN_DAMAGE_IMAGE_PIXELS ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error("Unsupported image contents.");
    }
    return await image.rotate().webp({ quality: 85, effort: 4 }).toBuffer();
  } catch {
    throw new MarketplaceError(400, "The selected damage photo is not a valid supported image.");
  }
}

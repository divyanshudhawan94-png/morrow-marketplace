import sharp from "sharp";
import { MarketplaceError } from "./repository.js";

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PRODUCT_IMAGE_PIXELS = 40_000_000;

const inputMimeTypes = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export async function normalizeProductImage(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<Buffer> {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
    throw new MarketplaceError(413, "Image must be between 1 byte and 5 MB.");
  }

  const expectedFormat =
    inputMimeTypes[declaredMimeType as keyof typeof inputMimeTypes];
  if (!expectedFormat) {
    throw new MarketplaceError(400, "Choose a JPEG, PNG, or WebP image.");
  }

  try {
    const image = sharp(buffer, { limitInputPixels: MAX_PRODUCT_IMAGE_PIXELS });
    const metadata = await image.metadata();
    if (
      metadata.format !== expectedFormat ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 8000 ||
      metadata.height > 8000 ||
      metadata.width * metadata.height > MAX_PRODUCT_IMAGE_PIXELS ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error("Image metadata is unsupported.");
    }
    return await image.rotate().webp({ quality: 85, effort: 4 }).toBuffer();
  } catch {
    throw new MarketplaceError(400, "The selected file is not a valid supported image.");
  }
}

/**
 * Cover art: the bytes an app publishes to SMTC (PNG, JPEG or an uncompressed BMP) become a small
 * JPEG data URL. It is served to the local renderer and, base64 inside a LiveKit RPC answer, to
 * the listeners, so it must stay well under LiveKit's 15 KiB RPC payload.
 */

/** Longest side of the cover sent around. */
export const ART_MAX_SIZE_PX = 160;
/** JPEG budget: base64 makes it 4/3 bigger, still under livekit's 15 KiB RPC payload. */
export const ART_MAX_JPEG_BYTES = 11_000;
/** Covers kept for `getMusicArt` (the current one is touched on every update). */
export const ART_CACHE_SIZE = 20;

/** Tried in order until the JPEG fits the budget. */
const ENCODE_ATTEMPTS: readonly { size: number; quality: number }[] = [
  { size: ART_MAX_SIZE_PX, quality: 80 },
  { size: ART_MAX_SIZE_PX, quality: 65 },
  { size: 128, quality: 60 },
  { size: 96, quality: 50 },
];

/** The subset of Electron's `NativeImage` used here (faked in tests). */
export interface ImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width?: number;
    height?: number;
    quality?: 'good' | 'better' | 'best';
  }): ImageLike;
  toJPEG(quality: number): Buffer;
}

/** The subset of Electron's `nativeImage` module used here. */
export interface ImageFactory {
  /** PNG or JPEG. */
  createFromBuffer(buffer: Buffer): ImageLike;
  /** Raw top-down BGRA pixels. */
  createFromBitmap(buffer: Buffer, options: { width: number; height: number }): ImageLike;
}

export interface DecodedBitmap {
  width: number;
  height: number;
  /** Top-down BGRA pixels, fully opaque (what `createFromBitmap` expects on Windows). */
  bgra: Buffer;
}

const BMP_MAX_DIMENSION = 4096;
const BI_RGB = 0;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;

/** Reads one channel through a BI_BITFIELDS mask and scales it to 8 bits. */
function channelReader(mask: number): (pixel: number) => number {
  if (mask === 0) return () => 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1) bits += 1;
  const max = 2 ** bits - 1;
  return (pixel) => {
    const value = ((pixel & mask) >>> 0) >>> shift;
    return bits === 8 ? value : Math.round((value * 255) / max);
  };
}

/**
 * Decodes an uncompressed 24/32-bit Windows BMP (`BM` header, BITMAPINFOHEADER or later), which
 * Electron's `createFromBuffer` cannot read. Null for anything else (palettes, RLE, PNG, JPEG…).
 */
export function decodeBmp(data: Uint8Array): DecodedBitmap | null {
  if (data.byteLength < 54 || data[0] !== 0x42 || data[1] !== 0x4d) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  if (headerSize < 40) return null;
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bitsPerPixel = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  if (width <= 0 || height <= 0 || width > BMP_MAX_DIMENSION || height > BMP_MAX_DIMENSION) {
    return null;
  }
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) return null;

  // Red, green, blue masks for 32-bit pixels (read as little-endian uint32).
  let masks: [number, number, number] = [0x00ff0000, 0x0000ff00, 0x000000ff];
  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    // Later headers hold the masks; BITMAPINFOHEADER is followed by them. Same offsets either way.
    if (bitsPerPixel !== 32 || data.byteLength < 66) return null;
    masks = [view.getUint32(54, true), view.getUint32(58, true), view.getUint32(62, true)];
  } else if (compression !== BI_RGB) {
    return null;
  }

  const bytesPerPixel = bitsPerPixel / 8;
  const rowSize = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  if (pixelOffset < 54 || pixelOffset + rowSize * height > data.byteLength) return null;

  const [red, green, blue] = masks.map(channelReader) as [
    (pixel: number) => number,
    (pixel: number) => number,
    (pixel: number) => number,
  ];
  const bgra = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = pixelOffset + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const src = row + x * bytesPerPixel;
      const dst = (y * width + x) * 4;
      if (bytesPerPixel === 3) {
        bgra[dst] = view.getUint8(src);
        bgra[dst + 1] = view.getUint8(src + 1);
        bgra[dst + 2] = view.getUint8(src + 2);
      } else {
        const pixel = view.getUint32(src, true);
        bgra[dst] = blue(pixel);
        bgra[dst + 1] = green(pixel);
        bgra[dst + 2] = red(pixel);
      }
      bgra[dst + 3] = 255;
    }
  }
  return { width, height, bgra };
}

/**
 * The cover as a `data:image/jpeg;base64,…` URL at most `ART_MAX_SIZE_PX` on its longest side and
 * `ART_MAX_JPEG_BYTES` long, or null when it cannot be decoded (or never fits).
 */
export function encodeCoverArt(bytes: Uint8Array, images: ImageFactory): string | null {
  if (bytes.byteLength === 0) return null;
  let image: ImageLike;
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bitmap = decodeBmp(buffer);
    image = bitmap
      ? images.createFromBitmap(bitmap.bgra, { width: bitmap.width, height: bitmap.height })
      : images.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (width <= 0 || height <= 0) return null;
    for (const attempt of ENCODE_ATTEMPTS) {
      const scale = Math.min(1, attempt.size / Math.max(width, height));
      const sized =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: 'best',
            })
          : image;
      const jpeg = sized.toJPEG(attempt.quality);
      if (jpeg.byteLength > 0 && jpeg.byteLength <= ART_MAX_JPEG_BYTES) {
        return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Tiny least-recently-used map: `get` and `set` both mark the key as the newest. */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

import { describe, expect, it, vi } from 'vitest';
import {
  ART_MAX_JPEG_BYTES,
  decodeBmp,
  encodeCoverArt,
  LruCache,
  type ImageFactory,
  type ImageLike,
} from './art';

/** Builds a BMP file: BITMAPINFOHEADER, optional bitfield masks, padded rows. */
function bmp(options: {
  width: number;
  height: number;
  bitsPerPixel: 24 | 32;
  topDown?: boolean;
  compression?: number;
  masks?: [number, number, number];
  /** [b, g, r] per pixel, top row first. */
  pixels: [number, number, number][];
}): Buffer {
  const { width, height, bitsPerPixel } = options;
  const masksSize = options.masks ? 12 : 0;
  const offset = 14 + 40 + masksSize;
  const rowSize = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const file = Buffer.alloc(offset + rowSize * height);
  file.write('BM', 0, 'latin1');
  file.writeUInt32LE(file.length, 2);
  file.writeUInt32LE(offset, 10);
  file.writeUInt32LE(40, 14);
  file.writeInt32LE(width, 18);
  file.writeInt32LE(options.topDown ? -height : height, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(bitsPerPixel, 28);
  file.writeUInt32LE(options.compression ?? 0, 30);
  if (options.masks) options.masks.forEach((mask, i) => file.writeUInt32LE(mask, 54 + i * 4));
  options.pixels.forEach(([b, g, r], index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const fileRow = options.topDown ? y : height - 1 - y;
    const at = offset + fileRow * rowSize + x * (bitsPerPixel / 8);
    if (bitsPerPixel === 24) {
      file[at] = b;
      file[at + 1] = g;
      file[at + 2] = r;
    } else if (options.masks) {
      // Masks used by the test: R=0xff, G=0xff00, B=0xff0000 (RGBX in memory).
      file.writeUInt32LE((r | (g << 8) | (b << 16)) >>> 0, at);
    } else {
      file.writeUInt32LE(((r << 16) | (g << 8) | b) >>> 0, at);
    }
  });
  return file;
}

const RED: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [255, 0, 0];
const WHITE: [number, number, number] = [255, 255, 255];

describe('decodeBmp', () => {
  it('decodes a bottom-up 24-bit BMP with padded rows into top-down BGRA', () => {
    const decoded = decodeBmp(
      bmp({ width: 3, height: 2, bitsPerPixel: 24, pixels: [RED, GREEN, BLUE, WHITE, RED, GREEN] }),
    );
    expect(decoded).not.toBeNull();
    expect(decoded?.width).toBe(3);
    expect(decoded?.height).toBe(2);
    expect([...(decoded?.bgra ?? [])]).toEqual([
      0,
      0,
      255,
      255,
      0,
      255,
      0,
      255,
      255,
      0,
      0,
      255, // top row
      255,
      255,
      255,
      255,
      0,
      0,
      255,
      255,
      0,
      255,
      0,
      255, // bottom row
    ]);
  });

  it('decodes top-down 32-bit BI_RGB (ignoring the unused byte) and bitfields', () => {
    const plain = decodeBmp(
      bmp({ width: 2, height: 1, bitsPerPixel: 32, topDown: true, pixels: [RED, BLUE] }),
    );
    expect([...(plain?.bgra ?? [])]).toEqual([0, 0, 255, 255, 255, 0, 0, 255]);

    const fields = decodeBmp(
      bmp({
        width: 2,
        height: 1,
        bitsPerPixel: 32,
        compression: 3,
        masks: [0x000000ff, 0x0000ff00, 0x00ff0000],
        pixels: [RED, GREEN],
      }),
    );
    expect([...(fields?.bgra ?? [])]).toEqual([0, 0, 255, 255, 0, 255, 0, 255]);
  });

  it('returns null for other formats and broken files', () => {
    expect(decodeBmp(Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(60).fill(0)]))).toBeNull();
    expect(decodeBmp(Buffer.from('BM'))).toBeNull();
    const truncated = bmp({ width: 4, height: 4, bitsPerPixel: 24, pixels: [] }).subarray(0, 70);
    expect(decodeBmp(truncated)).toBeNull();
    const palette = bmp({ width: 1, height: 1, bitsPerPixel: 24, pixels: [RED] });
    palette.writeUInt16LE(8, 28);
    expect(decodeBmp(palette)).toBeNull();
    const rle = bmp({ width: 1, height: 1, bitsPerPixel: 24, compression: 1, pixels: [RED] });
    expect(decodeBmp(rle)).toBeNull();
  });
});

interface FakeImage extends ImageLike {
  width: number;
  height: number;
}

/** A nativeImage stand-in whose JPEG size depends on the pixel count and the quality. */
function fakeImages(
  options: { width?: number; height?: number; empty?: boolean; bytesPerPixel?: number } = {},
) {
  const make = (width: number, height: number): FakeImage => ({
    width,
    height,
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width, height }),
    resize: vi.fn((size: { width?: number; height?: number }) =>
      make(size.width ?? width, size.height ?? height),
    ),
    toJPEG: vi.fn((quality: number) =>
      Buffer.alloc(Math.round(width * height * (options.bytesPerPixel ?? 0.3) * (quality / 80))),
    ),
  });
  const factory = {
    createFromBuffer: vi.fn<(buffer: Buffer) => FakeImage>(() =>
      make(options.width ?? 640, options.height ?? 480),
    ),
    createFromBitmap: vi.fn((_buffer: Buffer, size: { width: number; height: number }) =>
      make(size.width, size.height),
    ),
  } satisfies ImageFactory;
  return factory;
}

describe('encodeCoverArt', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('shrinks the longest side to 160 px, keeping the ratio, and returns a JPEG data URL', () => {
    const images = fakeImages({ width: 640, height: 480 });
    const url = encodeCoverArt(PNG, images);
    expect(url).toMatch(/^data:image\/jpeg;base64,/);
    const image = images.createFromBuffer.mock.results[0]?.value as FakeImage;
    expect(image.resize).toHaveBeenCalledWith({ width: 160, height: 120, quality: 'best' });
    const decoded = Buffer.from((url ?? '').split(',')[1] ?? '', 'base64');
    expect(decoded.byteLength).toBeLessThanOrEqual(ART_MAX_JPEG_BYTES);
  });

  it('does not upscale small covers', () => {
    const images = fakeImages({ width: 100, height: 100 });
    expect(encodeCoverArt(PNG, images)).not.toBeNull();
    const image = images.createFromBuffer.mock.results[0]?.value as FakeImage;
    expect(image.resize).not.toHaveBeenCalled();
    expect(image.toJPEG).toHaveBeenCalledWith(80);
  });

  it('lowers quality and size until the JPEG fits the budget', () => {
    // 160x160 at 0.6 B/px is ~15 KB at quality 80: too big; 128 px at quality 60 fits.
    const images = fakeImages({ width: 300, height: 300, bytesPerPixel: 0.6 });
    const url = encodeCoverArt(PNG, images);
    expect(url).not.toBeNull();
    const decoded = Buffer.from((url ?? '').split(',')[1] ?? '', 'base64');
    expect(decoded.byteLength).toBeLessThanOrEqual(ART_MAX_JPEG_BYTES);
    const image = images.createFromBuffer.mock.results[0]?.value as FakeImage;
    expect(image.resize).toHaveBeenLastCalledWith({ width: 128, height: 128, quality: 'best' });
  });

  it('gives up when nothing fits', () => {
    expect(encodeCoverArt(PNG, fakeImages({ bytesPerPixel: 50 }))).toBeNull();
  });

  it('decodes BMP covers itself and hands the pixels to createFromBitmap', () => {
    const images = fakeImages();
    const file = bmp({ width: 2, height: 2, bitsPerPixel: 24, pixels: [RED, GREEN, BLUE, WHITE] });
    expect(encodeCoverArt(file, images)).not.toBeNull();
    expect(images.createFromBuffer).not.toHaveBeenCalled();
    expect(images.createFromBitmap).toHaveBeenCalledWith(expect.any(Buffer), {
      width: 2,
      height: 2,
    });
  });

  it('returns null for empty input, undecodable images and native errors', () => {
    expect(encodeCoverArt(new Uint8Array(0), fakeImages())).toBeNull();
    expect(encodeCoverArt(PNG, fakeImages({ empty: true }))).toBeNull();
    expect(encodeCoverArt(PNG, fakeImages({ width: 0, height: 0 }))).toBeNull();
    const throwing = fakeImages();
    throwing.createFromBuffer.mockImplementation(() => {
      throw new Error('decode failed');
    });
    expect(encodeCoverArt(PNG, throwing)).toBeNull();
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a is now the newest
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
    expect(cache.get('zzz')).toBeUndefined();
  });
});

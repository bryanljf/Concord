#!/usr/bin/env node
/**
 * Generates the tray icons and the app icon as PNG files without any dependency:
 * shapes are rasterised with supersampling and encoded with node:zlib + a CRC32 table.
 *
 *   resources/tray/idle.png      16x16   accent square + white "screen"
 *   resources/tray/idle@2x.png   32x32   (Electron picks @2x on high-DPI displays)
 *   resources/tray/live.png              red square + white dot
 *   resources/tray/offline.png           grey square + white "screen"
 *   resources/icon.png           256x256 future installer / notification icon
 *
 * Usage: node scripts/gen-icons.mjs
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ACCENT = '#5865f2';
const LIVE = '#da373c';
const OFFLINE = '#80848e';
const WHITE = '#ffffff';

const SUPERSAMPLE = 4;

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes an RGBA buffer (width * height * 4 bytes) as a PNG. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type "None" for this scanline
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Rasteriser: shapes are described in unit coordinates (0..1) and drawn with
// supersampled coverage so edges look smooth even at 16x16.
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Rounded rectangle test in unit coordinates. */
function roundedRect(x0, y0, x1, y1, radius) {
  return (px, py) => {
    if (px < x0 || px > x1 || py < y0 || py > y1) return false;
    const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
}

function circle(cx, cy, radius) {
  return (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= radius * radius;
  };
}

/**
 * Renders a list of layers ({ color, inside }) into an RGBA buffer of the given size.
 * Later layers are composited over earlier ones.
 */
function render(size, layers) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const colors = layers.map((layer) => hexToRgb(layer.color));

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Accumulated premultiplied colour for this pixel.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) / size;
          // Topmost layer covering this sample wins (all layers are opaque).
          for (let i = layers.length - 1; i >= 0; i -= 1) {
            if (layers[i].inside(px, py)) {
              const [cr, cg, cb] = colors[i];
              r += cr;
              g += cg;
              b += cb;
              a += 1;
              break;
            }
          }
        }
      }
      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
        rgba[offset + 3] = Math.round((a / samples) * 255);
      }
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Icon designs
// ---------------------------------------------------------------------------

const background = (color) => ({ color, inside: roundedRect(0.02, 0.02, 0.98, 0.98, 0.24) });

/** A small monitor: screen rectangle plus a short stand. */
const screenLayers = [
  { color: WHITE, inside: roundedRect(0.2, 0.26, 0.8, 0.64, 0.05) },
  { color: WHITE, inside: roundedRect(0.4, 0.68, 0.6, 0.76, 0.02) },
];

const DESIGNS = {
  idle: [background(ACCENT), ...screenLayers],
  live: [background(LIVE), { color: WHITE, inside: circle(0.5, 0.5, 0.22) }],
  offline: [background(OFFLINE), ...screenLayers],
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const trayDir = join(root, 'resources', 'tray');
mkdirSync(trayDir, { recursive: true });

function write(path, size, layers) {
  writeFileSync(path, encodePng(size, size, render(size, layers)));
  console.log(`wrote ${path} (${size}x${size})`);
}

for (const [name, layers] of Object.entries(DESIGNS)) {
  write(join(trayDir, `${name}.png`), 16, layers);
  write(join(trayDir, `${name}@2x.png`), 32, layers);
}
write(join(root, 'resources', 'icon.png'), 256, DESIGNS.idle);

process.exitCode = 0;

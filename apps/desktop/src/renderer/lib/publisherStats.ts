import type { StreamKind } from './streamKey';
import type { OutboundPoint, OutboundWindow, QualityLimitation } from './rtcStats';
import { codecName } from './streamStats';

/**
 * The broadcaster's sender numbers travel to viewers as a participant attribute
 * (`concord.stats.screen` / `concord.stats.camera`): a compact, versioned JSON written every 5 s
 * while the video is live and cleared with '' when it stops. Viewers only see their receiver
 * stats, so this is what tells them whether frames are lost before they leave the broadcaster's
 * machine (capture, encoder, uplink) or on the way. Kept under 400 bytes: attributes go to every
 * participant on every change.
 */

export const STATS_ATTRIBUTES: Readonly<Record<StreamKind, string>> = {
  screen: 'concord.stats.screen',
  camera: 'concord.stats.camera',
};

export function statsAttributeKey(kind: StreamKind): string {
  return STATS_ATTRIBUTES[kind];
}

export const PUBLISHER_SUMMARY_VERSION = 1;
export const MAX_SUMMARY_BYTES = 400;
/** How often the broadcaster rewrites the attribute (and the window each summary covers). */
export const PUBLISH_INTERVAL_MS = 5_000;

export type PublisherLimitation = QualityLimitation;

export interface PublisherLayer {
  rid: string | null;
  width: number | null;
  height: number | null;
  /** Frames sent per second. */
  fps: number | null;
  kbps: number | null;
  /** False when dynacast paused it (nobody watches that layer). */
  active: boolean;
}

/** What the broadcaster measured over the last few seconds (decoded attribute). */
export interface PublisherSummary {
  v: typeof PUBLISHER_SUMMARY_VERSION;
  /** Broadcaster's `Date.now()`. */
  at: number;
  /** Preset frame rate (30 for the webcam). */
  targetFps: number | null;
  /** Frames the capture delivered (`media-source`). */
  captureFps: number | null;
  /** Frames the encoder produced on the top active layer. */
  encodeFps: number | null;
  /** Frames sent on the top active layer. */
  sentFps: number | null;
  width: number | null;
  height: number | null;
  captureWidth: number | null;
  captureHeight: number | null;
  bitrateKbps: number | null;
  targetBitrateKbps: number | null;
  limitation: PublisherLimitation | null;
  /** Share (0–1) of the window limited by CPU / bandwidth. */
  cpuShare: number | null;
  bandwidthShare: number | null;
  encoder: string | null;
  hardware: boolean | null;
  /** "H264", "VP9", … */
  codec: string | null;
  encodeMs: number | null;
  uplinkKbps: number | null;
  rttMs: number | null;
  /** Loss the SFU reports for the broadcaster's packets. */
  lossPercent: number | null;
  layers: PublisherLayer[];
}

const MAX_ENCODER_CHARS = 64;
const MAX_LAYERS = 4;
const LIMITATIONS: readonly PublisherLimitation[] = ['none', 'cpu', 'bandwidth', 'other'];

function round(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function kbps(bps: number | null): number | null {
  return bps === null ? null : round(bps / 1000, 0);
}

/**
 * The summary of the last `PUBLISH_INTERVAL_MS`: rates from the window, resolution, encoder and
 * limitation from the latest point.
 */
export function buildPublisherSummary(input: {
  at: number;
  targetFps: number;
  window: OutboundWindow;
  latest: OutboundPoint;
}): PublisherSummary {
  const { at, targetFps, window, latest } = input;
  return {
    v: PUBLISHER_SUMMARY_VERSION,
    at,
    targetFps,
    captureFps: round(window.captureFps, 1),
    encodeFps: round(window.encodeFps, 1),
    sentFps: round(window.sentFps, 1),
    width: latest.width,
    height: latest.height,
    captureWidth: latest.captureWidth,
    captureHeight: latest.captureHeight,
    bitrateKbps: kbps(window.bitrate),
    targetBitrateKbps: kbps(latest.targetBitrate),
    limitation: latest.limitation,
    cpuShare: round(window.cpuShare, 2),
    bandwidthShare: round(window.bandwidthShare, 2),
    encoder: latest.encoder ? latest.encoder.slice(0, MAX_ENCODER_CHARS) : null,
    hardware: latest.hardware,
    codec: codecName(latest.codec ?? undefined),
    encodeMs: round(window.encodeMs, 1),
    uplinkKbps: kbps(window.uplink),
    rttMs: round(window.rttMs, 0),
    lossPercent: round(window.remoteLossPercent, 1),
    layers: window.layers.map((layer) => ({
      rid: layer.rid,
      width: layer.width,
      height: layer.height,
      fps: round(layer.sentFps, 1),
      kbps: kbps(layer.bitrate),
      active: layer.active,
    })),
  };
}

// Wire format (v1), short keys; absent = null:
// {"v":1,"at":…,"tf":30,"cf":29.9,"ef":28.4,"sf":28.4,"w":1920,"h":1080,"cw":1920,"ch":1080,
//  "br":3950,"tb":4000,"lim":"bandwidth","cpu":0.05,"bw":0.42,"enc":"OpenH264","hw":0,"co":"H264",
//  "ems":6.2,"up":5100,"rtt":35,"loss":0.4,"ly":[["q",960,540,30,1000,1],["h",1920,1080,28.4,2950,1]]}
type Wire = Record<string, unknown>;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

function toWire(summary: PublisherSummary, encoder: string | null, layers: boolean): Wire {
  const wire: Wire = { v: summary.v, at: Math.round(summary.at) };
  const put = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined) wire[key] = value;
  };
  put('tf', summary.targetFps);
  put('cf', summary.captureFps);
  put('ef', summary.encodeFps);
  put('sf', summary.sentFps);
  put('w', summary.width);
  put('h', summary.height);
  put('cw', summary.captureWidth);
  put('ch', summary.captureHeight);
  put('br', summary.bitrateKbps);
  put('tb', summary.targetBitrateKbps);
  put('lim', summary.limitation);
  put('cpu', summary.cpuShare);
  put('bw', summary.bandwidthShare);
  put('enc', encoder);
  put('hw', summary.hardware === null ? null : summary.hardware ? 1 : 0);
  put('co', summary.codec);
  put('ems', summary.encodeMs);
  put('up', summary.uplinkKbps);
  put('rtt', summary.rttMs);
  put('loss', summary.lossPercent);
  if (layers && summary.layers.length > 0) {
    wire.ly = summary.layers
      .slice(0, MAX_LAYERS)
      .map((layer) => [
        layer.rid,
        layer.width,
        layer.height,
        layer.fps,
        layer.kbps,
        layer.active ? 1 : 0,
      ]);
  }
  return wire;
}

/**
 * The attribute value, at most `MAX_SUMMARY_BYTES`: when too long the encoder name is shortened,
 * then the layers dropped, then the encoder name dropped.
 */
export function encodePublisherSummary(summary: PublisherSummary): string {
  const encoder = summary.encoder ? summary.encoder.slice(0, MAX_ENCODER_CHARS) : null;
  const attempts: [string | null, boolean][] = [
    [encoder, true],
    [encoder ? encoder.slice(0, 24) : null, true],
    [encoder ? encoder.slice(0, 24) : null, false],
    [null, false],
  ];
  for (const [name, layers] of attempts) {
    const json = JSON.stringify(toWire(summary, name, layers));
    if (byteLength(json) <= MAX_SUMMARY_BYTES) return json;
  }
  return JSON.stringify({ v: summary.v, at: Math.round(summary.at) });
}

function isRecord(value: unknown): value is Wire {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function text(value: unknown, maxLength: number, pattern?: RegExp): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  return pattern && !pattern.test(value) ? null : value;
}

function flag(value: unknown): boolean | null {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

const FPS_MAX = 1000;
const PIXELS_MAX = 16_384;
const KBPS_MAX = 1_000_000;

function decodeLayer(value: unknown): PublisherLayer | null {
  if (!Array.isArray(value)) return null;
  const [rid, width, height, fps, rate, active] = value as unknown[];
  if (rid !== null && text(rid, 8, /^[\w-]+$/) === null) return null;
  return {
    rid: rid === null ? null : (rid as string),
    width: bounded(width, 0, PIXELS_MAX),
    height: bounded(height, 0, PIXELS_MAX),
    fps: bounded(fps, 0, FPS_MAX),
    kbps: bounded(rate, 0, KBPS_MAX),
    active: flag(active) ?? false,
  };
}

/** Defensive: anything that is not a v1 summary (other versions, garbage) → null. */
export function decodePublisherSummary(raw: unknown): PublisherSummary | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4 * MAX_SUMMARY_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== PUBLISHER_SUMMARY_VERSION) return null;
  const at = bounded(parsed.at, 1, Number.MAX_SAFE_INTEGER);
  if (at === null) return null;
  const layers = Array.isArray(parsed.ly)
    ? parsed.ly
        .slice(0, MAX_LAYERS)
        .map(decodeLayer)
        .filter((layer): layer is PublisherLayer => layer !== null)
    : [];
  return {
    v: PUBLISHER_SUMMARY_VERSION,
    at,
    targetFps: bounded(parsed.tf, 1, FPS_MAX),
    captureFps: bounded(parsed.cf, 0, FPS_MAX),
    encodeFps: bounded(parsed.ef, 0, FPS_MAX),
    sentFps: bounded(parsed.sf, 0, FPS_MAX),
    width: bounded(parsed.w, 0, PIXELS_MAX),
    height: bounded(parsed.h, 0, PIXELS_MAX),
    captureWidth: bounded(parsed.cw, 0, PIXELS_MAX),
    captureHeight: bounded(parsed.ch, 0, PIXELS_MAX),
    bitrateKbps: bounded(parsed.br, 0, KBPS_MAX),
    targetBitrateKbps: bounded(parsed.tb, 0, KBPS_MAX),
    limitation: LIMITATIONS.find((limitation) => limitation === parsed.lim) ?? null,
    cpuShare: bounded(parsed.cpu, 0, 1),
    bandwidthShare: bounded(parsed.bw, 0, 1),
    encoder: text(parsed.enc, 100),
    hardware: flag(parsed.hw),
    codec: text(parsed.co, 16, /^[\w.-]+$/),
    encodeMs: bounded(parsed.ems, 0, 10_000),
    uplinkKbps: bounded(parsed.up, 0, KBPS_MAX),
    rttMs: bounded(parsed.rtt, 0, 60_000),
    lossPercent: bounded(parsed.loss, 0, 100),
    layers,
  };
}

/** The broadcaster's summary as a viewer sees it. */
export type PublisherStats =
  /** No attribute: a Concord without stats (before v0.2.0), or not published yet. */
  | { status: 'missing' }
  /** An attribute this version cannot read (newer format, corrupted). */
  | { status: 'invalid' }
  | { status: 'ok'; summary: PublisherSummary };

export function readPublisherStats(
  attributes: Readonly<Record<string, string>> | undefined,
  kind: StreamKind,
): PublisherStats {
  const raw = attributes?.[statsAttributeKey(kind)];
  if (!raw) return { status: 'missing' };
  const summary = decodePublisherSummary(raw);
  return summary ? { status: 'ok', summary } : { status: 'invalid' };
}

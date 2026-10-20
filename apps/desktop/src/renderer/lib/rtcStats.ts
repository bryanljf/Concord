/**
 * WebRTC stats for the stats panel, without livekit: `RemoteTrack.getRTCStatsReport()` is the
 * receiver's report (inbound-rtp, codec, transport, candidate-pair, candidates) and
 * `LocalTrack.getRTCStatsReport()` the sender's (media-source, one outbound-rtp per simulcast
 * layer, remote-inbound-rtp, codec, transport, candidate-pair, candidates). Each report becomes a
 * flat sample; two samples become a per-second point; points become 30 s windows. Fields a
 * browser does not fill (Chrome never sets `availableIncomingBitrate`; `decoderImplementation`
 * is hidden from pages that do not capture) stay null.
 */

import { trimHistory } from './sparkline';

/** How much history the stats panel keeps and charts. */
export const STATS_HISTORY_MS = 30_000;
/** How often the hooks read the stats. */
export const STATS_SAMPLE_MS = 1_000;

/** The local ICE candidate in use: plain UDP, TCP (UDP blocked) or a TURN relay. */
export type ConnectionKind = 'udp' | 'tcp' | 'relay';

/** `qualityLimitationReason` of an outbound-rtp. */
export type QualityLimitation = 'none' | 'cpu' | 'bandwidth' | 'other';

/** Seconds spent in each `qualityLimitationReason` (cumulative in a sample, deltas in a point). */
export interface LimitationDurations {
  none: number;
  cpu: number;
  bandwidth: number;
  other: number;
}

/** What both `RTCStatsReport` and a test `Map` provide. */
export interface StatsReportLike {
  forEach(callback: (value: unknown, key: string) => void): void;
}

type Entry = Record<string, unknown>;

interface Indexed {
  all: Entry[];
  byId: Map<string, Entry>;
}

function isEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null;
}

function indexReport(report: StatsReportLike): Indexed {
  const all: Entry[] = [];
  const byId = new Map<string, Entry>();
  report.forEach((value, key) => {
    if (!isEntry(value)) return;
    all.push(value);
    byId.set(typeof value.id === 'string' ? value.id : key, value);
  });
  return { all, byId };
}

function num(entry: Entry | null | undefined, key: string): number | null {
  const value = entry?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(entry: Entry | null | undefined, key: string): string | null {
  const value = entry?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bool(entry: Entry | null | undefined, key: string): boolean | null {
  const value = entry?.[key];
  return typeof value === 'boolean' ? value : null;
}

function isVideo(entry: Entry): boolean {
  // `kind` is the current name; very old Chromium only had `mediaType`.
  return (str(entry, 'kind') ?? str(entry, 'mediaType')) === 'video';
}

function linked(index: Indexed, entry: Entry | null | undefined, key: string): Entry | null {
  const id = str(entry, key);
  return id ? (index.byId.get(id) ?? null) : null;
}

/** The candidate pair in use: the transport's selected pair, else a nominated succeeded one. */
function selectedPair(index: Indexed): Entry | null {
  for (const entry of index.all) {
    if (entry.type !== 'transport') continue;
    const pair = linked(index, entry, 'selectedCandidatePairId');
    if (pair) return pair;
  }
  const pairs = index.all.filter((entry) => entry.type === 'candidate-pair');
  return (
    pairs.find((pair) => bool(pair, 'selected') === true) ??
    pairs.find((pair) => bool(pair, 'nominated') === true && pair.state === 'succeeded') ??
    null
  );
}

function connectionOf(index: Indexed, pair: Entry | null): ConnectionKind | null {
  const local = linked(index, pair, 'localCandidateId');
  if (!local) return null;
  if (str(local, 'candidateType') === 'relay') return 'relay';
  const protocol = str(local, 'protocol');
  if (protocol === 'tcp') return 'tcp';
  if (protocol === 'udp') return 'udp';
  return null;
}

function secondsToMs(seconds: number | null): number | null {
  return seconds === null ? null : seconds * 1000;
}

// ---------------------------------------------------------------------------------------------
// Receiver side
// ---------------------------------------------------------------------------------------------

/** One reading of a subscribed video (counters are cumulative since the receiver started). */
export interface InboundVideoSample {
  /** `RTCStats.timestamp` (ms); only differences are meaningful. */
  timestamp: number;
  packetsReceived: number;
  packetsLost: number;
  bytesReceived: number;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number | null;
  /** Seconds. */
  totalFreezesDuration: number | null;
  pauseCount: number | null;
  keyFramesDecoded: number;
  nackCount: number;
  pliCount: number;
  firCount: number;
  /** Seconds. */
  jitter: number | null;
  /** Seconds, cumulative over `jitterBufferEmittedCount` frames. */
  jitterBufferDelay: number | null;
  jitterBufferEmittedCount: number | null;
  /** Seconds, cumulative over `framesDecoded`. */
  totalDecodeTime: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  /** "video/H264". */
  codec: string | null;
  decoderImplementation: string | null;
  powerEfficientDecoder: boolean | null;
  /** ICE round trip of the selected candidate pair. */
  rttMs: number | null;
  connection: ConnectionKind | null;
}

/** The video `inbound-rtp` of a receiver report (the busiest one); null when there is none. */
export function parseInboundVideo(report: StatsReportLike): InboundVideoSample | null {
  const index = indexReport(report);
  let inbound: Entry | null = null;
  for (const entry of index.all) {
    if (entry.type !== 'inbound-rtp' || !isVideo(entry)) continue;
    if (!inbound || (num(entry, 'bytesReceived') ?? 0) > (num(inbound, 'bytesReceived') ?? 0)) {
      inbound = entry;
    }
  }
  if (!inbound) return null;
  const pair = selectedPair(index);
  return {
    timestamp: num(inbound, 'timestamp') ?? 0,
    packetsReceived: num(inbound, 'packetsReceived') ?? 0,
    packetsLost: num(inbound, 'packetsLost') ?? 0,
    bytesReceived: num(inbound, 'bytesReceived') ?? 0,
    framesReceived: num(inbound, 'framesReceived') ?? 0,
    framesDecoded: num(inbound, 'framesDecoded') ?? 0,
    framesDropped: num(inbound, 'framesDropped') ?? 0,
    freezeCount: num(inbound, 'freezeCount'),
    totalFreezesDuration: num(inbound, 'totalFreezesDuration'),
    pauseCount: num(inbound, 'pauseCount'),
    keyFramesDecoded: num(inbound, 'keyFramesDecoded') ?? 0,
    nackCount: num(inbound, 'nackCount') ?? 0,
    pliCount: num(inbound, 'pliCount') ?? 0,
    firCount: num(inbound, 'firCount') ?? 0,
    jitter: num(inbound, 'jitter'),
    jitterBufferDelay: num(inbound, 'jitterBufferDelay'),
    jitterBufferEmittedCount: num(inbound, 'jitterBufferEmittedCount'),
    totalDecodeTime: num(inbound, 'totalDecodeTime'),
    frameWidth: num(inbound, 'frameWidth'),
    frameHeight: num(inbound, 'frameHeight'),
    framesPerSecond: num(inbound, 'framesPerSecond'),
    codec: str(linked(index, inbound, 'codecId'), 'mimeType'),
    decoderImplementation: str(inbound, 'decoderImplementation'),
    powerEfficientDecoder: bool(inbound, 'powerEfficientDecoder'),
    rttMs: secondsToMs(num(pair, 'currentRoundTripTime')),
    connection: connectionOf(index, pair),
  };
}

/** One second (or so) of a subscribed video: deltas between two samples and their rates. */
export interface InboundPoint {
  /** `Date.now()` when the second sample was taken. */
  at: number;
  /** Time between the two samples. */
  seconds: number;
  packetsReceived: number;
  packetsLost: number;
  /** Lost / (lost + received); null without packets. */
  lossPercent: number | null;
  /** Bits per second. */
  bitrate: number;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  fpsReceived: number;
  fpsDecoded: number;
  droppedPerSecond: number;
  freezes: number;
  freezeSeconds: number;
  pauses: number;
  nacks: number;
  plis: number;
  firs: number;
  keyFrames: number;
  decodeSeconds: number | null;
  /** Average decode time per frame in this interval. */
  decodeMs: number | null;
  jitterBufferSeconds: number | null;
  jitterBufferEmitted: number | null;
  /** Average time a frame waited in the jitter buffer in this interval. */
  jitterBufferMs: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  width: number | null;
  height: number | null;
}

/** Minimum time between two samples for a meaningful rate. */
const MIN_INTERVAL_MS = 250;

function delta(next: number, prev: number): number {
  return Math.max(0, next - prev);
}

function nullableDelta(next: number | null, prev: number | null): number | null {
  return next === null || prev === null ? null : Math.max(0, next - prev);
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * The point between two samples of the same receiver; null when they are too close or the
 * counters went backwards (a new receiver: the next sample starts over).
 */
export function deriveInboundPoint(
  prev: InboundVideoSample | null,
  next: InboundVideoSample,
  at: number,
): InboundPoint | null {
  if (!prev) return null;
  const elapsedMs = next.timestamp - prev.timestamp;
  if (elapsedMs < MIN_INTERVAL_MS) return null;
  if (next.bytesReceived < prev.bytesReceived || next.packetsReceived < prev.packetsReceived) {
    return null;
  }
  const seconds = elapsedMs / 1000;
  const packetsReceived = delta(next.packetsReceived, prev.packetsReceived);
  // packetsLost can go down when late packets arrive; never below zero per interval.
  const packetsLost = delta(next.packetsLost, prev.packetsLost);
  const packets = packetsReceived + packetsLost;
  const framesReceived = delta(next.framesReceived, prev.framesReceived);
  const framesDecoded = delta(next.framesDecoded, prev.framesDecoded);
  const framesDropped = delta(next.framesDropped, prev.framesDropped);
  const decodeSeconds = nullableDelta(next.totalDecodeTime, prev.totalDecodeTime);
  const jitterBufferSeconds = nullableDelta(next.jitterBufferDelay, prev.jitterBufferDelay);
  const jitterBufferEmitted = nullableDelta(
    next.jitterBufferEmittedCount,
    prev.jitterBufferEmittedCount,
  );
  const decodePerFrame = ratio(decodeSeconds, framesDecoded);
  const bufferPerFrame = ratio(jitterBufferSeconds, jitterBufferEmitted);
  return {
    at,
    seconds,
    packetsReceived,
    packetsLost,
    lossPercent: packets > 0 ? (packetsLost / packets) * 100 : null,
    bitrate: (delta(next.bytesReceived, prev.bytesReceived) * 8) / seconds,
    framesReceived,
    framesDecoded,
    framesDropped,
    fpsReceived: framesReceived / seconds,
    fpsDecoded: framesDecoded / seconds,
    droppedPerSecond: framesDropped / seconds,
    freezes: nullableDelta(next.freezeCount, prev.freezeCount) ?? 0,
    freezeSeconds: nullableDelta(next.totalFreezesDuration, prev.totalFreezesDuration) ?? 0,
    pauses: nullableDelta(next.pauseCount, prev.pauseCount) ?? 0,
    nacks: delta(next.nackCount, prev.nackCount),
    plis: delta(next.pliCount, prev.pliCount),
    firs: delta(next.firCount, prev.firCount),
    keyFrames: delta(next.keyFramesDecoded, prev.keyFramesDecoded),
    decodeSeconds,
    decodeMs: secondsToMs(decodePerFrame),
    jitterBufferSeconds,
    jitterBufferEmitted,
    jitterBufferMs: secondsToMs(bufferPerFrame),
    jitterMs: secondsToMs(next.jitter),
    rttMs: next.rttMs,
    width: next.frameWidth,
    height: next.frameHeight,
  };
}

/** Totals and averages of the receiver points after `from` (e.g. the last 30 s). */
export interface InboundWindow {
  seconds: number;
  packetsReceived: number;
  packetsLost: number;
  lossPercent: number | null;
  bitrate: number | null;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  fpsReceived: number | null;
  fpsDecoded: number | null;
  freezes: number;
  freezeSeconds: number;
  pauses: number;
  nacks: number;
  plis: number;
  firs: number;
  keyFrames: number;
  decodeMs: number | null;
  jitterBufferMs: number | null;
}

function sumOf<T>(items: readonly T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}

/** Sum of the non-null values and how many there were. */
function nullableSum<T>(items: readonly T[], pick: (item: T) => number | null) {
  let total = 0;
  let count = 0;
  for (const item of items) {
    const value = pick(item);
    if (value === null) continue;
    total += value;
    count += 1;
  }
  return { total, count };
}

function average<T>(items: readonly T[], pick: (item: T) => number | null): number | null {
  const { total, count } = nullableSum(items, pick);
  return count > 0 ? total / count : null;
}

/** Null when no point is newer than `from`. */
export function summarizeInbound(
  points: readonly InboundPoint[],
  from: number,
): InboundWindow | null {
  const inside = points.filter((point) => point.at > from);
  if (inside.length === 0) return null;
  const seconds = sumOf(inside, (p) => p.seconds);
  const packetsReceived = sumOf(inside, (p) => p.packetsReceived);
  const packetsLost = sumOf(inside, (p) => p.packetsLost);
  const framesReceived = sumOf(inside, (p) => p.framesReceived);
  const framesDecoded = sumOf(inside, (p) => p.framesDecoded);
  const packets = packetsReceived + packetsLost;
  const decode = nullableSum(inside, (p) => p.decodeSeconds);
  const decodedWithTime = sumOf(inside, (p) => (p.decodeSeconds === null ? 0 : p.framesDecoded));
  const buffer = nullableSum(inside, (p) => p.jitterBufferSeconds);
  const emitted = nullableSum(inside, (p) => p.jitterBufferEmitted);
  return {
    seconds,
    packetsReceived,
    packetsLost,
    lossPercent: packets > 0 ? (packetsLost / packets) * 100 : null,
    bitrate: seconds > 0 ? sumOf(inside, (p) => p.bitrate * p.seconds) / seconds : null,
    framesReceived,
    framesDecoded,
    framesDropped: sumOf(inside, (p) => p.framesDropped),
    fpsReceived: seconds > 0 ? framesReceived / seconds : null,
    fpsDecoded: seconds > 0 ? framesDecoded / seconds : null,
    freezes: sumOf(inside, (p) => p.freezes),
    freezeSeconds: sumOf(inside, (p) => p.freezeSeconds),
    pauses: sumOf(inside, (p) => p.pauses),
    nacks: sumOf(inside, (p) => p.nacks),
    plis: sumOf(inside, (p) => p.plis),
    firs: sumOf(inside, (p) => p.firs),
    keyFrames: sumOf(inside, (p) => p.keyFrames),
    decodeMs:
      decode.count > 0 && decodedWithTime > 0 ? (decode.total / decodedWithTime) * 1000 : null,
    jitterBufferMs:
      buffer.count > 0 && emitted.total > 0 ? (buffer.total / emitted.total) * 1000 : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Sender side
// ---------------------------------------------------------------------------------------------

/** What the SFU reported back about one layer (RTCP receiver reports). */
export interface RemoteInboundSample {
  /** 0–1, over the last report interval. */
  fractionLost: number | null;
  roundTripTimeMs: number | null;
  packetsLost: number | null;
}

/** One simulcast layer (`outbound-rtp`) of the local video. */
export interface OutboundLayerSample {
  /** Matches the same layer across samples: rid, else ssrc, else the stats id. */
  key: string;
  /** livekit's "q" (low), "h", "f" (high); null without simulcast. */
  rid: string | null;
  /** False when dynacast paused the layer (nobody watches it). */
  active: boolean | null;
  bytesSent: number;
  packetsSent: number;
  framesEncoded: number;
  framesSent: number;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  qualityLimitationReason: QualityLimitation | null;
  qualityLimitationDurations: LimitationDurations | null;
  encoderImplementation: string | null;
  powerEfficientEncoder: boolean | null;
  /** Bits per second the encoder aims for right now. */
  targetBitrate: number | null;
  /** Seconds, cumulative over `framesEncoded`. */
  totalEncodeTime: number | null;
  qpSum: number | null;
  hugeFramesSent: number;
  nackCount: number;
  pliCount: number;
  firCount: number;
  keyFramesEncoded: number;
  /** "video/H264". */
  codec: string | null;
  remote: RemoteInboundSample | null;
}

/** The capture feeding the sender (`media-source`). */
export interface MediaSourceSample {
  /** Frames captured since the track started; null when the browser does not report it. */
  frames: number | null;
  framesPerSecond: number | null;
  width: number | null;
  height: number | null;
}

/** One reading of the local video's sender. */
export interface OutboundVideoSample {
  timestamp: number;
  source: MediaSourceSample | null;
  /** Lowest layer first. */
  layers: OutboundLayerSample[];
  /** Bits per second the congestion controller thinks the uplink takes. */
  availableOutgoingBitrate: number | null;
  rttMs: number | null;
  connection: ConnectionKind | null;
}

const LIMITATIONS: readonly QualityLimitation[] = ['none', 'cpu', 'bandwidth', 'other'];

function limitationOf(value: unknown): QualityLimitation | null {
  return LIMITATIONS.find((limitation) => limitation === value) ?? null;
}

function durationsOf(value: unknown): LimitationDurations | null {
  if (!isEntry(value)) return null;
  return {
    none: num(value, 'none') ?? 0,
    cpu: num(value, 'cpu') ?? 0,
    bandwidth: num(value, 'bandwidth') ?? 0,
    other: num(value, 'other') ?? 0,
  };
}

/** livekit's simulcast rids from the lowest to the highest layer. */
const RID_ORDER = ['q', 'h', 'f'];

function compareLayers(a: OutboundLayerSample, b: OutboundLayerSample): number {
  const rankA = a.rid === null ? -1 : RID_ORDER.indexOf(a.rid);
  const rankB = b.rid === null ? -1 : RID_ORDER.indexOf(b.rid);
  if (rankA >= 0 && rankB >= 0) return rankA - rankB;
  return (a.frameWidth ?? 0) - (b.frameWidth ?? 0);
}

function remoteInboundFor(index: Indexed, outbound: Entry): RemoteInboundSample | null {
  const id = str(outbound, 'id');
  const ssrc = num(outbound, 'ssrc');
  const remote = index.all.find(
    (entry) =>
      entry.type === 'remote-inbound-rtp' &&
      ((id !== null && entry.localId === id) || (ssrc !== null && num(entry, 'ssrc') === ssrc)),
  );
  if (!remote) return null;
  return {
    fractionLost: num(remote, 'fractionLost'),
    roundTripTimeMs: secondsToMs(num(remote, 'roundTripTime')),
    packetsLost: num(remote, 'packetsLost'),
  };
}

function parseLayer(index: Indexed, entry: Entry): OutboundLayerSample {
  const rid = str(entry, 'rid');
  const ssrc = num(entry, 'ssrc');
  return {
    key: rid ?? (ssrc !== null ? String(ssrc) : (str(entry, 'id') ?? '')),
    rid,
    active: bool(entry, 'active'),
    bytesSent: num(entry, 'bytesSent') ?? 0,
    packetsSent: num(entry, 'packetsSent') ?? 0,
    framesEncoded: num(entry, 'framesEncoded') ?? 0,
    framesSent: num(entry, 'framesSent') ?? 0,
    frameWidth: num(entry, 'frameWidth'),
    frameHeight: num(entry, 'frameHeight'),
    framesPerSecond: num(entry, 'framesPerSecond'),
    qualityLimitationReason: limitationOf(entry.qualityLimitationReason),
    qualityLimitationDurations: durationsOf(entry.qualityLimitationDurations),
    encoderImplementation: str(entry, 'encoderImplementation'),
    powerEfficientEncoder: bool(entry, 'powerEfficientEncoder'),
    targetBitrate: num(entry, 'targetBitrate'),
    totalEncodeTime: num(entry, 'totalEncodeTime'),
    qpSum: num(entry, 'qpSum'),
    hugeFramesSent: num(entry, 'hugeFramesSent') ?? 0,
    nackCount: num(entry, 'nackCount') ?? 0,
    pliCount: num(entry, 'pliCount') ?? 0,
    firCount: num(entry, 'firCount') ?? 0,
    keyFramesEncoded: num(entry, 'keyFramesEncoded') ?? 0,
    codec: str(linked(index, entry, 'codecId'), 'mimeType'),
    remote: remoteInboundFor(index, entry),
  };
}

/** The video side of a sender report; null when it has no video outbound-rtp yet. */
export function parseOutboundVideo(report: StatsReportLike): OutboundVideoSample | null {
  const index = indexReport(report);
  const outbound = index.all.filter((entry) => entry.type === 'outbound-rtp' && isVideo(entry));
  const first = outbound[0];
  if (!first) return null;
  const sourceEntry =
    linked(index, first, 'mediaSourceId') ??
    index.all.find((entry) => entry.type === 'media-source' && isVideo(entry)) ??
    null;
  const pair = selectedPair(index);
  return {
    timestamp: num(first, 'timestamp') ?? 0,
    source: sourceEntry
      ? {
          frames: num(sourceEntry, 'frames'),
          framesPerSecond: num(sourceEntry, 'framesPerSecond'),
          width: num(sourceEntry, 'width'),
          height: num(sourceEntry, 'height'),
        }
      : null,
    layers: outbound.map((entry) => parseLayer(index, entry)).sort(compareLayers),
    availableOutgoingBitrate: num(pair, 'availableOutgoingBitrate'),
    rttMs: secondsToMs(num(pair, 'currentRoundTripTime')),
    connection: connectionOf(index, pair),
  };
}

const SOFTWARE_CODECS = /openh264|libvpx|libaom|ffmpeg|dav1d|svt|libx26/i;
const HARDWARE_CODECS =
  /external|mediafoundation|d3d11|dxva|nvenc|nvdec|vaapi|videotoolbox|qsv|amf|v4l2|accelerat/i;

/**
 * Whether a codec implementation runs on the GPU: `powerEfficient*` when the browser reports it,
 * else from the name ("OpenH264", "libvpx" → software; "ExternalEncoder",
 * "MediaFoundationVideoEncodeAccelerator", "D3D11VideoDecoder" → hardware). Any software
 * part of a "SimulcastEncoderAdapter (…, …)" counts as software. Null when unknown.
 */
export function isHardwareCodec(
  implementation: string | null,
  powerEfficient: boolean | null,
): boolean | null {
  if (powerEfficient !== null) return powerEfficient;
  if (!implementation) return null;
  if (SOFTWARE_CODECS.test(implementation)) return false;
  if (HARDWARE_CODECS.test(implementation)) return true;
  return null;
}

/** One simulcast layer in a sender point. */
export interface OutboundLayerPoint {
  rid: string | null;
  /** Encoded frames in this interval (or not paused by dynacast). */
  active: boolean;
  width: number | null;
  height: number | null;
  encodeFps: number;
  sentFps: number;
  bitrate: number;
  targetBitrate: number | null;
  limitation: QualityLimitation | null;
}

/** One second (or so) of the local video's sender. */
export interface OutboundPoint {
  at: number;
  seconds: number;
  /** Frames the capture delivered in this interval; null when not reported. */
  framesCaptured: number | null;
  captureFps: number | null;
  captureWidth: number | null;
  captureHeight: number | null;
  /** The highest layer that is encoding (the one the fps refer to). */
  topRid: string | null;
  framesEncoded: number;
  framesSent: number;
  encodeFps: number | null;
  sentFps: number | null;
  width: number | null;
  height: number | null;
  /** All layers, bits per second. */
  bitrate: number;
  /** Sum of the active layers' targets. */
  targetBitrate: number | null;
  encodeSeconds: number | null;
  encodeMs: number | null;
  qpSum: number | null;
  qp: number | null;
  limitation: QualityLimitation | null;
  /** Seconds the top layer spent limited in this interval. */
  limited: LimitationDurations | null;
  cpuShare: number | null;
  bandwidthShare: number | null;
  hugeFrames: number;
  nacks: number;
  plis: number;
  keyFrames: number;
  /** Loss the SFU reported for what you send (packet-weighted over the layers). */
  remoteLossPercent: number | null;
  rttMs: number | null;
  uplink: number | null;
  connection: ConnectionKind | null;
  encoder: string | null;
  hardware: boolean | null;
  codec: string | null;
  layers: OutboundLayerPoint[];
}

interface LayerDelta {
  next: OutboundLayerSample;
  /** The same layer in the previous sample; null when it is new or its counters restarted. */
  before: OutboundLayerSample | null;
  framesEncoded: number;
  framesSent: number;
  bytesSent: number;
  packetsSent: number;
}

function layerDeltas(prev: OutboundVideoSample, next: OutboundVideoSample): LayerDelta[] {
  return next.layers.map((layer) => {
    const found = prev.layers.find((candidate) => candidate.key === layer.key);
    const before =
      found && layer.framesEncoded >= found.framesEncoded && layer.bytesSent >= found.bytesSent
        ? found
        : null;
    return {
      next: layer,
      before,
      framesEncoded: before ? delta(layer.framesEncoded, before.framesEncoded) : 0,
      framesSent: before ? delta(layer.framesSent, before.framesSent) : 0,
      bytesSent: before ? delta(layer.bytesSent, before.bytesSent) : 0,
      packetsSent: before ? delta(layer.packetsSent, before.packetsSent) : 0,
    };
  });
}

/** Delta of a cumulative layer counter; 0 for a new layer. */
function counterDelta(d: LayerDelta, pick: (layer: OutboundLayerSample) => number): number {
  return d.before ? delta(pick(d.next), pick(d.before)) : 0;
}

function durationsDelta(
  next: LimitationDurations | null,
  prev: LimitationDurations | null,
): LimitationDurations | null {
  if (!next || !prev) return null;
  return {
    none: delta(next.none, prev.none),
    cpu: delta(next.cpu, prev.cpu),
    bandwidth: delta(next.bandwidth, prev.bandwidth),
    other: delta(next.other, prev.other),
  };
}

function limitedTotal(limited: LimitationDurations): number {
  return limited.none + limited.cpu + limited.bandwidth + limited.other;
}

/** The point between two samples of the same sender; null when they are too close. */
export function deriveOutboundPoint(
  prev: OutboundVideoSample | null,
  next: OutboundVideoSample,
  at: number,
): OutboundPoint | null {
  if (!prev) return null;
  const elapsedMs = next.timestamp - prev.timestamp;
  if (elapsedMs < MIN_INTERVAL_MS) return null;
  const seconds = elapsedMs / 1000;
  const deltas = layerDeltas(prev, next);
  const enabled = deltas.filter((d) => d.next.active !== false);
  // The fps refer to the highest layer that is encoding (dynacast pauses unwatched layers).
  const top = enabled.filter((d) => d.framesEncoded > 0).at(-1) ?? enabled.at(-1) ?? deltas.at(-1);
  const before = top?.before ?? null;

  const prevFrames = prev.source?.frames ?? null;
  const nextFrames = next.source?.frames ?? null;
  const framesCaptured =
    prevFrames !== null && nextFrames !== null && nextFrames >= prevFrames
      ? nextFrames - prevFrames
      : null;

  const framesEncoded = top?.framesEncoded ?? 0;
  const encodeSeconds =
    top && before ? nullableDelta(top.next.totalEncodeTime, before.totalEncodeTime) : null;
  const qpSum = top && before ? nullableDelta(top.next.qpSum, before.qpSum) : null;
  const limited =
    top && before
      ? durationsDelta(top.next.qualityLimitationDurations, before.qualityLimitationDurations)
      : null;
  const limitedSeconds = limited ? limitedTotal(limited) : 0;
  const targets = nullableSum(enabled, (d) => d.next.targetBitrate);

  let lossWeighted = 0;
  let lossPackets = 0;
  for (const d of deltas) {
    const fraction = d.next.remote?.fractionLost ?? null;
    if (fraction === null || d.packetsSent === 0) continue;
    lossWeighted += fraction * d.packetsSent;
    lossPackets += d.packetsSent;
  }
  const remoteRtt =
    deltas.map((d) => d.next.remote?.roundTripTimeMs ?? null).find((ms) => ms !== null) ?? null;

  return {
    at,
    seconds,
    framesCaptured,
    captureFps:
      framesCaptured !== null ? framesCaptured / seconds : (next.source?.framesPerSecond ?? null),
    captureWidth: next.source?.width ?? null,
    captureHeight: next.source?.height ?? null,
    topRid: top?.next.rid ?? null,
    framesEncoded,
    framesSent: top?.framesSent ?? 0,
    encodeFps: top ? framesEncoded / seconds : null,
    sentFps: top ? top.framesSent / seconds : null,
    width: top?.next.frameWidth ?? null,
    height: top?.next.frameHeight ?? null,
    bitrate: (sumOf(deltas, (d) => d.bytesSent) * 8) / seconds,
    targetBitrate: targets.count > 0 ? targets.total : null,
    encodeSeconds,
    encodeMs: secondsToMs(ratio(encodeSeconds, framesEncoded)),
    qpSum,
    qp: ratio(qpSum, framesEncoded),
    limitation: top?.next.qualityLimitationReason ?? null,
    limited,
    cpuShare: limited && limitedSeconds > 0 ? limited.cpu / limitedSeconds : null,
    bandwidthShare: limited && limitedSeconds > 0 ? limited.bandwidth / limitedSeconds : null,
    hugeFrames: sumOf(deltas, (d) => counterDelta(d, (layer) => layer.hugeFramesSent)),
    nacks: sumOf(deltas, (d) => counterDelta(d, (layer) => layer.nackCount)),
    plis: sumOf(deltas, (d) => counterDelta(d, (layer) => layer.pliCount)),
    keyFrames: top ? counterDelta(top, (layer) => layer.keyFramesEncoded) : 0,
    remoteLossPercent: lossPackets > 0 ? (lossWeighted / lossPackets) * 100 : null,
    rttMs: next.rttMs ?? remoteRtt,
    uplink: next.availableOutgoingBitrate,
    connection: next.connection,
    encoder: top?.next.encoderImplementation ?? null,
    hardware: top
      ? isHardwareCodec(top.next.encoderImplementation, top.next.powerEfficientEncoder)
      : null,
    codec: top?.next.codec ?? null,
    layers: deltas.map((d) => ({
      rid: d.next.rid,
      active: d.next.active !== false && d.framesEncoded > 0,
      width: d.next.frameWidth,
      height: d.next.frameHeight,
      encodeFps: d.framesEncoded / seconds,
      sentFps: d.framesSent / seconds,
      bitrate: (d.bytesSent * 8) / seconds,
      targetBitrate: d.next.targetBitrate,
      limitation: d.next.qualityLimitationReason,
    })),
  };
}

/** Totals and averages of the sender points after `from`. */
export interface OutboundWindow {
  seconds: number;
  captureFps: number | null;
  encodeFps: number | null;
  sentFps: number | null;
  bitrate: number | null;
  targetBitrate: number | null;
  encodeMs: number | null;
  qp: number | null;
  /** Share (0–1) of the time the top layer was limited by CPU / bandwidth. */
  cpuShare: number | null;
  bandwidthShare: number | null;
  hugeFrames: number;
  nacks: number;
  plis: number;
  keyFrames: number;
  remoteLossPercent: number | null;
  rttMs: number | null;
  uplink: number | null;
  /** Per layer (lowest first, as in the last point), averaged over the window. */
  layers: OutboundLayerWindow[];
}

/** One simulcast layer averaged over a window. */
export interface OutboundLayerWindow {
  rid: string | null;
  /** Encoded at least one frame in the window. */
  active: boolean;
  width: number | null;
  height: number | null;
  encodeFps: number;
  sentFps: number;
  bitrate: number;
  targetBitrate: number | null;
  limitation: QualityLimitation | null;
}

function summarizeLayers(inside: readonly OutboundPoint[]): OutboundLayerWindow[] {
  const last = inside.at(-1);
  if (!last) return [];
  return last.layers.map((layer) => {
    const samples = inside.flatMap((point) =>
      point.layers
        .filter((candidate) => candidate.rid === layer.rid)
        .map((found) => ({ seconds: point.seconds, layer: found })),
    );
    const seconds = sumOf(samples, (s) => s.seconds);
    const weighted = (pick: (l: OutboundLayerPoint) => number): number =>
      seconds > 0 ? sumOf(samples, (s) => pick(s.layer) * s.seconds) / seconds : 0;
    return {
      rid: layer.rid,
      active: samples.some((s) => s.layer.active),
      width: layer.width,
      height: layer.height,
      encodeFps: weighted((l) => l.encodeFps),
      sentFps: weighted((l) => l.sentFps),
      bitrate: weighted((l) => l.bitrate),
      targetBitrate: layer.targetBitrate,
      limitation: layer.limitation,
    };
  });
}

/** Null when no point is newer than `from`. */
export function summarizeOutbound(
  points: readonly OutboundPoint[],
  from: number,
): OutboundWindow | null {
  const inside = points.filter((point) => point.at > from);
  if (inside.length === 0) return null;
  const seconds = sumOf(inside, (p) => p.seconds);
  const captured = inside.filter((p) => p.framesCaptured !== null);
  const capturedSeconds = sumOf(captured, (p) => p.seconds);
  const framesEncoded = sumOf(inside, (p) => p.framesEncoded);
  const encode = nullableSum(inside, (p) => p.encodeSeconds);
  const encodedWithTime = sumOf(inside, (p) => (p.encodeSeconds === null ? 0 : p.framesEncoded));
  const qp = nullableSum(inside, (p) => p.qpSum);
  const encodedWithQp = sumOf(inside, (p) => (p.qpSum === null ? 0 : p.framesEncoded));
  const limited = inside.flatMap((p) => (p.limited ? [p.limited] : []));
  const limitedSeconds = sumOf(limited, limitedTotal);
  return {
    seconds,
    captureFps:
      captured.length > 0 && capturedSeconds > 0
        ? sumOf(captured, (p) => p.framesCaptured ?? 0) / capturedSeconds
        : average(inside, (p) => p.captureFps),
    encodeFps: seconds > 0 ? framesEncoded / seconds : null,
    sentFps: seconds > 0 ? sumOf(inside, (p) => p.framesSent) / seconds : null,
    bitrate: seconds > 0 ? sumOf(inside, (p) => p.bitrate * p.seconds) / seconds : null,
    targetBitrate: average(inside, (p) => p.targetBitrate),
    encodeMs:
      encode.count > 0 && encodedWithTime > 0 ? (encode.total / encodedWithTime) * 1000 : null,
    qp: qp.count > 0 && encodedWithQp > 0 ? qp.total / encodedWithQp : null,
    cpuShare: limitedSeconds > 0 ? sumOf(limited, (l) => l.cpu) / limitedSeconds : null,
    bandwidthShare: limitedSeconds > 0 ? sumOf(limited, (l) => l.bandwidth) / limitedSeconds : null,
    hugeFrames: sumOf(inside, (p) => p.hugeFrames),
    nacks: sumOf(inside, (p) => p.nacks),
    plis: sumOf(inside, (p) => p.plis),
    keyFrames: sumOf(inside, (p) => p.keyFrames),
    remoteLossPercent: average(inside, (p) => p.remoteLossPercent),
    rttMs: average(inside, (p) => p.rttMs),
    uplink: average(inside, (p) => p.uplink),
    layers: summarizeLayers(inside),
  };
}

/** Appends a point and drops what fell out of the 30 s window (plus one older point). */
export function appendPoint<T extends { at: number }>(
  history: readonly T[],
  point: T,
  windowMs: number = STATS_HISTORY_MS,
): T[] {
  return trimHistory([...history, point], point.at, windowMs);
}

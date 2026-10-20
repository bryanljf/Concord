import { describe, expect, it } from 'vitest';
import {
  appendPoint,
  deriveInboundPoint,
  deriveOutboundPoint,
  isHardwareCodec,
  parseInboundVideo,
  parseOutboundVideo,
  summarizeInbound,
  summarizeOutbound,
  type InboundPoint,
  type OutboundPoint,
} from './rtcStats';

type Stats = Record<string, unknown>;

/** A Chrome-like report: a Map from stats id to the stats object. */
function report(...entries: Stats[]): Map<string, Stats> {
  return new Map(entries.map((entry) => [entry.id as string, entry]));
}

function network(options: {
  protocol?: 'udp' | 'tcp';
  candidateType?: string;
  selected?: boolean;
  rtt?: number;
  availableOutgoingBitrate?: number;
}): Stats[] {
  const { protocol = 'udp', candidateType = 'host', selected = true, rtt = 0.035 } = options;
  return [
    {
      id: 'T01',
      type: 'transport',
      dtlsState: 'connected',
      ...(selected ? { selectedCandidatePairId: 'CPgood' } : {}),
    },
    // A pair that failed: never the one in use.
    {
      id: 'CPbad',
      type: 'candidate-pair',
      state: 'failed',
      nominated: false,
      localCandidateId: 'Irelay',
      remoteCandidateId: 'Iremote',
      currentRoundTripTime: 0.9,
    },
    {
      id: 'CPgood',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'Ilocal',
      remoteCandidateId: 'Iremote',
      currentRoundTripTime: rtt,
      ...(options.availableOutgoingBitrate !== undefined
        ? { availableOutgoingBitrate: options.availableOutgoingBitrate }
        : {}),
    },
    { id: 'Ilocal', type: 'local-candidate', candidateType, protocol, address: '192.168.0.10' },
    { id: 'Irelay', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
    { id: 'Iremote', type: 'remote-candidate', candidateType: 'host', protocol },
  ];
}

interface InboundCounters {
  timestamp: number;
  packetsReceived: number;
  packetsLost: number;
  bytesReceived: number;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  totalFreezesDuration: number;
  totalDecodeTime: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
}

function receiverReport(counters: InboundCounters, extra: Stats = {}, net: Stats[] = network({})) {
  return report(
    {
      id: 'IT01A1',
      type: 'inbound-rtp',
      kind: 'audio',
      timestamp: counters.timestamp,
      bytesReceived: 99_999_999,
      packetsReceived: 99_999,
    },
    {
      id: 'IT01V1',
      type: 'inbound-rtp',
      kind: 'video',
      ssrc: 1234,
      transportId: 'T01',
      codecId: 'CIT01_102',
      pauseCount: 0,
      keyFramesDecoded: 3,
      nackCount: 10,
      pliCount: 1,
      firCount: 0,
      jitter: 0.004,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 30,
      decoderImplementation: 'D3D11VideoDecoder',
      powerEfficientDecoder: true,
      ...counters,
      ...extra,
    },
    { id: 'CIT01_102', type: 'codec', mimeType: 'video/H264', payloadType: 102 },
    ...net,
  );
}

const BASE_IN: InboundCounters = {
  timestamp: 1_000_000,
  packetsReceived: 10_000,
  packetsLost: 10,
  bytesReceived: 5_000_000,
  framesReceived: 900,
  framesDecoded: 898,
  framesDropped: 1,
  freezeCount: 0,
  totalFreezesDuration: 0,
  totalDecodeTime: 2.7,
  jitterBufferDelay: 45,
  jitterBufferEmittedCount: 900,
};

const NEXT_IN: InboundCounters = {
  timestamp: 1_001_000,
  packetsReceived: 10_490,
  packetsLost: 20,
  bytesReceived: 5_500_000,
  framesReceived: 930,
  framesDecoded: 926,
  framesDropped: 3,
  freezeCount: 1,
  totalFreezesDuration: 0.4,
  totalDecodeTime: 2.784,
  jitterBufferDelay: 46.5,
  jitterBufferEmittedCount: 930,
};

describe('parseInboundVideo', () => {
  it('reads the video inbound-rtp, its codec and the selected candidate pair', () => {
    const sample = parseInboundVideo(receiverReport(BASE_IN));
    expect(sample).toMatchObject({
      timestamp: 1_000_000,
      packetsReceived: 10_000,
      packetsLost: 10,
      bytesReceived: 5_000_000,
      framesDecoded: 898,
      freezeCount: 0,
      jitter: 0.004,
      frameWidth: 1920,
      frameHeight: 1080,
      codec: 'video/H264',
      decoderImplementation: 'D3D11VideoDecoder',
      powerEfficientDecoder: true,
      rttMs: 35,
      connection: 'udp',
    });
  });

  it('leaves fields the browser does not fill as null', () => {
    const sample = parseInboundVideo(
      receiverReport(BASE_IN, { decoderImplementation: undefined, powerEfficientDecoder: 'x' }),
    );
    expect(sample?.decoderImplementation).toBeNull();
    expect(sample?.powerEfficientDecoder).toBeNull();
  });

  it('falls back to the nominated succeeded pair and classifies TCP and TURN', () => {
    const tcp = parseInboundVideo(
      receiverReport(BASE_IN, {}, network({ selected: false, protocol: 'tcp', rtt: 0.08 })),
    );
    expect(tcp?.connection).toBe('tcp');
    expect(tcp?.rttMs).toBe(80);
    const relay = parseInboundVideo(
      receiverReport(BASE_IN, {}, network({ candidateType: 'relay' })),
    );
    expect(relay?.connection).toBe('relay');
  });

  it('returns null without a video inbound-rtp', () => {
    expect(parseInboundVideo(report({ id: 'A', type: 'inbound-rtp', kind: 'audio' }))).toBeNull();
    expect(parseInboundVideo(new Map())).toBeNull();
  });
});

describe('deriveInboundPoint', () => {
  const prev = parseInboundVideo(receiverReport(BASE_IN));
  const next = parseInboundVideo(receiverReport(NEXT_IN));

  it('turns two samples into per-second rates', () => {
    if (!next) throw new Error('fixture');
    const point = deriveInboundPoint(prev, next, 42);
    expect(point).toMatchObject({
      at: 42,
      seconds: 1,
      packetsReceived: 490,
      packetsLost: 10,
      bitrate: 4_000_000,
      fpsReceived: 30,
      fpsDecoded: 28,
      framesDropped: 2,
      droppedPerSecond: 2,
      freezes: 1,
      freezeSeconds: 0.4,
      nacks: 0,
      jitterMs: 4,
      rttMs: 35,
      width: 1920,
    });
    expect(point?.lossPercent).toBeCloseTo(2, 5);
    expect(point?.decodeMs).toBeCloseTo(3, 5);
    expect(point?.jitterBufferMs).toBeCloseTo(50, 5);
  });

  it('needs a previous sample at least 250 ms older with counters that did not restart', () => {
    if (!next || !prev) throw new Error('fixture');
    expect(deriveInboundPoint(null, next, 0)).toBeNull();
    expect(deriveInboundPoint(prev, { ...next, timestamp: prev.timestamp + 100 }, 0)).toBeNull();
    expect(deriveInboundPoint(next, { ...prev, timestamp: next.timestamp + 1000 }, 0)).toBeNull();
  });
});

function inboundPoint(at: number, overrides: Partial<InboundPoint> = {}): InboundPoint {
  return {
    at,
    seconds: 1,
    packetsReceived: 500,
    packetsLost: 0,
    lossPercent: 0,
    bitrate: 4_000_000,
    framesReceived: 30,
    framesDecoded: 30,
    framesDropped: 0,
    fpsReceived: 30,
    fpsDecoded: 30,
    droppedPerSecond: 0,
    freezes: 0,
    freezeSeconds: 0,
    pauses: 0,
    nacks: 0,
    plis: 0,
    firs: 0,
    keyFrames: 0,
    decodeSeconds: 0.09,
    decodeMs: 3,
    jitterBufferSeconds: 1.5,
    jitterBufferEmitted: 30,
    jitterBufferMs: 50,
    jitterMs: 4,
    rttMs: 35,
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

describe('summarizeInbound', () => {
  it('sums the points after `from` and averages the rates over their time', () => {
    const points = [
      inboundPoint(1_000, { packetsLost: 500 }),
      inboundPoint(2_000, {
        packetsLost: 10,
        packetsReceived: 490,
        freezes: 1,
        freezeSeconds: 0.5,
      }),
      inboundPoint(3_000, { framesReceived: 20, framesDecoded: 18, framesDropped: 2, plis: 1 }),
    ];
    const window = summarizeInbound(points, 1_000);
    expect(window).toMatchObject({
      seconds: 2,
      packetsReceived: 990,
      packetsLost: 10,
      framesReceived: 50,
      framesDecoded: 48,
      framesDropped: 2,
      fpsReceived: 25,
      fpsDecoded: 24,
      freezes: 1,
      freezeSeconds: 0.5,
      plis: 1,
      bitrate: 4_000_000,
    });
    expect(window?.lossPercent).toBeCloseTo(1, 5);
    expect(window?.decodeMs).toBeCloseTo(3.75, 5);
    expect(window?.jitterBufferMs).toBeCloseTo(50, 5);
    expect(summarizeInbound(points, 3_000)).toBeNull();
  });
});

interface LayerCounters {
  bytesSent: number;
  packetsSent: number;
  framesEncoded: number;
  framesSent: number;
  totalEncodeTime: number;
  qpSum: number;
  cpu: number;
  bandwidth: number;
  none: number;
  active?: boolean;
  fractionLost?: number;
}

function senderReport(options: {
  timestamp: number;
  frames: number;
  low: LayerCounters;
  high: LayerCounters;
  limitation?: string;
  encoder?: string;
  powerEfficient?: boolean;
}) {
  const layer = (rid: string, ssrc: number, size: [number, number], c: LayerCounters): Stats => ({
    id: `OT01V${ssrc}`,
    type: 'outbound-rtp',
    kind: 'video',
    timestamp: options.timestamp,
    ssrc,
    rid,
    mediaSourceId: 'SV1',
    codecId: 'COT01_102',
    transportId: 'T01',
    active: c.active ?? true,
    bytesSent: c.bytesSent,
    packetsSent: c.packetsSent,
    framesEncoded: c.framesEncoded,
    framesSent: c.framesSent,
    frameWidth: size[0],
    frameHeight: size[1],
    framesPerSecond: 30,
    qualityLimitationReason: options.limitation ?? 'none',
    qualityLimitationDurations: { other: 0, cpu: c.cpu, bandwidth: c.bandwidth, none: c.none },
    encoderImplementation: options.encoder ?? 'SimulcastEncoderAdapter (OpenH264, OpenH264)',
    ...(options.powerEfficient !== undefined
      ? { powerEfficientEncoder: options.powerEfficient }
      : {}),
    targetBitrate: rid === 'q' ? 1_000_000 : 3_000_000,
    totalEncodeTime: c.totalEncodeTime,
    qpSum: c.qpSum,
    hugeFramesSent: 0,
    nackCount: 0,
    pliCount: 0,
    firCount: 0,
    keyFramesEncoded: 2,
  });
  const remote = (ssrc: number, c: LayerCounters): Stats => ({
    id: `RI${ssrc}`,
    type: 'remote-inbound-rtp',
    kind: 'video',
    ssrc,
    localId: `OT01V${ssrc}`,
    fractionLost: c.fractionLost ?? 0,
    roundTripTime: 0.04,
    packetsLost: 3,
  });
  return report(
    {
      id: 'SV1',
      type: 'media-source',
      kind: 'video',
      trackIdentifier: 'track',
      frames: options.frames,
      framesPerSecond: 30,
      width: 1920,
      height: 1080,
    },
    // The high layer first: the parser sorts lowest first.
    layer('h', 2, [1920, 1080], options.high),
    layer('q', 1, [960, 540], options.low),
    remote(1, options.low),
    remote(2, options.high),
    { id: 'COT01_102', type: 'codec', mimeType: 'video/H264', payloadType: 102 },
    ...network({ protocol: 'tcp', availableOutgoingBitrate: 5_100_000 }),
  );
}

const LOW_0: LayerCounters = {
  bytesSent: 1_000_000,
  packetsSent: 1_000,
  framesEncoded: 300,
  framesSent: 300,
  totalEncodeTime: 0.6,
  qpSum: 9_000,
  cpu: 0,
  bandwidth: 0,
  none: 10,
};
const HIGH_0: LayerCounters = {
  bytesSent: 3_000_000,
  packetsSent: 3_000,
  framesEncoded: 300,
  framesSent: 299,
  totalEncodeTime: 1.5,
  qpSum: 9_000,
  cpu: 0,
  bandwidth: 2,
  none: 8,
};
const LOW_1: LayerCounters = {
  ...LOW_0,
  bytesSent: 1_125_000,
  packetsSent: 1_100,
  framesEncoded: 330,
  framesSent: 330,
  totalEncodeTime: 0.66,
  qpSum: 9_900,
  none: 11,
};
const HIGH_1: LayerCounters = {
  ...HIGH_0,
  bytesSent: 3_375_000,
  packetsSent: 3_300,
  framesEncoded: 324,
  framesSent: 322,
  totalEncodeTime: 1.644,
  qpSum: 9_960,
  bandwidth: 2.5,
  none: 8.5,
  fractionLost: 0.02,
};

describe('parseOutboundVideo', () => {
  it('reads the capture, every layer (lowest first) and the uplink', () => {
    const sample = parseOutboundVideo(
      senderReport({ timestamp: 5_000, frames: 600, low: LOW_0, high: HIGH_0 }),
    );
    expect(sample?.source).toEqual({ frames: 600, framesPerSecond: 30, width: 1920, height: 1080 });
    expect(sample?.layers.map((layer) => layer.rid)).toEqual(['q', 'h']);
    expect(sample?.layers[1]).toMatchObject({
      key: 'h',
      active: true,
      framesEncoded: 300,
      frameWidth: 1920,
      qualityLimitationReason: 'none',
      qualityLimitationDurations: { none: 8, cpu: 0, bandwidth: 2, other: 0 },
      encoderImplementation: 'SimulcastEncoderAdapter (OpenH264, OpenH264)',
      powerEfficientEncoder: null,
      targetBitrate: 3_000_000,
      codec: 'video/H264',
      remote: { fractionLost: 0, roundTripTimeMs: 40, packetsLost: 3 },
    });
    expect(sample?.availableOutgoingBitrate).toBe(5_100_000);
    expect(sample?.rttMs).toBe(35);
    expect(sample?.connection).toBe('tcp');
  });

  it('returns null before the sender has a video outbound-rtp', () => {
    expect(parseOutboundVideo(report({ id: 'SV1', type: 'media-source', kind: 'video' }))).toBe(
      null,
    );
  });
});

describe('deriveOutboundPoint', () => {
  const prev = parseOutboundVideo(
    senderReport({ timestamp: 5_000, frames: 600, low: LOW_0, high: HIGH_0 }),
  );

  it('measures capture, encode and send fps on the top layer, plus the totals', () => {
    const next = parseOutboundVideo(
      senderReport({
        timestamp: 6_000,
        frames: 630,
        low: LOW_1,
        high: HIGH_1,
        limitation: 'bandwidth',
      }),
    );
    if (!next) throw new Error('fixture');
    const point = deriveOutboundPoint(prev, next, 77);
    expect(point).toMatchObject({
      at: 77,
      seconds: 1,
      framesCaptured: 30,
      captureFps: 30,
      topRid: 'h',
      encodeFps: 24,
      sentFps: 23,
      width: 1920,
      height: 1080,
      bitrate: 4_000_000,
      targetBitrate: 4_000_000,
      limitation: 'bandwidth',
      limited: { none: 0.5, cpu: 0, bandwidth: 0.5, other: 0 },
      cpuShare: 0,
      bandwidthShare: 0.5,
      rttMs: 35,
      uplink: 5_100_000,
      connection: 'tcp',
      encoder: 'SimulcastEncoderAdapter (OpenH264, OpenH264)',
      hardware: false,
      codec: 'video/H264',
    });
    expect(point?.encodeMs).toBeCloseTo(6, 5);
    expect(point?.qp).toBeCloseTo(40, 5);
    // 2% on the high layer (300 packets), 0% on the low one (100 packets).
    expect(point?.remoteLossPercent).toBeCloseTo(1.5, 5);
    expect(point?.layers).toEqual([
      expect.objectContaining({ rid: 'q', active: true, encodeFps: 30, bitrate: 1_000_000 }),
      expect.objectContaining({ rid: 'h', active: true, encodeFps: 24, bitrate: 3_000_000 }),
    ]);
  });

  it('falls back to the lower layer when dynacast paused the top one', () => {
    const next = parseOutboundVideo(
      senderReport({
        timestamp: 6_000,
        frames: 630,
        low: LOW_1,
        high: { ...HIGH_0, active: false },
        powerEfficient: true,
      }),
    );
    if (!next) throw new Error('fixture');
    const point = deriveOutboundPoint(prev, next, 0);
    expect(point?.topRid).toBe('q');
    expect(point?.encodeFps).toBe(30);
    expect(point?.width).toBe(960);
    expect(point?.hardware).toBe(true);
    expect(point?.targetBitrate).toBe(1_000_000);
    expect(point?.layers[1]?.active).toBe(false);
  });

  it('needs a previous sample', () => {
    if (!prev) throw new Error('fixture');
    expect(deriveOutboundPoint(null, prev, 0)).toBeNull();
  });
});

function outboundPoint(at: number, overrides: Partial<OutboundPoint> = {}): OutboundPoint {
  return {
    at,
    seconds: 1,
    framesCaptured: 30,
    captureFps: 30,
    captureWidth: 1920,
    captureHeight: 1080,
    topRid: 'h',
    framesEncoded: 30,
    framesSent: 30,
    encodeFps: 30,
    sentFps: 30,
    width: 1920,
    height: 1080,
    bitrate: 4_000_000,
    targetBitrate: 4_000_000,
    encodeSeconds: 0.15,
    encodeMs: 5,
    qpSum: 900,
    qp: 30,
    limitation: 'none',
    limited: { none: 1, cpu: 0, bandwidth: 0, other: 0 },
    cpuShare: 0,
    bandwidthShare: 0,
    hugeFrames: 0,
    nacks: 0,
    plis: 0,
    keyFrames: 0,
    remoteLossPercent: 0,
    rttMs: 30,
    uplink: 6_000_000,
    connection: 'udp',
    encoder: 'ExternalEncoder',
    hardware: true,
    codec: 'video/H264',
    layers: [
      {
        rid: 'q',
        active: true,
        width: 960,
        height: 540,
        encodeFps: 30,
        sentFps: 30,
        bitrate: 1_000_000,
        targetBitrate: 1_000_000,
        limitation: 'none',
      },
      {
        rid: 'h',
        active: true,
        width: 1920,
        height: 1080,
        encodeFps: 30,
        sentFps: 30,
        bitrate: 3_000_000,
        targetBitrate: 3_000_000,
        limitation: 'none',
      },
    ],
    ...overrides,
  };
}

describe('summarizeOutbound', () => {
  it('averages the stages and the limitation shares over the window', () => {
    const points = [
      outboundPoint(1_000),
      outboundPoint(2_000, {
        framesEncoded: 20,
        framesSent: 18,
        limited: { none: 0, cpu: 1, bandwidth: 0, other: 0 },
        remoteLossPercent: 4,
      }),
    ];
    const window = summarizeOutbound(points, 0);
    expect(window).toMatchObject({
      seconds: 2,
      captureFps: 30,
      encodeFps: 25,
      sentFps: 24,
      bitrate: 4_000_000,
      cpuShare: 0.5,
      bandwidthShare: 0,
      remoteLossPercent: 2,
      rttMs: 30,
      uplink: 6_000_000,
    });
    expect(window?.encodeMs).toBeCloseTo(6, 5);
    expect(window?.qp).toBeCloseTo(36, 5);
    expect(window?.layers.map((layer) => [layer.rid, layer.sentFps, layer.active])).toEqual([
      ['q', 30, true],
      ['h', 30, true],
    ]);
    expect(summarizeOutbound(points, 2_000)).toBeNull();
  });
});

describe('isHardwareCodec', () => {
  it.each<[string | null, boolean | null, boolean | null]>([
    ['OpenH264', null, false],
    ['SimulcastEncoderAdapter (ExternalEncoder, OpenH264)', null, false],
    ['libvpx', null, false],
    ['ExternalEncoder', null, true],
    ['MediaFoundationVideoEncodeAccelerator', null, true],
    ['D3D11VideoDecoder', null, true],
    ['OpenH264', true, true],
    ['Something', null, null],
    [null, null, null],
  ])('%s / powerEfficient=%s -> %s', (implementation, powerEfficient, expected) => {
    expect(isHardwareCodec(implementation, powerEfficient)).toBe(expected);
  });
});

describe('appendPoint', () => {
  it('keeps 30 s plus one older point', () => {
    let history: { at: number }[] = [];
    for (const at of [0, 10_000, 20_000, 31_000, 45_000]) history = appendPoint(history, { at });
    expect(history.map((point) => point.at)).toEqual([10_000, 20_000, 31_000, 45_000]);
  });
});

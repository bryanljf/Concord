import { describe, expect, it } from 'vitest';
import {
  diagnoseLocal,
  diagnoseRemote,
  formatFps,
  formatMs,
  formatPercent,
  formatResolution,
  formatSeconds,
  formatShare,
  lossStage,
  senderFromSummary,
  type Issue,
  type LocalDiagnosticsInput,
  type RemoteDiagnosticsInput,
} from './diagnostics';
import type { PublisherSummary } from './publisherStats';
import type { InboundVideoSample, InboundWindow, OutboundPoint, OutboundWindow } from './rtcStats';

function inbound(overrides: Partial<InboundWindow> = {}): InboundWindow {
  return {
    seconds: 30,
    packetsReceived: 15_000,
    packetsLost: 0,
    lossPercent: 0,
    bitrate: 4_000_000,
    framesReceived: 900,
    framesDecoded: 900,
    framesDropped: 0,
    fpsReceived: 30,
    fpsDecoded: 30,
    freezes: 0,
    freezeSeconds: 0,
    pauses: 0,
    nacks: 0,
    plis: 0,
    firs: 0,
    keyFrames: 1,
    decodeMs: 3,
    jitterBufferMs: 40,
    ...overrides,
  };
}

function receiver(overrides: Partial<InboundVideoSample> = {}): InboundVideoSample {
  return {
    timestamp: 0,
    packetsReceived: 0,
    packetsLost: 0,
    bytesReceived: 0,
    framesReceived: 0,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    totalFreezesDuration: 0,
    pauseCount: 0,
    keyFramesDecoded: 0,
    nackCount: 0,
    pliCount: 0,
    firCount: 0,
    jitter: 0.004,
    jitterBufferDelay: null,
    jitterBufferEmittedCount: null,
    totalDecodeTime: null,
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 30,
    codec: 'video/H264',
    decoderImplementation: null,
    powerEfficientDecoder: null,
    rttMs: 30,
    connection: 'udp',
    ...overrides,
  };
}

function summary(overrides: Partial<PublisherSummary> = {}): PublisherSummary {
  return {
    v: 1,
    at: 1_000,
    targetFps: 30,
    captureFps: 30,
    encodeFps: 30,
    sentFps: 30,
    width: 1920,
    height: 1080,
    captureWidth: 1920,
    captureHeight: 1080,
    bitrateKbps: 3900,
    targetBitrateKbps: 4000,
    limitation: 'none',
    cpuShare: 0,
    bandwidthShare: 0,
    encoder: 'ExternalEncoder',
    hardware: true,
    codec: 'H264',
    encodeMs: 4,
    uplinkKbps: 8000,
    rttMs: 30,
    lossPercent: 0,
    layers: [
      { rid: 'q', width: 960, height: 540, fps: 30, kbps: 1000, active: true },
      { rid: 'h', width: 1920, height: 1080, fps: 30, kbps: 2900, active: true },
    ],
    ...overrides,
  };
}

function remote(
  overrides: Partial<RemoteDiagnosticsInput> = {},
  publisher: Partial<PublisherSummary> = {},
): RemoteDiagnosticsInput {
  return {
    kind: 'screen',
    window: inbound(),
    recent: inbound({ seconds: 10 }),
    latest: receiver(),
    publishedWidth: 1920,
    publishedHeight: 1080,
    paused: false,
    publisher: { status: 'ok', summary: summary(publisher) },
    publisherAgeMs: 2_000,
    ...overrides,
  };
}

function outbound(overrides: Partial<OutboundWindow> = {}): OutboundWindow {
  return {
    seconds: 10,
    captureFps: 30,
    encodeFps: 30,
    sentFps: 30,
    bitrate: 4_000_000,
    targetBitrate: 4_000_000,
    encodeMs: 4,
    qp: 28,
    cpuShare: 0,
    bandwidthShare: 0,
    hugeFrames: 0,
    nacks: 0,
    plis: 0,
    keyFrames: 0,
    remoteLossPercent: 0,
    rttMs: 30,
    uplink: 8_000_000,
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

function latestPoint(overrides: Partial<OutboundPoint> = {}): OutboundPoint {
  return {
    at: 0,
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
    encodeSeconds: 0.12,
    encodeMs: 4,
    qpSum: 840,
    qp: 28,
    limitation: 'none',
    limited: null,
    cpuShare: 0,
    bandwidthShare: 0,
    hugeFrames: 0,
    nacks: 0,
    plis: 0,
    keyFrames: 0,
    remoteLossPercent: 0,
    rttMs: 30,
    uplink: 8_000_000,
    connection: 'udp',
    encoder: 'ExternalEncoder',
    hardware: true,
    codec: 'video/H264',
    layers: [],
    ...overrides,
  };
}

function local(
  recent: Partial<OutboundWindow> = {},
  latest: Partial<OutboundPoint> = {},
  kind: LocalDiagnosticsInput['kind'] = 'screen',
): LocalDiagnosticsInput {
  return { kind, targetFps: 30, recent: outbound(recent), latest: latestPoint(latest) };
}

const ids = (issues: readonly Issue[]): string[] => issues.map((issue) => issue.id);
const find = (issues: readonly Issue[], id: string): Issue | undefined =>
  issues.find((issue) => issue.id === id);

describe('diagnoseRemote', () => {
  it('finds nothing in a healthy stream', () => {
    expect(diagnoseRemote(remote())).toEqual([]);
  });

  it('flags packet loss above 2% (error above 10%)', () => {
    expect(find(diagnoseRemote(remote({ window: inbound({ lossPercent: 1.5 }) })), 'loss')).toBe(
      undefined,
    );
    const loss = find(diagnoseRemote(remote({ window: inbound({ lossPercent: 3 }) })), 'loss');
    expect(loss).toMatchObject({ level: 'warning' });
    expect(loss?.text).toContain('3%');
    expect(
      find(diagnoseRemote(remote({ window: inbound({ lossPercent: 12 }) })), 'loss')?.level,
    ).toBe('error');
  });

  it('blames the broadcaster when it sends fewer frames, naming the first stage', () => {
    const issues = diagnoseRemote(
      remote(
        { recent: inbound({ fpsReceived: 20 }) },
        { captureFps: 30, encodeFps: 20, sentFps: 20 },
      ),
    );
    const fps = find(issues, 'fps-low');
    expect(fps?.text).toContain('o transmissor está enviando menos quadros');
    expect(fps?.text).toContain('A perda começa na codificação');
  });

  it('blames the path or the decoder when the broadcaster sends enough', () => {
    const fps = find(diagnoseRemote(remote({ recent: inbound({ fpsReceived: 20 }) })), 'fps-low');
    expect(fps?.level).toBe('warning');
    expect(fps?.text).toContain('os quadros se perdem no caminho ou na decodificação');
    expect(
      find(diagnoseRemote(remote({ recent: inbound({ fpsReceived: 10 }) })), 'fps-low')?.level,
    ).toBe('error');
  });

  it('cannot judge the frame rate without the target', () => {
    const issues = diagnoseRemote(
      remote({ recent: inbound({ fpsReceived: 10 }), publisher: { status: 'missing' } }),
    );
    expect(find(issues, 'fps-low')).toBeUndefined();
  });

  it('reports a broadcaster limited by CPU', () => {
    const issue = find(
      diagnoseRemote(remote({}, { limitation: 'cpu', cpuShare: 0.6 })),
      'cpu-limited',
    );
    expect(issue?.text).toContain('limitado por CPU em 60% do tempo');
  });

  it('reports a broadcaster limited by bandwidth', () => {
    const issue = find(
      diagnoseRemote(remote({}, { bandwidthShare: 0.5, uplinkKbps: 3000 })),
      'bandwidth-limited',
    );
    expect(issue?.text).toContain('limitado por banda em 50% do tempo');
    expect(issue?.text).toContain('3 Mbps');
  });

  it("reports the broadcaster's capture below the target", () => {
    const issue = find(diagnoseRemote(remote({}, { captureFps: 22 })), 'capture-low');
    expect(issue?.text).toBe(
      'A captura da janela/tela do transmissor está abaixo de 30 fps: 22 fps (normal com a imagem parada).',
    );
  });

  it('reports a software encoder (a warning when CPU is short too)', () => {
    const info = find(
      diagnoseRemote(remote({}, { hardware: false, encoder: 'OpenH264' })),
      'software-encoder',
    );
    expect(info).toMatchObject({ level: 'info' });
    expect(info?.text).toContain('OpenH264');
    expect(
      find(diagnoseRemote(remote({}, { hardware: false, limitation: 'cpu' })), 'software-encoder')
        ?.level,
    ).toBe('warning');
  });

  it('reports an odd resolution that forces software H.264', () => {
    const issue = find(diagnoseRemote(remote({}, { width: 1365, height: 768 })), 'odd-resolution');
    expect(issue?.text).toContain('1365×768');
    expect(
      find(diagnoseRemote(remote({}, { width: 1365, codec: 'VP9' })), 'odd-resolution'),
    ).toBeUndefined();
  });

  it('reports freezes (an error after 3 s frozen)', () => {
    const issue = find(
      diagnoseRemote(remote({ window: inbound({ freezes: 2, freezeSeconds: 1.2 }) })),
      'freezes',
    );
    expect(issue).toMatchObject({ level: 'warning' });
    expect(issue?.text).toBe('2 congelamentos nos últimos 30 s (1,2 s parado).');
    expect(
      find(diagnoseRemote(remote({ window: inbound({ freezes: 1, freezeSeconds: 4 }) })), 'freezes')
        ?.level,
    ).toBe('error');
  });

  it('reports frames dropped while decoding', () => {
    expect(
      find(diagnoseRemote(remote({ window: inbound({ framesDropped: 40 }) })), 'decode-drops')
        ?.text,
    ).toContain('40 quadros descartados');
    expect(
      find(diagnoseRemote(remote({ window: inbound({ framesDropped: 3 }) })), 'decode-drops'),
    ).toBeUndefined();
    expect(
      find(diagnoseRemote(remote({ recent: inbound({ fpsDecoded: 20 }) })), 'decode-drops'),
    ).toBeDefined();
  });

  it('notes the low simulcast layer', () => {
    const issue = find(
      diagnoseRemote(remote({ latest: receiver({ frameWidth: 960, frameHeight: 540 }) })),
      'low-layer',
    );
    expect(issue).toMatchObject({ level: 'info' });
    expect(issue?.text).toContain('960×540 de 1920×1080');
  });

  it('reports TCP and TURN connections', () => {
    expect(ids(diagnoseRemote(remote({ latest: receiver({ connection: 'tcp' }) })))).toContain(
      'tcp',
    );
    expect(ids(diagnoseRemote(remote({ latest: receiver({ connection: 'relay' }) })))).toContain(
      'relay',
    );
  });

  it('reports high RTT and jitter', () => {
    expect(ids(diagnoseRemote(remote({ latest: receiver({ rttMs: 200 }) })))).toContain('rtt');
    expect(ids(diagnoseRemote(remote({ latest: receiver({ rttMs: 150 }) })))).not.toContain('rtt');
    expect(ids(diagnoseRemote(remote({ latest: receiver({ jitter: 0.045 }) })))).toContain(
      'jitter',
    );
  });

  it('notes a broadcaster without stats or with an unreadable summary', () => {
    expect(diagnoseRemote(remote({ publisher: { status: 'missing' } }))).toEqual([
      expect.objectContaining({ id: 'publisher-missing', level: 'info' }),
    ]);
    expect(ids(diagnoseRemote(remote({ publisher: { status: 'invalid' } })))).toEqual([
      'publisher-invalid',
    ]);
  });

  it('notes a stale summary', () => {
    const issue = find(diagnoseRemote(remote({ publisherAgeMs: 20_000 })), 'publisher-stale');
    expect(issue?.text).toContain('há 20 s');
    expect(find(diagnoseRemote(remote({ publisherAgeMs: 10_000 })), 'publisher-stale')).toBe(
      undefined,
    );
  });

  it('reports a paused video instead of a low frame rate', () => {
    const issues = diagnoseRemote(remote({ paused: true, recent: inbound({ fpsReceived: 0 }) }));
    expect(ids(issues)).toContain('paused');
    expect(ids(issues)).not.toContain('fps-low');
  });

  it('lists errors first, then warnings, then notes', () => {
    const issues = diagnoseRemote(
      remote({
        window: inbound({ lossPercent: 15 }),
        latest: receiver({ connection: 'tcp', frameWidth: 960, frameHeight: 540 }),
      }),
    );
    expect(issues.map((issue) => issue.level)).toEqual(['error', 'warning', 'info']);
  });
});

describe('diagnoseLocal', () => {
  it('finds nothing in a healthy broadcast and waits for data', () => {
    expect(diagnoseLocal(local())).toEqual([]);
    expect(diagnoseLocal({ ...local(), recent: null })).toEqual([]);
  });

  it('reports the capture below the target (screen and webcam wording)', () => {
    expect(
      find(diagnoseLocal(local({ captureFps: 22, encodeFps: 22, sentFps: 22 })), 'capture-low')
        ?.text,
    ).toBe(
      'A captura da janela/tela está abaixo de 30 fps: 22 fps (normal com a imagem parada); em movimento, cada quadro está levando tempo demais para ser capturado neste PC (o Chromium limita o tempo gasto na captura), antes do encoder e da rede.',
    );
    expect(
      find(diagnoseLocal(local({ captureFps: 15 }, {}, 'camera')), 'capture-low')?.text,
    ).toContain('A câmera está entregando 15 fps');
  });

  it('reports the encoder dropping frames, with the cause', () => {
    const issues = diagnoseLocal(
      local({ encodeFps: 21, sentFps: 21, bandwidthShare: 0.7, uplink: 4_500_000 }),
    );
    expect(find(issues, 'encode-low')?.text).toBe(
      'O encoder está descartando quadros (30 capturados, 21 codificados por segundo): falta banda no upload.',
    );
    expect(find(issues, 'bandwidth-limited')?.level).toBe('warning');
    expect(ids(issues)).not.toContain('capture-low');
  });

  it('blames the preset bitrate cap, not the upload, when the uplink has headroom', () => {
    const issues = diagnoseLocal(local({ encodeFps: 21, sentFps: 21, bandwidthShare: 0.7 }));
    expect(find(issues, 'encode-low')?.text).toContain(
      'o teto de bitrate da qualidade não comporta tanto movimento',
    );
    const cap = find(issues, 'bandwidth-limited');
    expect(cap?.level).toBe('info');
    expect(cap?.text).toContain('No teto de bitrate da qualidade (4 Mbps)');
    expect(cap?.text).toContain('tem folga');
  });

  it('words the bitrate cap for a viewer too', () => {
    const issue = find(
      diagnoseRemote(remote({}, { bandwidthShare: 0.5, uplinkKbps: 9000 })),
      'bandwidth-limited',
    );
    expect(issue?.text).toContain('O transmissor está no teto de bitrate da qualidade');
  });

  it('reports encoded frames that are not sent', () => {
    expect(ids(diagnoseLocal(local({ sentFps: 20 })))).toContain('send-low');
  });

  it('reports CPU limitation in your own words', () => {
    const issue = find(diagnoseLocal(local({ cpuShare: 0.3 })), 'cpu-limited');
    expect(issue?.text).toContain('Codificação limitada por CPU em 30% do tempo');
  });

  it('reports a slow encoder', () => {
    const issue = find(diagnoseLocal(local({ encodeMs: 30 })), 'slow-encode');
    expect(issue?.text).toBe('Cada quadro leva 30 ms para codificar; a 30 fps o limite é 33,3 ms.');
  });

  it('reports software encoding and odd layer sizes', () => {
    const issues = diagnoseLocal(
      local(
        {
          layers: [
            {
              rid: 'q',
              active: true,
              width: 683,
              height: 384,
              encodeFps: 30,
              sentFps: 30,
              bitrate: 1_000_000,
              targetBitrate: 1_000_000,
              limitation: 'none',
            },
          ],
        },
        { hardware: false, encoder: 'OpenH264' },
      ),
    );
    expect(ids(issues)).toEqual(['odd-resolution', 'software-encoder']);
  });

  it('reports loss on the way to the server, TCP and high RTT', () => {
    const issues = diagnoseLocal(
      local({ remoteLossPercent: 5, rttMs: 220 }, { connection: 'tcp' }),
    );
    expect(ids(issues)).toEqual(['sender-loss', 'tcp', 'rtt']);
  });
});

describe('lossStage', () => {
  it('names the first stage below 85% of the target (or of the previous stage)', () => {
    expect(lossStage(senderFromSummary(summary()))).toBeNull();
    expect(lossStage(senderFromSummary(summary({ captureFps: 20 })))).toBe('capture');
    expect(lossStage(senderFromSummary(summary({ encodeFps: 24, sentFps: 24 })))).toBe('encode');
    expect(lossStage(senderFromSummary(summary({ sentFps: 20 })))).toBe('send');
    // Capture at 20 and encode at 20: the capture is the cause, not the encoder.
    expect(
      lossStage(senderFromSummary(summary({ captureFps: 20, encodeFps: 20, sentFps: 20 }))),
    ).toBe('capture');
  });
});

describe('formatting', () => {
  it('formats numbers in pt-BR', () => {
    expect(formatFps(29.84)).toBe('29,8');
    expect(formatFps(30)).toBe('30');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.04)).toBe('< 0,1%');
    expect(formatPercent(2.45)).toBe('2,5%');
    expect(formatShare(0.426)).toBe('43%');
    expect(formatMs(35.4)).toBe('35 ms');
    expect(formatMs(3.25, 1)).toBe('3,3 ms');
    expect(formatSeconds(1.25)).toBe('1,3 s');
    expect(formatResolution(1920, 1080)).toBe('1920×1080');
    expect(formatResolution(null, 1080)).toBeNull();
  });
});

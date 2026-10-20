import type { PublisherStats, PublisherSummary } from './publisherStats';
import type {
  ConnectionKind,
  InboundVideoSample,
  InboundWindow,
  OutboundPoint,
  OutboundWindow,
  QualityLimitation,
} from './rtcStats';
import { codecName, formatBitrate } from './streamStats';
import type { StreamKind } from './streamKey';

/**
 * "Possíveis problemas" of the stats panel (pt-BR), from the numbers of a remote video (receiver
 * windows + the broadcaster's summary) or of your own (sender windows). The sender rules name the
 * first stage that loses frames: capture → encoder → send → network/SFU → viewer.
 */

export type IssueLevel = 'info' | 'warning' | 'error';

export interface Issue {
  /** Stable rule id ("loss", "capture-low", …). */
  id: string;
  level: IssueLevel;
  text: string;
}

export const NO_PROBLEMS_TEXT = 'Nenhum problema detectado.';

/** Below this share of the target (or of the previous stage), a frame rate is "low". */
export const FPS_RATIO = 0.85;
/** Received width under this share of the published one = a lower simulcast layer. */
export const LOW_LAYER_RATIO = 0.9;
export const LOSS_WARNING_PERCENT = 2;
export const LOSS_ERROR_PERCENT = 10;
export const RTT_WARNING_MS = 150;
export const JITTER_WARNING_MS = 30;
/** Limited by CPU / bandwidth for at least this share of the window. */
export const LIMITED_SHARE = 0.2;
/** Uplink estimate this many times the encoder target: the preset cap is the limit, not the network. */
export const UPLINK_HEADROOM = 1.5;
/** Encoding a frame takes more than this share of the frame interval. */
export const ENCODE_BUDGET_RATIO = 0.8;
export const STALE_PUBLISHER_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// pt-BR number formatting (shared with the panel)
// ---------------------------------------------------------------------------------------------

function decimal(value: number, digits: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: digits });
}

/** "30", "29,8". */
export function formatFps(fps: number): string {
  return decimal(Math.max(0, fps), 1);
}

/** "0%", "< 0,1%", "2,4%". */
export function formatPercent(percent: number): string {
  if (percent <= 0) return '0%';
  if (percent < 0.1) return '< 0,1%';
  return `${decimal(percent, 1)}%`;
}

/** Share 0–1 → "42%". */
export function formatShare(share: number): string {
  return `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
}

/** "35 ms", "3,2 ms" (digits = 1). */
export function formatMs(ms: number, digits = 0): string {
  return `${decimal(Math.max(0, ms), digits)} ms`;
}

/** "1920×1080"; null when unknown. */
export function formatResolution(width: number | null, height: number | null): string | null {
  return width && height ? `${width}×${height}` : null;
}

/** 4000 → "4 Mbps". */
export function formatKbps(kbps: number): string {
  return formatBitrate(kbps * 1000);
}

/** "1,3 s". */
export function formatSeconds(seconds: number): string {
  return `${decimal(Math.max(0, seconds), 1)} s`;
}

// ---------------------------------------------------------------------------------------------
// The broadcaster's pipeline, the same for a remote summary and your own sender stats
// ---------------------------------------------------------------------------------------------

/** The sender numbers the rules need, whoever measured them. */
export interface SenderView {
  targetFps: number | null;
  captureFps: number | null;
  encodeFps: number | null;
  sentFps: number | null;
  limitation: QualityLimitation | null;
  cpuShare: number | null;
  bandwidthShare: number | null;
  encoder: string | null;
  hardware: boolean | null;
  /** "H264", … */
  codec: string | null;
  /** Encoded sizes: the top layer and every active layer. */
  sizes: { width: number | null; height: number | null }[];
  encodeMs: number | null;
  uplinkKbps: number | null;
  /** What the encoder aims for (all layers), capped by the quality preset. */
  targetKbps: number | null;
  /** Loss the SFU reports for what the broadcaster sends. */
  lossPercent: number | null;
  rttMs: number | null;
}

export function senderFromSummary(summary: PublisherSummary): SenderView {
  return {
    targetFps: summary.targetFps,
    captureFps: summary.captureFps,
    encodeFps: summary.encodeFps,
    sentFps: summary.sentFps,
    limitation: summary.limitation,
    cpuShare: summary.cpuShare,
    bandwidthShare: summary.bandwidthShare,
    encoder: summary.encoder,
    hardware: summary.hardware,
    codec: summary.codec,
    sizes: [
      { width: summary.width, height: summary.height },
      ...summary.layers.filter((layer) => layer.active),
    ],
    encodeMs: summary.encodeMs,
    uplinkKbps: summary.uplinkKbps,
    targetKbps: summary.targetBitrateKbps,
    lossPercent: summary.lossPercent,
    rttMs: summary.rttMs,
  };
}

/** Rates from `recent`, encoder and limitation from the latest point. */
export function senderFromLocal(
  targetFps: number,
  recent: OutboundWindow,
  latest: OutboundPoint | null,
): SenderView {
  return {
    targetFps,
    captureFps: recent.captureFps,
    encodeFps: recent.encodeFps,
    sentFps: recent.sentFps,
    limitation: latest?.limitation ?? null,
    cpuShare: recent.cpuShare,
    bandwidthShare: recent.bandwidthShare,
    encoder: latest?.encoder ?? null,
    hardware: latest?.hardware ?? null,
    codec: codecName(latest?.codec ?? undefined),
    sizes: [
      { width: latest?.width ?? null, height: latest?.height ?? null },
      ...recent.layers.filter((layer) => layer.active),
    ],
    encodeMs: recent.encodeMs,
    uplinkKbps: recent.uplink === null ? null : recent.uplink / 1000,
    targetKbps: recent.targetBitrate === null ? null : recent.targetBitrate / 1000,
    lossPercent: recent.remoteLossPercent,
    rttMs: recent.rttMs,
  };
}

export type PipelineStage = 'capture' | 'encode' | 'send';

export const STAGE_LABELS: Readonly<Record<PipelineStage, string>> = {
  capture: 'na captura',
  encode: 'na codificação',
  send: 'no envio',
};

const below = (value: number | null, reference: number | null): boolean =>
  value !== null && reference !== null && reference > 0 && value < reference * FPS_RATIO;

/** The first stage of the broadcaster's pipeline that loses frames; null when none does. */
export function lossStage(view: SenderView): PipelineStage | null {
  const target = view.targetFps;
  if (below(view.captureFps, target)) return 'capture';
  const encodeReference =
    target === null ? view.captureFps : Math.min(target, view.captureFps ?? target);
  if (below(view.encodeFps, encodeReference)) return 'encode';
  if (view.encodeFps !== null && view.encodeFps >= 1 && below(view.sentFps, view.encodeFps)) {
    return 'send';
  }
  return null;
}

type Perspective = 'local' | 'remote';

/** Screen capture only delivers frames when the image changes: a still screen is not a fault. */
const STATIC_NOTE = ' (normal com a imagem parada)';

function isOdd(value: number | null): boolean {
  return value !== null && value % 2 === 1;
}

/**
 * WebRTC reports "bandwidth" both when the network is short and when the preset's bitrate cap is
 * what limits the encoder; an uplink estimate well above the target means it is the cap.
 */
function capLimited(view: SenderView): boolean {
  return (
    view.uplinkKbps !== null &&
    view.targetKbps !== null &&
    view.targetKbps > 0 &&
    view.uplinkKbps >= view.targetKbps * UPLINK_HEADROOM
  );
}

function limitationCause(view: SenderView): string {
  if (view.limitation === 'bandwidth' || (view.bandwidthShare ?? 0) >= LIMITED_SHARE) {
    return capLimited(view)
      ? 'o teto de bitrate da qualidade não comporta tanto movimento'
      : 'falta banda no upload';
  }
  if (view.limitation === 'cpu' || (view.cpuShare ?? 0) >= LIMITED_SHARE) return 'falta CPU';
  return 'o bitrate não comporta tanto movimento';
}

/** Rules about the broadcaster's machine, worded for yourself or for a viewer. */
export function senderIssues(
  view: SenderView,
  perspective: Perspective,
  kind: StreamKind,
): Issue[] {
  const issues: Issue[] = [];
  const remote = perspective === 'remote';
  const target = view.targetFps;

  if (below(view.captureFps, target)) {
    const fps = formatFps(view.captureFps ?? 0);
    let text: string;
    if (kind === 'camera') {
      text = remote
        ? `A câmera do transmissor entrega ${fps} fps (alvo ${target}).`
        : `A câmera está entregando ${fps} fps (alvo ${target}); com pouca luz, webcams reduzem os quadros.`;
    } else {
      text = remote
        ? `A captura da janela/tela do transmissor está abaixo de ${target} fps: ${fps} fps${STATIC_NOTE}.`
        : `A captura da janela/tela está abaixo de ${target} fps: ${fps} fps${STATIC_NOTE}; em movimento, cada quadro está levando tempo demais para ser capturado neste PC (o Chromium limita o tempo gasto na captura), antes do encoder e da rede.`;
    }
    issues.push({ id: 'capture-low', level: 'warning', text });
  }

  const encodeReference =
    target === null ? view.captureFps : Math.min(target, view.captureFps ?? target);
  if (below(view.encodeFps, encodeReference)) {
    const who = remote ? 'O encoder do transmissor está' : 'O encoder está';
    const from =
      view.captureFps === null ? `alvo ${target}` : `${formatFps(view.captureFps)} capturados`;
    issues.push({
      id: 'encode-low',
      level: 'warning',
      text: `${who} descartando quadros (${from}, ${formatFps(view.encodeFps ?? 0)} codificados por segundo): ${limitationCause(view)}.`,
    });
  }

  if (view.encodeFps !== null && view.encodeFps >= 1 && below(view.sentFps, view.encodeFps)) {
    issues.push({
      id: 'send-low',
      level: 'warning',
      text: `${remote ? 'Quadros codificados pelo transmissor' : 'Quadros codificados'} não estão saindo (${formatFps(view.encodeFps)} codificados, ${formatFps(view.sentFps ?? 0)} enviados por segundo): falta banda no upload.`,
    });
  }

  const cpuLimited = view.limitation === 'cpu' || (view.cpuShare ?? 0) >= LIMITED_SHARE;
  if (cpuLimited) {
    const share =
      view.cpuShare !== null && view.cpuShare > 0
        ? ` em ${formatShare(view.cpuShare)} do tempo`
        : '';
    issues.push({
      id: 'cpu-limited',
      level: 'warning',
      text: remote
        ? `O transmissor está limitado por CPU${share}: o computador dele não dá conta de codificar.`
        : `Codificação limitada por CPU${share}: seu computador não dá conta. A qualidade Leve alivia.`,
    });
  }

  if (view.limitation === 'bandwidth' || (view.bandwidthShare ?? 0) >= LIMITED_SHARE) {
    const share =
      view.bandwidthShare !== null && view.bandwidthShare > 0
        ? ` em ${formatShare(view.bandwidthShare)} do tempo`
        : '';
    const uplink = view.uplinkKbps !== null ? ` (estimado em ${formatKbps(view.uplinkKbps)})` : '';
    if (capLimited(view)) {
      const cap = formatKbps(view.targetKbps ?? 0);
      issues.push({
        id: 'bandwidth-limited',
        level: 'info',
        text: remote
          ? `O transmissor está no teto de bitrate da qualidade (${cap})${share}: com tanto movimento, a resolução cai; o upload dele${uplink} tem folga.`
          : `No teto de bitrate da qualidade (${cap})${share}: com tanto movimento, a resolução cai; seu upload${uplink} tem folga.`,
      });
    } else {
      issues.push({
        id: 'bandwidth-limited',
        level: 'warning',
        text: remote
          ? `O transmissor está limitado por banda${share}: o upload dele${uplink} não comporta o bitrate.`
          : `Codificação limitada por banda${share}: seu upload${uplink} não comporta o bitrate da qualidade.`,
      });
    }
  }

  const odd =
    view.codec === 'H264'
      ? view.sizes.find((size) => isOdd(size.width) || isOdd(size.height))
      : undefined;
  if (odd) {
    issues.push({
      id: 'odd-resolution',
      level: 'warning',
      text: `A resolução ${odd.width}×${odd.height} é ímpar, o que força o H.264 por software${remote ? ' no transmissor' : ''}.`,
    });
  }

  if (view.hardware === false) {
    const name = view.encoder ? ` (${view.encoder})` : '';
    issues.push({
      id: 'software-encoder',
      level: cpuLimited ? 'warning' : 'info',
      text: remote
        ? `O transmissor codifica por software${name}, o que disputa CPU com o jogo.`
        : `Codificação por software${name}: disputa CPU com o jogo.`,
    });
  }

  if (target !== null && view.encodeMs !== null) {
    const budget = 1000 / target;
    if (view.encodeMs > budget * ENCODE_BUDGET_RATIO) {
      issues.push({
        id: 'slow-encode',
        level: 'warning',
        text: `${remote ? 'No transmissor, cada' : 'Cada'} quadro leva ${formatMs(view.encodeMs, 1)} para codificar; a ${target} fps o limite é ${formatMs(budget, 1)}.`,
      });
    }
  }

  if (view.lossPercent !== null && view.lossPercent > LOSS_WARNING_PERCENT) {
    const loss = formatPercent(view.lossPercent);
    issues.push({
      id: 'sender-loss',
      level: view.lossPercent > LOSS_ERROR_PERCENT ? 'error' : 'warning',
      text: remote
        ? `O servidor recebe o vídeo do transmissor com ${loss} de perda.`
        : `O servidor recebe seus pacotes com ${loss} de perda: o upload está instável.`,
    });
  }

  return issues;
}

function connectionIssue(connection: ConnectionKind | null): Issue | null {
  if (connection === 'tcp') {
    return {
      id: 'tcp',
      level: 'warning',
      text: 'Conexão por TCP: o UDP parece bloqueado, e perdas viram atrasos e travadas.',
    };
  }
  if (connection === 'relay') {
    return {
      id: 'relay',
      level: 'warning',
      text: 'Conexão via TURN (relay): o tráfego passa por um intermediário e o atraso aumenta.',
    };
  }
  return null;
}

function rttIssue(rttMs: number | null): Issue | null {
  if (rttMs === null || rttMs <= RTT_WARNING_MS) return null;
  return { id: 'rtt', level: 'warning', text: `Atraso alto até o servidor (${formatMs(rttMs)}).` };
}

const LEVEL_ORDER: Record<IssueLevel, number> = { error: 0, warning: 1, info: 2 };

/** Errors first, then warnings, then notes; rule order within a level. */
function sorted(issues: readonly (Issue | null)[]): Issue[] {
  return issues
    .filter((issue): issue is Issue => issue !== null)
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => LEVEL_ORDER[a.issue.level] - LEVEL_ORDER[b.issue.level] || a.index - b.index)
    .map(({ issue }) => issue);
}

// ---------------------------------------------------------------------------------------------
// A video you watch
// ---------------------------------------------------------------------------------------------

export interface RemoteDiagnosticsInput {
  kind: StreamKind;
  /** Last 30 s: loss and counts. */
  window: InboundWindow | null;
  /** Last 10 s: frame rates. */
  recent: InboundWindow | null;
  latest: InboundVideoSample | null;
  /** Size the broadcaster announced for the publication (its top layer). */
  publishedWidth: number | null;
  publishedHeight: number | null;
  /** The server stopped forwarding the video (`Track.StreamState.Paused`). */
  paused: boolean;
  publisher: PublisherStats;
  /** Time since the broadcaster's summary last changed; null without one. */
  publisherAgeMs: number | null;
}

export function diagnoseRemote(input: RemoteDiagnosticsInput): Issue[] {
  const { window, recent, latest, publisher } = input;
  const issues: (Issue | null)[] = [];
  const summary = publisher.status === 'ok' ? publisher.summary : null;

  if (input.paused) {
    issues.push({
      id: 'paused',
      level: 'warning',
      text: 'O servidor pausou o vídeo por falta de banda na sua conexão.',
    });
  }

  const loss = window?.lossPercent ?? null;
  if (loss !== null && loss > LOSS_WARNING_PERCENT) {
    issues.push({
      id: 'loss',
      level: loss > LOSS_ERROR_PERCENT ? 'error' : 'warning',
      text: `Perda de ${formatPercent(loss)} dos pacotes entre o servidor e você nos últimos 30 s.`,
    });
  }

  const target = summary?.targetFps ?? null;
  const received = recent?.fpsReceived ?? null;
  if (!input.paused && below(received, target)) {
    const sent = summary?.sentFps ?? null;
    const view = summary ? senderFromSummary(summary) : null;
    const stage = view ? lossStage(view) : null;
    const head = `Você recebe ${formatFps(received ?? 0)} de ${target} fps`;
    let text: string;
    if (below(sent, target)) {
      const where = stage
        ? ` A perda começa ${STAGE_LABELS[stage]}${stage === 'capture' && input.kind === 'screen' ? STATIC_NOTE : ''}.`
        : '';
      text = `${head}: o transmissor está enviando menos quadros (${formatFps(sent ?? 0)} fps).${where}`;
    } else if (sent !== null) {
      text = `${head}, mas o transmissor envia ${formatFps(sent)}: os quadros se perdem no caminho ou na decodificação.`;
    } else {
      text = `${head}: os quadros se perdem no caminho ou na decodificação.`;
    }
    issues.push({
      id: 'fps-low',
      level: (received ?? 0) < (target ?? 0) * 0.5 ? 'error' : 'warning',
      text,
    });
  }

  if (window) {
    const dropLimit = Math.max(5, window.framesReceived * 0.01);
    const slowDecode =
      recent !== null &&
      recent.fpsReceived !== null &&
      recent.fpsReceived >= 1 &&
      below(recent.fpsDecoded, recent.fpsReceived);
    if (window.framesDropped > dropLimit || slowDecode) {
      const decoded =
        slowDecode && recent?.fpsDecoded !== null && recent?.fpsDecoded !== undefined
          ? ` (${formatFps(recent.fpsDecoded)} de ${formatFps(recent.fpsReceived ?? 0)} quadros por segundo decodificados)`
          : '';
      issues.push({
        id: 'decode-drops',
        level: 'warning',
        text: `${window.framesDropped} quadros descartados na decodificação nos últimos 30 s${decoded}: seu computador não está acompanhando.`,
      });
    }

    if (window.freezes > 0) {
      issues.push({
        id: 'freezes',
        level: window.freezeSeconds >= 3 ? 'error' : 'warning',
        text: `${window.freezes} ${window.freezes === 1 ? 'congelamento' : 'congelamentos'} nos últimos 30 s (${formatSeconds(window.freezeSeconds)} parado).`,
      });
    }
  }

  const receivedSize = formatResolution(latest?.frameWidth ?? null, latest?.frameHeight ?? null);
  if (
    receivedSize &&
    latest?.frameWidth &&
    input.publishedWidth &&
    latest.frameWidth < input.publishedWidth * LOW_LAYER_RATIO
  ) {
    const original =
      formatResolution(input.publishedWidth, input.publishedHeight) ?? `${input.publishedWidth} px`;
    issues.push({
      id: 'low-layer',
      level: 'info',
      text: `Você está recebendo a camada baixa (${receivedSize} de ${original}): normal em miniaturas; no destaque, indica pouca banda.`,
    });
  }

  issues.push(connectionIssue(latest?.connection ?? null));
  issues.push(rttIssue(latest?.rttMs ?? null));
  const jitterMs = latest?.jitter == null ? null : latest.jitter * 1000;
  if (jitterMs !== null && jitterMs > JITTER_WARNING_MS) {
    issues.push({
      id: 'jitter',
      level: 'warning',
      text: `Jitter alto (${formatMs(jitterMs)}): os pacotes chegam em intervalos irregulares.`,
    });
  }

  if (publisher.status === 'missing') {
    issues.push({
      id: 'publisher-missing',
      level: 'info',
      text: 'O transmissor usa uma versão sem estatísticas: não dá para saber se os quadros se perdem no computador dele.',
    });
  } else if (publisher.status === 'invalid') {
    issues.push({
      id: 'publisher-invalid',
      level: 'info',
      text: 'As estatísticas do transmissor vieram num formato desconhecido (outra versão do Concord).',
    });
  } else {
    if (input.publisherAgeMs !== null && input.publisherAgeMs > STALE_PUBLISHER_MS) {
      issues.push({
        id: 'publisher-stale',
        level: 'info',
        text: `As estatísticas do transmissor não são atualizadas há ${Math.round(input.publisherAgeMs / 1000)} s.`,
      });
    }
    issues.push(...senderIssues(senderFromSummary(publisher.summary), 'remote', input.kind));
  }

  return sorted(issues);
}

// ---------------------------------------------------------------------------------------------
// Your own video
// ---------------------------------------------------------------------------------------------

export interface LocalDiagnosticsInput {
  kind: StreamKind;
  targetFps: number;
  /** Last 10 s. */
  recent: OutboundWindow | null;
  latest: OutboundPoint | null;
}

export function diagnoseLocal(input: LocalDiagnosticsInput): Issue[] {
  if (!input.recent) return [];
  const view = senderFromLocal(input.targetFps, input.recent, input.latest);
  return sorted([
    ...senderIssues(view, 'local', input.kind),
    connectionIssue(input.latest?.connection ?? null),
    rttIssue(view.rttMs),
  ]);
}

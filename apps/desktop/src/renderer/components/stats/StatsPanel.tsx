import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { Track } from 'livekit-client';
import type { RemoteStream } from '../../hooks/useRemoteStreams';
import type { LocalStatsHistory, LocalStatsSnapshot } from '../../hooks/usePublishStats';
import { useStreamDiagnostics } from '../../hooks/useStreamDiagnostics';
import { concord, toErrorMessage } from '../../lib/concord';
import {
  diagnoseLocal,
  diagnoseRemote,
  formatFps,
  formatKbps,
  formatMs,
  formatPercent,
  formatResolution,
  formatSeconds,
  formatShare,
  FPS_RATIO,
  LOSS_WARNING_PERCENT,
  LOW_LAYER_RATIO,
  lossStage,
  NO_PROBLEMS_TEXT,
  senderFromLocal,
  senderFromSummary,
  STAGE_LABELS,
  type Issue,
  type IssueLevel,
  type PipelineStage,
} from '../../lib/diagnostics';
import { pluralize } from '../../lib/format';
import type { PublisherStats, PublisherSummary } from '../../lib/publisherStats';
import {
  isHardwareCodec,
  STATS_HISTORY_MS,
  summarizeInbound,
  summarizeOutbound,
  type ConnectionKind,
  type OutboundLayerWindow,
  type QualityLimitation,
} from '../../lib/rtcStats';
import { niceMax, seriesRange, toSeries, type SeriesSample } from '../../lib/sparkline';
import type { StreamKind } from '../../lib/streamKey';
import { codecName, formatBitrate } from '../../lib/streamStats';
import { CloseIcon } from '../icons';
import { Sparkline } from '../Sparkline';
import '../../styles/stats-panel.css';

export type StatsTarget =
  | { kind: 'remote'; stream: RemoteStream }
  | {
      kind: 'local';
      source: StreamKind;
      /** "Sua tela: Valorant" / "Sua câmera". */
      name: string;
      stats: LocalStatsHistory | null;
      /** Frame rate the encoder aims for (preset fps; 30 for the webcam). */
      targetFps: number;
    };

export interface StatsPanelProps {
  target: StatsTarget;
  /** The × button. Esc is handled by the owner (Workspace/PopoutView), not by the panel. */
  onClose(): void;
}

/** Frame rates and the diagnosis use the last 10 s; counts and the charts the last 30 s. */
const RECENT_MS = 10_000;
const CHART_WIDTH = 296;
const CHART_HEIGHT = 44;
/** Two points further apart than this are a gap in the charts (no video for a while). */
const CHART_GAP_MS = 2_500;
const COPIED_FEEDBACK_MS = 2_000;

const CONNECTION_LABELS: Record<ConnectionKind, string> = {
  udp: 'UDP',
  tcp: 'TCP',
  relay: 'TURN (relay)',
};

const LIMITATION_LABELS: Record<QualityLimitation, string> = {
  none: 'nenhuma',
  cpu: 'CPU',
  bandwidth: 'banda',
  other: 'outra',
};

const LEVEL_LABELS: Record<IssueLevel, string> = {
  error: 'Problema',
  warning: 'Atenção',
  info: 'Observação',
};

interface Row {
  label: string;
  /** Null shows "—". */
  value: string | null;
  title?: string;
  warn?: boolean;
}

function DetailList({ rows }: { rows: readonly Row[] }) {
  return (
    <dl className="stats-panel__list">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt>{row.label}</dt>
          <dd title={row.title} className={row.warn ? 'stats-panel__value--warn' : undefined}>
            {row.value ?? '—'}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function IssueList({ issues }: { issues: readonly Issue[] | null }) {
  if (issues === null) return <p className="stats-panel__note">Coletando dados…</p>;
  if (issues.length === 0) return <p className="stats-panel__ok">{NO_PROBLEMS_TEXT}</p>;
  return (
    <ul className="stats-panel__issues">
      {issues.map((issue) => (
        <li key={issue.id} className={`stats-panel__issue stats-panel__issue--${issue.level}`}>
          <span className="sr-only">{LEVEL_LABELS[issue.level]}: </span>
          {issue.text}
        </li>
      ))}
    </ul>
  );
}

interface ChartsProps {
  now: number;
  loss: SeriesSample[];
  fps: SeriesSample[];
  /** "recebidos" / "enviados". */
  fpsNoun: string;
  targetFps: number | null;
}

/** "Perda de pacotes" (%) and "Quadros por segundo" with the target as a dashed line. */
function Charts({ now, loss, fps, fpsNoun, targetFps }: ChartsProps) {
  if (now === 0) return null;
  const lossMax = niceMax(
    loss.map((sample) => sample.value),
    5,
    5,
  );
  const lossRange = seriesRange(loss);
  const fpsMax = niceMax([...fps.map((sample) => sample.value), targetFps], 10, 10, 1.15);
  const fpsRange = seriesRange(fps);
  const target: SeriesSample[] | undefined =
    targetFps !== null
      ? [
          { at: now - STATS_HISTORY_MS, value: targetFps },
          { at: now, value: targetFps },
        ]
      : undefined;
  return (
    <section className="stats-panel__section stats-panel__charts">
      <Sparkline
        samples={loss}
        now={now}
        windowMs={STATS_HISTORY_MS}
        max={lossMax}
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        caption="Perda de pacotes"
        summary={lossRange ? `máx ${formatPercent(lossRange.max)}` : 'sem dados'}
        scaleLabel={`${lossMax}%`}
      />
      <Sparkline
        className="stats-panel__chart"
        samples={fps}
        now={now}
        windowMs={STATS_HISTORY_MS}
        max={fpsMax}
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        caption={`Quadros por segundo ${fpsNoun}`}
        summary={
          fpsRange
            ? `mín ${formatFps(fpsRange.min)}${targetFps !== null ? ` · alvo ${targetFps}` : ''}`
            : 'sem dados'
        }
        scaleLabel={`${fpsMax} fps`}
        secondary={target}
      />
    </section>
  );
}

function appVersion(): string {
  try {
    return concord().version;
  } catch {
    return 'desconhecida';
  }
}

type CopyState = { state: 'idle' } | { state: 'copied' } | { state: 'error'; message: string };

const stop = (event: SyntheticEvent): void => event.stopPropagation();

interface FrameProps {
  title: string;
  onClose(): void;
  /** Null while there is nothing to judge yet. */
  issues: readonly Issue[] | null;
  /** Everything "Copiar diagnóstico" puts on the clipboard (without the app header). */
  buildReport(): Record<string, unknown>;
  children: ReactNode;
}

/** Header with ×, scrollable body, "Possíveis problemas" and "Copiar diagnóstico". */
function PanelFrame({ title, onClose, issues, buildReport, children }: FrameProps) {
  const [copy, setCopy] = useState<CopyState>({ state: 'idle' });

  useEffect(() => {
    if (copy.state !== 'copied') return;
    const timer = window.setTimeout(() => setCopy({ state: 'idle' }), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const onCopy = (): void => {
    let text: string;
    try {
      text = JSON.stringify(
        {
          app: 'Concord',
          version: appVersion(),
          copiedAt: new Date().toISOString(),
          ...buildReport(),
        },
        null,
        2,
      );
    } catch (err) {
      setCopy({ state: 'error', message: toErrorMessage(err) });
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => setCopy({ state: 'copied' }),
      (err: unknown) =>
        setCopy({
          state: 'error',
          message: `Não foi possível copiar: ${toErrorMessage(err, 'a área de transferência recusou.')}`,
        }),
    );
  };

  return (
    // The panel sits over a tile: clicks, double clicks, the context menu and the wheel stay here.
    <section
      className="stats-panel"
      role="dialog"
      aria-label={title}
      onPointerDown={stop}
      onPointerUp={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onWheel={stop}
    >
      <header className="stats-panel__header">
        <h2 className="stats-panel__title" title={title}>
          {title}
        </h2>
        <button
          type="button"
          className="icon-btn stats-panel__close"
          aria-label="Fechar estatísticas"
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="stats-panel__body">
        {children}
        <section className="stats-panel__section">
          <h3 className="stats-panel__heading">Possíveis problemas</h3>
          <IssueList issues={issues} />
        </section>
        <div className="stats-panel__footer">
          <button type="button" className="btn btn--sm" onClick={onCopy}>
            {copy.state === 'copied' ? 'Copiado!' : 'Copiar diagnóstico'}
          </button>
          {copy.state === 'error' && (
            <p className="stats-panel__error" role="alert">
              {copy.message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function hardwareLabel(hardware: boolean | null): string | null {
  if (hardware === null) return null;
  return hardware ? 'hardware' : 'software';
}

function joinParts(parts: readonly (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null && part.length > 0);
  return present.length > 0 ? present.join(' · ') : null;
}

/** "banda agora · CPU 5% · banda 42%". */
function limitationText(
  limitation: QualityLimitation | null,
  cpuShare: number | null,
  bandwidthShare: number | null,
): string | null {
  return joinParts([
    limitation ? `${LIMITATION_LABELS[limitation]} agora` : null,
    cpuShare ? `CPU ${formatShare(cpuShare)}` : null,
    bandwidthShare ? `banda ${formatShare(bandwidthShare)}` : null,
  ]);
}

function fpsOrDash(fps: number | null): string {
  return fps === null ? '—' : formatFps(fps);
}

function stageText(stage: PipelineStage | null): string {
  return stage ? `começa ${STAGE_LABELS[stage]}` : 'nenhuma etapa abaixo do alvo';
}

// ---------------------------------------------------------------------------------------------
// A video you watch
// ---------------------------------------------------------------------------------------------

function PublisherSection({
  publisher,
  ageMs,
}: {
  publisher: PublisherStats;
  ageMs: number | null;
}) {
  let content: ReactNode;
  if (publisher.status === 'missing') {
    content = <p className="stats-panel__note">O transmissor usa uma versão sem estatísticas.</p>;
  } else if (publisher.status === 'invalid') {
    content = (
      <p className="stats-panel__note">As estatísticas do transmissor não puderam ser lidas.</p>
    );
  } else {
    content = <DetailList rows={publisherRows(publisher.summary, ageMs)} />;
  }
  return (
    <section className="stats-panel__section">
      <h3 className="stats-panel__heading">Transmissor</h3>
      {content}
    </section>
  );
}

function publisherRows(summary: PublisherSummary, ageMs: number | null): Row[] {
  const stage = lossStage(senderFromSummary(summary));
  const sent = formatResolution(summary.width, summary.height);
  const captured = formatResolution(summary.captureWidth, summary.captureHeight);
  return [
    {
      label: 'Captura · codificação · envio',
      value: `${fpsOrDash(summary.captureFps)} · ${fpsOrDash(summary.encodeFps)} · ${fpsOrDash(summary.sentFps)} fps`,
      title: 'A primeira etapa abaixo do alvo aponta onde os quadros se perdem.',
      warn: stage !== null,
    },
    { label: 'Perda de quadros', value: stageText(stage), warn: stage !== null },
    {
      label: 'Resolução enviada',
      value: sent && captured && captured !== sent ? `${sent} (captura ${captured})` : sent,
    },
    {
      label: 'Encoder',
      value: joinParts([summary.encoder ?? summary.codec, hardwareLabel(summary.hardware)]),
      warn: summary.hardware === false,
    },
    {
      label: 'Limitação',
      value: limitationText(summary.limitation, summary.cpuShare, summary.bandwidthShare),
      warn: summary.limitation === 'cpu' || summary.limitation === 'bandwidth',
    },
    {
      label: 'Bitrate',
      value:
        summary.bitrateKbps === null
          ? null
          : `${formatKbps(summary.bitrateKbps)}${summary.targetBitrateKbps !== null ? ` de ${formatKbps(summary.targetBitrateKbps)}` : ''}`,
    },
    {
      label: 'Upload estimado',
      value: summary.uplinkKbps === null ? null : formatKbps(summary.uplinkKbps),
    },
    {
      label: 'Perda no envio',
      value: summary.lossPercent === null ? null : formatPercent(summary.lossPercent),
    },
    { label: 'Atualizado', value: ageMs === null ? null : `há ${Math.round(ageMs / 1000)} s` },
  ];
}

function RemoteStatsPanel({ stream, onClose }: { stream: RemoteStream; onClose(): void }) {
  const { now, latest, points, publisher, publisherChangedAt } = useStreamDiagnostics(stream);
  const window30 = now > 0 ? summarizeInbound(points, now - STATS_HISTORY_MS) : null;
  const recent = now > 0 ? summarizeInbound(points, now - RECENT_MS) : null;
  const summary = publisher.status === 'ok' ? publisher.summary : null;
  const dimensions = stream.video?.dimensions;
  // What the broadcaster encodes now (top active layer), else what it announced at publish time.
  const publishedWidth = summary?.width ?? dimensions?.width ?? null;
  const publishedHeight = summary?.height ?? dimensions?.height ?? null;
  const paused = stream.streamState === Track.StreamState.Paused;
  const publisherAgeMs =
    publisherChangedAt === null || now === 0 ? null : Math.max(0, now - publisherChangedAt);
  const targetFps = summary?.targetFps ?? null;
  const hasVideo = stream.videoTrack !== null;

  // Without video only the broadcaster's side can be judged; with video, wait for a window.
  const issues =
    now > 0 && (window30 || !hasVideo)
      ? diagnoseRemote({
          kind: stream.kind,
          window: window30,
          recent,
          latest,
          publishedWidth,
          publishedHeight,
          paused,
          publisher,
          publisherAgeMs,
        })
      : null;

  const receivedSize = formatResolution(latest?.frameWidth ?? null, latest?.frameHeight ?? null);
  const originalSize = formatResolution(publishedWidth, publishedHeight);
  const lowLayer =
    latest?.frameWidth != null && publishedWidth !== null
      ? latest.frameWidth < publishedWidth * LOW_LAYER_RATIO
      : null;
  const fpsLow =
    targetFps !== null && recent?.fpsReceived != null && recent.fpsReceived < targetFps * FPS_RATIO;
  const decoderHardware = hardwareLabel(
    isHardwareCodec(latest?.decoderImplementation ?? null, latest?.powerEfficientDecoder ?? null),
  );

  const rows: Row[] = [
    {
      label: 'Resolução',
      value:
        receivedSize && originalSize && receivedSize !== originalSize
          ? `${receivedSize} · original ${originalSize}`
          : (receivedSize ?? originalSize),
    },
    {
      label: 'Quadros por segundo',
      value: recent
        ? joinParts([
            `${fpsOrDash(recent.fpsReceived)} recebidos`,
            `${fpsOrDash(recent.fpsDecoded)} decodificados`,
            targetFps !== null ? `alvo ${targetFps}` : null,
          ])
        : null,
      warn: fpsLow,
    },
    { label: 'Bitrate', value: recent?.bitrate != null ? formatBitrate(recent.bitrate) : null },
    {
      label: 'Codec',
      value: joinParts([
        codecName(latest?.codec ?? undefined),
        decoderHardware ? `decodificação por ${decoderHardware}` : null,
      ]),
      title: latest?.decoderImplementation ?? undefined,
    },
    {
      label: 'Decodificação',
      value: window30?.decodeMs != null ? `${formatMs(window30.decodeMs, 1)} por quadro` : null,
    },
    {
      label: 'Perda (30 s)',
      value: window30
        ? `${formatPercent(window30.lossPercent ?? 0)} (${pluralize(window30.packetsLost, 'pacote', 'pacotes')})`
        : null,
      warn: (window30?.lossPercent ?? 0) > LOSS_WARNING_PERCENT,
    },
    {
      label: 'Jitter',
      value: latest?.jitter != null ? formatMs(latest.jitter * 1000) : null,
    },
    {
      label: 'Atraso do buffer',
      value: window30?.jitterBufferMs != null ? formatMs(window30.jitterBufferMs) : null,
    },
    { label: 'RTT', value: latest?.rttMs != null ? formatMs(latest.rttMs) : null },
    {
      label: 'Conexão',
      value: latest?.connection ? CONNECTION_LABELS[latest.connection] : null,
      warn: latest?.connection === 'tcp' || latest?.connection === 'relay',
    },
    {
      label: 'Camada',
      value: lowLayer === null ? null : lowLayer ? 'baixa' : 'alta',
    },
    {
      label: 'Congelamentos (30 s)',
      value: window30 ? `${window30.freezes} (${formatSeconds(window30.freezeSeconds)})` : null,
      warn: (window30?.freezes ?? 0) > 0,
    },
    {
      label: 'Quadros descartados (30 s)',
      value: window30 ? String(window30.framesDropped) : null,
    },
    {
      label: 'PLI / NACK (30 s)',
      value: window30 ? `${window30.plis} / ${window30.nacks}` : null,
    },
  ];

  const subject = `${stream.kind === 'camera' ? 'Câmera' : 'Tela'} de ${stream.name}`;
  const buildReport = (): Record<string, unknown> => ({
    target: {
      kind: 'remote',
      stream: stream.key,
      source: stream.kind,
      participantId: stream.participantId,
      name: stream.name,
      published: dimensions ?? null,
      streamState: stream.streamState,
      subscribed: hasVideo,
    },
    summary: { last10s: recent, last30s: window30, latest },
    publisher: { ...publisher, ageMs: publisherAgeMs },
    issues,
    history: points,
  });

  return (
    <PanelFrame
      title={`Estatísticas · ${subject}`}
      onClose={onClose}
      issues={issues}
      buildReport={buildReport}
    >
      {!hasVideo && (
        <p className="stats-panel__note">O vídeo não está sendo recebido nesta janela.</p>
      )}
      <section className="stats-panel__section">
        <DetailList rows={rows} />
      </section>
      <PublisherSection publisher={publisher} ageMs={publisherAgeMs} />
      <Charts
        now={now}
        loss={toSeries(points, (point) => point.lossPercent, CHART_GAP_MS)}
        fps={toSeries(points, (point) => point.fpsReceived, CHART_GAP_MS)}
        fpsNoun="recebidos"
        targetFps={targetFps}
      />
    </PanelFrame>
  );
}

// ---------------------------------------------------------------------------------------------
// Your own video
// ---------------------------------------------------------------------------------------------

const EMPTY_SNAPSHOT: LocalStatsSnapshot = {
  updatedAt: 0,
  targetFps: 0,
  sample: null,
  latest: null,
  points: [],
  published: null,
};

function useLocalSnapshot(stats: LocalStatsHistory | null): LocalStatsSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => (stats ? stats.subscribe(listener) : () => undefined),
    [stats],
  );
  const getSnapshot = useCallback(() => (stats ? stats.getSnapshot() : EMPTY_SNAPSHOT), [stats]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Lowest layer first → "baixa", ("média"), "alta"; a single layer is "única". */
function layerNames(count: number): string[] {
  if (count <= 1) return ['única'];
  if (count === 2) return ['baixa', 'alta'];
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? 'baixa' : index === count - 1 ? 'alta' : 'média',
  );
}

function layerState(layer: OutboundLayerWindow): string {
  if (!layer.active) return 'pausada';
  if (layer.limitation && layer.limitation !== 'none') {
    return `limitada (${LIMITATION_LABELS[layer.limitation]})`;
  }
  return 'ativa';
}

function LayerTable({ layers }: { layers: readonly OutboundLayerWindow[] }) {
  if (layers.length === 0) return null;
  const names = layerNames(layers.length);
  const rows = layers.map((layer, index) => ({ layer, name: names[index] ?? '' })).reverse();
  return (
    <table className="stats-panel__layers">
      <caption className="sr-only">Camadas de simulcast</caption>
      <thead>
        <tr>
          <th scope="col">Camada</th>
          <th scope="col">Resolução</th>
          <th scope="col">fps</th>
          <th scope="col">Bitrate</th>
          <th scope="col">Estado</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ layer, name }) => (
          <tr key={layer.rid ?? name} className={layer.active ? undefined : 'stats-panel__muted'}>
            <td>{name}</td>
            <td>{formatResolution(layer.width, layer.height) ?? '—'}</td>
            <td>{layer.active ? formatFps(layer.sentFps) : '—'}</td>
            <td>{layer.active ? formatBitrate(layer.bitrate) : '—'}</td>
            <td>{layerState(layer)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LocalStatsPanel({
  target,
  onClose,
}: {
  target: Extract<StatsTarget, { kind: 'local' }>;
  onClose(): void;
}) {
  const snapshot = useLocalSnapshot(target.stats);
  const { updatedAt: now, latest, points } = snapshot;
  const { targetFps } = target;
  const window30 = now > 0 ? summarizeOutbound(points, now - STATS_HISTORY_MS) : null;
  const recent = now > 0 ? summarizeOutbound(points, now - RECENT_MS) : null;
  const view = recent ? senderFromLocal(targetFps, recent, latest) : null;
  const stage = view ? lossStage(view) : null;
  const issues = recent ? diagnoseLocal({ kind: target.source, targetFps, recent, latest }) : null;

  const captured = formatResolution(latest?.captureWidth ?? null, latest?.captureHeight ?? null);
  const sent = formatResolution(latest?.width ?? null, latest?.height ?? null);
  const rows: Row[] = [
    {
      label: 'Resolução',
      value: joinParts([captured ? `captura ${captured}` : null, sent ? `enviada ${sent}` : null]),
    },
    {
      label: 'Captura',
      value: recent?.captureFps != null ? `${formatFps(recent.captureFps)} fps` : null,
      warn: stage === 'capture',
    },
    {
      label: 'Codificação',
      value: recent
        ? joinParts([
            `${fpsOrDash(recent.encodeFps)} fps`,
            recent.encodeMs !== null ? `${formatMs(recent.encodeMs, 1)} por quadro` : null,
            recent.qp !== null ? `QP ${Math.round(recent.qp)}` : null,
          ])
        : null,
      warn: stage === 'encode',
    },
    {
      label: 'Envio',
      value: recent
        ? joinParts([
            `${fpsOrDash(recent.sentFps)} fps`,
            recent.bitrate !== null
              ? `${formatBitrate(recent.bitrate)}${recent.targetBitrate !== null ? ` de ${formatBitrate(recent.targetBitrate)}` : ''}`
              : null,
          ])
        : null,
      warn: stage === 'send',
    },
    { label: 'Alvo', value: `${targetFps} fps` },
    {
      label: 'Perda de quadros',
      value: recent ? stageText(stage) : null,
      warn: stage !== null,
    },
    {
      label: 'Encoder',
      value: joinParts([
        latest?.encoder ?? codecName(latest?.codec ?? undefined),
        hardwareLabel(latest?.hardware ?? null),
      ]),
      warn: latest?.hardware === false,
    },
    {
      label: 'Limitação',
      value: recent
        ? limitationText(latest?.limitation ?? null, recent.cpuShare, recent.bandwidthShare)
        : null,
      warn: latest?.limitation === 'cpu' || latest?.limitation === 'bandwidth',
    },
    {
      label: 'Upload estimado',
      value: recent?.uplink != null ? formatBitrate(recent.uplink) : null,
    },
    {
      label: 'Perda no servidor (30 s)',
      value: window30?.remoteLossPercent != null ? formatPercent(window30.remoteLossPercent) : null,
      warn: (window30?.remoteLossPercent ?? 0) > LOSS_WARNING_PERCENT,
    },
    { label: 'RTT', value: recent?.rttMs != null ? formatMs(recent.rttMs) : null },
    {
      label: 'Conexão',
      value: latest?.connection ? CONNECTION_LABELS[latest.connection] : null,
      warn: latest?.connection === 'tcp' || latest?.connection === 'relay',
    },
    {
      label: 'Quadros enormes · PLI · NACK (30 s)',
      value: window30 ? `${window30.hugeFrames} · ${window30.plis} · ${window30.nacks}` : null,
    },
  ];

  const buildReport = (): Record<string, unknown> => ({
    target: { kind: 'local', source: target.source, name: target.name, targetFps },
    summary: { last10s: recent, last30s: window30, latest, lossStage: stage },
    published: snapshot.published,
    sample: snapshot.sample,
    issues,
    history: points,
  });

  return (
    <PanelFrame
      title={`Estatísticas · ${target.name}`}
      onClose={onClose}
      issues={target.stats ? issues : null}
      buildReport={buildReport}
    >
      {!target.stats && (
        <p className="stats-panel__note">As estatísticas aparecem quando a transmissão começar.</p>
      )}
      <section className="stats-panel__section">
        <DetailList rows={rows} />
      </section>
      {recent && recent.layers.length > 1 && (
        <section className="stats-panel__section">
          <h3 className="stats-panel__heading">Camadas</h3>
          <LayerTable layers={recent.layers} />
        </section>
      )}
      <Charts
        now={now}
        loss={toSeries(points, (point) => point.remoteLossPercent, CHART_GAP_MS)}
        fps={toSeries(points, (point) => point.sentFps, CHART_GAP_MS)}
        fpsNoun="enviados"
        targetFps={targetFps}
      />
    </PanelFrame>
  );
}

/**
 * "Estatísticas da transmissão": packet loss and fps over the last 30 s, stream details, the
 * publisher's encoder numbers and possible problems. Absolutely positioned in the top-left
 * corner of its nearest positioned ancestor (`.stage` or the pop-out).
 */
export function StatsPanel({ target, onClose }: StatsPanelProps) {
  return target.kind === 'remote' ? (
    <RemoteStatsPanel stream={target.stream} onClose={onClose} />
  ) : (
    <LocalStatsPanel target={target} onClose={onClose} />
  );
}

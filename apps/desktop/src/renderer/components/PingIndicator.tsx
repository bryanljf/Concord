import { useEffect, useId, useRef, useState } from 'react';
import type { ServerPing } from '../hooks/useServerPing';
import {
  pingLabel,
  pingLevel,
  pingRange,
  pingScaleMax,
  pingSparkline,
  regionLabel,
} from '../lib/ping';

interface PingIndicatorProps {
  ping: ServerPing;
}

const BARS = [1, 2, 3, 4] as const;
const CHART_WIDTH = 200;
const CHART_HEIGHT = 44;

/** Filled line of the last 30 s of pings (0 ms at the bottom), with its scale and range in text. */
function PingChart({ history }: Pick<ServerPing, 'history'>) {
  const last = history.at(-1);
  if (!last) return null;
  const max = pingScaleMax(history);
  const { line, area } = pingSparkline(history, last.at, CHART_WIDTH, CHART_HEIGHT, max);
  const range = pingRange(history);
  return (
    <figure className="ping__chart">
      <figcaption>
        <span>Últimos 30 s</span>
        <span>{range ? `mín ${range.min} · máx ${range.max} ms` : 'sem resposta'}</span>
      </figcaption>
      <div className="ping__plot">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line className="ping__grid" x1="0" x2={CHART_WIDTH} y1="0.5" y2="0.5" />
          <line
            className="ping__baseline"
            x1="0"
            x2={CHART_WIDTH}
            y1={CHART_HEIGHT - 0.5}
            y2={CHART_HEIGHT - 0.5}
          />
          <path className="ping__area" d={area} />
          <path className="ping__line" d={line} />
        </svg>
        <span className="ping__scale">{max} ms</span>
      </div>
    </figure>
  );
}

/**
 * Four bars lit up to the connection level, all in that level's color (1 red, 2 orange, 3 yellow,
 * 4 green), like Discord. Hovering
 * shows only the ping, like Discord; clicking opens the details: exact ping, server instance,
 * region and the last 30 s. Escape, a click outside or another click closes them.
 */
export function PingIndicator({ ping }: PingIndicatorProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const level = ping.lost ? 0 : pingLevel(ping.ms);
  const latency = pingLabel(ping.ms, ping.lost);
  const name = ping.info?.name ?? '—';
  const region = ping.info ? regionLabel(ping.info) : '—';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="ping" ref={root}>
      <button
        type="button"
        className="ping__button"
        aria-label={`Ping ${latency}. Clique para ver os detalhes da conexão.`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-tooltip={open ? undefined : latency}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`ping__bars ping__bars--${level}`} aria-hidden="true">
          {BARS.map((bar) => (
            <span key={bar} className={bar <= level ? 'ping__bar ping__bar--lit' : 'ping__bar'} />
          ))}
        </span>
      </button>
      {open && (
        <div id={panelId} className="ping__panel" role="dialog" aria-label="Conexão com o servidor">
          <dl>
            <dt>Ping</dt>
            <dd className={`ping__value ping__value--${level}`}>{latency}</dd>
            <dt>Servidor</dt>
            <dd>{name}</dd>
            <dt>Região</dt>
            <dd>{region}</dd>
          </dl>
          <PingChart history={ping.history} />
        </div>
      )}
    </div>
  );
}

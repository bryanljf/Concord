import type { CaptureSource } from '../../../preload/api';
import { MonitorIcon, WindowIcon } from '../icons';

interface SourceCardProps {
  source: CaptureSource;
  selected: boolean;
  onSelect(): void;
  /** Double-click: select and start right away. */
  onConfirm(): void;
}

/** Thumbnail card for one window or screen (the thumbnail refreshes every 2 s). */
export function SourceCard({ source, selected, onSelect, onConfirm }: SourceCardProps) {
  return (
    <button
      type="button"
      className={selected ? 'source-card source-card--selected' : 'source-card'}
      aria-pressed={selected}
      title={source.name}
      onClick={onSelect}
      onDoubleClick={() => {
        onSelect();
        onConfirm();
      }}
    >
      <span className="source-card__thumb">
        {source.thumbnailDataUrl ? (
          <img src={source.thumbnailDataUrl} alt="" draggable={false} />
        ) : (
          <span className="source-card__placeholder">
            {source.kind === 'screen' ? <MonitorIcon size={28} /> : <WindowIcon size={28} />}
          </span>
        )}
      </span>
      <span className="source-card__label">
        {source.appIconDataUrl ? (
          <img className="source-card__icon" src={source.appIconDataUrl} alt="" draggable={false} />
        ) : source.kind === 'screen' ? (
          <MonitorIcon size={16} />
        ) : (
          <WindowIcon size={16} />
        )}
        <span className="source-card__name">{source.name}</span>
      </span>
    </button>
  );
}

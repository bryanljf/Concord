import type { KeyboardEvent, MouseEvent } from 'react';
import type { Viewer } from '../../lib/viewers';
import { CameraOffIcon } from '../icons';
import { LocalPreview } from './LocalPreview';
import { ViewerList } from './ViewerList';
import '../../styles/local-camera.css';

export interface LocalCameraTileProps {
  /** Raw webcam capture (shown mirrored). */
  track: MediaStreamTrack;
  /** Device label ("Câmera" when unknown). */
  label: string;
  /** Who is watching your camera. */
  viewers: readonly Viewer[];
  /** Large (on the stage) or mini (in the strip). */
  focused: boolean;
  /** "Desligar câmera". */
  onStop(): void;
  /** Right click / ContextMenu key / Shift+F10: "Escolher câmera…", "Estatísticas", "Desligar". */
  onContextMenu?(event: MouseEvent<HTMLElement>): void;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
}

/** Preview of your own webcam, mirrored like a mirror (viewers see it the right way round). */
export function LocalCameraTile({
  track,
  label,
  viewers,
  focused,
  onStop,
  onContextMenu,
  onKeyDown,
}: LocalCameraTileProps) {
  return (
    <div
      className={
        focused
          ? 'tile tile--focused tile--local tile--local-camera'
          : 'tile tile--mini tile--local tile--local-camera'
      }
      role="group"
      tabIndex={onContextMenu ? 0 : undefined}
      aria-label={`Prévia da sua câmera: ${label}`}
      aria-haspopup={onContextMenu ? 'menu' : undefined}
      aria-keyshortcuts={onContextMenu ? 'Shift+F10 ContextMenu' : undefined}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <LocalPreview track={track} className="tile__video local-camera__video" />
      <div className={focused ? 'tile__top' : 'tile__top tile__top--mini'}>
        <span className="tile__badge badge-live local-camera__badge">VOCÊ · CÂMERA</span>
        <span className="tile__name">{label}</span>
        {!focused && <ViewerList viewers={viewers} variant="compact" />}
      </div>
      {focused && (
        <div className="tile__controls tile__controls--static">
          <div className="tile__bottom-left">
            <ViewerList viewers={viewers} />
            <span className="tile__hint">Prévia da sua câmera (espelhada só para você).</span>
          </div>
          <button type="button" className="btn btn--danger btn--sm" onClick={onStop}>
            <CameraOffIcon size={16} />
            Desligar câmera
          </button>
        </div>
      )}
    </div>
  );
}

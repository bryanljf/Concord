import type { KeyboardEvent, MouseEvent } from 'react';
import type { RemoteStream } from '../../hooks/useRemoteStreams';
import { Avatar } from '../Avatar';
import { CameraIcon, CloseIcon, WindowIcon } from '../icons';

interface ElsewhereTileProps {
  /** Who it is (the video itself is not subscribed in this window). */
  stream: RemoteStream;
  /** Where it sits: big on the stage, a grid cell, or the strip. */
  variant: 'focused' | 'grid' | 'mini';
  /** Screen share: "Trazer de volta" (closes the pop-out). Webcam: "Fechar picture-in-picture". */
  onBringBack(): void;
  /** Screen share: "Mostrar janela" (brings the pop-out to the front). */
  onShowWindow?(): void;
  /** Grid and strip: the × "Parar de assistir" shown on hover. */
  onStopWatching?(): void;
  /** Right click: the watched-stream menu ("Trazer para esta janela", "Parar de assistir"). */
  onContextMenu(event: MouseEvent<HTMLElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

/**
 * Takes the place of a watched stream another window shows (the pop-out, the cameras'
 * picture-in-picture), so it is never received nor heard twice: a notice and the way back.
 */
export function ElsewhereTile({
  stream,
  variant,
  onBringBack,
  onShowWindow,
  onStopWatching,
  onContextMenu,
  onKeyDown,
}: ElsewhereTileProps) {
  const camera = stream.kind === 'camera';
  const mini = variant === 'mini';
  const message = camera
    ? 'Câmera no picture-in-picture'
    : `A transmissão de ${stream.name} está aberta em outra janela`;
  const shortMessage = camera ? 'No picture-in-picture' : 'Em outra janela';
  const tile = (
    <div
      className={`tile tile--elsewhere tile--elsewhere-${variant}`}
      role="group"
      tabIndex={0}
      aria-label={`${camera ? `Câmera de ${stream.name}` : message}. Shift+F10 abre as opções.`}
      aria-haspopup="menu"
      aria-keyshortcuts="Shift+F10 ContextMenu"
      data-focused-live={variant === 'focused' ? '' : undefined}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <div className={mini ? 'tile__top tile__top--mini' : 'tile__top'}>
        <span className={camera ? 'tile__badge badge-camera' : 'tile__badge badge-live'}>
          {camera ? 'CÂMERA' : 'AO VIVO'}
        </span>
        <Avatar
          id={stream.participantId}
          name={stream.name}
          src={stream.avatarUrl}
          size={mini ? 'xs' : 'sm'}
        />
        <span className="tile__name">{stream.name}</span>
      </div>
      <div className="elsewhere">
        {!mini && (
          <span className="elsewhere__icon" aria-hidden="true">
            {camera ? <CameraIcon size={32} /> : <WindowIcon size={32} />}
          </span>
        )}
        <p className="elsewhere__message">{mini ? shortMessage : message}</p>
        <div className="elsewhere__actions">
          <button
            type="button"
            className={mini ? 'btn btn--primary btn--sm elsewhere__btn--mini' : 'btn btn--primary'}
            onClick={onBringBack}
          >
            {camera ? 'Fechar picture-in-picture' : 'Trazer de volta'}
          </button>
          {!camera && !mini && onShowWindow && (
            <button type="button" className="btn" onClick={onShowWindow}>
              Mostrar janela
            </button>
          )}
        </div>
      </div>
    </div>
  );
  if (variant === 'focused' || !onStopWatching) return tile;
  return (
    <div className={variant === 'grid' ? 'tile-mini tile-grid' : 'tile-mini'}>
      {tile}
      <button
        type="button"
        className={variant === 'grid' ? 'tile-mini__close tile-grid__close' : 'tile-mini__close'}
        aria-label={`Parar de assistir ${camera ? 'a câmera' : 'a transmissão'} de ${stream.name}`}
        title="Parar de assistir"
        onClick={onStopWatching}
      >
        <CloseIcon size={variant === 'grid' ? 16 : 14} />
      </button>
    </div>
  );
}

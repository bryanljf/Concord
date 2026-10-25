import { useEffect, useRef } from 'react';
import { JAM_BOT_IDENTITY, type JamState, type RoomId } from '@concord/shared';
import type { JamUploadStatus } from '../../../preload/api';
import type { MusicListening } from '../../hooks/useMusicListening';
import type { JamPerson } from '../../lib/jam';
import type { Viewer } from '../../lib/viewers';
import { CloseIcon, HeadphonesIcon } from '../icons';
import type { JamListeningControls } from '../jam/JamPlayer';
import { JamElsewhereItem, JamRoomPanel } from '../jam/JamRoomPanel';
import '../../styles/music.css';

/** The Jam in the drawer. */
export interface MusicDrawerJam {
  /** Your room while connected to it (where the controls work); null otherwise. */
  room: RoomId | null;
  /** That room's Jam; null when it has none (or you are not connected). */
  state: JamState | null;
  /** The Jams the connection cannot play: other rooms, yours while not connected. */
  elsewhere: readonly JamState[];
  clockOffsetMs: number;
  person(id: string): JamPerson;
  uploads: ReadonlyMap<string, JamUploadStatus>;
  /** Who listens to your room's Jam (`concord.watching` `@jam#music`), you included. */
  listeners: readonly Viewer[];
  /** "Adicionar música": the search dialog (the drawer stays open behind it). */
  onOpenSearch(): void;
}

interface MusicDrawerProps {
  open: boolean;
  /** The Jam; null when the server has none (the drawer then never opens). */
  jam: MusicDrawerJam | null;
  listening: MusicListening;
  /** The ×, or a click anywhere outside it (Esc and the room buttons are handled by the owner). */
  onClose(): void;
}

/**
 * Elements whose clicks never close the drawer: the rooms' music buttons toggle it themselves
 * (closing here first would make them reopen it), and the Jam's search dialog opens over it from
 * "Adicionar música" (the drawer is still there, with the new song, once it closes).
 */
const KEEPS_OPEN = '.music-button, .room-icon__music, .jam-modal-backdrop';

/**
 * The music drawer: slides in from the left over the top of the stage (the layout stays put) with
 * your room's Jam (player, controls, who listens, the queue and "Adicionar música"), then the Jams
 * of the other rooms ("Entrar e ouvir"). Nothing plays until "Ouvir" is pressed. Closing it (×,
 * Esc, a click outside) never stops the audio.
 */
export function MusicDrawer({ open, jam, listening, onClose }: MusicDrawerProps) {
  const jamHere = jam?.room && jam.state ? { room: jam.room, state: jam.state } : null;
  const jamsElsewhere = jam?.elsewhere ?? [];
  const empty = jamHere === null && jamsElsewhere.length === 0;
  const jamListening: JamListeningControls = {
    on: listening.listening.includes(JAM_BOT_IDENTITY),
    pending: listening.pending === JAM_BOT_IDENTITY,
    setting: listening.settingFor(JAM_BOT_IDENTITY),
    listen: () => listening.listen(JAM_BOT_IDENTITY),
    stop: () => listening.stop(JAM_BOT_IDENTITY),
    setVolume: (volume) => listening.setVolume(JAM_BOT_IDENTITY, volume),
    toggleMute: () => listening.toggleMute(JAM_BOT_IDENTITY),
  };
  const panel = useRef<HTMLElement>(null);

  // A click anywhere else closes it, like the ×.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panel.current?.contains(target) || target.closest(KEEPS_OPEN)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onClose]);

  return (
    <section
      ref={panel}
      id="music-drawer"
      className={open ? 'music-drawer music-drawer--open' : 'music-drawer'}
      aria-label="Música"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="music-drawer__header">
        <HeadphonesIcon size={18} />
        <h2 className="music-drawer__title">Música</h2>
        <button
          type="button"
          className="icon-btn music-drawer__close"
          aria-label="Fechar o painel de música"
          title="Fechar (Esc)"
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </button>
      </header>
      <div className="music-drawer__body">
        {jam && jamHere && (
          <JamRoomPanel
            room={jamHere.room}
            state={jamHere.state}
            clockOffsetMs={jam.clockOffsetMs}
            person={jam.person}
            uploads={jam.uploads}
            listeners={jam.listeners}
            listening={jamListening}
            onOpenSearch={jam.onOpenSearch}
          />
        )}

        {jamsElsewhere.length > 0 && (
          <section className="music-drawer__section" aria-label="Jams em outras salas">
            <h3 className="music-drawer__heading">Em outras salas</h3>
            <ul className="music-drawer__list">
              {jamsElsewhere.map((state) => (
                <JamElsewhereItem
                  key={`jam:${state.room}`}
                  state={state}
                  pending={
                    listening.pending === JAM_BOT_IDENTITY && listening.pendingRoom === state.room
                  }
                  onListenIn={() => listening.listenIn(state.room, JAM_BOT_IDENTITY)}
                />
              ))}
            </ul>
          </section>
        )}

        {empty && <p className="music-drawer__empty">Nenhuma Jam tocando agora.</p>}
      </div>
    </section>
  );
}

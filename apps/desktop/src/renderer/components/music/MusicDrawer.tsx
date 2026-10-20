import { useEffect, useRef } from 'react';
import { roomLabel } from '@concord/shared';
import type { MusicBroadcastState } from '../../hooks/useMusicBroadcast';
import type { MusicListening } from '../../hooks/useMusicListening';
import { useOwnMusicArt, type RemoteMusic } from '../../hooks/useRemoteMusic';
import { listenersLabel, listenersTitle, type PresenceMusic } from '../../lib/musicListening';
import type { Viewer } from '../../lib/viewers';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';
import { CloseIcon, HeadphonesIcon } from '../icons';
import { MusicPlayerBar } from './MusicPlayerBar';
import '../../styles/music.css';

/** Who you are, for your own entry. */
export interface MusicDrawerSelf {
  id: string;
  name: string;
  avatarUrl: string | null;
}

interface MusicDrawerProps {
  open: boolean;
  self: MusicDrawerSelf;
  /** Your music broadcast: "Sua música" on top while starting or live. */
  own: MusicBroadcastState;
  /** Who listens to your music (`concord.watching` `<you>#music`). */
  ownListeners: readonly Viewer[];
  /** The music broadcasts in your room (livekit). */
  music: readonly RemoteMusic[];
  /** The ones livekit cannot show yet: other rooms (and yours while not connected). */
  elsewhere: readonly PresenceMusic[];
  listening: MusicListening;
  /** "Parar música" on your own entry. */
  onStopOwn(): void;
  /** The ×, or a click anywhere outside it (Esc and the room buttons are handled by the owner). */
  onClose(): void;
}

interface OwnMusicProps {
  self: MusicDrawerSelf;
  own: Extract<MusicBroadcastState, { status: 'starting' | 'live' }>;
  listeners: readonly Viewer[];
  onStop(): void;
}

function OwnMusic({ self, own, listeners, onStop }: OwnMusicProps) {
  const nowPlaying = own.status === 'live' ? own.nowPlaying : null;
  const artUrl = useOwnMusicArt(nowPlaying?.artId ?? null);
  const starting = own.status === 'starting';
  return (
    <MusicPlayerBar
      who="Você"
      personId={self.id}
      avatarUrl={self.avatarUrl}
      app={own.app}
      nowPlaying={nowPlaying}
      artUrl={artUrl}
      placeholder={starting ? 'Iniciando…' : undefined}
      actions={
        <button
          type="button"
          className="btn btn--danger btn--sm"
          disabled={starting}
          onClick={onStop}
        >
          Parar música
        </button>
      }
      footer={
        <p
          className="music-player__listeners"
          title={listenersTitle(listeners.map((viewer) => viewer.name))}
        >
          <HeadphonesIcon size={14} />
          {listenersLabel(listeners.length)}
          {own.status === 'live' && (
            <span
              className="music-player__quality"
              title="Qualidade do áudio enviado: a melhor que a sua conexão aguenta sem perder pacotes"
            >
              · {own.audioKbps} kbps
            </span>
          )}
        </p>
      }
    />
  );
}

/**
 * The music drawer: slides in from the left over the top of the stage (the layout stays put) and
 * lists every music broadcast with its own "Ouvir", like "Assistir" for lives: your own first,
 * then a full player for each one in your room, then the other rooms (entering them to listen).
 * Nothing plays until "Ouvir" is pressed, even with a single broadcast. Closing it (×, Esc, a click
 * outside) never stops the audio.
 */
export function MusicDrawer({
  open,
  self,
  own,
  ownListeners,
  music,
  elsewhere,
  listening,
  onStopOwn,
  onClose,
}: MusicDrawerProps) {
  const ownActive = own.status === 'starting' || own.status === 'live';
  const empty = !ownActive && music.length === 0 && elsewhere.length === 0;
  const panel = useRef<HTMLElement>(null);

  // A click anywhere else closes it, like the ×. The room rows' music buttons toggle it
  // themselves (closing here first would make them reopen it).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panel.current?.contains(target) || target.closest('.music-button')) return;
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
        {ownActive && (
          <section className="music-drawer__section" aria-label="Sua música">
            <h3 className="music-drawer__heading">Sua música</h3>
            <OwnMusic self={self} own={own} listeners={ownListeners} onStop={onStopOwn} />
          </section>
        )}

        {music.length > 0 && (
          <section className="music-drawer__section" aria-label="Músicas nesta sala">
            <h3 className="music-drawer__heading">Nesta sala</h3>
            <ul className="music-drawer__list">
              {music.map((item) => {
                const id = item.participantId;
                const on = listening.listening.includes(id);
                const pending = listening.pending === id;
                return (
                  <li key={id}>
                    <MusicPlayerBar
                      who={item.name}
                      personId={id}
                      avatarUrl={item.avatarUrl}
                      app={item.app}
                      nowPlaying={item.nowPlaying}
                      artUrl={item.artUrl}
                      listening={on}
                      actions={
                        on ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => listening.stop(id)}
                          >
                            Parar de ouvir
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={pending}
                            aria-label={`Ouvir a música de ${item.name}`}
                            onClick={() => listening.listen(id)}
                          >
                            {pending ? <Spinner size="sm" label="Conectando" /> : 'Ouvir'}
                          </button>
                        )
                      }
                      volume={
                        on
                          ? {
                              setting: listening.settingFor(id),
                              onVolume: (volume) => listening.setVolume(id, volume),
                              onToggleMute: () => listening.toggleMute(id),
                            }
                          : null
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {elsewhere.length > 0 && (
          <section className="music-drawer__section" aria-label="Músicas em outras salas">
            <h3 className="music-drawer__heading">Em outras salas</h3>
            <ul className="music-drawer__list">
              {elsewhere.map(({ room, participant }) => {
                const pending = listening.pending === participant.id;
                const where = roomLabel(room);
                return (
                  <li key={`${room}\n${participant.id}`} className="music-elsewhere">
                    <Avatar
                      id={participant.id}
                      name={participant.name}
                      src={participant.avatarUrl}
                      size="sm"
                    />
                    <div className="music-elsewhere__text">
                      <p className="music-elsewhere__name" title={`Música de ${participant.name}`}>
                        Música de <strong>{participant.name}</strong>
                        <span className="music-elsewhere__room"> · {where}</span>
                      </p>
                      <p className="music-elsewhere__hint">Ouvir entra na sala</p>
                    </div>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={pending}
                      aria-label={`Entrar em ${where} e ouvir a música de ${participant.name}`}
                      onClick={() => listening.listenIn(room, participant.id)}
                    >
                      {pending ? <Spinner size="sm" label="Entrando" /> : 'Ouvir'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {empty && <p className="music-drawer__empty">Procurando as transmissões de música…</p>}
      </div>
    </section>
  );
}

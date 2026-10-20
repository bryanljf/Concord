import { useMemo, useState } from 'react';
import { QUALITY_PRESETS, roomLabel, type QualityPresetId, type RoomId } from '@concord/shared';
import type { CaptureSource, MusicAppId, ProcessAudioSupport } from '../../../preload/api';
import type { BroadcastAudioMode, BroadcastRequest } from '../../hooks/useBroadcast';
import type { MusicBroadcastState } from '../../hooks/useMusicBroadcast';
import { useCaptureSources } from '../../hooks/useCaptureSources';
import { useMusicAppStatus } from '../../hooks/useMusicAppStatus';
import { useProcessAudioSupport } from '../../hooks/useProcessAudioSupport';
import type { Settings } from '../../lib/concord';
import { presetDescription } from '../../lib/encoding';
import { musicDuplicationWarning, screenAudioIncludesMusic } from '../../lib/musicWarnings';
import { sourceKindOf } from '../../lib/sourceSwitch';
import { Spinner } from '../Spinner';
import {
  CloseIcon,
  MonitorIcon,
  MusicIcon,
  RefreshIcon,
  SpeakerIcon,
  StopIcon,
  SwapScreenIcon,
  WarningIcon,
  WindowIcon,
} from '../icons';
import { MusicTab } from './MusicTab';
import { SourceCard } from './SourceCard';
import '../../styles/source-picker.css';

const PRESET_IDS: QualityPresetId[] = ['light', 'standard', 'game'];

const CODEC_LABELS: Record<Settings['codec'], string> = {
  h264: 'H.264',
  vp9: 'VP9',
  av1: 'AV1',
};

interface SourcePickerProps {
  rooms: RoomId[];
  /** Room already joined, or null: the picker then asks which room to stream to. */
  currentRoom: RoomId | null;
  settings: Settings;
  /** A broadcast is being started (or switched) with the last request. */
  starting: boolean;
  /**
   * Switch mode (while live): the room is fixed, the shared source is marked "Transmitindo
   * agora", the current quality/audio are preselected and the button reads "Trocar".
   */
  live?: { sourceId: string; quality: QualityPresetId; audio: BroadcastAudioMode } | null;
  onCancel(): void;
  onStart(request: BroadcastRequest): void;
  /** "Música" tab: the music broadcast (independent of the screen share), started from here. */
  music: MusicBroadcastState;
  /** "Transmitir música" in the Música tab (joins the selected room when needed). */
  onStartMusic(room: RoomId, app: MusicAppId): void;
  onStopMusic(): void;
}

type Tab = CaptureSource['kind'] | 'music';

/** The only music app for now ("Por enquanto, só o Spotify"). */
const MUSIC_APP: MusicAppId = 'spotify';

/** Discord-like modal to choose a window/screen, the quality and the audio, or the music. */
export function SourcePicker({
  rooms,
  currentRoom,
  settings,
  starting,
  live = null,
  onCancel,
  onStart,
  music,
  onStartMusic,
  onStopMusic,
}: SourcePickerProps) {
  const switching = live !== null;
  const [room, setRoom] = useState<RoomId | null>(
    currentRoom ?? (rooms.length === 1 ? (rooms[0] ?? null) : null),
  );
  const [tab, setTab] = useState<Tab>(live ? sourceKindOf(live.sourceId) : 'window');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityPresetId>(live?.quality ?? settings.defaultQuality);
  const [audioChoice, setAudioChoice] = useState<boolean | null>(
    live ? live.audio !== 'none' : null,
  );
  const [musicRetry, setMusicRetry] = useState(0);
  const support = useProcessAudioSupport();
  const choosingRoom = room === null;
  const musicTab = tab === 'music';
  // The Música tab only needs the list while live, for the name of what is being shared.
  const { sources, loading, error, refresh } = useCaptureSources(
    !choosingRoom && (!musicTab || switching),
  );
  const musicStatus = useMusicAppStatus(MUSIC_APP, !choosingRoom && musicTab, musicRetry);

  const processAudio = support?.supported === true;
  // Per-process capture is safe by default; whole-system loopback carries the Discord call.
  const audioOn = audioChoice ?? processAudio;
  const audioMode: BroadcastAudioMode = audioOn ? (processAudio ? 'process' : 'system') : 'none';

  const visible = useMemo(() => sources.filter((source) => source.kind === tab), [sources, tab]);
  // A selection whose window disappeared between refreshes simply stops being selectable.
  const selected = sources.find((source) => source.id === selectedId) ?? null;

  // Music + a screen share whose audio also carries the music app: allowed, but it goes out twice.
  const musicActive = music.status === 'live' || music.status === 'starting';
  const musicNowPlaying =
    music.status === 'live' ? music.nowPlaying : (musicStatus?.nowPlaying ?? null);
  const selectedDuplicates =
    musicActive &&
    selected !== null &&
    screenAudioIncludesMusic(
      { sourceId: selected.id, sourceName: selected.name, audio: audioMode },
      MUSIC_APP,
      musicNowPlaying,
    );
  const liveSourceName = live ? sources.find((source) => source.id === live.sourceId)?.name : '';
  const liveDuplicates =
    live !== null &&
    screenAudioIncludesMusic(
      { sourceId: live.sourceId, sourceName: liveSourceName ?? '', audio: live.audio },
      MUSIC_APP,
      musicNowPlaying,
    );

  function start(): void {
    if (!room || !selected) return;
    onStart({
      room,
      sourceId: selected.id,
      sourceName: selected.name,
      quality,
      audio: audioMode,
    });
  }

  const canStartMusic =
    room !== null && music.status === 'idle' && musicStatus?.running === true && processAudio;

  function startMusic(): void {
    if (room && canStartMusic) onStartMusic(room, MUSIC_APP);
  }

  return (
    <div className="picker-backdrop" onClick={onCancel}>
      <div
        className="picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="picker__header">
          <h2 id="picker-title" className="picker__title">
            {choosingRoom
              ? 'Transmitir em qual sala?'
              : musicTab
                ? 'Transmitir música'
                : switching
                  ? 'Trocar o que você está transmitindo'
                  : 'O que você quer transmitir?'}
          </h2>
          {!choosingRoom && room && (
            <span className="picker__room">
              em <strong>{roomLabel(room)}</strong>
              {!currentRoom && !switching && rooms.length > 1 && (
                <button type="button" className="btn btn--link" onClick={() => setRoom(null)}>
                  trocar
                </button>
              )}
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar"
            data-tooltip="Fechar (Esc)"
            onClick={onCancel}
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {choosingRoom ? (
          <div className="picker__rooms">
            {rooms.length === 0 ? (
              <p className="picker__empty">
                Nenhuma sala disponível. Verifique a conexão com o servidor.
              </p>
            ) : (
              rooms.map((candidate, index) => (
                <button
                  key={candidate}
                  type="button"
                  className="picker__room-btn"
                  autoFocus={index === 0}
                  onClick={() => setRoom(candidate)}
                >
                  <SpeakerIcon size={20} />
                  <span>{roomLabel(candidate)}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            <div className="picker__tabs" role="tablist" aria-label="Tipo de fonte">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'window'}
                className="picker__tab"
                autoFocus
                onClick={() => setTab('window')}
              >
                <WindowIcon size={18} />
                Aplicativos
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'screen'}
                className="picker__tab"
                onClick={() => setTab('screen')}
              >
                <MonitorIcon size={18} />
                Telas
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={musicTab}
                className="picker__tab"
                onClick={() => setTab('music')}
              >
                <MusicIcon size={18} />
                Música
              </button>
              <button
                type="button"
                className="icon-btn picker__refresh"
                aria-label={musicTab ? 'Verificar de novo' : 'Atualizar lista'}
                data-tooltip={musicTab ? 'Verificar de novo' : 'Atualizar lista'}
                onClick={musicTab ? () => setMusicRetry((value) => value + 1) : refresh}
              >
                <RefreshIcon size={18} />
              </button>
            </div>

            <div className="picker__grid-wrap" role="tabpanel">
              {musicTab ? (
                <MusicTab
                  app={MUSIC_APP}
                  status={musicStatus}
                  support={support}
                  music={music}
                  duplicates={liveDuplicates}
                  onRetry={() => setMusicRetry((value) => value + 1)}
                />
              ) : loading ? (
                <div className="picker__state" role="status">
                  <Spinner label="Carregando" />
                  <span>Procurando janelas e telas…</span>
                </div>
              ) : error ? (
                <div className="picker__state picker__state--error" role="alert">
                  <WarningIcon size={28} />
                  <span>{error}</span>
                  <button type="button" className="btn btn--sm" onClick={refresh}>
                    Tentar de novo
                  </button>
                </div>
              ) : visible.length === 0 ? (
                <div className="picker__state" role="status">
                  <span>
                    {tab === 'window'
                      ? 'Nenhuma janela aberta foi encontrada.'
                      : 'Nenhuma tela foi encontrada.'}
                  </span>
                </div>
              ) : (
                <ul className="picker__grid">
                  {visible.map((source) => (
                    <li key={source.id}>
                      <SourceCard
                        source={source}
                        selected={source.id === selectedId}
                        live={source.id === live?.sourceId}
                        onSelect={() => setSelectedId(source.id)}
                        onConfirm={start}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {!musicTab && (
              <ScreenOptions
                quality={quality}
                codec={settings.codec}
                support={support}
                audioOn={audioOn}
                duplicatesMusic={selectedDuplicates}
                onQuality={setQuality}
                onAudio={setAudioChoice}
              />
            )}

            <div className="picker__footer">
              <button type="button" className="btn btn--ghost" onClick={onCancel}>
                {musicTab && music.status === 'live' ? 'Fechar' : 'Cancelar'}
              </button>
              {musicTab ? (
                <MusicAction
                  music={music}
                  canStart={canStartMusic}
                  onStart={startMusic}
                  onStop={onStopMusic}
                />
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!selected || starting}
                  onClick={start}
                >
                  {starting ? (
                    <Spinner size="sm" label={switching ? 'Trocando' : 'Iniciando'} />
                  ) : switching ? (
                    <SwapScreenIcon size={18} />
                  ) : (
                    <MonitorIcon size={18} />
                  )}
                  {starting
                    ? switching
                      ? 'Trocando…'
                      : 'Iniciando…'
                    : switching
                      ? 'Trocar'
                      : 'Transmitir'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface ScreenOptionsProps {
  quality: QualityPresetId;
  codec: Settings['codec'];
  support: ProcessAudioSupport | null;
  audioOn: boolean;
  /** The music is being broadcast and the selected source's audio also carries it. */
  duplicatesMusic: boolean;
  onQuality(quality: QualityPresetId): void;
  onAudio(enabled: boolean): void;
}

/** Quality and audio of a window/screen broadcast, with their warnings. */
function ScreenOptions({
  quality,
  codec,
  support,
  audioOn,
  duplicatesMusic,
  onQuality,
  onAudio,
}: ScreenOptionsProps) {
  const processAudio = support?.supported === true;
  return (
    <>
      <div className="picker__options">
        <div className="field picker__quality">
          <label className="field__label" htmlFor="picker-quality">
            Qualidade
          </label>
          <select
            id="picker-quality"
            className="select"
            value={quality}
            onChange={(event) => onQuality(event.target.value as QualityPresetId)}
          >
            {PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {QUALITY_PRESETS[id].label} — {presetDescription(id)}
              </option>
            ))}
          </select>
          <p className="field__hint">
            Codec {CODEC_LABELS[codec]} · mude o padrão nas configurações.
          </p>
        </div>

        <label className="switch picker__audio">
          <span className="switch__text">
            <span className="switch__title">
              {processAudio ? 'Áudio do aplicativo' : 'Incluir áudio do sistema'}
            </span>
            <span className="switch__desc">
              {support === null
                ? 'Verificando a captura de áudio…'
                : processAudio
                  ? 'Só o som do jogo, sem a call do Discord.'
                  : 'Use fone de ouvido ou o áudio da call vai junto.'}
            </span>
            {support !== null && !processAudio && support.reason && (
              <span className="switch__desc picker__reason">{support.reason}</span>
            )}
          </span>
          <input
            type="checkbox"
            checked={audioOn}
            disabled={support === null}
            onChange={(event) => onAudio(event.target.checked)}
          />
        </label>
      </div>

      {audioOn && support !== null && !processAudio && (
        <p className="picker__warning" role="note">
          <WarningIcon size={16} />
          Use fone de ouvido ou o áudio da call vai junto: o áudio do sistema inclui tudo que o seu
          PC toca, Discord incluído.
        </p>
      )}

      {duplicatesMusic && (
        <p className="picker__warning" role="note">
          <WarningIcon size={16} />
          {musicDuplicationWarning(MUSIC_APP)}
        </p>
      )}
    </>
  );
}

interface MusicActionProps {
  music: MusicBroadcastState;
  canStart: boolean;
  onStart(): void;
  onStop(): void;
}

/** Footer button of the Música tab: "Transmitir música", or "Parar música" while it plays. */
function MusicAction({ music, canStart, onStart, onStop }: MusicActionProps) {
  switch (music.status) {
    case 'idle':
      return (
        <button type="button" className="btn btn--primary" disabled={!canStart} onClick={onStart}>
          <MusicIcon size={18} />
          Transmitir música
        </button>
      );
    case 'starting':
      return (
        <button type="button" className="btn btn--primary" disabled>
          <Spinner size="sm" label="Iniciando" />
          Iniciando…
        </button>
      );
    case 'live':
      return (
        <button type="button" className="btn btn--danger" onClick={onStop}>
          <StopIcon size={18} />
          Parar música
        </button>
      );
    case 'stopping':
      return (
        <button type="button" className="btn btn--danger" disabled>
          <Spinner size="sm" label="Parando" />
          Parando…
        </button>
      );
  }
}

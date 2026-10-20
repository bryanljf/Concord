import { roomLabel, type PresenceParticipant, type RoomId } from '@concord/shared';
import type { Settings } from '../../lib/concord';
import { Avatar } from '../Avatar';
import { SettingsSection } from './SettingsSection';

interface NotificationsSectionProps {
  settings: Settings;
  rooms: RoomId[];
  /** Everyone currently seen in presence (any room). */
  participants: PresenceParticipant[];
  onUpdate(patch: Partial<Settings>): void;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function NotificationsSection({
  settings,
  rooms,
  participants,
  onUpdate,
}: NotificationsSectionProps) {
  // Muted people who are offline right now still need a chip so they can be unmuted.
  const people: { id: string; name: string; avatarUrl?: string | null }[] = [
    ...participants,
    ...settings.mutedUsers
      .filter((id) => !participants.some((participant) => participant.id === id))
      .map((id) => ({ id, name: id })),
  ];

  return (
    <SettingsSection id="notificacoes" title="Sons">
      <label className="check">
        <input
          type="checkbox"
          checked={settings.viewerSounds}
          onChange={() => onUpdate({ viewerSounds: !settings.viewerSounds })}
        />
        <span>
          Tocar um som quando alguém entrar ou sair da sua live ou de uma live que você assiste
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.roomSounds}
          onChange={() => onUpdate({ roomSounds: !settings.roomSounds })}
        />
        <span>Tocar um som quando alguém (ou você) entrar ou sair da sala em que você está</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.musicSounds}
          onChange={() => onUpdate({ musicSounds: !settings.musicSounds })}
        />
        <span>Som quando alguém começar a transmitir música</span>
      </label>
      <p className="field__hint">
        Som quando alguém entra ao vivo ou começa a transmitir música na sua sala: toca um aviso
        curto enquanto você está numa sala e outra pessoa começa a transmitir nela. Silencie salas
        ou pessoas aqui.
      </p>
      <fieldset className="settings__fieldset">
        <legend className="field__label">Sem som nestas salas</legend>
        {rooms.length === 0 ? (
          <p className="field__hint">Nenhuma sala conhecida ainda.</p>
        ) : (
          rooms.map((room) => (
            <label key={room} className="check">
              <input
                type="checkbox"
                checked={settings.mutedRooms.includes(room)}
                onChange={() => onUpdate({ mutedRooms: toggle(settings.mutedRooms, room) })}
              />
              <span>{roomLabel(room)}</span>
            </label>
          ))
        )}
      </fieldset>
      <fieldset className="settings__fieldset">
        <legend className="field__label">Sem som para estas pessoas</legend>
        {people.length === 0 ? (
          <p className="field__hint">
            Ninguém conectado agora. As pessoas aparecem aqui quando entram numa sala.
          </p>
        ) : (
          <div className="chips">
            {people.map((person) => {
              const muted = settings.mutedUsers.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  className="chip"
                  aria-pressed={muted}
                  title={
                    muted
                      ? `Voltar a tocar o som quando ${person.name} entrar ao vivo ou transmitir música`
                      : `Não tocar som quando ${person.name} entrar ao vivo ou transmitir música`
                  }
                  onClick={() => onUpdate({ mutedUsers: toggle(settings.mutedUsers, person.id) })}
                >
                  <Avatar id={person.id} name={person.name} src={person.avatarUrl} size="xs" />
                  {person.name}
                  {muted && <span aria-hidden="true">· silenciado</span>}
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
    </SettingsSection>
  );
}

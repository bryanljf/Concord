import { roomLabel, type PresenceParticipant, type RoomId } from '@concord/shared';
import type { Settings } from '../../lib/concord';
import { mutablePeople } from '../../lib/presence';
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
  // One chip per person (PC and phone alike); muted people who are offline right now still need
  // theirs so they can be unmuted.
  const people = mutablePeople(participants, settings.mutedUsers);

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
        <span>Som quando começar uma Jam na sua sala</span>
      </label>
      <p className="field__hint">
        Som quando alguém entra ao vivo ou começa uma Jam na sua sala: toca um aviso curto enquanto
        você está numa sala e outra pessoa começa a transmitir nela ou adiciona a primeira música da
        Jam. Silencie salas ou pessoas aqui.
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
                      ? `Voltar a tocar o som quando ${person.name} entrar ao vivo ou começar uma Jam`
                      : `Não tocar som quando ${person.name} entrar ao vivo ou começar uma Jam`
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

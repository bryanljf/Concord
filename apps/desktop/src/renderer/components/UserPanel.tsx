import type { UserInfo } from '@concord/shared';
import { statusLabel, statusShortLabel, statusTone } from '../lib/presence';
import type { PresenceConnectionStatus } from '../lib/concord';
import { Avatar } from './Avatar';
import { GearIcon } from './icons';
import '../styles/user-panel.css';

interface UserPanelProps {
  user: UserInfo;
  status: PresenceConnectionStatus;
  onOpenSettings(): void;
  /** Avatar/name click: settings on Conta, ready to edit the display name. */
  onOpenProfile(): void;
  /** Collapsed sidebar: the avatar over the gear, no name (the buttons keep their labels). */
  compact?: boolean;
}

export function UserPanel({
  user,
  status,
  onOpenSettings,
  onOpenProfile,
  compact = false,
}: UserPanelProps) {
  const tone = statusTone(status);
  const label = statusLabel(status);
  return (
    <div className={compact ? 'user-panel user-panel--compact' : 'user-panel'}>
      <button
        type="button"
        className="user-panel__profile"
        aria-label={`${user.displayName} — editar perfil`}
        title={`Editar perfil · ${label}`}
        onClick={onOpenProfile}
      >
        <span className="user-panel__avatar">
          <Avatar id={user.id} name={user.displayName} src={user.avatarUrl} />
          <span
            className={`user-panel__dot user-panel__dot--${tone}`}
            role="img"
            aria-label={label}
          />
        </span>
        {!compact && (
          <span className="user-panel__info">
            <span className="user-panel__name">{user.displayName}</span>
            <span className="user-panel__status">{statusShortLabel(status)}</span>
          </span>
        )}
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Configurações"
        title="Configurações"
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>
    </div>
  );
}

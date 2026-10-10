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
}

export function UserPanel({ user, status, onOpenSettings }: UserPanelProps) {
  const tone = statusTone(status);
  const label = statusLabel(status);
  return (
    <div className="user-panel">
      <div className="user-panel__avatar" title={label}>
        <Avatar id={user.id} name={user.displayName} />
        <span
          className={`user-panel__dot user-panel__dot--${tone}`}
          role="img"
          aria-label={label}
        />
      </div>
      <div className="user-panel__info" title={label}>
        <span className="user-panel__name">{user.displayName}</span>
        <span className="user-panel__status">{statusShortLabel(status)}</span>
      </div>
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

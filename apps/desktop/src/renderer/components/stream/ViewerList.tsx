import { viewersLabel, type Viewer } from '../../lib/viewers';
import { Avatar } from '../Avatar';
import { EyeIcon } from '../icons';

interface ViewerListProps {
  viewers: readonly Viewer[];
  /** `compact`: only the eye and the count (mini tiles, where the overlay ignores the pointer). */
  variant?: 'full' | 'compact';
}

const STACKED = 3;

/**
 * Who is watching a live, as in Discord's Go Live: eye + count + stacked avatars; hovering or
 * focusing it lists everyone.
 */
export function ViewerList({ viewers, variant = 'full' }: ViewerListProps) {
  const label = viewersLabel(viewers);
  if (variant === 'compact') {
    return (
      <span className="viewers viewers--compact" role="img" aria-label={label} title={label}>
        <EyeIcon size={14} />
        {viewers.length}
      </span>
    );
  }
  const extra = viewers.length - STACKED;
  return (
    <div className="viewers" role="group" tabIndex={0} aria-label={label}>
      <EyeIcon size={16} />
      <span className="viewers__count">{viewers.length}</span>
      {viewers.length > 0 && (
        <span className="viewers__stack" aria-hidden="true">
          {viewers.slice(0, STACKED).map((viewer) => (
            <Avatar
              key={viewer.id}
              id={viewer.id}
              name={viewer.name}
              src={viewer.avatarUrl}
              size="xs"
            />
          ))}
          {extra > 0 && <span className="viewers__more">+{extra}</span>}
        </span>
      )}
      <div className="viewers__popover" aria-hidden="true">
        {viewers.length === 0 ? (
          <p className="viewers__empty">Ninguém assistindo ainda.</p>
        ) : (
          <>
            <p className="viewers__title">Assistindo — {viewers.length}</p>
            <ul className="viewers__list">
              {viewers.map((viewer) => (
                <li key={viewer.id}>
                  <Avatar id={viewer.id} name={viewer.name} src={viewer.avatarUrl} size="sm" />
                  <span>{viewer.name}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

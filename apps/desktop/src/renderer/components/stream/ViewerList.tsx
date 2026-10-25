import {
  viewerStack,
  viewersEmptyText,
  viewersHeading,
  viewersLabel,
  type AudienceKind,
  type Viewer,
} from '../../lib/viewers';
import { Avatar } from '../Avatar';
import { EyeIcon, HeadphonesIcon } from '../icons';
import '../../styles/viewers.css';

interface ViewerListProps {
  viewers: readonly Viewer[];
  /** `compact`: only the icon and the count (mini tiles, where the overlay ignores the pointer). */
  variant?: 'full' | 'compact';
  /** `watching` (the eye: a live, a camera) or `listening` (headphones: a music, the Jam). */
  kind?: AudienceKind;
  /** `overlay`: dark pill over a video; `surface`: on the app's panels and cards. */
  tone?: 'overlay' | 'surface';
  /** Where the list opens on hover: above (tiles' bottom bars) or below (inside a scroll box). */
  placement?: 'above' | 'below';
  /** Which edge the list lines up with: the start, or the end for one at the right of a row. */
  align?: 'start' | 'end';
  className?: string;
}

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/**
 * Who is watching a live (or listening to a music), as in Discord's Go Live: icon + count +
 * slightly overlapped avatars (yours too while you are among them); hovering or focusing it lists
 * everyone.
 */
export function ViewerList({
  viewers,
  variant = 'full',
  kind = 'watching',
  tone = 'overlay',
  placement = 'above',
  align = 'start',
  className,
}: ViewerListProps) {
  const label = viewersLabel(viewers, kind);
  const Icon = kind === 'listening' ? HeadphonesIcon : EyeIcon;
  if (variant === 'compact') {
    return (
      <span
        className={classes(
          'viewers viewers--compact',
          tone === 'surface' && 'viewers--surface',
          className,
        )}
        role="img"
        aria-label={label}
        title={label}
      >
        <Icon size={14} />
        {viewers.length}
      </span>
    );
  }
  const { shown, extra } = viewerStack(viewers);
  return (
    <div
      className={classes(
        'viewers',
        tone === 'surface' && 'viewers--surface',
        placement === 'below' && 'viewers--below',
        align === 'end' && 'viewers--end',
        className,
      )}
      role="group"
      tabIndex={0}
      aria-label={label}
    >
      <Icon size={16} />
      <span className="viewers__count">{viewers.length}</span>
      {shown.length > 0 && (
        <span className="viewers__stack" aria-hidden="true">
          {shown.map((viewer) => (
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
          <p className="viewers__empty">{viewersEmptyText(kind)}</p>
        ) : (
          <>
            <p className="viewers__title">{viewersHeading(viewers.length, kind)}</p>
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

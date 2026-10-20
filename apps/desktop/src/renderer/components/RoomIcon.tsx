import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { roomLabel, type PresenceParticipant, type RoomId } from '@concord/shared';
import { pluralize } from '../lib/format';
import { roomIndicators } from '../lib/presence';
import { roomShortLabel } from '../lib/roomShortLabel';
import { Avatar } from './Avatar';
import { CameraIcon, HeadphonesIcon } from './icons';

interface RoomIconProps {
  room: RoomId;
  participants: PresenceParticipant[];
  current: boolean;
  onJoin(room: RoomId): void;
  /** The headphones beside a room with music open and close the music drawer. */
  onToggleMusic(): void;
}

/**
 * From the icon's right edge to the popover: clears the headphones beside the icon, the rest of
 * the column and a small gap (the icon keeps a fixed offset, see `.room-icon`).
 */
const POPOVER_OFFSET = 24;
/** Space kept between the popover and the window's top and bottom edges. */
const POPOVER_MARGIN = 8;

/** Where the popover goes: its left edge, and the height it is centered on (viewport px). */
interface Anchor {
  left: number;
  centerY: number;
}

function anchorOf(button: HTMLElement): Anchor {
  const rect = button.getBoundingClientRect();
  return { left: rect.right + POPOVER_OFFSET, centerY: rect.top + rect.height / 2 };
}

/**
 * A room in the collapsed sidebar, like a Discord server icon: its short label in a rounded
 * square, the current room marked by a pill on the column's left edge. A green dot when someone
 * is in it, a blinking red one when someone is live, headphones beside it while someone
 * broadcasts music. Hovering it (or reaching it with the keyboard) shows who is there; a click
 * joins it.
 */
export function RoomIcon({ room, participants, current, onJoin, onToggleMusic }: RoomIconProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const popoverId = useId();
  const label = roomLabel(room);
  const { online, live, music } = roomIndicators(participants);
  const details = [
    online ? pluralize(participants.length, 'pessoa', 'pessoas') : 'vazia',
    live ? 'ao vivo' : null,
    music ? 'música' : null,
  ]
    .filter((detail) => detail !== null)
    .join(', ');

  // The popover is placed once: scrolling, resizing or leaving the window hides it instead.
  const open = anchor !== null;
  useEffect(() => {
    if (!open) return;
    const hide = (): void => setAnchor(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [open]);

  return (
    <li className="room-icon">
      <button
        type="button"
        className="room-icon__button"
        data-navitem
        aria-current={current ? 'true' : undefined}
        aria-label={`${current ? 'Você está em' : 'Entrar em'} ${label} (${details})`}
        aria-describedby={open ? popoverId : undefined}
        onClick={() => onJoin(room)}
        onMouseEnter={(event) => setAnchor(anchorOf(event.currentTarget))}
        onMouseLeave={() => setAnchor(null)}
        onFocus={(event) => {
          // Keyboard only: a mouse click already has the hover popover.
          if (event.currentTarget.matches(':focus-visible')) {
            setAnchor(anchorOf(event.currentTarget));
          }
        }}
        onBlur={() => setAnchor(null)}
      >
        <span className="room-icon__label" aria-hidden="true">
          {roomShortLabel(room)}
        </span>
        {live && <span className="room-icon__live" aria-hidden="true" />}
        {online && <span className="room-icon__online" aria-hidden="true" />}
      </button>
      {/* After the button: its hover and focus styles reach the pill with `~`. */}
      <span className="room-icon__pill" aria-hidden="true" />
      {music && (
        // Plain headphones (no button look), yet the way to the music drawer while collapsed.
        <button
          type="button"
          className="room-icon__music"
          aria-label={`Música em ${label}: abrir o painel de música`}
          title="Música"
          onClick={onToggleMusic}
        >
          <HeadphonesIcon size={12} />
        </button>
      )}
      {anchor && (
        <RoomPopover id={popoverId} label={label} participants={participants} anchor={anchor} />
      )}
    </li>
  );
}

interface RoomPopoverProps {
  id: string;
  label: string;
  participants: readonly PresenceParticipant[];
  anchor: Anchor;
}

/**
 * The room's name and who is in it, right of the column. In a portal so the scrolling sidebar
 * cannot clip it; it never takes the focus nor the pointer.
 */
function RoomPopover({ id, label, participants, anchor }: RoomPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Centered on the icon but kept inside the window; runs before paint on every render, since
  // people joining or leaving change its height.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const height = element.offsetHeight;
    const bottomLimit = window.innerHeight - height - POPOVER_MARGIN;
    const top = Math.max(POPOVER_MARGIN, Math.min(anchor.centerY - height / 2, bottomLimit));
    element.style.top = `${top}px`;
  });

  return createPortal(
    <div ref={ref} id={id} className="room-popover" role="tooltip" style={{ left: anchor.left }}>
      <p className="room-popover__title">{label}</p>
      {participants.length === 0 ? (
        <p className="room-popover__empty">Ninguém aqui</p>
      ) : (
        <ul className="room-popover__people">
          {participants.map((participant) => (
            <li key={participant.id} className="room-popover__person">
              <Avatar
                id={participant.id}
                name={participant.name}
                src={participant.avatarUrl}
                size="xs"
              />
              <span className="room-popover__name">{participant.name}</span>
              {participant.camera && (
                <span className="room-popover__icon" role="img" aria-label="Câmera ligada">
                  <CameraIcon size={14} />
                </span>
              )}
              {participant.music && (
                <span className="room-popover__icon" role="img" aria-label="Transmitindo música">
                  <HeadphonesIcon size={14} />
                </span>
              )}
              {participant.streaming && <span className="room-popover__live">AO VIVO</span>}
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

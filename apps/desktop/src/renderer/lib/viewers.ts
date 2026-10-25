/**
 * Who is watching each live. Every main window publishes the lives it watches as a LiveKit
 * participant attribute (`WATCHING_ATTRIBUTE`, a JSON array of participant ids); every client
 * derives the viewers of each live from the attributes of everyone in the room. Pure so it can be
 * unit-tested; `hooks/useViewers.ts` reads and writes the attribute.
 */

export const WATCHING_ATTRIBUTE = 'concord.watching';

/** Live participant id → ids of the people watching it, in a stable order. */
export type ViewersByLive = ReadonlyMap<string, readonly string[]>;

export const NO_VIEWERS: ViewersByLive = new Map();

/** At most this many ids are published (a room holds 15 people). */
const MAX_WATCHED = 32;

export function encodeWatching(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].slice(0, MAX_WATCHED));
}

/** Tolerates a missing or malformed attribute (another version, a tampered client): empty list. */
export function decodeWatching(value: string | undefined): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].slice(0, MAX_WATCHED);
}

/**
 * Whether an attribute update (`RoomEvent.ParticipantAttributesChanged`'s changed keys; a removed
 * key arrives as '') touches who watches what. Other attributes, like the stats every live
 * publishes every few seconds, must not rebuild the viewers.
 */
export function changesWatching(changedAttributes: Readonly<Record<string, string>>): boolean {
  return Object.hasOwn(changedAttributes, WATCHING_ATTRIBUTE);
}

export interface WatchingParticipant {
  identity: string;
  attributes: Readonly<Record<string, string>>;
}

/**
 * Groups the room's participants by the lives they watch. Nobody counts as a viewer of their own
 * live, and each live's viewers keep the order of `participants`.
 */
export function collectViewers(participants: Iterable<WatchingParticipant>): ViewersByLive {
  const viewers = new Map<string, string[]>();
  for (const participant of participants) {
    for (const liveId of decodeWatching(participant.attributes[WATCHING_ATTRIBUTE])) {
      if (liveId === participant.identity) continue;
      const list = viewers.get(liveId);
      if (list) {
        if (!list.includes(participant.identity)) list.push(participant.identity);
      } else {
        viewers.set(liveId, [participant.identity]);
      }
    }
  }
  return viewers;
}

/** A viewer ready to show: name and avatar from presence, LiveKit's name as a fallback. */
export interface Viewer {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export function resolveViewers(
  ids: readonly string[],
  profiles: ReadonlyMap<string, { name: string; avatarUrl: string | null }>,
  livekitName: (id: string) => string | undefined,
): Viewer[] {
  return ids.map((id) => {
    const profile = profiles.get(id);
    return {
      id,
      name: profile?.name || livekitName(id) || id,
      avatarUrl: profile?.avatarUrl ?? null,
    };
  });
}

/**
 * What a people list is about: watching a live or a camera (`concord.watching` `<id>`,
 * `<id>#camera`), or listening to a music (`<id>#music`; the Jam's is `@jam#music`).
 */
export type AudienceKind = 'watching' | 'listening';

const AUDIENCE_VERBS: Readonly<Record<AudienceKind, { gerund: string; heading: string }>> = {
  watching: { gerund: 'assistindo', heading: 'Assistindo' },
  listening: { gerund: 'ouvindo', heading: 'Ouvindo' },
};

/**
 * "Ninguém assistindo" / "1 pessoa assistindo: Ana" / "3 pessoas assistindo: Ana, Bia e Caio";
 * "ouvindo" for a music's listeners.
 */
export function viewersLabel(
  viewers: readonly Pick<Viewer, 'name'>[],
  kind: AudienceKind = 'watching',
): string {
  const { gerund } = AUDIENCE_VERBS[kind];
  if (viewers.length === 0) return `Ninguém ${gerund}`;
  const names = viewers.map((viewer) => viewer.name);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} e ${names.at(-1) ?? ''}`;
  const count = viewers.length === 1 ? `1 pessoa ${gerund}` : `${viewers.length} pessoas ${gerund}`;
  return `${count}: ${list}`;
}

/** Heading of the list shown on hover: "Assistindo — 3" / "Ouvindo — 3". */
export function viewersHeading(count: number, kind: AudienceKind = 'watching'): string {
  return `${AUDIENCE_VERBS[kind].heading} — ${count}`;
}

/** The list shown on hover while nobody is there: "Ninguém assistindo ainda." / "…ouvindo…". */
export function viewersEmptyText(kind: AudienceKind = 'watching'): string {
  return `Ninguém ${AUDIENCE_VERBS[kind].gerund} ainda.`;
}

/** Avatars shown slightly overlapped next to the count; the others add up to "+N". */
export const STACKED_VIEWERS = 3;

export interface ViewerStack<T> {
  /** The first ones, in the list's order (you among them like anyone else). */
  shown: T[];
  /** How many more ("+2"); 0 when everyone shows. */
  extra: number;
}

/** The overlapped avatars of a people list: the first `max` and how many more there are. */
export function viewerStack<T>(viewers: readonly T[], max = STACKED_VIEWERS): ViewerStack<T> {
  const shown = viewers.slice(0, Math.max(0, max));
  return { shown, extra: viewers.length - shown.length };
}

export interface ViewerChanges {
  joined: string[];
  left: string[];
}

/**
 * People who started or stopped watching one of the lives `selfId` is part of
 * (`involvedLiveIds`: your own live while you broadcast, plus the watched lives that are still
 * live) between two snapshots. You never count, and someone who moves between two of those lives
 * only counts as joined.
 */
export function diffViewers(
  prev: ViewersByLive,
  next: ViewersByLive,
  involvedLiveIds: readonly string[],
  selfId: string,
): ViewerChanges {
  const joined = new Set<string>();
  const left = new Set<string>();
  for (const liveId of involvedLiveIds) {
    const before = prev.get(liveId) ?? [];
    const after = next.get(liveId) ?? [];
    for (const viewerId of after) {
      if (viewerId !== selfId && !before.includes(viewerId)) joined.add(viewerId);
    }
    for (const viewerId of before) {
      if (viewerId !== selfId && !after.includes(viewerId)) left.add(viewerId);
    }
  }
  return { joined: [...joined], left: [...left].filter((id) => !joined.has(id)) };
}

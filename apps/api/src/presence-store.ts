import type { PresenceEvent, PresenceParticipant, PresenceSnapshot, RoomId } from '@telao/shared';

export interface ParticipantIdentity {
  id: string;
  name: string;
  /** Unix epoch in milliseconds. */
  joinedAt: number;
}

/** Full state of one participant, as reported by a resync against the LiveKit server. */
export interface ParticipantState extends ParticipantIdentity {
  /** SIDs of the screen-share video tracks currently published. */
  screenTracks: string[];
}

export type RoomState = Record<RoomId, ParticipantState[]>;

export type PresenceListener = (event: PresenceEvent) => void;

interface Entry extends ParticipantIdentity {
  screenTracks: Set<string>;
}

function toParticipant(entry: Entry): PresenceParticipant {
  return {
    id: entry.id,
    name: entry.name,
    streaming: entry.screenTracks.size > 0,
    joinedAt: entry.joinedAt,
  };
}

/**
 * In-memory presence: who is in which room and who is screen-sharing. Fed by LiveKit
 * webhooks and periodic resyncs; emits granular events only when something changes.
 */
export class PresenceStore {
  private readonly rooms = new Map<RoomId, Map<string, Entry>>();
  private readonly listeners = new Set<PresenceListener>();

  constructor(private readonly knownRooms: readonly RoomId[] = []) {}

  subscribe(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  snapshot(): PresenceSnapshot {
    const rooms: Record<RoomId, PresenceParticipant[]> = {};
    for (const room of this.knownRooms) rooms[room] = [];
    for (const [room, entries] of this.rooms) {
      rooms[room] = [...entries.values()].map(toParticipant);
    }
    return { rooms };
  }

  participant(room: RoomId, participantId: string): PresenceParticipant | undefined {
    const entry = this.rooms.get(room)?.get(participantId);
    return entry ? toParticipant(entry) : undefined;
  }

  /** Adds a participant; a repeated join only refreshes the display name. */
  join(room: RoomId, participant: ParticipantIdentity): void {
    this.ensure(room, participant);
  }

  leave(room: RoomId, participantId: string): void {
    const entries = this.rooms.get(room);
    const entry = entries?.get(participantId);
    if (!entries || !entry) return;
    entries.delete(participantId);
    if (entries.size === 0) this.rooms.delete(room);
    if (entry.screenTracks.size > 0) this.emit({ type: 'stream_stopped', room, participantId });
    this.emit({ type: 'participant_left', room, participant: toParticipant(entry) });
  }

  /** Registers a published screen-share track; creates the participant if unknown. */
  screenTrackPublished(room: RoomId, participant: ParticipantIdentity, trackSid: string): void {
    const entry = this.ensure(room, participant);
    const wasStreaming = entry.screenTracks.size > 0;
    entry.screenTracks.add(trackSid);
    if (!wasStreaming) this.emit({ type: 'stream_started', room, participantId: entry.id });
  }

  screenTrackUnpublished(room: RoomId, participantId: string, trackSid: string): void {
    const entry = this.rooms.get(room)?.get(participantId);
    if (!entry || !entry.screenTracks.delete(trackSid)) return;
    if (entry.screenTracks.size === 0) this.emit({ type: 'stream_stopped', room, participantId });
  }

  clearRoom(room: RoomId): void {
    const entries = this.rooms.get(room);
    if (!entries) return;
    for (const id of [...entries.keys()]) this.leave(room, id);
  }

  /**
   * Reconciles the store with authoritative state from the server, emitting only the
   * events needed to get from the current state to the new one.
   */
  replaceAll(state: RoomState): void {
    for (const room of [...this.rooms.keys()]) {
      if (!(room in state)) this.clearRoom(room);
    }
    for (const [room, participants] of Object.entries(state)) {
      const wanted = new Map(participants.map((p) => [p.id, p]));
      const current = this.rooms.get(room);
      if (current) {
        for (const id of [...current.keys()]) {
          if (!wanted.has(id)) this.leave(room, id);
        }
      }
      for (const participant of participants) {
        const entry = this.ensure(room, participant);
        const wantedTracks = new Set(participant.screenTracks);
        for (const sid of [...entry.screenTracks]) {
          if (!wantedTracks.has(sid)) this.screenTrackUnpublished(room, participant.id, sid);
        }
        for (const sid of wantedTracks) {
          if (!entry.screenTracks.has(sid)) this.screenTrackPublished(room, participant, sid);
        }
      }
    }
  }

  private ensure(room: RoomId, participant: ParticipantIdentity): Entry {
    let entries = this.rooms.get(room);
    if (!entries) {
      entries = new Map();
      this.rooms.set(room, entries);
    }
    const existing = entries.get(participant.id);
    if (existing) {
      existing.name = participant.name;
      return existing;
    }
    const entry: Entry = { ...participant, screenTracks: new Set() };
    entries.set(participant.id, entry);
    this.emit({ type: 'participant_joined', room, participant: toParticipant(entry) });
    return entry;
  }

  private emit(event: PresenceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

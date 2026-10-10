import {
  ParticipantInfo,
  Room,
  TokenVerifier,
  TrackInfo,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';
import { describe, expect, it, vi } from 'vitest';
import { TOKEN_TTL_SECONDS } from '@telao/shared';
import { createRoomToken, fetchRoomState, isScreenShareVideo } from '../src/livekit';
import { ALICE, API_KEY, API_SECRET, testConfig } from './helpers';

describe('createRoomToken', () => {
  it('issues a 6 h token with screen-share-only publish grants', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { token, expiresAt } = await createRoomToken(testConfig().livekit, ALICE, 'geral');
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(token);
    expect(claims.sub).toBe('alice');
    expect(claims.name).toBe('Alice');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'geral',
      canSubscribe: true,
      canPublish: true,
      canPublishSources: ['screen_share', 'screen_share_audio'],
      canPublishData: true,
    });
    const exp = claims.exp ?? 0;
    expect(exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS);
    expect(exp).toBeLessThanOrEqual(before + TOKEN_TTL_SECONDS + 5);
    expect(Math.abs(expiresAt - exp * 1000)).toBeLessThanOrEqual(1000);
  });
});

describe('isScreenShareVideo', () => {
  it.each<[TrackSource, TrackType, boolean]>([
    [TrackSource.SCREEN_SHARE, TrackType.VIDEO, true],
    [TrackSource.SCREEN_SHARE_AUDIO, TrackType.AUDIO, false],
    [TrackSource.CAMERA, TrackType.VIDEO, false],
    [TrackSource.SCREEN_SHARE, TrackType.AUDIO, false],
  ])('source %i, type %i -> %s', (source, type, expected) => {
    expect(isScreenShareVideo({ source, type })).toBe(expected);
  });
});

describe('fetchRoomState', () => {
  it('maps rooms, participants and screen-share video tracks', async () => {
    const participants: Record<string, ParticipantInfo[]> = {
      geral: [
        new ParticipantInfo({
          identity: 'alice',
          name: 'Alice',
          joinedAt: 1_700_000_000n,
          tracks: [
            new TrackInfo({
              sid: 'TR_screen',
              type: TrackType.VIDEO,
              source: TrackSource.SCREEN_SHARE,
            }),
            new TrackInfo({
              sid: 'TR_audio',
              type: TrackType.AUDIO,
              source: TrackSource.SCREEN_SHARE_AUDIO,
            }),
            new TrackInfo({ sid: 'TR_cam', type: TrackType.VIDEO, source: TrackSource.CAMERA }),
          ],
        }),
        new ParticipantInfo({ identity: 'bob', name: '', joinedAt: 1_700_000_010n }),
      ],
      jogos: [],
    };
    const roomService = {
      listRooms: vi.fn(async () => [
        new Room({ name: 'geral', sid: 'RM_1' }),
        new Room({ name: 'jogos', sid: 'RM_2' }),
      ]),
      listParticipants: vi.fn(async (room: string) => participants[room] ?? []),
    };

    await expect(fetchRoomState(roomService)).resolves.toEqual({
      geral: [
        { id: 'alice', name: 'Alice', joinedAt: 1_700_000_000_000, screenTracks: ['TR_screen'] },
        { id: 'bob', name: 'bob', joinedAt: 1_700_000_010_000, screenTracks: [] },
      ],
      jogos: [],
    });
    expect(roomService.listParticipants).toHaveBeenCalledTimes(2);
  });

  it('returns an empty state when there are no rooms', async () => {
    const roomService = {
      listRooms: vi.fn(async () => []),
      listParticipants: vi.fn(async () => []),
    };
    await expect(fetchRoomState(roomService)).resolves.toEqual({});
    expect(roomService.listParticipants).not.toHaveBeenCalled();
  });
});

import {
  ParticipantInfo,
  Room,
  TokenVerifier,
  TrackInfo,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';
import { describe, expect, it, vi } from 'vitest';
import { TOKEN_TTL_SECONDS } from '@concord/shared';
import {
  createJamBotToken,
  createRoomToken,
  fetchRoomState,
  isAuxiliaryParticipant,
  isCameraVideo,
  isScreenShareVideo,
} from '../src/livekit';
import { ALICE, API_KEY, API_SECRET, testConfig } from './helpers';

describe('createRoomToken', () => {
  it('issues a 6 h token with screen-share and camera publish grants, never a microphone', async () => {
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
      canPublishSources: ['screen_share', 'screen_share_audio', 'camera'],
      canPublishData: true,
      canUpdateOwnMetadata: true,
    });
    const exp = claims.exp ?? 0;
    expect(exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS);
    expect(exp).toBeLessThanOrEqual(before + TOKEN_TTL_SECONDS + 5);
    expect(Math.abs(expiresAt - exp * 1000)).toBeLessThanOrEqual(1000);
  });

  it.each(['popout', 'pip'] as const)(
    'issues a hidden, subscribe-only token under the %s identity',
    async (purpose) => {
      const before = Math.floor(Date.now() / 1000);
      const { token, expiresAt } = await createRoomToken(
        testConfig().livekit,
        ALICE,
        'geral',
        purpose,
      );
      const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(token);
      expect(claims.sub).toBe(`alice~${purpose}`);
      expect(claims.name).toBe('Alice');
      expect(claims.video).toEqual({
        roomJoin: true,
        room: 'geral',
        canSubscribe: true,
        canPublish: false,
        canPublishData: false,
        hidden: true,
      });
      const exp = claims.exp ?? 0;
      expect(exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS);
      expect(Math.abs(expiresAt - exp * 1000)).toBeLessThanOrEqual(1000);
    },
  );
});

describe('createJamBotToken', () => {
  it('lets the bot publish one Microphone track and nothing else', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { token, expiresAt } = await createJamBotToken(testConfig().livekit, 'geral');
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(token);
    expect(claims.sub).toBe('@jam');
    expect(claims.name).toBe('Jam');
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'geral',
      canSubscribe: false,
      canPublish: true,
      canPublishSources: ['microphone'],
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    const exp = claims.exp ?? 0;
    expect(exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_SECONDS);
    expect(Math.abs(expiresAt - exp * 1000)).toBeLessThanOrEqual(1000);
  });
});

describe('isAuxiliaryParticipant', () => {
  it.each<[string, boolean]>([
    ['alice', false],
    ['alice~popout', true],
    ['alice~pip', true],
    ['alice-popout', false],
  ])('%s -> %s', (identity, expected) => {
    expect(isAuxiliaryParticipant(new ParticipantInfo({ identity }))).toBe(expected);
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

describe('isCameraVideo', () => {
  it.each<[TrackSource, TrackType, boolean]>([
    [TrackSource.CAMERA, TrackType.VIDEO, true],
    [TrackSource.SCREEN_SHARE, TrackType.VIDEO, false],
    [TrackSource.MICROPHONE, TrackType.AUDIO, false],
    [TrackSource.CAMERA, TrackType.AUDIO, false],
  ])('source %i, type %i -> %s', (source, type, expected) => {
    expect(isCameraVideo({ source, type })).toBe(expected);
  });
});

describe('fetchRoomState', () => {
  it('maps rooms, participants and their screen-share and camera tracks', async () => {
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
            new TrackInfo({
              sid: 'TR_mic',
              type: TrackType.AUDIO,
              source: TrackSource.MICROPHONE,
              name: 'microphone',
            }),
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
        {
          id: 'alice',
          name: 'Alice',
          joinedAt: 1_700_000_000_000,
          screenTracks: ['TR_screen'],
          cameraTracks: ['TR_cam'],
        },
        {
          id: 'bob',
          name: 'bob',
          joinedAt: 1_700_000_010_000,
          screenTracks: [],
          cameraTracks: [],
        },
      ],
      jogos: [],
    });
    expect(roomService.listParticipants).toHaveBeenCalledTimes(2);
  });

  it('leaves auxiliary identities (pop-out and PiP windows) out of the state', async () => {
    const roomService = {
      listRooms: vi.fn(async () => [new Room({ name: 'geral', sid: 'RM_1' })]),
      listParticipants: vi.fn(async () => [
        new ParticipantInfo({ identity: 'ana', name: 'Ana', joinedAt: 1_700_000_000n }),
        new ParticipantInfo({
          identity: 'ana~popout',
          name: 'Ana',
          joinedAt: 1_700_000_005n,
          tracks: [
            new TrackInfo({ sid: 'TR_x', type: TrackType.VIDEO, source: TrackSource.SCREEN_SHARE }),
          ],
        }),
        new ParticipantInfo({
          identity: 'ana~pip',
          name: 'Ana',
          joinedAt: 1_700_000_006n,
          tracks: [
            new TrackInfo({ sid: 'TR_y', type: TrackType.VIDEO, source: TrackSource.CAMERA }),
            new TrackInfo({ sid: 'TR_z', type: TrackType.AUDIO, source: TrackSource.MICROPHONE }),
          ],
        }),
      ]),
    };

    await expect(fetchRoomState(roomService)).resolves.toEqual({
      geral: [
        {
          id: 'ana',
          name: 'Ana',
          joinedAt: 1_700_000_000_000,
          screenTracks: [],
          cameraTracks: [],
        },
      ],
    });
  });

  it('leaves the jam bot out of the state', async () => {
    const roomService = {
      listRooms: vi.fn(async () => [new Room({ name: 'geral', sid: 'RM_1' })]),
      listParticipants: vi.fn(async () => [
        new ParticipantInfo({
          identity: '@jam',
          name: 'Jam',
          joinedAt: 1_700_000_001n,
          tracks: [
            new TrackInfo({
              sid: 'TR_jam',
              type: TrackType.AUDIO,
              source: TrackSource.MICROPHONE,
              name: 'concord:music:jam',
            }),
          ],
        }),
      ]),
    };
    await expect(fetchRoomState(roomService)).resolves.toEqual({ geral: [] });
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

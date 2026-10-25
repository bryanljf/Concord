import { describe, expect, it } from 'vitest';
import {
  changesWatching,
  collectViewers,
  decodeWatching,
  encodeWatching,
  diffViewers,
  resolveViewers,
  STACKED_VIEWERS,
  viewerStack,
  viewersEmptyText,
  viewersHeading,
  viewersLabel,
  WATCHING_ATTRIBUTE,
  type ViewersByLive,
} from './viewers';

const watching = (identity: string, ids: string[]) => ({
  identity,
  attributes: { [WATCHING_ATTRIBUTE]: encodeWatching(ids) },
});

const viewers = (entries: Record<string, string[]>): ViewersByLive =>
  new Map(Object.entries(entries));

describe('encodeWatching / decodeWatching', () => {
  it('round-trips without duplicates', () => {
    expect(decodeWatching(encodeWatching(['ana', 'bia', 'ana']))).toEqual(['ana', 'bia']);
    expect(encodeWatching([])).toBe('[]');
  });

  it.each<[string | undefined]>([[undefined], [''], ['nope'], ['{"a":1}'], ['[1,null,""]']])(
    'reads %j as nothing watched',
    (value) => {
      expect(decodeWatching(value)).toEqual([]);
    },
  );

  it('keeps only the string ids of a mixed list', () => {
    expect(decodeWatching('["ana",2,"bia"]')).toEqual(['ana', 'bia']);
  });
});

describe('changesWatching', () => {
  it('is true when the watching attribute changed or was removed', () => {
    expect(changesWatching({ [WATCHING_ATTRIBUTE]: '["ana"]' })).toBe(true);
    expect(changesWatching({ [WATCHING_ATTRIBUTE]: '', 'concord.stats.screen': '{}' })).toBe(true);
  });

  it('ignores updates of other attributes (the periodic stats)', () => {
    expect(changesWatching({ 'concord.stats.screen': '{"v":1}' })).toBe(false);
    expect(changesWatching({})).toBe(false);
  });
});

describe('collectViewers', () => {
  it('groups participants by the lives they watch, in participant order', () => {
    const result = collectViewers([
      watching('bia', ['ana']),
      watching('caio', ['ana', 'dani']),
      { identity: 'dani', attributes: {} },
    ]);
    expect(result.get('ana')).toEqual(['bia', 'caio']);
    expect(result.get('dani')).toEqual(['caio']);
    expect(result.has('bia')).toBe(false);
  });

  it('never counts someone as a viewer of their own live', () => {
    expect(collectViewers([watching('ana', ['ana'])]).size).toBe(0);
  });
});

describe('resolveViewers', () => {
  it('prefers presence, then the LiveKit name, then the id', () => {
    const profiles = new Map([['ana', { name: 'Ana', avatarUrl: 'https://a/ana.png' }]]);
    const livekit = (id: string) => (id === 'bia' ? 'Bia' : undefined);
    expect(resolveViewers(['ana', 'bia', 'caio'], profiles, livekit)).toEqual([
      { id: 'ana', name: 'Ana', avatarUrl: 'https://a/ana.png' },
      { id: 'bia', name: 'Bia', avatarUrl: null },
      { id: 'caio', name: 'caio', avatarUrl: null },
    ]);
  });
});

describe('viewersLabel', () => {
  it.each<[string[], string]>([
    [[], 'Ninguém assistindo'],
    [['Ana'], '1 pessoa assistindo: Ana'],
    [['Ana', 'Bia'], '2 pessoas assistindo: Ana e Bia'],
    [['Ana', 'Bia', 'Caio'], '3 pessoas assistindo: Ana, Bia e Caio'],
  ])('%j -> %s', (names, expected) => {
    expect(viewersLabel(names.map((name) => ({ name })))).toBe(expected);
  });

  it.each<[string[], string]>([
    [[], 'Ninguém ouvindo'],
    [['Ana'], '1 pessoa ouvindo: Ana'],
    [['Ana', 'Bia', 'Caio'], '3 pessoas ouvindo: Ana, Bia e Caio'],
  ])('listening %j -> %s', (names, expected) => {
    expect(
      viewersLabel(
        names.map((name) => ({ name })),
        'listening',
      ),
    ).toBe(expected);
  });
});

describe('viewersHeading / viewersEmptyText', () => {
  it('says watching by default and listening for music', () => {
    expect(viewersHeading(3)).toBe('Assistindo — 3');
    expect(viewersHeading(2, 'listening')).toBe('Ouvindo — 2');
    expect(viewersEmptyText()).toBe('Ninguém assistindo ainda.');
    expect(viewersEmptyText('listening')).toBe('Ninguém ouvindo ainda.');
  });
});

describe('viewerStack', () => {
  const people = ['ana', 'bia', 'caio', 'dani', 'eva'];

  it('shows the first three, in order, and counts the others', () => {
    expect(viewerStack(people)).toEqual({ shown: ['ana', 'bia', 'caio'], extra: 2 });
    expect(STACKED_VIEWERS).toBe(3);
  });

  it('shows everyone when they fit, with no "+N"', () => {
    expect(viewerStack(people.slice(0, 3))).toEqual({ shown: ['ana', 'bia', 'caio'], extra: 0 });
    expect(viewerStack(['me'])).toEqual({ shown: ['me'], extra: 0 });
    expect(viewerStack([])).toEqual({ shown: [], extra: 0 });
  });

  it('honors another limit and never a negative one', () => {
    expect(viewerStack(people, 1)).toEqual({ shown: ['ana'], extra: 4 });
    expect(viewerStack(people, -1)).toEqual({ shown: [], extra: 5 });
  });
});

describe('diffViewers', () => {
  it('reports people who started watching a live you are part of', () => {
    const prev = viewers({ ana: ['bia'] });
    const next = viewers({ ana: ['bia', 'caio'], dani: ['eva'] });
    expect(diffViewers(prev, next, ['ana'], 'me')).toEqual({ joined: ['caio'], left: [] });
  });

  it('ignores lives you are not part of and your own arrival or departure', () => {
    const next = viewers({ ana: ['me'], dani: ['eva'] });
    expect(diffViewers(new Map(), next, ['ana'], 'me')).toEqual({ joined: [], left: [] });
    expect(diffViewers(next, new Map(), ['ana'], 'me')).toEqual({ joined: [], left: [] });
  });

  it('reports viewers of your own live', () => {
    const next = viewers({ me: ['bia'] });
    expect(diffViewers(new Map(), next, ['me'], 'me')).toEqual({ joined: ['bia'], left: [] });
  });

  it('reports someone joining two of your lives once', () => {
    const next = viewers({ ana: ['bia'], me: ['bia'] });
    expect(diffViewers(new Map(), next, ['ana', 'me'], 'me').joined).toEqual(['bia']);
  });

  it('reports people who stopped watching', () => {
    const prev = viewers({ ana: ['bia', 'caio'] });
    const next = viewers({ ana: ['caio'] });
    expect(diffViewers(prev, next, ['ana'], 'me')).toEqual({ joined: [], left: ['bia'] });
  });

  it('counts a move between two of your lives as a join only', () => {
    const prev = viewers({ ana: ['bia'] });
    const next = viewers({ me: ['bia'] });
    expect(diffViewers(prev, next, ['ana', 'me'], 'me')).toEqual({ joined: ['bia'], left: [] });
  });
});

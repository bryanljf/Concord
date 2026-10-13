import { describe, expect, it } from 'vitest';
import { UNSUBSCRIBED, planSubscriptions, type StreamCandidate } from './subscriptions';
import { EMPTY_WATCHING, pruneWatching, resetWatching, unwatch, watch } from './watching';

const ana: StreamCandidate = { participantId: 'ana', hasVideo: true, hasAudio: true };
const beto: StreamCandidate = { participantId: 'beto', hasVideo: true, hasAudio: false };
const carla: StreamCandidate = { participantId: 'carla', hasVideo: true, hasAudio: true };
const silent: StreamCandidate = { participantId: 'dani', hasVideo: false, hasAudio: true };

describe('planSubscriptions', () => {
  it('subscribes nothing when nothing is watched (entering a room)', () => {
    const plan = planSubscriptions([ana, beto, carla], null, []);
    expect(plan.size).toBe(3);
    expect([...plan.values()].every((p) => p === UNSUBSCRIBED)).toBe(true);
  });

  it('gives the focused live full video plus audio and other watched lives low video only', () => {
    const plan = planSubscriptions([ana, beto, carla], 'beto', ['ana', 'beto']);
    expect(plan.get('beto')).toEqual({ video: 'high', audio: false });
    expect(plan.get('ana')).toEqual({ video: 'low', audio: false });
    expect(plan.get('carla')).toBe(UNSUBSCRIBED);
  });

  it('subscribes to the focused audio only when it exists', () => {
    expect(planSubscriptions([ana], 'ana', ['ana']).get('ana')).toEqual({
      video: 'high',
      audio: true,
    });
    expect(planSubscriptions([beto], 'beto', ['beto']).get('beto')).toEqual({
      video: 'high',
      audio: false,
    });
  });

  it('treats the focused live as watched even outside the watched list (pop-out)', () => {
    const plan = planSubscriptions([ana, beto], 'ana');
    expect(plan.get('ana')).toEqual({ video: 'high', audio: true });
    expect(plan.get('beto')).toBe(UNSUBSCRIBED);
  });

  it('never subscribes to a participant without a video publication', () => {
    const plan = planSubscriptions([silent, ana], 'dani', ['dani', 'ana']);
    expect(plan.get('dani')).toBe(UNSUBSCRIBED);
    expect(plan.get('ana')).toEqual({ video: 'low', audio: false });
  });

  it('ignores watched ids that are not live', () => {
    const plan = planSubscriptions([ana], 'zoe', ['zoe', 'ana']);
    expect(plan.has('zoe')).toBe(false);
    expect(plan.get('ana')).toEqual({ video: 'low', audio: false });
  });

  it('returns an empty plan for an empty room', () => {
    expect(planSubscriptions([], 'ana', ['ana']).size).toBe(0);
  });
});

describe('planSubscriptions with the watching transitions', () => {
  const streams = [ana, beto, carla];
  const planFor = (state: { watched: readonly string[]; focused: string | null }) =>
    planSubscriptions(streams, state.focused, state.watched);

  it('watching a second live demotes the first to a low-quality mini tile', () => {
    const state = watch(watch(EMPTY_WATCHING, 'ana'), 'carla');
    const plan = planFor(state);
    expect(plan.get('carla')).toEqual({ video: 'high', audio: true });
    expect(plan.get('ana')).toEqual({ video: 'low', audio: false });
    expect(plan.get('beto')).toBe(UNSUBSCRIBED);
  });

  it('unsubscribes video and audio of a live the user stops watching', () => {
    const state = unwatch(watch(watch(EMPTY_WATCHING, 'ana'), 'carla'), 'ana');
    const plan = planFor(state);
    expect(plan.get('ana')).toBe(UNSUBSCRIBED);
    expect(plan.get('carla')).toEqual({ video: 'high', audio: true });
  });

  it('promotes the next watched live to full quality and audio when the focused one is removed', () => {
    const state = unwatch(watch(watch(EMPTY_WATCHING, 'beto'), 'ana'), 'ana');
    const plan = planFor(state);
    expect(state.focused).toBe('beto');
    expect(plan.get('beto')).toEqual({ video: 'high', audio: false });
    expect(plan.get('ana')).toBe(UNSUBSCRIBED);
  });

  it('subscribes nothing once a watched live ended and the list was pruned', () => {
    const state = pruneWatching(watch(EMPTY_WATCHING, 'ana'), ['beto', 'carla']);
    expect([...planFor(state).values()].every((p) => p === UNSUBSCRIBED)).toBe(true);
  });

  it('subscribes nothing after a room change resets the list', () => {
    const plan = planFor(resetWatching());
    expect([...plan.values()].every((p) => p === UNSUBSCRIBED)).toBe(true);
  });
});

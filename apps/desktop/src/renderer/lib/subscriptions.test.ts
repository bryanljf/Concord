import { describe, expect, it } from 'vitest';
import { UNSUBSCRIBED, planSubscriptions, type StreamCandidate } from './subscriptions';
import {
  EMPTY_WATCHING,
  pruneWatching,
  resetWatching,
  showGrid,
  unwatch,
  watch,
  watchAndFocus,
  type WatchingState,
} from './watching';

const ana: StreamCandidate = { key: 'ana', hasVideo: true, hasAudio: true };
const anaCamera: StreamCandidate = { key: 'ana#camera', hasVideo: true, hasAudio: false };
const beto: StreamCandidate = { key: 'beto', hasVideo: true, hasAudio: false };
const carla: StreamCandidate = { key: 'carla', hasVideo: true, hasAudio: true };
const silent: StreamCandidate = { key: 'dani', hasVideo: false, hasAudio: true };

const HIGH_AUDIO = { video: 'high', audio: true };
const HIGH = { video: 'high', audio: false };
const LOW = { video: 'low', audio: false };

describe('planSubscriptions', () => {
  it('subscribes nothing when nothing is watched (entering a room)', () => {
    const plan = planSubscriptions([ana, anaCamera, beto, carla], null, []);
    expect(plan.size).toBe(4);
    expect([...plan.values()].every((p) => p === UNSUBSCRIBED)).toBe(true);
  });

  it('gives a screen share in destaque full video plus audio and the others low video only', () => {
    const plan = planSubscriptions([ana, anaCamera, beto, carla], 'carla', [
      'ana',
      'ana#camera',
      'carla',
    ]);
    expect(plan.get('carla')).toEqual(HIGH_AUDIO);
    expect(plan.get('ana')).toEqual(LOW);
    expect(plan.get('ana#camera')).toEqual(LOW);
    expect(plan.get('beto')).toBe(UNSUBSCRIBED);
  });

  it('subscribes to the audio only when it exists', () => {
    expect(planSubscriptions([beto], 'beto', ['beto']).get('beto')).toEqual(HIGH);
  });

  it('plays every watched stream at full quality on the grid, with every screen audio', () => {
    const plan = planSubscriptions([ana, anaCamera, beto, carla], null, [
      'ana',
      'ana#camera',
      'beto',
    ]);
    expect(plan.get('ana')).toEqual(HIGH_AUDIO);
    expect(plan.get('ana#camera')).toEqual(HIGH);
    expect(plan.get('beto')).toEqual(HIGH);
    expect(plan.get('carla')).toBe(UNSUBSCRIBED);
  });

  it('keeps every screen playing when a camera is in destaque', () => {
    const plan = planSubscriptions([ana, anaCamera, carla], 'ana#camera', [
      'ana',
      'ana#camera',
      'carla',
    ]);
    expect(plan.get('ana#camera')).toEqual(HIGH);
    expect(plan.get('ana')).toEqual(HIGH_AUDIO);
    expect(plan.get('carla')).toEqual(HIGH_AUDIO);
  });

  it('never subscribes to what another window shows (pop-out, picture-in-picture)', () => {
    const plan = planSubscriptions(
      [ana, anaCamera, carla],
      'ana',
      ['ana', 'ana#camera', 'carla'],
      ['ana', 'ana#camera'],
    );
    expect(plan.get('ana')).toBe(UNSUBSCRIBED);
    expect(plan.get('ana#camera')).toBe(UNSUBSCRIBED);
    expect(plan.get('carla')).toEqual(LOW);

    const grid = planSubscriptions([ana, carla], null, ['ana', 'carla'], ['ana']);
    expect(grid.get('ana')).toBe(UNSUBSCRIBED);
    expect(grid.get('carla')).toEqual(HIGH_AUDIO);
  });

  it('treats the focused live as watched even outside the watched list (pop-out)', () => {
    const plan = planSubscriptions([ana, anaCamera, beto], 'ana');
    expect(plan.get('ana')).toEqual(HIGH_AUDIO);
    expect(plan.get('ana#camera')).toBe(UNSUBSCRIBED);
    expect(plan.get('beto')).toBe(UNSUBSCRIBED);
  });

  it('subscribes only the cameras of the picture-in-picture window', () => {
    const plan = planSubscriptions([ana, anaCamera, beto], null, ['ana#camera']);
    expect(plan.get('ana#camera')).toEqual(HIGH);
    expect(plan.get('ana')).toBe(UNSUBSCRIBED);
    expect(plan.get('beto')).toBe(UNSUBSCRIBED);
  });

  it('never subscribes to a participant without a video publication', () => {
    const plan = planSubscriptions([silent, ana], 'dani', ['dani', 'ana']);
    expect(plan.get('dani')).toBe(UNSUBSCRIBED);
    expect(plan.get('ana')).toEqual(LOW);
  });

  it('ignores watched keys that are not published', () => {
    const plan = planSubscriptions([ana], null, ['zoe', 'ana']);
    expect(plan.has('zoe')).toBe(false);
    expect(plan.get('ana')).toEqual(HIGH_AUDIO);
  });

  it('returns an empty plan for an empty room', () => {
    expect(planSubscriptions([], 'ana', ['ana']).size).toBe(0);
  });
});

describe('planSubscriptions with the watching transitions', () => {
  const streams = [ana, anaCamera, beto, carla];
  const planFor = (state: WatchingState) =>
    planSubscriptions(streams, state.focused, state.watched);

  it('puts two watched lives side by side on the grid at full quality', () => {
    const plan = planFor(watch(watch(EMPTY_WATCHING, 'ana'), 'carla'));
    expect(plan.get('ana')).toEqual(HIGH_AUDIO);
    expect(plan.get('carla')).toEqual(HIGH_AUDIO);
    expect(plan.get('beto')).toBe(UNSUBSCRIBED);
  });

  it('demotes the others when one goes in destaque and restores them on the grid', () => {
    const focused = watchAndFocus(watch(EMPTY_WATCHING, 'ana'), 'carla');
    expect(planFor(focused).get('ana')).toEqual(LOW);
    expect(planFor(focused).get('carla')).toEqual(HIGH_AUDIO);
    expect(planFor(showGrid(focused)).get('ana')).toEqual(HIGH_AUDIO);
  });

  it('keeps the destaque when a camera is watched, the camera as a low mini tile', () => {
    const state = watch(watchAndFocus(EMPTY_WATCHING, 'carla'), 'ana#camera');
    expect(state.focused).toBe('carla');
    expect(planFor(state).get('ana#camera')).toEqual(LOW);
  });

  it('unsubscribes video and audio of a stream the user stops watching', () => {
    const state = unwatch(watch(watch(EMPTY_WATCHING, 'ana'), 'carla'), 'ana');
    const plan = planFor(state);
    expect(plan.get('ana')).toBe(UNSUBSCRIBED);
    expect(plan.get('carla')).toEqual(HIGH_AUDIO);
  });

  it('goes back to the grid when the stream in destaque is removed', () => {
    const state = unwatch(watchAndFocus(watch(EMPTY_WATCHING, 'beto'), 'ana'), 'ana');
    expect(state.focused).toBeNull();
    expect(planFor(state).get('beto')).toEqual(HIGH);
    expect(planFor(state).get('ana')).toBe(UNSUBSCRIBED);
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

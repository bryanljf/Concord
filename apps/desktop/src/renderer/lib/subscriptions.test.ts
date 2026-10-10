import { describe, expect, it } from 'vitest';
import {
  UNSUBSCRIBED,
  pickFocused,
  planSubscriptions,
  type StreamCandidate,
} from './subscriptions';

const ana: StreamCandidate = { participantId: 'ana', hasVideo: true, hasAudio: true };
const beto: StreamCandidate = { participantId: 'beto', hasVideo: true, hasAudio: false };
const carla: StreamCandidate = { participantId: 'carla', hasVideo: true, hasAudio: true };
const silent: StreamCandidate = { participantId: 'dani', hasVideo: false, hasAudio: true };

describe('planSubscriptions', () => {
  it('gives the focused stream full video plus audio and the rest low video only', () => {
    const plan = planSubscriptions([ana, beto, carla], 'beto');
    expect(plan.get('beto')).toEqual({ video: 'high', audio: false });
    expect(plan.get('ana')).toEqual({ video: 'low', audio: false });
    expect(plan.get('carla')).toEqual({ video: 'low', audio: false });
  });

  it('subscribes to the focused audio only when it exists', () => {
    expect(planSubscriptions([ana], 'ana').get('ana')).toEqual({ video: 'high', audio: true });
    expect(planSubscriptions([beto], 'beto').get('beto')).toEqual({ video: 'high', audio: false });
  });

  it('never subscribes to a participant without a video publication', () => {
    const plan = planSubscriptions([silent, ana], 'dani');
    expect(plan.get('dani')).toBe(UNSUBSCRIBED);
    expect(plan.get('ana')).toEqual({ video: 'low', audio: false });
  });

  it('subscribes nothing at full quality when nobody is focused', () => {
    const plan = planSubscriptions([ana, beto], null);
    expect([...plan.values()].every((p) => p.video === 'low' && !p.audio)).toBe(true);
  });

  it('caps the number of previews', () => {
    const plan = planSubscriptions([ana, beto, carla], 'ana', { maxPreviews: 1 });
    expect(plan.get('ana')?.video).toBe('high');
    expect(plan.get('beto')?.video).toBe('low');
    expect(plan.get('carla')).toBe(UNSUBSCRIBED);
  });

  it('returns an empty plan for an empty room', () => {
    expect(planSubscriptions([], 'ana').size).toBe(0);
  });
});

describe('pickFocused', () => {
  it('honours the request only while that stream exists', () => {
    expect(pickFocused([ana, beto], 'beto')).toBe('beto');
    expect(pickFocused([ana, beto], 'zoe')).toBe('ana');
    expect(pickFocused([ana, beto], null)).toBe('ana');
    expect(pickFocused([], 'ana')).toBeNull();
  });
});

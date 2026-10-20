/**
 * Adaptive bitrate of the music track: always aims for the best Opus stereo quality the
 * broadcaster's connection carries cleanly. Pure (`hooks/useMusicBroadcast.ts` samples the
 * sender stats and applies the result with `RTCRtpSender.setParameters`).
 *
 * Only loss and round-trip time drive it: Chrome's bandwidth estimate for an audio-only sender
 * hovers around what is already being sent, so trusting it would drag a good connection down.
 * The SFU forwards the same stream to every listener (Opus has no layers), so this follows the
 * broadcaster's uplink.
 */

/** Opus stereo steps, best first; 320 kbps is beyond audible differences for music. */
export const MUSIC_BITRATE_STEPS_KBPS: readonly number[] = [320, 256, 192, 160, 128, 96, 64];

/** Published at the top: the SDP allows up to 510 kbps, the sender cap does the rest. */
export const MUSIC_MAX_KBPS = 320;

/** How often the sender stats are sampled. */
export const AUDIO_QUALITY_SAMPLE_MS = 2_000;

/** Loss above this (fraction of packets, per receiver report) steps down at once. */
export const LOSS_DOWN = 0.02;
/** Loss below this counts as clean. */
export const LOSS_CLEAN = 0.005;
/** Round trip this much above the session's best means queues are building up. */
export const RTT_QUEUE_MS = 120;
/** Clean for this long before trying the next step up. */
export const CLEAN_BEFORE_UP_MS = 10_000;

export interface AudioNetworkSample {
  /** `remote-inbound-rtp.fractionLost` (0–1); null when not reported yet. */
  lossFraction: number | null;
  /** Round trip in ms (remote-inbound or candidate pair); null when unknown. */
  rttMs: number | null;
}

export interface AudioQualityState {
  kbps: number;
  /** Lowest round trip seen this session (the uncongested baseline). */
  bestRttMs: number | null;
  /** Since when the connection has been clean (null: not clean right now). */
  cleanSince: number | null;
}

export function initialAudioQuality(): AudioQualityState {
  return { kbps: MUSIC_MAX_KBPS, bestRttMs: null, cleanSince: null };
}

function stepDown(kbps: number): number {
  return MUSIC_BITRATE_STEPS_KBPS.find((step) => step < kbps) ?? kbps;
}

function stepUp(kbps: number): number {
  const higher = MUSIC_BITRATE_STEPS_KBPS.filter((step) => step > kbps);
  return higher.at(-1) ?? kbps;
}

/** The bitrate after one more sample: down at the first sign of trouble, up after a clean while. */
export function nextAudioQuality(
  state: AudioQualityState,
  sample: AudioNetworkSample,
  now: number,
): AudioQualityState {
  const rtt = sample.rttMs !== null && Number.isFinite(sample.rttMs) ? sample.rttMs : null;
  const bestRttMs =
    rtt === null
      ? state.bestRttMs
      : state.bestRttMs === null
        ? rtt
        : Math.min(state.bestRttMs, rtt);
  const queued = rtt !== null && bestRttMs !== null && rtt - bestRttMs > RTT_QUEUE_MS;
  const loss = sample.lossFraction;

  if ((loss !== null && loss > LOSS_DOWN) || queued) {
    return { kbps: stepDown(state.kbps), bestRttMs, cleanSince: null };
  }
  const clean = (loss === null || loss < LOSS_CLEAN) && !queued;
  if (!clean) return { kbps: state.kbps, bestRttMs, cleanSince: null };
  const cleanSince = state.cleanSince ?? now;
  if (state.kbps < MUSIC_MAX_KBPS && now - cleanSince >= CLEAN_BEFORE_UP_MS) {
    // One step at a time, then another clean while before the next.
    return { kbps: stepUp(state.kbps), bestRttMs, cleanSince: now };
  }
  return { kbps: state.kbps, bestRttMs, cleanSince };
}

/** Loss and round trip of the audio sender, from `LocalTrack.getRTCStatsReport()`. */
export function audioNetworkSample(report: RTCStatsReport): AudioNetworkSample {
  let lossFraction: number | null = null;
  let rttMs: number | null = null;
  let pairRttMs: number | null = null;
  report.forEach((entry: Record<string, unknown>) => {
    if (entry.type === 'remote-inbound-rtp' && entry.kind === 'audio') {
      if (typeof entry.fractionLost === 'number') lossFraction = entry.fractionLost;
      if (typeof entry.roundTripTime === 'number') rttMs = entry.roundTripTime * 1000;
    } else if (
      entry.type === 'candidate-pair' &&
      entry.nominated === true &&
      typeof entry.currentRoundTripTime === 'number'
    ) {
      pairRttMs = entry.currentRoundTripTime * 1000;
    }
  });
  return { lossFraction, rttMs: rttMs ?? pairRttMs };
}

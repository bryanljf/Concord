/**
 * `Settings.videoEncoder` applied to what a publisher offers. LiveKit negotiates H.264 in the
 * order the client lists the profiles, and livekit-client lists them as Chromium does, which ends
 * on Constrained Baseline (42e01f): the server supports only that one and High. Measured on
 * Electron 44 with an NVIDIA GPU: Chromium's Windows hardware encoder (Media Foundation) takes
 * Baseline, Main and High but never Constrained Baseline, so every live so far was encoded with
 * OpenH264. "GPU" lists the profiles a hardware encoder takes first (High, Main, Baseline);
 * without one, Chromium does not even offer them and Constrained Baseline (OpenH264) remains.
 * "CPU" keeps the order as it is. `orderCodecsFor` is pure (unit-tested); `installEncoderPreference`
 * applies it to new sender transceivers.
 */
import type { VideoEncoderPreference } from '../../preload/api';

/** Lower ranks first: profiles Chromium's hardware encoders take, Constrained Baseline last. */
function h264Rank(codec: RTCRtpCodec): number {
  const match = /profile-level-id=([0-9a-f]{2})([0-9a-f]{2})/i.exec(codec.sdpFmtpLine ?? '');
  if (!match) return 3;
  const profile = parseInt(match[1] ?? '', 16);
  const constraints = parseInt(match[2] ?? '', 16);
  if (profile === 0x64) return 0; // High
  if (profile === 0x4d) return 1; // Main
  // Baseline; with constraint_set1 (0x40) it is Constrained Baseline.
  if (profile === 0x42) return constraints & 0x40 ? 3 : 2;
  return 3;
}

function isH264(codec: RTCRtpCodec): boolean {
  return codec.mimeType.toLowerCase() === 'video/h264';
}

/**
 * The codec list for a video sender: for the GPU, the H.264 entries reordered (High, Main,
 * Baseline, then Constrained Baseline) in the slots they already held, so the other codecs
 * keep their places. For the CPU, unchanged.
 */
export function orderCodecsFor(
  preference: VideoEncoderPreference,
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  if (preference === 'cpu') return [...codecs];
  const h264 = codecs.filter(isH264);
  const sorted = h264
    .map((codec, index) => ({ codec, index }))
    .sort((a, b) => h264Rank(a.codec) - h264Rank(b.codec) || a.index - b.index)
    .map(({ codec }) => codec);
  let next = 0;
  return codecs.map((codec) => (isH264(codec) ? (sorted[next++] ?? codec) : codec));
}

let currentPreference: VideoEncoderPreference = 'cpu';
let installed = false;

/** What the next publish uses; call whenever the setting changes (or is about to). */
export function setEncoderPreference(preference: VideoEncoderPreference): void {
  currentPreference = preference;
}

/**
 * Wraps `RTCPeerConnection.addTransceiver` once for this window. livekit-client (2.22) never sets
 * codec preferences: it creates each sender transceiver and offers Chromium's default order. For
 * the GPU, a new video sender gets the reordered list before the offer is made. Receivers and
 * audio are never touched.
 */
export function installEncoderPreference(): void {
  if (installed || typeof RTCPeerConnection === 'undefined') return;
  installed = true;
  const original = RTCPeerConnection.prototype.addTransceiver;
  const wrapped = function addTransceiver(
    this: RTCPeerConnection,
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ): RTCRtpTransceiver {
    const transceiver = original.call(this, trackOrKind, init);
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    if (currentPreference === 'gpu' && kind === 'video' && transceiver.direction === 'sendonly') {
      try {
        const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
        transceiver.setCodecPreferences(orderCodecsFor('gpu', codecs));
      } catch (err) {
        // Chromium's own order then: the live still goes out, encoded on the CPU.
        console.warn('could not prefer the hardware H.264 profiles', err);
      }
    }
    return transceiver;
  };
  RTCPeerConnection.prototype.addTransceiver = wrapped as typeof original;
}

/**
 * Pure helpers for the webcam: capture constraints, publish encoding, device labels and pt-BR
 * error messages. Kept free of livekit imports so they stay testable in Node; the hook that
 * publishes adds `Track.Source.Camera` and the simulcast layers (see `hooks/useCamera.ts`).
 */

/** What the webcam is asked for: 720p30, enough for a face and cheap to encode. */
export const CAMERA_CAPTURE = { width: 1280, height: 720, fps: 30 } as const;

/** Shape of livekit's `VideoEncoding` (`videoEncoding` in `TrackPublishOptions`). */
export interface CameraEncoding {
  maxBitrate: number;
  maxFramerate: number;
}

/** Top simulcast layer of the webcam (the bottom one is livekit's `VideoPresets.h180`). */
export const CAMERA_ENCODING: CameraEncoding = { maxBitrate: 1_500_000, maxFramerate: 30 };

/**
 * `getUserMedia` constraints: the saved device must be that one (`exact`, so a missing camera
 * fails instead of silently opening another), the size and frame rate are `ideal` so any webcam
 * opens, and `max` on the frame rate keeps a 60 fps camera from wasting encoder time.
 */
export function cameraConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: CAMERA_CAPTURE.width },
      height: { ideal: CAMERA_CAPTURE.height },
      frameRate: { ideal: CAMERA_CAPTURE.fps, max: CAMERA_CAPTURE.fps },
    },
  };
}

/** Windows appends the USB ids to webcam names: "HD Webcam (046d:0825)". */
const USB_IDS_SUFFIX = /\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i;

/** Device label for the UI, without the USB ids; `fallback` when the system gave none. */
export function cameraLabel(label: string, fallback = 'Câmera'): string {
  const cleaned = label.replace(USB_IDS_SUFFIX, '').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

export interface VideoInput {
  /** `MediaDeviceInfo.deviceId` (what `Settings.cameraDeviceId` stores). */
  id: string;
  label: string;
}

/** Shape of the `MediaDeviceInfo` fields used here (testable without a DOM). */
export interface DeviceInfoLike {
  kind: string;
  deviceId: string;
  label: string;
}

/**
 * The webcams in `enumerateDevices()` order. Devices without an id (no permission yet) cannot
 * be picked and are left out; unnamed ones become "Câmera N".
 */
export function toVideoInputs(devices: readonly DeviceInfoLike[]): VideoInput[] {
  return devices
    .filter(
      (device) =>
        device.kind === 'videoinput' && device.deviceId !== '' && device.deviceId !== 'default',
    )
    .map((device, index) => ({
      id: device.deviceId,
      label: cameraLabel(device.label, `Câmera ${index + 1}`),
    }));
}

const GENERIC_ERROR = 'Não foi possível ligar a câmera.';

/** pt-BR message for a failed `getUserMedia()` call on the webcam. */
export function cameraErrorMessage(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'O Windows bloqueou a câmera. Libere em Configurações do Windows → Privacidade e segurança → Câmera (Permitir que aplicativos da área de trabalho acessem a câmera).';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'A câmera está em uso por outro aplicativo.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Câmera não encontrada. Verifique se ela está conectada.';
    default:
      return GENERIC_ERROR;
  }
}

import { log } from './log';

/**
 * Raises this process's GPU scheduling priority (D3DKMT, the call OBS and Sunshine make) so the
 * screen capture is not queued behind a game that keeps the GPU busy.
 *
 * Chromium captures the screen in the browser process, which is Electron's main
 * (`desktopCaptureThread`, with its own D3D11 device): every frame is copied to a staging texture
 * and `Map` waits for the GPU. When a game fills the GPU queue that wait grows, and Chromium spaces
 * captures to twice the time each one takes, so a game drops a live to 8-16 fps. Measured on an
 * RTX 3050 with HAGS on and a load of 16 ms GPU frames: 16 fps captured at the default class,
 * 16 at HIGH, 29 at REALTIME, at a cost of ~5% of the load's frame rate. REALTIME needed no admin.
 *
 * OBS and Sunshine drop to HIGH on NVIDIA with HAGS because the driver can freeze NVENC in a
 * REALTIME process when VRAM is nearly full; NVENC never runs here (hardware encoding is in
 * Chromium's GPU process), and this process only uses the GPU to capture.
 */

const logger = log('gpu-priority');

/** `D3DKMT_SCHEDULINGPRIORITYCLASS` (d3dkmthk.h). */
export const GPU_PRIORITY_CLASSES = {
  idle: 0,
  'below-normal': 1,
  normal: 2,
  'above-normal': 3,
  high: 4,
  realtime: 5,
} as const;

export type GpuPriority = keyof typeof GPU_PRIORITY_CLASSES;

export const DEFAULT_GPU_PRIORITY: GpuPriority = 'realtime';

/** Environment variable that picks another class ("normal" keeps the Windows default). */
export const GPU_PRIORITY_ENV = 'CONCORD_GPU_PRIORITY';

export interface GpuPriorityNative {
  /** NTSTATUS of `D3DKMTSetProcessSchedulingPriorityClass` on this process (0 = success). */
  set(priorityClass: number): number;
  /** This process's class, null when the query fails. */
  get(): number | null;
}

export interface GpuPriorityDeps {
  platform: string;
  /** Value of `CONCORD_GPU_PRIORITY`. */
  override: string | undefined;
  loadNative: () => GpuPriorityNative | null;
}

export type GpuPriorityResult =
  { applied: true; priority: GpuPriority } | { applied: false; reason: string };

export function parseGpuPriority(value: string | undefined): GpuPriority | null {
  const key = value?.trim().toLowerCase();
  return key && Object.hasOwn(GPU_PRIORITY_CLASSES, key) ? (key as GpuPriority) : null;
}

/**
 * koffi is an external dependency with a prebuilt binary (@koromix/koffi-win32-x64), resolved at
 * runtime: required lazily and guarded so the app keeps working without it.
 */
function loadNativeBinding(): GpuPriorityNative | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    const currentProcess = kernel32.func('void *GetCurrentProcess()');
    const setClass = gdi32.func(
      'int32 D3DKMTSetProcessSchedulingPriorityClass(void *process, int32 priority)',
    );
    const getClass = gdi32.func(
      'int32 D3DKMTGetProcessSchedulingPriorityClass(void *process, _Out_ int32 *priority)',
    );
    // A pseudo-handle: nothing to close.
    const self: unknown = currentProcess();
    return {
      set: (priorityClass) => setClass(self, priorityClass) as number,
      get: () => {
        const out = [0];
        return getClass(self, out) === 0 ? (out[0] ?? null) : null;
      },
    };
  } catch (err) {
    logger.warn('koffi could not be loaded', err);
    return null;
  }
}

function className(priorityClass: number | null): string {
  const entry = Object.entries(GPU_PRIORITY_CLASSES).find(([, value]) => value === priorityClass);
  return entry ? entry[0] : String(priorityClass);
}

/** Best effort, once at startup: a failure is logged and the app goes on at the default class. */
export function raiseGpuPriority(overrides: Partial<GpuPriorityDeps> = {}): GpuPriorityResult {
  const deps: GpuPriorityDeps = {
    platform: process.platform,
    override: process.env[GPU_PRIORITY_ENV],
    loadNative: loadNativeBinding,
    ...overrides,
  };
  if (deps.platform !== 'win32') return { applied: false, reason: 'not Windows' };

  let priority = DEFAULT_GPU_PRIORITY;
  if (deps.override !== undefined && deps.override !== '') {
    const parsed = parseGpuPriority(deps.override);
    if (parsed) priority = parsed;
    else logger.warn(`ignoring ${GPU_PRIORITY_ENV}=${deps.override}`);
  }

  const native = deps.loadNative();
  if (!native) return { applied: false, reason: 'native binding unavailable' };
  try {
    const before = native.get();
    const status = native.set(GPU_PRIORITY_CLASSES[priority]);
    if (status !== 0) {
      const code = `0x${(status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
      logger.warn(`could not set the GPU scheduling priority to ${priority} (NTSTATUS ${code})`);
      return { applied: false, reason: `NTSTATUS ${code}` };
    }
    logger.info(`GPU scheduling priority: ${priority} (was ${className(before)})`);
    return { applied: true, priority };
  } catch (err) {
    logger.warn('could not set the GPU scheduling priority', err);
    return { applied: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

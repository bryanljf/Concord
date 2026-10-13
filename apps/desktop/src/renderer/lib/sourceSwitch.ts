/**
 * Pure decisions for switching what is shared while live (`useBroadcast().switchSource`): the
 * video is swapped in place (same publication, viewers keep their subscription), and the audio
 * publication is replaced, published, unpublished or left alone depending on what the old and
 * the new source carry.
 */

export type AudioSwitchAction = 'keep-none' | 'publish' | 'replace' | 'unpublish';

/**
 * @param audioPublished the broadcast currently has a ScreenShareAudio publication.
 * @param newAudio the new source produced an audio track (loopback or per-process).
 */
export function audioSwitchAction(audioPublished: boolean, newAudio: boolean): AudioSwitchAction {
  if (audioPublished) return newAudio ? 'replace' : 'unpublish';
  return newAudio ? 'publish' : 'keep-none';
}

export interface SourceSwitchPlan {
  /** The per-process capture of the old source must be stopped before the new one starts
   *  (main runs a single process capture at a time). */
  stopOldProcessAudioFirst: boolean;
  /** The quality preset changed: re-apply the encoding to the swapped video track. */
  reencode: boolean;
}

export function planSourceSwitch(
  current: { quality: string; processAudio: boolean },
  next: { quality: string; audio: 'none' | 'system' | 'process' },
): SourceSwitchPlan {
  return {
    stopOldProcessAudioFirst: current.processAudio && next.audio === 'process',
    reencode: current.quality !== next.quality,
  };
}

/** The tab the picker opens on: the kind of the source being shared (Electron ids). */
export function sourceKindOf(sourceId: string): 'screen' | 'window' {
  return sourceId.startsWith('screen:') ? 'screen' : 'window';
}

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  context ??= new AudioContext();
  return context;
}

function tone(audio: AudioContext, frequency: number, start: number, duration: number): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.08, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function play(sequence: readonly [number, number, number][]): void {
  const audio = getContext();
  if (!audio) return;
  void audio.resume().then(() => {
    const start = audio.currentTime;
    for (const [frequency, offset, duration] of sequence) {
      tone(audio, frequency, start + offset, duration);
    }
  });
}

export function playTransmissionStarted(): void {
  play([
    [523.25, 0, 0.12],
    [659.25, 0.1, 0.16],
    [783.99, 0.22, 0.22],
  ]);
}

export function playTransmissionEnded(): void {
  play([
    [783.99, 0, 0.12],
    [659.25, 0.1, 0.16],
    [523.25, 0.22, 0.22],
  ]);
}

/** Someone started watching a live you are part of: a soft, quick rising pair of notes. */
export function playViewerJoined(): void {
  play([
    [659.25, 0, 0.09],
    [880, 0.07, 0.18],
  ]);
}

/** Someone stopped watching a live you are part of: the same pair, falling. */
export function playViewerLeft(): void {
  play([
    [880, 0, 0.09],
    [659.25, 0.07, 0.18],
  ]);
}

/** Someone (or you) entered the room: a lower, rounder rising pair, like a voice channel. */
export function playRoomJoined(): void {
  play([
    [392, 0, 0.1],
    [587.33, 0.08, 0.22],
  ]);
}

/** Someone (or you) left the room: the same pair, falling. */
export function playRoomLeft(): void {
  play([
    [587.33, 0, 0.1],
    [392, 0.08, 0.22],
  ]);
}

/** Someone else went live in the room you are in: a light, higher two-note chime. */
export function playLiveStartedInRoom(): void {
  play([
    [987.77, 0, 0.1],
    [1318.51, 0.09, 0.26],
  ]);
}

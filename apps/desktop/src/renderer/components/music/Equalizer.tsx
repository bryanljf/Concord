import '../../styles/music.css';

interface EqualizerProps {
  /** Frozen bars (the music is paused). */
  paused?: boolean;
}

/** Three bouncing bars: music you are listening to (static with reduced motion). */
export function Equalizer({ paused = false }: EqualizerProps) {
  return (
    <span className={paused ? 'music-eq music-eq--paused' : 'music-eq'} aria-hidden="true">
      <span className="music-eq__bar" />
      <span className="music-eq__bar" />
      <span className="music-eq__bar" />
    </span>
  );
}

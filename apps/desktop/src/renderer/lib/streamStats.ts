/** Bitrate / fps / resolution of a subscribed video track, from two `inbound-rtp` samples. */

export interface StatsSample {
  /** `RTCStats.timestamp` (milliseconds). */
  timestamp: number;
  bytesReceived: number;
  framesDecoded: number;
  frameWidth?: number;
  frameHeight?: number;
  codec?: string;
}

export interface StreamStats {
  /** Bits per second. */
  bitrate: number;
  fps: number;
  width: number | null;
  height: number | null;
  /** "H264", "VP9", … (from the RTP codec mime type). */
  codec: string | null;
}

/** Null until two samples at least 250 ms apart exist. */
export function deriveStats(prev: StatsSample | null, next: StatsSample): StreamStats | null {
  if (!prev) return null;
  const elapsedMs = next.timestamp - prev.timestamp;
  if (elapsedMs < 250) return null;
  const seconds = elapsedMs / 1000;
  const bitrate = Math.max(0, ((next.bytesReceived - prev.bytesReceived) * 8) / seconds);
  const fps = Math.max(0, (next.framesDecoded - prev.framesDecoded) / seconds);
  return {
    bitrate: Math.round(bitrate),
    fps: Math.round(fps),
    width: next.frameWidth ?? null,
    height: next.frameHeight ?? null,
    codec: codecName(next.codec),
  };
}

/** "video/H264" → "H264"; undefined → null. */
export function codecName(mimeType: string | undefined): string | null {
  if (!mimeType) return null;
  const name = mimeType.split('/')[1] ?? mimeType;
  return name.length > 0 ? name.toUpperCase() : null;
}

/** "4,2 Mbps" / "850 kbps" / "0 kbps". */
export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps`;
  }
  return `${Math.round(bps / 1000).toLocaleString('pt-BR')} kbps`;
}

/** "1920×1080 · 60 fps · 4,2 Mbps · H264" (resolution and codec only when known). */
export function formatStats(stats: StreamStats): string {
  const parts: string[] = [];
  if (stats.width && stats.height) parts.push(`${stats.width}×${stats.height}`);
  parts.push(`${stats.fps} fps`, formatBitrate(stats.bitrate));
  if (stats.codec) parts.push(stats.codec);
  return parts.join(' · ');
}

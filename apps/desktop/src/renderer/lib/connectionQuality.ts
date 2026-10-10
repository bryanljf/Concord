/**
 * livekit's `ConnectionQuality` is a string enum ("excellent" | "good" | "poor" | "lost" |
 * "unknown"); this module works on the raw strings so it stays free of livekit imports.
 */

export type QualityLevel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export function toQualityLevel(value: string): QualityLevel {
  switch (value) {
    case 'excellent':
    case 'good':
    case 'poor':
    case 'lost':
      return value;
    default:
      return 'unknown';
  }
}

/** Number of lit bars (out of 3) in the signal icon. */
export function qualityBars(value: string): 0 | 1 | 2 | 3 {
  switch (toQualityLevel(value)) {
    case 'excellent':
      return 3;
    case 'good':
      return 2;
    case 'poor':
      return 1;
    default:
      return 0;
  }
}

export function qualityLabel(value: string): string {
  switch (toQualityLevel(value)) {
    case 'excellent':
      return 'Conexão excelente';
    case 'good':
      return 'Conexão boa';
    case 'poor':
      return 'Conexão ruim';
    case 'lost':
      return 'Conexão perdida';
    default:
      return 'Qualidade da conexão desconhecida';
  }
}

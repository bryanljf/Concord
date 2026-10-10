import { describe, expect, it } from 'vitest';
import { qualityBars, qualityLabel, toQualityLevel } from './connectionQuality';

describe('connection quality helpers', () => {
  it('maps livekit values to bars and pt-BR labels', () => {
    expect(qualityBars('excellent')).toBe(3);
    expect(qualityBars('good')).toBe(2);
    expect(qualityBars('poor')).toBe(1);
    expect(qualityBars('lost')).toBe(0);
    expect(qualityBars('unknown')).toBe(0);
    expect(qualityLabel('excellent')).toBe('Conexão excelente');
    expect(qualityLabel('lost')).toBe('Conexão perdida');
  });

  it('treats unexpected values as unknown', () => {
    expect(toQualityLevel('whatever')).toBe('unknown');
    expect(qualityLabel('whatever')).toBe('Qualidade da conexão desconhecida');
  });
});

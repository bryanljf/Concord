import { describe, expect, it } from 'vitest';
import {
  isModifierKey,
  keyEventToAccelerator,
  keyToken,
  modifierTokens,
  type AcceleratorKeyEvent,
} from './accelerator';

function press(partial: Partial<AcceleratorKeyEvent>): AcceleratorKeyEvent {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...partial,
  };
}

describe('keyEventToAccelerator', () => {
  it('builds the default chord from Ctrl+Shift+L', () => {
    const event = press({ key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true });
    expect(keyEventToAccelerator(event)).toBe('CommandOrControl+Shift+L');
  });

  it('returns null while only modifiers are held', () => {
    expect(
      keyEventToAccelerator(press({ key: 'Control', code: 'ControlLeft', ctrlKey: true })),
    ).toBe(null);
    expect(keyEventToAccelerator(press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBe(
      null,
    );
    expect(keyEventToAccelerator(press({ key: 'CapsLock', code: 'CapsLock' }))).toBe(null);
  });

  it('rejects plain keys and Shift-only chords (they would swallow normal typing)', () => {
    expect(keyEventToAccelerator(press({ key: 'l', code: 'KeyL' }))).toBe(null);
    expect(keyEventToAccelerator(press({ key: 'L', code: 'KeyL', shiftKey: true }))).toBe(null);
    expect(keyEventToAccelerator(press({ key: ' ', code: 'Space' }))).toBe(null);
  });

  it('allows function keys on their own', () => {
    expect(keyEventToAccelerator(press({ key: 'F9', code: 'F9' }))).toBe('F9');
    expect(keyEventToAccelerator(press({ key: 'F12', code: 'F12', shiftKey: true }))).toBe(
      'Shift+F12',
    );
  });

  it('uses the physical key so layouts do not matter', () => {
    expect(keyEventToAccelerator(press({ key: 'ç', code: 'KeyC', altKey: true }))).toBe('Alt+C');
    expect(keyEventToAccelerator(press({ key: '!', code: 'Digit1', ctrlKey: true }))).toBe(
      'CommandOrControl+1',
    );
  });

  it('maps special keys to Electron names', () => {
    expect(keyEventToAccelerator(press({ key: ' ', code: 'Space', ctrlKey: true }))).toBe(
      'CommandOrControl+Space',
    );
    expect(keyEventToAccelerator(press({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }))).toBe(
      'Alt+Up',
    );
    expect(keyEventToAccelerator(press({ key: '5', code: 'Numpad5', ctrlKey: true }))).toBe(
      'CommandOrControl+num5',
    );
    expect(keyEventToAccelerator(press({ key: '+', code: 'NumpadAdd', ctrlKey: true }))).toBe(
      'CommandOrControl+numadd',
    );
    expect(keyEventToAccelerator(press({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toBe(
      'CommandOrControl+Enter',
    );
  });

  it('orders modifiers consistently and maps the Windows key to Super', () => {
    const event = press({
      key: 'K',
      code: 'KeyK',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
    });
    expect(keyEventToAccelerator(event)).toBe('CommandOrControl+Alt+Shift+Super+K');
  });

  it('treats Cmd as the primary modifier on macOS', () => {
    const event = press({ key: 'l', code: 'KeyL', metaKey: true, shiftKey: true });
    expect(keyEventToAccelerator(event, 'darwin')).toBe('Shift+CommandOrControl+L');
    expect(keyEventToAccelerator(press({ key: 'l', code: 'KeyL', ctrlKey: true }), 'darwin')).toBe(
      'Control+L',
    );
  });

  it('rejects keys that cannot be bound', () => {
    expect(keyEventToAccelerator(press({ key: 'Escape', code: 'Escape', ctrlKey: true }))).toBe(
      null,
    );
    expect(keyEventToAccelerator(press({ key: 'Unidentified', code: '', ctrlKey: true }))).toBe(
      null,
    );
  });
});

describe('keyToken', () => {
  it('falls back to the printed character for unknown codes', () => {
    expect(keyToken(press({ key: 'q', code: '' }))).toBe('Q');
    expect(keyToken(press({ key: '7', code: '' }))).toBe('7');
    expect(keyToken(press({ key: '+', code: '' }))).toBe('Plus');
    expect(keyToken(press({ key: '/', code: '' }))).toBe('/');
    expect(keyToken(press({ key: 'Dead', code: '' }))).toBe(null);
  });
});

describe('modifierTokens / isModifierKey', () => {
  it('lists held modifiers', () => {
    expect(modifierTokens(press({ ctrlKey: true, shiftKey: true }))).toEqual([
      'CommandOrControl',
      'Shift',
    ]);
    expect(modifierTokens(press({}))).toEqual([]);
  });

  it('recognises modifier key names', () => {
    expect(isModifierKey('Control')).toBe(true);
    expect(isModifierKey('Meta')).toBe(true);
    expect(isModifierKey('a')).toBe(false);
  });
});

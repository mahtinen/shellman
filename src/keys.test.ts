import { describe, expect, it } from 'vitest';
import { BINDINGS, bindingLabel, matchKey, matchNoteKey, type KeyLike } from './keys';

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('matchKey', () => {
  it('matches exact modifiers only', () => {
    expect(matchKey(key('KeyT', { ctrlKey: true, shiftKey: true }))).toEqual({ action: 'newTab' });
    expect(matchKey(key('KeyT', { ctrlKey: true }))).toBeNull();
    expect(matchKey(key('KeyT', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull();
  });

  it('never fires on AltGr (Ctrl+Alt) combinations', () => {
    for (const code of ['Digit2', 'Digit4', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'KeyE', 'KeyQ', 'ArrowLeft']) {
      expect(matchKey(key(code, { ctrlKey: true, altKey: true }))).toBeNull();
      expect(matchKey(key(code, { ctrlKey: true, altKey: true, shiftKey: true }))).toBeNull();
    }
  });

  it('leaves plain Ctrl+C / Ctrl+V for the terminal to decide', () => {
    expect(matchKey(key('KeyC', { ctrlKey: true }))).toBeNull();
    expect(matchKey(key('KeyV', { ctrlKey: true }))).toBeNull();
  });

  it('opens a new note with Ctrl+Shift+J; Ctrl+S and Ctrl+F belong to the note', () => {
    expect(matchKey(key('KeyJ', { ctrlKey: true, shiftKey: true }))).toEqual({ action: 'newNote' });
    expect(matchNoteKey(key('KeyS', { ctrlKey: true }))).toBe('save');
    expect(matchNoteKey(key('KeyF', { ctrlKey: true }))).toBe('find');
    expect(matchNoteKey(key('KeyF', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('distinguishes next and previous tab', () => {
    expect(matchKey(key('Tab', { ctrlKey: true }))).toEqual({ action: 'nextTab' });
    expect(matchKey(key('Tab', { ctrlKey: true, shiftKey: true }))).toEqual({ action: 'prevTab' });
  });

  it('passes the tab index for Alt+digit', () => {
    expect(matchKey(key('Digit1', { altKey: true }))).toEqual({ action: 'goToTab', arg: 0 });
    expect(matchKey(key('Digit9', { altKey: true }))).toEqual({ action: 'goToTab', arg: 8 });
  });

  it('ignores the Windows key', () => {
    expect(matchKey(key('KeyT', { ctrlKey: true, shiftKey: true, metaKey: true }))).toBeNull();
  });

  it('has no conflicting bindings', () => {
    const seen = new Set<string>();
    for (const b of BINDINGS) {
      const sig = `${b.code}|${!!b.ctrl}|${!!b.shift}|${!!b.alt}`;
      expect(seen.has(sig), sig).toBe(false);
      seen.add(sig);
      expect(b.ctrl && b.alt, `Ctrl+Alt binding ${sig}`).toBeFalsy();
    }
  });
});

describe('bindingLabel', () => {
  it('formats readable labels', () => {
    expect(bindingLabel({ action: 'newTab', code: 'KeyT', ctrl: true, shift: true })).toBe('Ctrl+Shift+T');
    expect(bindingLabel({ action: 'focusLeft', code: 'ArrowLeft', alt: true })).toBe('Alt+←');
    expect(bindingLabel({ action: 'goToTab', code: 'Digit3', alt: true })).toBe('Alt+3');
  });
});

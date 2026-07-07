import { describe, it, expect, afterEach } from 'vitest';
import { safeStorage } from './safe-storage';

type Win = { window?: unknown };
const g = globalThis as Win;

function setWindow(localStorage: unknown): void {
  g.window = { localStorage };
}

afterEach(() => {
  delete g.window;
});

describe('safeStorage', () => {
  it('no-ops safely when window is undefined (SSR)', () => {
    delete g.window;
    expect(safeStorage.isAvailable()).toBe(false);
    expect(safeStorage.get('k')).toBeNull();
    expect(safeStorage.set('k', 'v')).toBe(false);
    expect(() => safeStorage.remove('k')).not.toThrow();
  });

  it('round-trips values when storage works', () => {
    const backing = new Map<string, string>();
    setWindow({
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });
    expect(safeStorage.isAvailable()).toBe(true);
    expect(safeStorage.set('focus', 'staff')).toBe(true);
    expect(safeStorage.get('focus')).toBe('staff');
    safeStorage.remove('focus');
    expect(safeStorage.get('focus')).toBeNull();
  });

  it('never throws when storage is disabled (setItem blows up)', () => {
    setWindow({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(safeStorage.isAvailable()).toBe(false);
    expect(safeStorage.get('k')).toBeNull();
    expect(safeStorage.set('k', 'v')).toBe(false);
    expect(() => safeStorage.remove('k')).not.toThrow();
  });
});

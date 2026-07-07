/**
 * localStorage wrapper that NEVER throws.
 *
 * Embedded/sandboxed webviews (and Safari private mode) can disable or block Web
 * Storage entirely — a bare `localStorage.getItem` then throws and white-screens
 * the app. Ground rule: wrap every access in try/catch so the app degrades
 * gracefully. All methods no-op safely when storage is unavailable.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const probe = '__clearview_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

export const safeStorage = {
  get(key: string): string | null {
    const store = resolveStorage();
    if (!store) return null;
    try {
      return store.getItem(key);
    } catch {
      return null;
    }
  },

  set(key: string, value: string): boolean {
    const store = resolveStorage();
    if (!store) return false;
    try {
      store.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },

  remove(key: string): void {
    const store = resolveStorage();
    if (!store) return;
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
  },

  /** True only when a working Web Storage is present. */
  isAvailable(): boolean {
    return resolveStorage() !== null;
  },
};

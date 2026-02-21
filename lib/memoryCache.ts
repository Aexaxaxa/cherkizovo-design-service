type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

export type { CacheEntry };

export function get<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.value as T;
}

export function getEntry<T>(key: string): CacheEntry<T> | null {
  const entry = store.get(key);
  if (!entry) return null;
  return entry as CacheEntry<T>;
}

export function set<T>(key: string, value: T, ttlSec: number): void {
  const safeTtlMs = Math.max(1, Math.floor(ttlSec * 1000));
  store.set(key, {
    value,
    expiresAt: Date.now() + safeTtlMs
  });
}

export function del(key: string): void {
  store.delete(key);
}

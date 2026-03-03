type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  sizeBytes: number;
};

type CacheStats = {
  hits: number;
  misses: number;
  evictions: number;
};

type CacheDebugLevel = "none" | "errors" | "verbose";

type LruTtlCacheOptions = {
  maxItems: number;
  maxBytes?: number;
  debug?: boolean;
  debugLevel?: CacheDebugLevel;
  debugSampleRate?: number;
  name?: string;
};

export type LruTtlCacheSnapshot = CacheStats & {
  items: number;
  bytes: number;
  inflight: number;
  lastEvictionReason?: string;
};

export class LruTtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly maxItems: number;
  private readonly maxBytes?: number;
  private readonly debugLevel: CacheDebugLevel;
  private readonly debugSampleRate: number;
  private readonly name: string;
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private lastEvictionReason?: string;

  constructor(options: LruTtlCacheOptions) {
    this.maxItems = Math.max(1, Math.floor(options.maxItems));
    this.maxBytes = options.maxBytes && options.maxBytes > 0 ? Math.floor(options.maxBytes) : undefined;
    this.debugLevel = options.debugLevel ?? (options.debug ? "verbose" : "none");
    this.debugSampleRate = Math.max(1, Math.floor(options.debugSampleRate ?? 20));
    this.name = options.name ?? "cache";
  }

  private shouldLog(level: Exclude<CacheDebugLevel, "none">): boolean {
    if (this.debugLevel === "none") return false;
    if (this.debugLevel === "errors") return level === "errors";
    return true;
  }

  private shouldSample(): boolean {
    return Math.floor(Math.random() * this.debugSampleRate) === 0;
  }

  private log(level: Exclude<CacheDebugLevel, "none">, message: string) {
    if (!this.shouldLog(level)) return;
    if (!this.shouldSample()) return;
    console.log(`[cache:${this.name}] ${message}`);
  }

  private deleteInternal(key: string, reason?: string) {
    const existing = this.store.get(key);
    if (!existing) return;
    this.store.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - existing.sizeBytes);
    this.evictions += 1;
    this.lastEvictionReason = reason;
    this.log("errors", `evict key=${key}${reason ? ` reason=${reason}` : ""}`);
  }

  private touch(key: string, entry: CacheEntry<T>) {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  private evictIfNeeded() {
    while (this.store.size > this.maxItems) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) break;
      this.deleteInternal(oldestKey, "maxItems");
    }

    while (this.maxBytes !== undefined && this.totalBytes > this.maxBytes) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) break;
      this.deleteInternal(oldestKey, "maxBytes");
    }
  }

  set(key: string, value: T, ttlMs: number, sizeBytes = 1): void {
    const safeTtlMs = Math.max(1, Math.floor(ttlMs));
    const safeSizeBytes = Math.max(1, Math.floor(sizeBytes));
    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes = Math.max(0, this.totalBytes - existing.sizeBytes);
      this.store.delete(key);
    }

    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + safeTtlMs,
      sizeBytes: safeSizeBytes
    };
    this.store.set(key, entry);
    this.totalBytes += safeSizeBytes;
    this.evictIfNeeded();
  }

  get(key: string): T | undefined {
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      this.log("errors", `miss key=${key}`);
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.deleteInternal(key, "ttl");
      this.misses += 1;
      this.log("errors", `miss key=${key} reason=expired`);
      return undefined;
    }
    this.touch(key, entry);
    this.hits += 1;
    return entry.value;
  }

  delete(key: string): void {
    const existing = this.store.get(key);
    if (!existing) return;
    this.store.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - existing.sizeBytes);
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
    this.totalBytes = 0;
  }

  stats(): LruTtlCacheSnapshot {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      items: this.store.size,
      bytes: this.totalBytes,
      inflight: this.inFlight.size,
      lastEvictionReason: this.lastEvictionReason
    };
  }

  async getOrSetAsync(key: string, ttlMs: number, loaderFn: () => Promise<T>, sizeBytes?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const promise = loaderFn()
      .then((value) => {
        const resolvedSize = sizeBytes ?? this.estimateSize(value);
        this.set(key, value, ttlMs, resolvedSize);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  private estimateSize(value: T): number {
    if (Buffer.isBuffer(value)) return value.length;
    return 1;
  }
}

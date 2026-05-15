/**
 * Simple in-memory cache with TTL.
 * No external dependencies (no Redis needed).
 * Usage:
 *   const cache = new MemoryCache(300_000); // 5 min TTL
 *   const data = await cache.getOrSet('key', async () => expensiveQuery());
 */
export class MemoryCache {
  constructor(ttlMs = 300_000) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async getOrSet(key, factory) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    this.set(key, value);
    return value;
  }

  invalidate(key) {
    if (key) {
      this.store.delete(key);
    } else {
      this.store.clear();
    }
  }
}

// Shared caches for different TTLs
export const megaMenuCache = new MemoryCache(5 * 60 * 1000);   // 5 minutes
export const plansCache = new MemoryCache(10 * 60 * 1000);      // 10 minutes

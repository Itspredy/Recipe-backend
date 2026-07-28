/**
 * Import cache.
 *
 * Recipes are shared content: a viral reel gets imported by thousands of
 * different users. Processing each URL once and replaying the result is what
 * keeps the scraper/AI bill proportional to "unique recipes" instead of "taps",
 * so this is the highest-leverage cost control in the service.
 *
 * Two backends:
 *   • Postgres  — used when DATABASE_URL is set. Survives restarts and is
 *     shared across instances, so a redeploy doesn't throw the savings away.
 *     On Railway this is a one-click add-on.
 *   • Memory    — bounded LRU with TTL. The default. An unbounded Map would
 *     grow until the container OOMs, so entries are capped and evicted.
 *
 * Postgres failures never take the service down: we log once and fall back to
 * the in-memory store.
 */

const TTL_MS = Number(process.env.CACHE_TTL_MS ?? 30 * 24 * 60 * 60 * 1000); // 30 days
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 5_000);

// ── Memory store (always present; also the fallback) ────────────────────────

const memory = new Map(); // key -> { payload, expiresAt }

function memoryGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  // Refresh recency for LRU eviction.
  memory.delete(key);
  memory.set(key, hit);
  return hit.payload;
}

function memorySet(key, payload) {
  memory.delete(key);
  memory.set(key, { payload, expiresAt: Date.now() + TTL_MS });
  while (memory.size > MAX_ENTRIES) {
    // Oldest insertion order == least recently used.
    memory.delete(memory.keys().next().value);
  }
}

// ── Postgres store (optional) ───────────────────────────────────────────────

let pool = null;
let pgReady = false;

async function initPostgres() {
  if (!process.env.DATABASE_URL) return false;

  try {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOL_MAX ?? 5),
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    });
    // A pool-level error handler is required, otherwise a dropped backend
    // connection surfaces as an unhandled 'error' event and kills the process.
    pool.on('error', (err) => console.warn('[cache] postgres pool error:', err.message));

    await pool.query(`
      CREATE TABLE IF NOT EXISTS import_cache (
        url         TEXT PRIMARY KEY,
        payload     JSONB       NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS import_cache_expires_idx ON import_cache (expires_at)');

    pgReady = true;
    console.log('[cache] using postgres');
    return true;
  } catch (err) {
    console.warn('[cache] postgres unavailable, using memory cache:', err.message);
    pool = null;
    pgReady = false;
    return false;
  }
}

/** Call once at boot. Never throws. */
export async function initCache() {
  await initPostgres();
}

export async function cacheGet(key) {
  if (pgReady) {
    try {
      const { rows } = await pool.query(
        'SELECT payload FROM import_cache WHERE url = $1 AND expires_at > now()',
        [key],
      );
      if (rows.length) return rows[0].payload;
      return null;
    } catch (err) {
      console.warn('[cache] postgres read failed:', err.message);
    }
  }
  return memoryGet(key);
}

export async function cacheSet(key, payload) {
  // Always populate memory: it fronts postgres and keeps hot items fast.
  memorySet(key, payload);

  if (pgReady) {
    try {
      await pool.query(
        `INSERT INTO import_cache (url, payload, expires_at)
         VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
         ON CONFLICT (url) DO UPDATE
           SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
        [key, payload, String(TTL_MS)],
      );
    } catch (err) {
      console.warn('[cache] postgres write failed:', err.message);
    }
  }
}

export function cacheStatus() {
  return { backend: pgReady ? 'postgres' : 'memory', memoryEntries: memory.size, maxEntries: MAX_ENTRIES };
}

export async function closeCache() {
  if (pool) await pool.end().catch(() => {});
}

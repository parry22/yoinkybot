import pg from "pg";
import { config } from "../config.js";
import { SUPABASE_ROOT_CA } from "./supabase-ca.js";

/**
 * Two very different consumers share this module, and they need opposite pool
 * shapes — which the old flat `max: 10` got wrong for one of them.
 *
 * The BACKEND is a single long-lived process. Ten connections is right: pg-boss's
 * workers plus the bot plus the crons genuinely want concurrency, and the process
 * holds them for its whole lifetime.
 *
 * The WEB APP is Vercel serverless. Every concurrent function instance builds its
 * OWN pool, so `max: 10` means ten connections *per instance* — a traffic spike
 * that spins up 20 instances asks for 200 connections. Against a managed
 * Postgres's connection ceiling (Supabase free is far below that, and a pooler in
 * transaction mode has its own client limit) this exhausts the server and the
 * failure looks random: most requests fine, some throwing "too many clients", no
 * pattern. Each serverless invocation handles one request and does a handful of
 * sequential queries, so it needs 1-2 connections, not ten.
 *
 * Detected via the runtime rather than a new env var, so it cannot drift out of
 * sync with where the code is actually running. Vercel sets VERCEL=1 on all its
 * runtimes; AWS_LAMBDA_FUNCTION_NAME is the belt-and-braces check.
 */
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * TLS for Supabase.
 *
 * The Supabase pooler serves a chain rooted in Supabase's own CA, which is not
 * in the public trust store. node-postgres treats the `sslmode=require` in the
 * connection string as `verify-full`, so it rejects that chain outright:
 *   Error: self-signed certificate in certificate chain
 * — confirmed against both pooler ports in CI before the cutover, which is the
 * only reason this wasn't a production outage.
 *
 * Pinning the real CA keeps verification ON, including the hostname check. The
 * easy alternatives (`sslmode=no-verify`, `rejectUnauthorized: false`) would
 * encrypt while authenticating nothing, leaving the database credential open to
 * anyone who can get in the path — not a trade worth making for a managed
 * database reached across the public internet.
 *
 * Host-matched rather than applied unconditionally, so a non-Supabase
 * DATABASE_URL (Neon today, local dev, a future move) keeps the public trust
 * store and is unaffected by this.
 */
const isSupabase = /\.supabase\.(co|com)(:|\/|$)/.test(config.DATABASE_URL);

/**
 * Strip `sslmode` from the URL when we're supplying our own TLS config.
 *
 * THIS IS LOAD-BEARING, and the reason the first attempt at CA pinning silently
 * did nothing. `pg` builds its parameters as
 *   Object.assign({}, config, parse(config.connectionString))
 * — the parsed connection string is merged ON TOP of the explicit options, so a
 * `sslmode=require` in the URL overwrites the `ssl` object rather than deferring
 * to it. The CA was simply never consulted, and the failure was identical to
 * having passed no CA at all ("self-signed certificate in certificate chain"),
 * which is exactly what made it look like the wrong cert.
 *
 * Removing the parameter here rather than relying on whoever writes DATABASE_URL
 * to leave it out: the env var is edited by hand across two deploy surfaces, and
 * a re-added `sslmode` would quietly disable verification again.
 */
function withoutSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return url; // unparseable — leave it alone and let pg report the real error
  }
}

/**
 * The connection settings every Postgres client in this codebase must use.
 *
 * Exported because `pg.Pool` is NOT the only consumer: pg-boss (jobs/boss.ts)
 * builds its own connection, and it passed the raw DATABASE_URL — so the moment
 * the URL pointed at Supabase it would have hit the same TLS rejection the pool
 * did, taking every background job down with it while the web app looked fine.
 * One helper means TLS cannot be right in one place and wrong in another.
 */
export function dbConnectionOptions(): { connectionString: string; ssl?: pg.PoolConfig["ssl"] } {
  if (!isSupabase) return { connectionString: config.DATABASE_URL };
  return {
    connectionString: withoutSslMode(config.DATABASE_URL),
    // Full verification (chain + hostname) against Supabase's own root, which
    // the public trust store doesn't carry.
    ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
  };
}

/**
 * THE SESSION-POOLER BUDGET. Supabase's session pooler (port 5432, what the
 * Railway backend uses) allows **15 client connections total**, and exceeding it
 * does not queue — it throws:
 *
 *     error: (EMAXCONNSESSION) max clients reached in session mode
 *            - max clients are limited to pool_size: 15
 *
 * which surfaces as random query failures across unrelated features. It looked
 * like "analytics isn't fetching" because that page runs several queries and any
 * one of them could lose the race for a slot.
 *
 * The backend opens TWO independent pools against that one budget: this one, and
 * pg-boss's (jobs/boss.ts). Neither used to declare a size, so this pool took 10
 * and pg-boss's default took another 10 — 20 against a ceiling of 15. It worked
 * on Neon, which allows far more, and broke the moment we moved.
 *
 * So the 15 is now divided on purpose:
 *   pg-boss   8   (BOSS_POOL_MAX in jobs/boss.ts — it needs the most; 27 workers
 *                  poll plus maintenance)
 *   this pool 4   (request/job query traffic)
 *   spare     3   (boot migrations, a one-off script, a human's psql)
 *
 * Keep the sum under 15. If you raise one, lower the other.
 */
export const APP_POOL_MAX = 4;

export const pool = new pg.Pool({
  ...dbConnectionOptions(),
  max: isServerless ? 2 : APP_POOL_MAX,
  // Serverless instances are frozen between invocations and then discarded. An
  // idle connection held by a frozen instance is a connection the server has
  // reserved for nobody, so let it go quickly.
  //
  // The backend releases idle connections too, which it did not before (0 = never).
  // Against a shared 15-slot pooler, holding connections open while idle is just
  // hoarding slots that boot migrations and pg-boss need — and reconnecting is
  // cheap next to failing.
  idleTimeoutMillis: isServerless ? 10_000 : 30_000,
  // Fail fast rather than hanging a request for the platform's full timeout when
  // the database is unreachable — which is exactly what happened when the Neon
  // compute quota ran out: every page sat waiting instead of erroring cleanly.
  connectionTimeoutMillis: 10_000,
});

// A pooled connection can be killed server-side (pooler recycling, a failover, an
// idle reaper). `pg` emits that on the pool, and an unhandled 'error' event on an
// EventEmitter takes the whole process down — so this listener is what stops a
// routine connection drop from becoming a crash.
pool.on("error", (err) => console.error("pg pool error (connection dropped)", err.message));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/** Serialize a number[] embedding for a pgvector parameter. */
export function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

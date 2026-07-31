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

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  // An explicit `ssl` object takes precedence over the connection string's
  // sslmode, which is what lets us keep verify-full semantics with our own root.
  ...(isSupabase ? { ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true } } : {}),
  max: isServerless ? 2 : 10,
  // Serverless instances are frozen between invocations and then discarded. An
  // idle connection held by a frozen instance is a connection the server has
  // reserved for nobody, so let it go quickly; the long-lived backend keeps its
  // connections warm instead (0 = never time out).
  idleTimeoutMillis: isServerless ? 10_000 : 0,
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

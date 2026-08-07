/** Process-local worker liveness — updated when workers register and periodically. */
let lastWorkerHeartbeat: number | null = null;
let bootedAt = Date.now();

export function markWorkersBooted(): void {
  bootedAt = Date.now();
}

export function touchWorkerHeartbeat(): void {
  lastWorkerHeartbeat = Date.now();
}

export function getWorkerHeartbeatAt(): string | null {
  return lastWorkerHeartbeat ? new Date(lastWorkerHeartbeat).toISOString() : null;
}

export function getWorkerHeartbeatMs(): number | null {
  return lastWorkerHeartbeat;
}

export const WORKER_STALE_MS = 2 * 60 * 1000;
export const WORKER_BOOT_GRACE_MS = 2 * 60 * 1000;
export const QUEUE_DEPTH_ALERT = 500;

export interface QueueDepth {
  created: number;
  retry: number;
  active: number;
  oldestAgeSec: number | null;
}

export interface WorkerHealthInput {
  depth: QueueDepth | null;
  heartbeatAt: number | null;
  now?: number;
  bootedAt?: number;
}

/** Pure evaluation for tests and /health. */
export function evaluateWorkerHealth(input: WorkerHealthInput): { ok: boolean; reason?: string } {
  const now = input.now ?? Date.now();
  const boot = input.bootedAt ?? bootedAt;
  const depth = input.depth;
  const heartbeat = input.heartbeatAt;

  if (depth && depth.created > QUEUE_DEPTH_ALERT) {
    return { ok: false, reason: `queue depth ${depth.created} exceeds ${QUEUE_DEPTH_ALERT}` };
  }

  const pastGrace = now - boot > WORKER_BOOT_GRACE_MS;
  if (pastGrace && heartbeat === null) {
    return { ok: false, reason: "no worker heartbeat registered" };
  }
  if (pastGrace && heartbeat !== null && now - heartbeat > WORKER_STALE_MS) {
    return { ok: false, reason: "worker heartbeat stale" };
  }

  return { ok: true };
}

export interface PgbossJobRow {
  created: string;
  retry: string;
  active: string;
  oldest_age_sec: string | null;
}

/** Map a pg-boss job aggregate row into queue depth stats. */
export function mapQueueDepth(row: PgbossJobRow | null | undefined): QueueDepth | null {
  if (!row) return null;
  return {
    created: Number(row.created) || 0,
    retry: Number(row.retry) || 0,
    active: Number(row.active) || 0,
    oldestAgeSec: row.oldest_age_sec != null ? Number(row.oldest_age_sec) : null,
  };
}

/** Query pg-boss queue depth when the schema exists. Returns null if tables are absent. */
export async function fetchQueueDepth(): Promise<QueueDepth | null> {
  const { queryOne } = await import("../db/pool.js");
  const exists = await queryOne<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'pgboss' AND table_name = 'job'
     ) AS ok`,
  );
  if (!exists?.ok) return null;

  const row = await queryOne<PgbossJobRow>(
    `SELECT
       count(*) FILTER (WHERE state = 'created')::text AS created,
       count(*) FILTER (WHERE state = 'retry')::text AS retry,
       count(*) FILTER (WHERE state = 'active')::text AS active,
       round(extract(epoch FROM (now() - min(created_on) FILTER (WHERE state IN ('created', 'retry')))))::text
         AS oldest_age_sec
     FROM pgboss.job
    WHERE state IN ('created', 'retry', 'active')`,
  ).catch(() => null);

  return mapQueueDepth(row);
}

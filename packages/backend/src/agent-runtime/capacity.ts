import { readFileSync } from "node:fs";
import { config } from "../config.js";

/**
 * Admission control for SDK subprocesses (docs/INTERNAL §3n).
 *
 * WHY: each `query()` spawns a real Claude Code subprocess. Unbounded, a burst of
 * loops would spawn a subprocess per loop and OOM the single Railway instance.
 * `AGENT_MAX_CONCURRENCY` existed as a config flag but nothing enforced it; this
 * is the enforcement, plus a memory check so the cap is grounded in what the
 * container actually has free rather than a guess made at config time.
 *
 * This is what makes the migration work WITHOUT a Railway plan upgrade. Measured
 * on the current plan: the limit is 8 GB / 8 vCPU and the backend idles at
 * ~156 MB (2%). Even at the pessimistic ~1 GiB-per-subprocess estimate, the
 * default concurrency of 2 peaks near 2.2 GB - roughly a quarter of the box. The
 * plan was never the binding constraint; the missing piece was a bound.
 *
 * CONTAINER MEMORY, NOT HOST MEMORY: `os.freemem()` reports the *host's* free
 * memory inside a container, which on a shared host is both wrong and wildly
 * optimistic. The cgroup files are the only honest source, so we read those and
 * treat "cannot determine" as "do not gate on memory" (the concurrency cap still
 * applies) rather than inventing a number.
 */

interface MemorySnapshot {
  /** Container memory limit in bytes, or null when it cannot be determined. */
  limitBytes: number | null;
  /** Current container usage in bytes, or null. */
  usedBytes: number | null;
}

function readFirstNumber(paths: string[]): number | null {
  for (const p of paths) {
    try {
      const raw = readFileSync(p, "utf8").trim();
      if (raw === "max") return null; // cgroup v2 "unlimited"
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** cgroup v2 first, then v1. Values are bytes. */
export function readContainerMemory(): MemorySnapshot {
  const limitBytes = readFirstNumber(["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
  const usedBytes = readFirstNumber([
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ]);
  // cgroup v1 reports a sentinel near 2^63 when unlimited; treat as unknown.
  const sane = limitBytes != null && limitBytes < 2 ** 53 ? limitBytes : null;
  return { limitBytes: sane, usedBytes };
}

const MB = 1024 * 1024;

/**
 * True when there is room for one more subprocess: enough free container memory
 * for the estimated subprocess footprint *plus* the reserve we keep for the
 * Fastify server, pg-boss workers and the bot, which must not be starved.
 */
export function hasMemoryHeadroom(): { ok: boolean; detail: string } {
  const { limitBytes, usedBytes } = readContainerMemory();
  if (limitBytes == null || usedBytes == null) {
    return { ok: true, detail: "cgroup unreadable - gating on concurrency only" };
  }
  const freeMb = (limitBytes - usedBytes) / MB;
  const needMb = config.AGENT_SUBPROCESS_MB + config.AGENT_MEMORY_RESERVE_MB;
  return {
    ok: freeMb >= needMb,
    detail: `free=${Math.round(freeMb)}MB need=${needMb}MB (limit=${Math.round(limitBytes / MB)}MB)`,
  };
}

/** FIFO waiter queue so a burst is serialised rather than rejected. */
const waiters: Array<() => void> = [];
let active = 0;

export function activeSubprocesses(): number {
  return active;
}

/**
 * Acquire a subprocess slot. Resolves once both the concurrency cap and the
 * memory check allow another spawn. Rejects only if the wait exceeds
 * `AGENT_ACQUIRE_TIMEOUT_MS`, which the caller treats as "run this on legacy
 * instead" - a queue that grows without bound would turn memory pressure into
 * silent latency, and for the interactive chat loop that is worse than a
 * downgrade.
 */
export async function acquireSlot(label: string): Promise<() => void> {
  const started = Date.now();
  const timeoutMs = config.AGENT_ACQUIRE_TIMEOUT_MS;

  for (;;) {
    const mem = hasMemoryHeadroom();
    if (active < config.AGENT_MAX_CONCURRENCY && mem.ok) {
      active++;
      let released = false;
      return () => {
        // Idempotent: the adapter releases in a finally, and a double release
        // would corrupt the counter and let concurrency creep upward.
        if (released) return;
        released = true;
        active--;
        const next = waiters.shift();
        if (next) next();
      };
    }

    const waited = Date.now() - started;
    if (waited >= timeoutMs) {
      throw new AgentCapacityError(
        `no SDK slot for ${label} after ${waited}ms (active=${active}/${config.AGENT_MAX_CONCURRENCY}, ${mem.detail})`,
      );
    }

    // Wake on the next release, or re-poll - memory can free up without a
    // release when an unrelated part of the process gives memory back.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(250, timeoutMs - waited));
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Distinguishes "no capacity" from "the loop itself failed" at the callsite. */
export class AgentCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCapacityError";
  }
}

/**
 * Observed container-memory delta across one subprocess, logged so the
 * `AGENT_SUBPROCESS_MB` estimate can be replaced with a measured number instead
 * of the ~1 GiB assumption §3n started from.
 */
export function sampleUsedMb(): number | null {
  const { usedBytes } = readContainerMemory();
  return usedBytes == null ? null : Math.round(usedBytes / MB);
}

import { describe, expect, it } from "vitest";
import {
  evaluateWorkerHealth,
  mapQueueDepth,
  QUEUE_DEPTH_ALERT,
  WORKER_BOOT_GRACE_MS,
  WORKER_STALE_MS,
} from "./health.js";

describe("evaluateWorkerHealth", () => {
  const boot = 1_000_000;
  const now = boot + WORKER_BOOT_GRACE_MS + 1;

  it("passes during boot grace without heartbeat", () => {
    expect(
      evaluateWorkerHealth({
        depth: { created: 0, retry: 0, active: 0, oldestAgeSec: null },
        heartbeatAt: null,
        now: boot + 30_000,
        bootedAt: boot,
      }).ok,
    ).toBe(true);
  });

  it("fails when heartbeat is missing after grace", () => {
    expect(
      evaluateWorkerHealth({
        depth: { created: 0, retry: 0, active: 0, oldestAgeSec: null },
        heartbeatAt: null,
        now,
        bootedAt: boot,
      }),
    ).toEqual({ ok: false, reason: "no worker heartbeat registered" });
  });

  it("fails when heartbeat is stale", () => {
    expect(
      evaluateWorkerHealth({
        depth: { created: 0, retry: 0, active: 0, oldestAgeSec: null },
        heartbeatAt: now - WORKER_STALE_MS - 1,
        now,
        bootedAt: boot,
      }),
    ).toEqual({ ok: false, reason: "worker heartbeat stale" });
  });

  it("fails when created depth exceeds threshold", () => {
    expect(
      evaluateWorkerHealth({
        depth: { created: QUEUE_DEPTH_ALERT + 1, retry: 0, active: 0, oldestAgeSec: 120 },
        heartbeatAt: now,
        now,
        bootedAt: boot,
      }).ok,
    ).toBe(false);
  });

  it("passes with fresh heartbeat and moderate depth", () => {
    expect(
      evaluateWorkerHealth({
        depth: { created: 12, retry: 1, active: 2, oldestAgeSec: 45 },
        heartbeatAt: now - 5_000,
        now,
        bootedAt: boot,
      }).ok,
    ).toBe(true);
  });
});

describe("mapQueueDepth", () => {
  it("parses aggregate row", () => {
    expect(
      mapQueueDepth({ created: "10", retry: "2", active: "1", oldest_age_sec: "90" }),
    ).toEqual({ created: 10, retry: 2, active: 1, oldestAgeSec: 90 });
  });

  it("returns null for missing row", () => {
    expect(mapQueueDepth(null)).toBeNull();
  });
});

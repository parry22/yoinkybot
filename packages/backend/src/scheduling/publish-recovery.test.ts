import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The publishing pipeline's two silent-failure modes, pinned.
 *
 * 1. A post claimed for publishing (pending → publishing) whose run then dies
 *    used to sit at 'publishing' forever — the retry's claim requires 'pending',
 *    so nothing ever touched it again: no post, no error, no notice.
 * 2. A post that failed still burned a monthly slot, so a user whose token had
 *    expired could spend their whole Growth allowance on 401s.
 *
 * Both are database-shaped, so the DB is mocked and the assertions are on the
 * decisions: which rows get requeued, which get given up on, and what the cap
 * query is allowed to count.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  say: vi.fn(),
  send: vi.fn(),
  ensureWriteAuth: vi.fn(),
  markWriteAuthDead: vi.fn(),
  publish: vi.fn(),
  entitlementsFor: vi.fn(),
}));

vi.mock("../db/pool.js", () => ({
  query: (...args: unknown[]) => h.query(...args),
  queryOne: (...args: unknown[]) => h.queryOne(...args),
}));

vi.mock("../telegram/bot.js", () => ({
  dmChannel: () => ({ say: (...args: unknown[]) => h.say(...args), typing: async () => {} }),
}));

vi.mock("../jobs/boss.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jobs/boss.js")>();
  return { ...actual, getBoss: () => ({ send: (...args: unknown[]) => h.send(...args) }) };
});

vi.mock("../social/publish.js", () => ({
  publishConfigured: () => true,
  resolveWriteAuth: async () => null,
  writeAuthState: async () => ({ connected: true, needsReauth: false }),
  ensureWriteAuth: (...args: unknown[]) => h.ensureWriteAuth(...args),
  markWriteAuthDead: (...args: unknown[]) => h.markWriteAuthDead(...args),
  publish: (...args: unknown[]) => h.publish(...args),
}));

vi.mock("../social/media.js", () => ({
  mediaForPost: async () => [],
  uploadMediaFor: async () => ({ ok: true, mediaIds: [] }),
  attachMediaToPost: async () => 0,
}));

vi.mock("../billing/entitlements.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/entitlements.js")>();
  return { ...actual, entitlementsFor: (...args: unknown[]) => h.entitlementsFor(...args) };
});

const { handleScheduledPost, reapStuckPublishing } = await import("../jobs/scheduled-post.js");
const { monthlyScheduledCount, schedulePost, MAX_SCHEDULE_AHEAD_MS } = await import("./service.js");

/** The SQL text of the nth call to the mocked `query`, whitespace-collapsed. */
const sqlOf = (mock: typeof h.query, n = 0): string => String(mock.mock.calls[n]?.[0] ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.query.mockResolvedValue([]);
  h.queryOne.mockResolvedValue(undefined);
  h.send.mockResolvedValue("job-1");
  h.say.mockResolvedValue(undefined);
});

const JOB = { scheduledPostId: "post-1", userId: "user-1" };

describe("handleScheduledPost — claiming", () => {
  it("counts the attempt as part of the atomic claim", async () => {
    await handleScheduledPost(JOB);
    const claim = String(h.queryOne.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
    expect(claim).toContain("status = 'publishing'");
    expect(claim).toContain("publish_attempts = publish_attempts + 1");
    // The guard that makes cancel work — and the reason a dead run stranded the
    // row, which is what the reaper below exists to undo.
    expect(claim).toContain("status = 'pending'");
  });

  it("stops when the claim matches nothing (canceled or already handled)", async () => {
    await handleScheduledPost(JOB);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
  });
});

describe("handleScheduledPost — write auth", () => {
  beforeEach(() => {
    h.queryOne.mockResolvedValue({ platform: "x", content: "hello" });
  });

  it("fails the post and asks for a reconnect when the token can't be renewed", async () => {
    h.ensureWriteAuth.mockResolvedValue({
      ok: false,
      reason: "needs_reauth",
      detail: "X connection expired — reconnect X to publish",
    });
    await handleScheduledPost(JOB);
    expect(sqlOf(h.query)).toContain("status = 'failed'");
    expect(h.query.mock.calls[0]?.[1]).toEqual(["post-1", "X connection expired — reconnect X to publish"]);
    expect(String(h.say.mock.calls[0]?.[0])).toContain("reconnect X");
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("keeps the post retryable when the token endpoint itself was unreachable", async () => {
    h.ensureWriteAuth.mockResolvedValue({
      ok: false,
      reason: "refresh_failed",
      detail: "couldn't renew the X token: fetch failed",
    });
    // Rethrown so pg-boss applies the queue's retry/backoff.
    await expect(handleScheduledPost(JOB)).rejects.toThrow(/couldn't renew/);
    expect(sqlOf(h.query)).toContain("status = 'pending'");
    // A transient outage must not consume the post or nag the user.
    expect(h.say).not.toHaveBeenCalled();
  });

  it("drops the credential when the platform answers 401 mid-publish", async () => {
    h.ensureWriteAuth.mockResolvedValue({ ok: true, auth: { accessToken: "tok", authorUrn: null } });
    h.publish.mockResolvedValue({ ok: false, error: "X API 401: Unauthorized", authExpired: true });
    await handleScheduledPost(JOB);
    expect(h.markWriteAuthDead).toHaveBeenCalledWith("user-1", "x");
    expect(h.query.mock.calls[0]?.[1]?.[1]).toContain("reconnect X");
  });
});

describe("reapStuckPublishing", () => {
  it("only touches rows that have been in 'publishing' past the threshold", async () => {
    await reapStuckPublishing();
    const sql = sqlOf(h.query);
    expect(sql).toContain("WHERE status = 'publishing'");
    expect(sql).toContain("updated_at < now() - make_interval");
    const [minutes, maxAttempts] = h.query.mock.calls[0]?.[1] as [number, number];
    // Must outlast the queue's own expiry (20 min) so a slow-but-alive publish
    // is never reclaimed underneath itself and double-posted.
    expect(minutes).toBeGreaterThan(20);
    expect(maxAttempts).toBeGreaterThan(0);
  });

  it("does nothing when nothing is stuck", async () => {
    await reapStuckPublishing();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
  });

  it("re-sends a pg-boss job for every row it returns to 'pending'", async () => {
    h.query.mockResolvedValue([
      { id: "post-1", user_id: "user-1", status: "pending", platform: "x" },
      { id: "post-2", user_id: "user-2", status: "pending", platform: "linkedin" },
    ]);
    await reapStuckPublishing();
    // Flipping the status alone would strand it again: the job that claimed the
    // row is gone, so nothing would ever fire for it.
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[0]?.[1]).toEqual({ scheduledPostId: "post-1", userId: "user-1" });
    expect(h.say).not.toHaveBeenCalled();
  });

  it("gives up loudly instead of looping when a post is out of attempts", async () => {
    h.query.mockResolvedValue([{ id: "post-1", user_id: "user-1", status: "failed", platform: "x" }]);
    await reapStuckPublishing();
    expect(h.send).not.toHaveBeenCalled();
    expect(String(h.say.mock.calls[0]?.[0])).toContain("stopped retrying");
  });

  it("requeues the recoverable rows even when a sibling row is being given up on", async () => {
    h.query.mockResolvedValue([
      { id: "post-1", user_id: "user-1", status: "failed", platform: "x" },
      { id: "post-2", user_id: "user-2", status: "pending", platform: "x" },
    ]);
    await reapStuckPublishing();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]?.[1]).toEqual({ scheduledPostId: "post-2", userId: "user-2" });
  });
});

describe("monthlyScheduledCount — what a plan slot is spent on", () => {
  it("counts neither canceled nor failed posts", async () => {
    h.queryOne.mockResolvedValue({ n: "4" });
    await expect(monthlyScheduledCount("user-1")).resolves.toBe(4);
    const sql = String(h.queryOne.mock.calls[0]?.[0]).replace(/\s+/g, " ");
    // A failure used to consume a slot. Combined with the missing token refresh
    // that let a Growth user spend all 30 on posts that every one of them 401'd.
    expect(sql).toContain("status NOT IN ('canceled','failed')");
    expect(sql).toContain("created_at >= date_trunc('month', now())");
  });

  it("counts only the current calendar month for this user", async () => {
    h.queryOne.mockResolvedValue({ n: "0" });
    await monthlyScheduledCount("user-1");
    expect(h.queryOne.mock.calls[0]?.[1]).toEqual(["user-1"]);
  });
});

describe("schedulePost — bounds", () => {
  const soon = () => new Date(Date.now() + 60 * 60 * 1000);

  it("refuses a date beyond the ceiling before it touches the plan or the queue", async () => {
    const res = await schedulePost("user-1", {
      platform: "x",
      content: "shipping the thing",
      scheduledFor: new Date("3000-01-02T09:00:00Z"),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/more than a year out/);
    // Nothing was written and no pg-boss row was created — a year-3000 job would
    // have sat in the queue table effectively forever.
    expect(h.query).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.entitlementsFor).not.toHaveBeenCalled();
  });

  it("allows a date just inside the ceiling", async () => {
    h.entitlementsFor.mockResolvedValue({ scheduledPostsPerMonth: 30 });
    h.queryOne.mockResolvedValueOnce({ n: "0" }).mockResolvedValueOnce({ id: "post-9" });
    const res = await schedulePost("user-1", {
      platform: "x",
      content: "shipping the thing",
      scheduledFor: new Date(Date.now() + MAX_SCHEDULE_AHEAD_MS - 60_000),
    });
    expect(res.ok).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("still refuses a time in the past", async () => {
    const res = await schedulePost("user-1", {
      platform: "x",
      content: "shipping the thing",
      scheduledFor: new Date(Date.now() - 10 * 60_000),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/in the past/);
  });

  it("rejects at the cap without inserting anything", async () => {
    h.entitlementsFor.mockResolvedValue({ scheduledPostsPerMonth: 30 });
    h.queryOne.mockResolvedValue({ n: "30" });
    const res = await schedulePost("user-1", {
      platform: "x",
      content: "shipping the thing",
      scheduledFor: soon(),
    });
    expect(res).toMatchObject({ ok: false, capReached: true });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("never blocks an unlimited (Scale) plan", async () => {
    h.entitlementsFor.mockResolvedValue({ scheduledPostsPerMonth: null });
    h.queryOne.mockResolvedValueOnce({ n: "999" }).mockResolvedValueOnce({ id: "post-9" });
    const res = await schedulePost("user-1", {
      platform: "x",
      content: "shipping the thing",
      scheduledFor: soon(),
    });
    expect(res.ok).toBe(true);
  });
});

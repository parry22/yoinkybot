import { InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { publishConfigured } from "../social/publish.js";
import { startConnect } from "../strategist/connect.js";
import { getState, setState } from "../strategist/state.js";
import { sendTelegram } from "./bot.js";
import { mintConnectTicket } from "../lib/connect-tickets.js";
import type { Platform } from "../lib/types.js";

/**
 * OAuth-first connect for onboarding. When the platform app credentials exist,
 * the connect hand-off leads with a real account authorization (tap → approve →
 * done) instead of asking for a handle to scrape:
 *   - X: OAuth proves ownership, `GET /2/users/me` gives the VERIFIED handle +
 *     profile metadata (bio, follower count) — the sanctioned way to identify
 *     the account — and ingestion then runs against that verified handle, so we
 *     only ever read a profile the user has demonstrably consented to. The same
 *     token unlocks posting (scheduled posts) with no second auth later.
 *   - LinkedIn: the open API has NO scope that reads a member's posts
 *     (r_member_social / Community Management is partner-gated — do not request
 *     it), so auth here buys verified identity + posting rights, and the post
 *     history still comes from the profile-URL scrape the user hands us next.
 *
 * Sequence (the product rule): offer X first; once X resolves (connected or
 * skipped), offer LinkedIn. Either may be skipped, but skipping BOTH is refused
 * until at least one account is connected — there is no read without history.
 * A typed @handle / profile URL keeps working everywhere as the fallback (and
 * is the whole flow when no platform app is configured).
 */

const PLATFORM_ORDER: Platform[] = ["x", "linkedin"];
const label = (p: Platform) => (p === "x" ? "X" : "LinkedIn");

/** Auth-connect is possible only when this platform's app credentials exist. */
export function authConnectAvailable(platform: Platform): boolean {
  return publishConfigured(platform);
}

/** Whether ingestion (the history pull) is wired for this platform. */
function ingestConfigured(platform: Platform): boolean {
  return platform === "x" ? !!(config.TWITTERAPI_IO_KEY || config.APIFY_TOKEN) : !!config.APIFY_TOKEN;
}

/**
 * "Connected" for the at-least-one gate: an OAuth token OR a scrape connect in
 * flight/done. A `failed` scrape row without a token doesn't count.
 */
async function isConnected(userId: string, platform: Platform): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM connected_accounts
     WHERE user_id = $1 AND platform = $2
       AND (post_access_token IS NOT NULL OR status IN ('pending','ingesting','ingested'))`,
    [userId, platform],
  );
  return Number(row?.n ?? 0) > 0;
}

async function anyConnected(userId: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM connected_accounts
     WHERE user_id = $1
       AND (post_access_token IS NOT NULL OR status IN ('pending','ingesting','ingested'))`,
    [userId],
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * The consent link. Carries an opaque, short-lived ticket — NOT the user id.
 * `?u=<users.id>` on an unauthenticated route meant anyone who could construct
 * the URL could steer the consent at any account; see lib/connect-tickets.ts.
 * Minted fresh every time the offer is rendered, so the 15-minute window starts
 * when the user actually sees the button.
 */
const authUrl = (userId: string, platform: Platform) =>
  `${config.PUBLIC_URL}/oauth/${platform}/start?t=${mintConnectTicket(userId, platform)}`;

function offerKeyboard(userId: string, platform: Platform, withSkip: boolean): InlineKeyboard {
  const kb = new InlineKeyboard().url(`🔗 connect ${label(platform)}`, authUrl(userId, platform));
  if (withSkip) kb.row().text("skip for now →", `cauth:skip:${platform}`);
  return kb;
}

/**
 * Send an offer message with URL buttons, falling back to plain-text links if
 * Telegram rejects the buttons (it refuses non-HTTPS/localhost button URLs, so
 * a dev instance would otherwise go silent right at the hand-off).
 */
async function sendOffer(userId: string, text: string, kb: InlineKeyboard, plainLinks: string[]): Promise<void> {
  try {
    await sendTelegram(userId, text, undefined, kb);
  } catch (err) {
    console.error("connect-auth: button send failed, falling back to plain links", err);
    await sendTelegram(userId, `${text}\n\n${plainLinks.join("\n")}`).catch(() => {});
  }
}

function offerCopy(platform: Platform, first: boolean): string {
  if (platform === "x") {
    return (
      "one more thing before the read: connect your x properly — tap the button, approve on x, done. " +
      "that verifies it's actually your account (so i read the right person), and it means when we get " +
      "to posting, i can publish drafts for you the moment you say go.\n\n" +
      "rather not? skip it, or just drop your @handle and i'll read it the scrappy way."
    );
  }
  return first
    ? "let's get linkedin in the picture — tap to connect it. that verifies you and unlocks me posting " +
        "there for you later. linkedin doesn't let apps read your posts, so after connecting i'll ask for " +
        "your profile url to do the actual reading.\n\n" +
        "rather not? skip it, or just drop your profile url (linkedin.com/in/you) and i'll read from that."
    : "want linkedin in the picture too? a different register usually lives there — worth having both. " +
        "tap to connect (verifies you + unlocks posting there), then i'll grab your profile url for the read.";
}

/**
 * Offer the auth connect for one platform (marks it offered in connectFlow).
 * `withSkip` controls whether the skip button appears — the at-least-one
 * refusal re-offers without it.
 */
export async function offerAuthConnect(userId: string, platform: Platform, opts: { first?: boolean; withSkip?: boolean } = {}): Promise<void> {
  const st = await getState(userId);
  const flow = st.connectFlow ?? {};
  const offered = flow.offered ?? [];
  if (!offered.includes(platform)) {
    await setState(userId, { ...st, connectFlow: { ...flow, offered: [...offered, platform] } });
  }
  await sendOffer(
    userId,
    offerCopy(platform, opts.first ?? true),
    offerKeyboard(userId, platform, opts.withSkip ?? true),
    [`${label(platform)}: ${authUrl(userId, platform)}`],
  );
}

/**
 * Explicit reconnect: for the `/connect` command with no arg, used by an
 * already-active user, not the automated onboarding hand-off. Unlike
 * `maybeSendConnectAuthOffer`, this does NOT consult `isConnected` — an
 * explicit tap of /connect is unambiguous intent to (re)connect, and the
 * "already connected, don't re-offer" logic exists to avoid pestering someone
 * mid-onboarding, not to hide the button from someone asking for it by name.
 * This also covers the case a scrape-read (`status=ingested`) exists but the
 * POSTING token has gone stale (e.g. the platform app's credentials were
 * rotated) — `isConnected` would wrongly call that "already connected" and
 * never show the button again. Offers every platform with app credentials
 * configured, unconditionally; returns false only when none are configured.
 */
export async function offerReconnect(userId: string): Promise<boolean> {
  const platforms = PLATFORM_ORDER.filter(authConnectAvailable);
  if (platforms.length === 0) return false;
  const kb = new InlineKeyboard();
  for (const p of platforms) kb.url(`🔗 connect ${label(p)}`, authUrl(userId, p)).row();
  const connectWord = platforms.map(label).join(" or ");
  await sendOffer(
    userId,
    `connect ${connectWord} — tap below, approve, done. verifies it's you and unlocks me posting for you. ` +
      `already connected? tapping again just refreshes it, no harm.`,
    kb,
    platforms.map((p) => `${label(p)}: ${authUrl(userId, p)}`),
  );
  return true;
}

/**
 * The connect_transition hook: right after the intake completes, lead with the
 * X auth offer if it's configured and nothing has been offered yet. Returns
 * whether an offer actually went out, so callers can fall back to the plain
 * handle ask. `force` (the /start-resume and /connect paths) sends regardless
 * of phase, prior offers, and prior skips — an explicit ask to connect always
 * gets the buttons back. No-ops (false) when no platform app is configured or
 * everything offerable is already connected.
 */
export async function maybeSendConnectAuthOffer(userId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const st = await getState(userId);
  if (!opts.force) {
    if (st.phase !== "connect_transition") return false;
    if ((st.connectFlow?.offered?.length ?? 0) > 0) return false;
  }
  const next = await nextAuthPlatform(userId, { ignoreSkips: opts.force });
  if (!next) return false;
  await offerAuthConnect(userId, next, { first: true });
  return true;
}

/** The next platform to offer, in X-first order: configured, not connected, not skipped. */
async function nextAuthPlatform(userId: string, opts: { ignoreSkips?: boolean } = {}): Promise<Platform | null> {
  const st = await getState(userId);
  const skipped = opts.ignoreSkips ? [] : (st.connectFlow?.skipped ?? []);
  for (const p of PLATFORM_ORDER) {
    if (!authConnectAvailable(p)) continue;
    if (skipped.includes(p)) continue;
    if (await isConnected(userId, p)) continue;
    return p;
  }
  return null;
}

/**
 * The "skip for now" tap. Skipping one platform moves to the other; skipping
 * the last one with nothing connected is refused — the skipped list resets and
 * both connect buttons come back (typed handle stays an out, and satisfies the
 * gate, since either way we end up with an account to read).
 */
export async function handleAuthSkip(userId: string, platform: Platform): Promise<void> {
  const st = await getState(userId);
  const flow = st.connectFlow ?? {};
  const skipped = flow.skipped ?? [];
  if (!skipped.includes(platform)) {
    await setState(userId, { ...st, connectFlow: { ...flow, skipped: [...skipped, platform] } });
  }

  const next = await nextAuthPlatform(userId);
  if (next) {
    await offerAuthConnect(userId, next, { first: true });
    return;
  }
  if (await anyConnected(userId)) {
    await sendTelegram(
      userId,
      "no problem — i've got enough to work with from what's connected. i'll get reading.",
    ).catch(() => {});
    return;
  }

  // Nothing connected and they've skipped everything offerable: refuse, reset
  // the skips, and put the buttons back. At least one account is non-negotiable.
  const st2 = await getState(userId);
  await setState(userId, { ...st2, awaitingConnect: true, connectFlow: { ...(st2.connectFlow ?? {}), skipped: [] } });
  const platforms = PLATFORM_ORDER.filter(authConnectAvailable);
  const kb = new InlineKeyboard();
  for (const p of platforms) kb.url(`🔗 connect ${label(p)}`, authUrl(userId, p)).row();
  // Name only the platform(s) that actually have a button — a single-platform
  // instance (e.g. X auth configured, LinkedIn not yet) must not promise a
  // LinkedIn button that isn't there.
  const connectWord = platforms.length ? platforms.map(label).join(" or ") : "an account";
  await sendOffer(
    userId,
    "here's the thing — everything i do starts from your actual history. no account, no read, and " +
      "the whole thing runs on the read. you can skip one platform, not both.\n\n" +
      `connect ${connectWord} below, or just drop your @handle / profile url and i'll read it that way.`,
    kb,
    platforms.map((p) => `${label(p)}: ${authUrl(userId, p)}`),
  );
}

/**
 * The typed-link fallback for whichever platform ISN'T auth-configured: fires
 * once, right after the other platform connects (via button or typed handle),
 * during onboarding only. Keeps the "X first, then LinkedIn" promise true even
 * on an instance that only has X app credentials — LinkedIn still gets asked
 * for, just as a plain profile-URL request instead of a connect button.
 * Honors an explicit skip and never repeats (both tracked on connectFlow).
 */
export async function nudgeOtherPlatformTyped(userId: string, justConnected: Platform): Promise<void> {
  const other: Platform = justConnected === "x" ? "linkedin" : "x";
  if (authConnectAvailable(other)) return; // that platform's button flow owns the ask
  const st = await getState(userId);
  if (st.phase !== "profiling" && st.phase !== "connect_transition") return;
  const flow = st.connectFlow ?? {};
  if ((flow.skipped ?? []).includes(other)) return;
  if ((flow.offered ?? []).includes(other)) return;
  if (await isConnected(userId, other)) return;
  await setState(userId, { ...st, connectFlow: { ...flow, offered: [...(flow.offered ?? []), other] } });
  const copy =
    other === "linkedin"
      ? "want linkedin in the picture too? a different register usually lives there, worth having " +
        "both. no button for this one yet, just drop your profile url (linkedin.com/in/you) and i'll read it."
      : "want x in the picture too? drop your @handle and i'll pull that history as well.";
  await sendTelegram(userId, copy).catch(() => {});
}

interface XIdentity {
  id: string;
  username: string;
  name?: string;
  description?: string;
  verified?: boolean;
  followers?: number;
}

/**
 * The one sanctioned read this flow makes with the user token: who is this.
 * `users.read` covers it on every X API tier; we call it once per connect.
 */
async function fetchXIdentity(accessToken: string): Promise<XIdentity | null> {
  try {
    const res = await fetch(
      "https://api.x.com/2/users/me?user.fields=description,public_metrics,verified",
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
    );
    const body = (await res.json().catch(() => ({}))) as {
      data?: { id?: string; username?: string; name?: string; description?: string; verified?: boolean; public_metrics?: { followers_count?: number } };
    };
    if (!res.ok || !body.data?.id || !body.data.username) return null;
    return {
      id: body.data.id,
      username: body.data.username,
      name: body.data.name,
      description: body.data.description,
      verified: body.data.verified,
      followers: body.data.public_metrics?.followers_count,
    };
  } catch (err) {
    console.error("connect-auth: X identity fetch failed", err);
    return null;
  }
}

/**
 * The follow-through after an OAuth callback stored a token (routes/oauth.ts).
 * X: resolve the verified identity, stamp handle + profile metadata on the
 * account row, and kick the history ingest against the verified handle.
 * LinkedIn: no API post-read exists, so ask for the profile URL to scrape.
 * Then, if we're still in the onboarding hand-off, offer the other platform —
 * this is the "LinkedIn after X" leg of the sequence.
 */
export async function afterOAuthConnected(userId: string, platform: Platform, accessToken: string): Promise<void> {
  const st = await getState(userId);
  const inOnboarding = st.phase === "profiling" || st.phase === "connect_transition";

  if (platform === "x") {
    const who = await fetchXIdentity(accessToken);
    if (who) {
      await query(
        `UPDATE connected_accounts
         SET handle = $3,
             meta = meta || $4::jsonb
         WHERE user_id = $1 AND platform = $2`,
        [userId, "x", who.username, JSON.stringify({
          verified_via_oauth: true,
          x_user_id: who.id,
          name: who.name ?? null,
          bio: who.description ?? null,
          followers: who.followers ?? null,
          x_verified: who.verified ?? null,
        })],
      );
      const row = await queryOne<{ status: string }>(
        `SELECT status FROM connected_accounts WHERE user_id = $1 AND platform = 'x'`,
        [userId],
      );
      const alreadyRead = row?.status === "ingested" || row?.status === "ingesting";
      if (!alreadyRead && ingestConfigured("x")) {
        await startConnect(userId, "x", who.username);
        const st2 = await getState(userId);
        if (st2.awaitingConnect) await setState(userId, { ...st2, awaitingConnect: false });
        await sendTelegram(
          userId,
          `that's verified — you're @${who.username} ✅ pulling your x history now, i'll come back once i've actually read it.`,
        ).catch(() => {});
      } else if (alreadyRead) {
        await sendTelegram(userId, `verified — @${who.username} ✅ i've already read your history, so we're set. posting's unlocked too.`).catch(() => {});
      } else {
        await sendTelegram(
          userId,
          `verified — @${who.username} ✅ i can't pull post history on this instance though, so type me a handful of your actual takes and i'll read those.`,
        ).catch(() => {});
      }
    } else {
      // Token stored but identity unavailable (rate limit / tier hiccup):
      // posting is unlocked; fall back to asking for the handle for the read.
      const st2 = await getState(userId);
      await setState(userId, { ...st2, awaitingConnect: true });
      await sendTelegram(
        userId,
        "x is connected ✅ couldn't fetch your handle from x just now though — drop your @handle and i'll read your history from it.",
      ).catch(() => {});
    }
  } else {
    // LinkedIn: auth = verified identity + posting rights. Reading posts isn't
    // in any open LinkedIn scope, so the read still needs their profile URL.
    const st2 = await getState(userId);
    await setState(userId, { ...st2, awaitingConnect: true });
    await sendTelegram(
      userId,
      "linkedin's connected ✅ that verifies you and unlocks me posting there when you say go. " +
        "linkedin doesn't let apps read your posts, so drop your profile url (linkedin.com/in/you) " +
        "and i'll read your history from there.",
    ).catch(() => {});
  }

  // The sequence leg: X landed → offer LinkedIn (or vice versa if they went
  // LinkedIn-first via /connect). Only mid-onboarding, only if not already
  // connected/skipped/offered-and-pending — steady-state reconnects stay quiet.
  // When the other platform has no app credentials configured, there's no
  // button to offer — fall back to the plain typed-link ask so it still gets
  // asked for, just not via OAuth.
  if (inOnboarding) {
    const next = await nextAuthPlatform(userId);
    if (next && next !== platform) {
      await offerAuthConnect(userId, next, { first: platform === "linkedin" && next === "x" });
    } else {
      await nudgeOtherPlatformTyped(userId, platform);
    }
  }
}

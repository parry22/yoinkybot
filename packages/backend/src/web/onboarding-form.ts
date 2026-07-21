/**
 * Structured onboarding for the web: a dropdown/form wizard writes profile
 * fields directly (bypassing the LLM-driven conversational intake the bot
 * uses), so completion is exact rather than parsed. Reused by both the
 * onboarding wizard and the Settings "edit your info" section - same fields,
 * same write path, just a different caller.
 */
import {
  PROFILE_FIELDS,
  type ProfileField,
  type BrandProfile,
  getProfile,
  upsertProfileField,
  confirmPillars,
  finalizeProfile,
} from "../strategist/profile.js";
import { getState, setState, getStage, setStage } from "../strategist/state.js";

export type ProfileFormFields = Partial<Record<ProfileField, string | string[]>>;

function filled(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === "string" && v.trim().length > 0;
}

function toCsvArray(v: string | string[]): string[] {
  if (Array.isArray(v)) return v;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Which of the 7 intake fields are "done" - answered with a real value OR
 * explicitly skipped (present in the `unresolved` ledger, matching the
 * Telegram intake's own definition of captured). Powers the wizard's
 * gamified progress bar and the completion check - a skipped field must
 * count as done, or "skip onboarding" could never finish the profile.
 */
export function profileCompletionFields(p: BrandProfile | null): ProfileField[] {
  const unresolved = new Set(p?.unresolved ?? []);
  return PROFILE_FIELDS.filter((f) => filled(p?.[f as keyof BrandProfile]) || unresolved.has(f));
}

/**
 * Write one or more profile fields directly from a structured form (not a
 * conversational turn). Finalizes the profile and advances to the connect
 * hand-off once every field is filled - mirrors the tail of the session
 * machine's `applyProfileActions` / `skipAllIntake`, minus the LLM round trip.
 */
export async function submitProfileForm(
  userId: string,
  fields: ProfileFormFields,
): Promise<{ profile: BrandProfile | null; complete: boolean }> {
  for (const key of Object.keys(fields) as ProfileField[]) {
    if (!PROFILE_FIELDS.includes(key)) continue;
    const value = fields[key];
    if (value === undefined || !filled(value)) continue;
    if (key === "content_pillars") {
      await confirmPillars(userId, toCsvArray(value));
    } else {
      await upsertProfileField(userId, key, value);
    }
  }

  const profile = await getProfile(userId);
  const complete = await maybeFinalize(userId, profile);
  return { profile, complete };
}

/**
 * Web wizard's "skip this section" / "skip onboarding" - marks the given fields
 * unresolved WITHOUT touching any field the user has already answered (reads
 * actual `brand_profiles` state via `profileCompletionFields`, never the
 * Telegram session's conversational cursor, so it can't clobber real answers
 * regardless of which path filled them). Pass a subset for "skip this section",
 * or all of `PROFILE_FIELDS` for "skip onboarding entirely".
 */
export async function skipProfileFields(
  userId: string,
  fields: ProfileField[],
): Promise<{ profile: BrandProfile | null; complete: boolean }> {
  const before = await getProfile(userId);
  const already = new Set(profileCompletionFields(before));
  for (const f of fields) {
    if (!PROFILE_FIELDS.includes(f) || already.has(f)) continue;
    await upsertProfileField(userId, f, "", { unresolved: true });
  }
  const profile = await getProfile(userId);
  const complete = await maybeFinalize(userId, profile);
  return { profile, complete };
}

async function maybeFinalize(userId: string, profile: BrandProfile | null): Promise<boolean> {
  const complete = profileCompletionFields(profile).length === PROFILE_FIELDS.length;
  if (complete) {
    await finalizeProfile(userId);
    const stage = await getStage(userId);
    if (stage === "new" || stage === "profiling") await setStage(userId, "profile_set");
    const st = await getState(userId);
    if (st.phase !== "connect_transition") {
      await setState(userId, { ...st, phase: "connect_transition", awaitingConnect: true });
    }
  }
  return complete;
}

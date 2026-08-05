import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { findUserByClerkId, findOrCreateUserByClerkId, type User } from "@yoink/backend/web";

/**
 * The signed-in user for the current request, or null. Backed by Clerk: the
 * Clerk session id resolves to (or, on first sight, creates) our Postgres user
 * row via `clerk_user_id`. The signature is unchanged from the old cookie-based
 * version, so every server component / route that calls this keeps working.
 */
export async function getSessionUser(): Promise<User | null> {
  const { userId } = await auth();
  if (!userId) return null;

  // Fast path: an already-mapped account (no Clerk profile fetch needed).
  const existing = await findUserByClerkId(userId);
  if (existing) return existing;

  // First request of a brand-new (or pre-Clerk) account - we need the verified
  // email to link/create the row (and start the trial for a genuine signup).
  const cu = await currentUser();
  const email =
    cu?.primaryEmailAddress?.emailAddress ?? cu?.emailAddresses?.[0]?.emailAddress ?? null;
  return findOrCreateUserByClerkId(userId, email);
}

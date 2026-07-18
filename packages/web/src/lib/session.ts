import "server-only";
import { cookies } from "next/headers";
import { userForSession, type User } from "@yoink/backend/web";

export const SESSION_COOKIE = "yoink_session";

/** The signed-in user for the current request, or null. Validates the session
 *  token against the shared Postgres. */
export async function getSessionUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = await userForSession(token);
  return user ?? null;
}

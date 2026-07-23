import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything under /app requires a signed-in Clerk session. Unauthenticated
// visitors are redirected to the sign-in page (NEXT_PUBLIC_CLERK_SIGN_IN_URL).
// Presence-only replaced the old cookie sniff — Clerk validates the real session.
const isProtected = createRouteMatcher(["/app(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files, but always run for app pages…
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // …API routes, and Clerk's auto-proxy path.
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};

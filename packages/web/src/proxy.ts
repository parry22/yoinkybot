import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything under /app requires a signed-in Clerk session. Unauthenticated
// visitors are redirected to our branded /sign-in explicitly (rather than relying
// on NEXT_PUBLIC_CLERK_SIGN_IN_URL / Clerk's hosted portal), so the redirect is
// deterministic with no extra env config. Clerk still validates the real session.
const isProtected = createRouteMatcher(["/app(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) {
    const { userId } = await auth();
    if (!userId) return NextResponse.redirect(new URL("/sign-in", req.url));
  }
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

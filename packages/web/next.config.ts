import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const webDir = path.dirname(fileURLToPath(import.meta.url));
// Monorepo root — Turbopack otherwise mis-infers from packages/web/src/app and
// fails to resolve next/package.json after a config reload.
const monorepoRoot = path.join(webDir, "../..");

/**
 * CSP for Clerk auth, Next.js, Three.js/R3F (Knowledge canvas), and Vercel Blob
 * media previews. `unsafe-inline` / `unsafe-eval` are required by Clerk + Next
 * hydration; tighten later with nonces if we move to a nonce-based pipeline.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  [
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://clerk.meetyoinky.com",
    "https://challenges.cloudflare.com",
  ].join(" "),
  [
    "connect-src 'self'",
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://api.clerk.com",
    "https://clerk-telemetry.com",
    "https://*.clerk-telemetry.com",
    "https://clerk.meetyoinky.com",
    "https://*.blob.vercel-storage.com",
    "https://blob.vercel-storage.com",
    "wss://*.clerk.accounts.dev",
    "wss://*.clerk.com",
  ].join(" "),
  [
    "img-src 'self' data: blob:",
    "https://*.clerk.com",
    "https://*.clerk.accounts.dev",
    "https://img.clerk.com",
    "https://*.blob.vercel-storage.com",
    "https://blob.vercel-storage.com",
  ].join(" "),
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  [
    "frame-src 'self'",
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://challenges.cloudflare.com",
  ].join(" "),
  "media-src 'self' blob: https://*.blob.vercel-storage.com https://blob.vercel-storage.com",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  // The web app calls @yoink/backend domain functions in-process, so its TS
  // source must be transpiled by Next rather than treated as a prebuilt dep.
  transpilePackages: ["@yoink/backend"],
  // Heavy / native backend deps stay external node requires (never bundled).
  serverExternalPackages: ["pg", "pg-boss", "grammy", "posthog-node", "fastify"],
  turbopack: {
    root: monorepoRoot,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

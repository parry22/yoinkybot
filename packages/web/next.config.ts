import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The web app calls @yoink/backend domain functions in-process, so its TS
  // source must be transpiled by Next rather than treated as a prebuilt dep.
  transpilePackages: ["@yoink/backend"],
  // Heavy / native backend deps stay external node requires (never bundled).
  serverExternalPackages: ["pg", "pg-boss", "grammy", "posthog-node", "fastify"],
};

export default nextConfig;

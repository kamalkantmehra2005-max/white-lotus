import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

/**
 * Incomplete-copy check. GitHub's browser uploader takes at most 100 files per batch, so a project uploaded that way
 * can silently lose folders — and the build would then stop with a cryptic "module not found". This turns that into a
 * clear message naming what is missing.
 */
const REQUIRED = [
  "app/layout.tsx",
  "app/api/web/chat/route.ts",
  "components/web/web-app.tsx",
  "components/ui/primitives.tsx",
  "config/env.ts",
  "lib/database/schema.ts",
  "lib/database/migrations.generated.ts",
  "lib/web/turn.ts",
  "public/manifest.webmanifest",
  "types/modules.d.ts",
  "drizzle/meta/_journal.json",
  "instrumentation.ts",
  "proxy.ts",
  "tsconfig.json",
  "tailwind.config.ts",
  "postcss.config.mjs",
  "package-lock.json",
];
const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(process.cwd(), f)));
if (missing.length) {
  throw new Error(
    [
      "",
      "WHITE-LOTUS: this copy of the project is incomplete. Missing:",
      ...missing.map((f) => `  - ${f}`),
      "",
      "If you uploaded the project to GitHub in the browser: it accepts at most 100 files per upload, so some folders",
      "were left out. Open the unzipped white-lotus folder, drag the missing folders/files onto the repository page",
      "(keep the same folder structure), commit, and deploy again. See docs/ONLINE.md → \"If the build fails\".",
      "",
    ].join("\n"),
  );
}

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  // Content-Security-Policy is set per request with a nonce in proxy.ts (lib/security/csp.ts).
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // PGlite (the embedded local database) loads its WebAssembly files from node_modules at runtime.
  serverExternalPackages: ["pdf-parse", "mammoth", "@electric-sql/pglite"],
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
  // Never ship source maps of server code to the browser.
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Always fetch a fresh service worker so app updates reach installed phones promptly.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default nextConfig;

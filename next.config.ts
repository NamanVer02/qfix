import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
  // Resolve includes from project root so chromium bin is found
  outputFileTracingRoot: path.join(process.cwd()),
  // Include Chromium brotli binaries in serverless bundle (Vercel omits them by default)
  outputFileTracingIncludes: {
    "/api/tailor": [
      "node_modules/@sparticuz/chromium/bin/**",
      "node_modules/@sparticuz/chromium/bin/chromium.br",
      "node_modules/@sparticuz/chromium/bin/fonts.tar.br",
      "node_modules/@sparticuz/chromium/bin/swiftshader.tar.br",
    ],
    "/api/**": [
      "node_modules/@sparticuz/chromium/bin/**",
    ],
  },
};

export default nextConfig;

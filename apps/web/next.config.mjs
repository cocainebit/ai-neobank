import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const apiUrl = process.env.RELAY_API_URL ?? "http://127.0.0.1:8720";

const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // Pin the workspace root; a stray lockfile higher up would otherwise be picked.
  outputFileTracingRoot: workspaceRoot,
  // The browser talks to the API through this origin, so the session cookie is first-party.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiUrl}/:path*` }
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] }
    ];
  }
};

export default nextConfig;

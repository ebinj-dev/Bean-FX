import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* Type errors fail the build — the app code is type-clean and must stay so. */
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;

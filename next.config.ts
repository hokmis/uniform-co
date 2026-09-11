import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: {
    "/api/system-guide": ["./docs/system-guide/*.md"],
  },
};

export default nextConfig;

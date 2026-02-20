import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/generate": ["assets/fonts/gothampro/*.ttf"]
  }
};

export default nextConfig;

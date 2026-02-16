import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    outputFileTracingIncludes: {
      "/api/generate": ["assets/fonts/gothampro/*.ttf"]
    }
  } as unknown as NextConfig["experimental"]
};

export default nextConfig;

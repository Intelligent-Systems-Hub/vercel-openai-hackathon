import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The replay layer reads recorded fixtures from disk at request time; make
  // sure every server route's trace carries them to the deployment.
  outputFileTracingIncludes: {
    "/api/**": ["./fixtures/**/*"],
  },
};

export default nextConfig;

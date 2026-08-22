import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pino"],
};

export default nextConfig;

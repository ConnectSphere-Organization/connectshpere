import type { NextConfig } from "next";
import dotenv from "dotenv";
import type { DotenvConfigOptions } from "dotenv";

dotenv.config({ quiet: true } as DotenvConfigOptions);

const normalizeAllowedDevOrigin = (origin: string): string | undefined => {
  const trimmed = origin.trim();
  if (!trimmed || trimmed === "*" || trimmed === "**") {
    return undefined;
  }

  try {
    const url = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    return new URL(url).origin;
  } catch {
    return trimmed;
  }
};

const isString = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0;

const allowedDevOriginsSource = process.env.ALLOWED_DEV_ORIGINS || process.env.ALLOWED_ORIGINS;

let allowedDevOrigins: string[] = ['10.166.85.53', 'localhost:3000', '127.0.0.1:3000'];
if (allowedDevOriginsSource) {
  const parsed = allowedDevOriginsSource
    .split(",")
    .map(normalizeAllowedDevOrigin)
    .filter(isString);
  allowedDevOrigins = [...allowedDevOrigins, ...parsed];
}

const nextConfig: NextConfig = {
  reactCompiler: false,
  allowedDevOrigins,
  experimental: {
    webpackMemoryOptimizations: true,
    optimizePackageImports: [
      "lucide-react",
      "recharts",
      "@base-ui/react",
      "framer-motion",
      "@xyflow/react",
      "date-fns"
    ]
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_API_URL || 'http://localhost:5001';
    return [
      // WebSocket Gateway routes
      {
        source: '/socket.io/:path*',
        destination: `${backendUrl}/socket.io/:path*`,
      },
      {
        source: '/socket.io',
        destination: `${backendUrl}/socket.io`,
      },
      // API v1 routes
      {
        source: '/api/v1/automation/:path*',
        destination: `${backendUrl}/api/v1/automation/:path*`,
      },
      {
        source: '/api/v1/campaign/:path*',
        destination: `${backendUrl}/api/v1/campaign/:path*`,
      },
      {
        source: '/api/v1/whatsapp-forms/:path*',
        destination: `${backendUrl}/api/v1/automation/engine/whatsapp-forms/:path*`,
      },
      {
        source: '/api/v1/whatsapp-forms',
        destination: `${backendUrl}/api/v1/automation/engine/whatsapp-forms`,
      },
      {
        source: '/api/v1/campaigns/:path*',
        destination: `${backendUrl}/api/v1/campaign/campaigns/:path*`,
      },
      {
        source: '/api/v1/campaigns',
        destination: `${backendUrl}/api/v1/campaign/campaigns`,
      },
      {
        source: '/api/v1/segments/:path*',
        destination: `${backendUrl}/api/v1/campaign/segments/:path*`,
      },
      {
        source: '/api/v1/segments',
        destination: `${backendUrl}/api/v1/campaign/segments`,
      },
      {
        source: '/api/v1/workspace/:path*',
        destination: `${backendUrl}/api/v1/workspace/:path*`,
      },
      {
        source: '/api/v1/billing/:path*',
        destination: `${backendUrl}/api/v1/billing/:path*`,
      },
      {
        source: '/api/v1/admin/:path*',
        destination: `${backendUrl}/api/v1/super-admin/:path*`,
      },
      {
        source: '/api/v1/:path*',
        destination: `${backendUrl}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;

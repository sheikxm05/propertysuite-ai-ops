import type { NextConfig } from 'next';

/**
 * Secrets stay server-side. Only NEXT_PUBLIC_* may reach the browser, and the
 * client-bundle scan in CI asserts that no service-role or provider key string appears
 * in .next/static.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  typescript: {
    // Never ship with type errors. CI runs `npm run typecheck` separately too.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },

  // pdf-parse is CommonJS and must not be bundled into the edge/server graph.
  serverExternalPackages: ['pdf-parse'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;

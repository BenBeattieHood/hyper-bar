import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

const nextConfig = (phase: string): NextConfig => ({
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
  reactStrictMode: true,
  transpilePackages: ['@hyper/ui', 'hyper-sidebar'],
  async rewrites() {
    return [
      { source: '/_favicon', destination: '/api/favicon' },
      { source: '/_favicon/', destination: '/api/favicon' },
    ];
  },
});

export default nextConfig;

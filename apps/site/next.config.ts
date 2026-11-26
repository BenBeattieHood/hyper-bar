import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

const nextConfig = (phase: string): NextConfig => ({
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
  reactStrictMode: true,
  transpilePackages: ['@hyper/ui', 'hyper-sidebar'],
  output: 'export',
  trailingSlash: true,
});

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath: (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, ''),
  images: {
    unoptimized: true,
  },
  webpack(config, { isServer }) {
    // Emscripten's Node-only module import must not pull Node APIs into the browser.
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, module: false };
    return config;
  },
};

export default nextConfig;

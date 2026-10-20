import type { NextConfig } from 'next'

/**
 * ENGINE_URL = base URL of the skilllane-monitoring engine (default http://localhost:5100).
 * Server code calls it directly (lib/engine.ts, read at request time); the browser
 * goes through /engine/* → ${ENGINE_URL}/api/* (rewrites are fixed at build time).
 */
const ENGINE_URL = (process.env.ENGINE_URL || 'http://localhost:5100').replace(/\/+$/, '')

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `/` → `/overview` as a real 307 (the query string is passed on).
  async redirects() {
    return [{ source: '/', destination: '/overview', permanent: false }]
  },
  async rewrites() {
    return [{ source: '/engine/:path*', destination: `${ENGINE_URL}/api/:path*` }]
  },
  async headers() {
    // The data dictionary is Thai Markdown: show it as UTF-8 text instead of a download.
    return [{ source: '/DATA-DICTIONARY.md', headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }] }]
  },
}

export default nextConfig

/* eslint-disable @typescript-eslint/no-require-imports */
/** @type {import('next').NextConfig} */

const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
})

const nextConfig = {
  output: 'standalone',
  basePath: process.env.BASE_PATH,
  images: {
    unoptimized: true,
  },
  experimental: {
    esmExternals: true,
    reactCompiler: true,
  },
  turbopack: {
    rules: {
      // Configure any specific rules for your project here
    },
  },
}

module.exports = process.env.ANALYZE === 'true' ? withBundleAnalyzer(nextConfig) : nextConfig

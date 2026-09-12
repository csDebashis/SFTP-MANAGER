const backend = process.env.BACKEND_INTERNAL_URL || "http://127.0.0.1:8000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // File content crosses this proxy only as bounded raw chunks (8 MiB maximum).
    proxyClientMaxBodySize: process.env.UPLOAD_PROXY_MAX_BODY_SIZE || "8mb",
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;

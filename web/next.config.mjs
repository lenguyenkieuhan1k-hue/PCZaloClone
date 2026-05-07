/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Tránh mismatch hydration khi server và client render thời gian khác nhau.
  experimental: {
    typedRoutes: false
  }
}
export default nextConfig

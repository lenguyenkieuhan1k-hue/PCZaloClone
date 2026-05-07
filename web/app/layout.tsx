import type { Metadata } from 'next'
import './globals.css'
import Link from 'next/link'
import { getSessionUser } from '@/lib/auth-helpers'

export const metadata: Metadata = {
  title: 'ZaloMask — Đa tài khoản Zalo PC',
  description: 'Quản lý nhiều tài khoản Zalo.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://zalomask.com')
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser()

  return (
    <html lang="vi">
      <body className="font-sans min-h-screen flex flex-col">
        <header className="border-b border-gray-200">
          <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-9 h-9 rounded-xl bg-brand grid place-items-center text-white font-bold">Z</div>
              <span className="font-semibold text-lg">ZaloMask</span>
            </Link>
            <nav className="flex items-center gap-6 text-sm">
              <Link href="/pricing" className="hover:text-brand">Bảng giá</Link>
              <Link href="/dashboard" className="hover:text-brand">Tài khoản</Link>
              <a href="https://zalo.me/0981897779" target="_blank" rel="noreferrer" className="hover:text-brand">Liên hệ</a>
              {!user ? (
                <Link href="/auth/sign-in" className="px-4 py-2 rounded-lg bg-brand text-white hover:bg-brand-dark">Đăng nhập</Link>
              ) : (
                <div className="flex items-center gap-3 ml-2 pl-6 border-l border-gray-300">
                  <span className="text-xs text-gray-600">{user.email}</span>
                  <LogoutButton />
                </div>
              )}
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-gray-200 mt-16">
          <div className="max-w-6xl mx-auto px-6 py-8 text-sm text-gray-500 flex flex-col md:flex-row gap-4 justify-between">
            <p>© {new Date().getFullYear()} ZaloMask. Mọi quyền được bảo lưu.</p>
            <div className="flex gap-6">
              <a href="https://zalo.me/0981897779" target="_blank" rel="noreferrer">Zalo: 0981897779</a>
              <a href="https://t.me/zalomask" target="_blank" rel="noreferrer">Telegram: @zalomask</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  )
}

function LogoutButton() {
  return (
    <form action={async () => {
      'use server'
      const { cookies } = await import('next/headers')
      const cookieStore = cookies()
      cookieStore.delete('sb-access-token')
      cookieStore.delete('sb-refresh-token')
    }}>
      <button type="submit" className="text-xs text-red-600 hover:text-red-700">Đăng xuất</button>
    </form>
  )
}

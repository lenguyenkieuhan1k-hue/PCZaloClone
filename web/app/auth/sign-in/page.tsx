'use client'
import { useState } from 'react'
import { browserClient } from '@/lib/supabase'

export default function SignInPage() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleGoogle() {
    setBusy(true); setError('')
    try {
      const supabase = browserClient()
      const redirectTo = `${process.env.NEXT_PUBLIC_SITE_URL || window.location.origin}/auth/callback`
      const { error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo }
      })
      if (oauthErr) setError(oauthErr.message)
    } catch (e: any) {
      setError(e?.message || 'Lỗi đăng nhập')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-md mx-auto px-6 py-20">
      <h1 className="text-3xl font-bold text-center">Đăng nhập ZaloMask</h1>
      <p className="mt-3 text-center text-gray-600">Quản lý license, thiết bị active, gia hạn key.</p>

      <button
        onClick={handleGoogle}
        disabled={busy}
        className="mt-10 w-full px-4 py-3 rounded-lg border-2 border-gray-200 hover:border-brand transition flex items-center justify-center gap-3 disabled:opacity-50"
      >
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
          <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.2 6.5 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.6 19 12 24 12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.2 6.5 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/>
          <path fill="#4CAF50" d="M24 44c5.3 0 10-2 13.4-5.3l-6.2-5.1c-2 1.4-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.1 4.1-3.9 5.5l6.2 5.1C41 35.7 44 30.3 44 24c0-1.3-.1-2.4-.4-3.5z"/>
        </svg>
        <span className="font-medium">{busy ? 'Đang chuyển...' : 'Tiếp tục với Google'}</span>
      </button>

      {error && <p className="mt-4 text-sm text-red-600 text-center">{error}</p>}

      <p className="mt-12 text-xs text-center text-gray-500">
        Đăng nhập đồng nghĩa bạn đồng ý với <a href="/terms" className="underline">Điều khoản</a> và <a href="/privacy" className="underline">Chính sách bảo mật</a>.
      </p>
    </div>
  )
}

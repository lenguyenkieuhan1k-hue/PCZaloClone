'use client'
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { browserClient } from '@/lib/supabase'

/* OAuth callback — handles both PKCE (?code=...) and implicit (#access_token=...) flows. */
export default function CallbackPage() {
  const router = useRouter()
  const params = useSearchParams()
  const [status, setStatus] = useState('Đang xác thực...')

  useEffect(() => {
    const supabase = browserClient()

    function applySession(session: { access_token: string; refresh_token: string; expires_in?: number }) {
      const maxAge = session.expires_in ?? 3600
      document.cookie = `sb-access-token=${session.access_token}; path=/; max-age=${maxAge}; samesite=lax`
      document.cookie = `sb-refresh-token=${session.refresh_token}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`
      setStatus('Đăng nhập thành công, đang chuyển hướng...')
      router.replace('/dashboard')
    }

    const code = params.get('code')

    if (code) {
      // PKCE flow — exchange code for session
      supabase.auth.exchangeCodeForSession(code).then(({ data, error }) => {
        if (error || !data.session) {
          console.error('exchangeCodeForSession error:', error)
          router.replace('/auth/sign-in?error=exchange-failed')
          return
        }
        applySession(data.session)
      })
      return
    }

    // Implicit flow — Supabase JS auto-processes the hash fragment.
    // onAuthStateChange fires SIGNED_IN when it detects #access_token in hash.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        applySession(session)
      }
    })

    // Also check if session already exists (e.g. page refresh after sign-in)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) applySession(session)
    })

    // Timeout fallback — if nothing fires within 5s, something went wrong
    const timeout = setTimeout(() => {
      router.replace('/auth/sign-in?error=timeout')
    }, 5000)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [params, router])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-gray-500 text-sm">{status}</p>
    </div>
  )
}

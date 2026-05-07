'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type PaymentStatus = 'idle' | 'pending' | 'paid' | 'failed' | 'error' | 'timeout'

const POLL_INTERVAL_MS = 6000
const MAX_WAIT_MS = 10 * 60 * 1000           // 10 phút trước khi đề nghị support

interface ApiResponse {
  ok?: boolean
  status?: 'pending' | 'paid' | 'failed' | 'unauthorized'
  matched?: boolean
  licenseId?: string | null
}

export default function PaymentWatcher({ memo }: { memo: string }) {
  const router = useRouter()
  const [status, setStatus] = useState<PaymentStatus>('idle')
  const [errorDetail, setErrorDetail] = useState('')
  const [remainingMs, setRemainingMs] = useState(MAX_WAIT_MS)
  const startedAtRef = useRef<number>(Date.now())
  const query = useMemo(() => encodeURIComponent(memo), [memo])

  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setRemainingMs(Math.max(0, MAX_WAIT_MS - elapsed))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function pollOnce() {
      try {
        console.error(`[PAYMENT-WATCHER] Poll #${Math.floor((Date.now() - startedAtRef.current) / POLL_INTERVAL_MS)} at ${new Date().toISOString()}, memo="${memo}"`)
        const rs = await fetch(`/api/payment-status?memo=${query}`, { cache: 'no-store' })
        if (!rs.ok) {
          console.error(`[PAYMENT-WATCHER] HTTP ${rs.status}`)
          if (disposed) return
          setStatus('error')
          setErrorDetail(`HTTP ${rs.status}`)
          schedule()
          return
        }
        const data: ApiResponse = await rs.json()
        console.error(`[PAYMENT-WATCHER] Response:`, JSON.stringify(data))
        if (disposed) return

        if (data.status === 'paid') {
          console.error(`[PAYMENT-WATCHER] SUCCESS! status='paid', redirecting to /dashboard`)
          setStatus('paid')
          const url = data.licenseId
            ? `/dashboard?paid=${encodeURIComponent(data.licenseId)}`
            : '/dashboard?msg=' + encodeURIComponent('Thanh toán thành công, key đã được cấp.')
          router.replace(url)
          return
        }
        if (data.status === 'failed') {
          console.error(`[PAYMENT-WATCHER] Payment failed`)
          setStatus('failed')
          schedule()
          return
        }
        console.error(`[PAYMENT-WATCHER] Still pending, scheduling next poll...`)
        // pending / unauthorized / unknown
        const elapsed = Date.now() - startedAtRef.current
        if (elapsed > MAX_WAIT_MS) {
          console.error(`[PAYMENT-WATCHER] TIMEOUT after ${elapsed}ms`)
          setStatus('timeout')
          // stop polling — user can refresh manually
          return
        }
        setStatus('pending')
        schedule()
      } catch (error) {
        console.error(`[PAYMENT-WATCHER] Error:`, error)
        if (disposed) return
        setStatus('error')
        setErrorDetail(error instanceof Error ? error.message : 'unknown')
        schedule()
      }
    }

    function schedule() {
      if (disposed) return
      timer = setTimeout(pollOnce, POLL_INTERVAL_MS)
    }

    pollOnce()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [query, router])

  if (status === 'paid') {
    return (
      <p className="mt-4 text-sm text-green-700 font-medium">
        ✅ Đã xác nhận thanh toán — đang chuyển sang trang Tài khoản...
      </p>
    )
  }
  if (status === 'failed') {
    return (
      <p className="mt-4 text-sm text-red-600">
        ⚠ Giao dịch đã ghi nhận nhưng số tiền chưa khớp với gói. Vui lòng inbox{' '}
        <a href="https://zalo.me/0981897779" className="underline font-medium">Zalo 0981897779</a> để được xử lý.
      </p>
    )
  }
  if (status === 'timeout') {
    return (
      <div className="mt-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p className="font-medium">⏳ Đã chờ hơn 10 phút mà chưa nhận được xác nhận.</p>
        <p className="mt-2">Nếu bạn vừa chuyển khoản, hệ thống sẽ tự cập nhật trong vài phút nữa — refresh trang này để kiểm tra.</p>
        <p className="mt-2">Nếu cần xử lý gấp, inbox{' '}
          <a href="https://zalo.me/0981897779" className="underline font-medium">Zalo 0981897779</a> kèm ảnh chụp giao dịch + nội dung CK.
        </p>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <p className="mt-4 text-sm text-amber-700">
        Đang chờ hệ thống xác nhận thanh toán... ({errorDetail || 'tạm thời mất kết nối'})
      </p>
    )
  }

  const totalSec = Math.ceil(remainingMs / 1000)
  const mm = Math.floor(totalSec / 60).toString().padStart(2, '0')
  const ss = Math.max(0, totalSec % 60).toString().padStart(2, '0')

  return (
    <div className="mt-4 text-sm text-gray-600">
      <p>
        Đang tự động kiểm tra thanh toán mỗi {POLL_INTERVAL_MS / 1000} giây. Trang sẽ tự
        chuyển sang Tài khoản ngay khi giao dịch được xác nhận.
      </p>
      <p className="mt-2 font-medium text-blue-700">
        Thời gian giữ phiên thanh toán: {mm}:{ss}
      </p>
    </div>
  )
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

type PaymentStatus = 'idle' | 'pending' | 'paid' | 'failed' | 'error'

export default function PaymentWatcher({ memo }: { memo: string }) {
  const router = useRouter()
  const [status, setStatus] = useState<PaymentStatus>('idle')
  const query = useMemo(() => encodeURIComponent(memo), [memo])

  useEffect(() => {
    let disposed = false

    async function checkOnce() {
      try {
        const rs = await fetch(`/api/payment-status?memo=${query}`, { cache: 'no-store' })
        if (!rs.ok) {
          if (!disposed) setStatus('error')
          return
        }
        const data = await rs.json()
        const next = (data?.status || 'pending') as PaymentStatus
        if (disposed) return
        setStatus(next)
        if (next === 'paid') {
          router.replace('/dashboard?msg=Thanh toán thành công, key đã được cấp.')
        }
      } catch (_) {
        if (!disposed) setStatus('error')
      }
    }

    checkOnce()
    const timer = setInterval(checkOnce, 8000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [query, router])

  if (status === 'paid') {
    return <p className="mt-4 text-sm text-green-700">Đã xác nhận thanh toán, đang chuyển hướng...</p>
  }
  if (status === 'failed') {
    return <p className="mt-4 text-sm text-red-600">Giao dịch đã được ghi nhận nhưng chưa đủ số tiền theo gói. Vui lòng liên hệ hỗ trợ.</p>
  }
  if (status === 'error') {
    return <p className="mt-4 text-sm text-amber-700">Đang chờ hệ thống xác nhận thanh toán...</p>
  }
  return <p className="mt-4 text-sm text-gray-600">Đang tự động kiểm tra thanh toán mỗi vài giây...</p>
}

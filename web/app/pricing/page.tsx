import Link from 'next/link'
import { PLAN_TIERS, DURATION_LABEL, formatVnd, type Duration } from '@/lib/plans'

export const metadata = { title: 'Bảng giá — ZaloMask' }

const DURATIONS: Duration[] = ['1m', '3m', '6m', '1y']

export default function PricingPage() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <h1 className="text-4xl font-bold">Bảng giá</h1>
      <p className="mt-3 text-gray-600 max-w-2xl">
        Chọn gói theo số tài khoản Zalo bạn cần chạy đồng thời. Mua xong nhận key qua email,
        nhập vào app là dùng. Chưa kích hoạt key vẫn dùng được theo gói miễn phí (1 tài khoản).
        Không giới hạn thiết bị xoay vòng — chỉ giới hạn 1 máy active tại một thời điểm.
      </p>

      <div className="mt-10 space-y-6">
        {PLAN_TIERS.map(tier => (
          <div key={tier.id} id={tier.id} className="border border-gray-200 rounded-xl p-6 hover:border-brand transition">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold">{tier.label}</h2>
                <p className="text-gray-500 text-sm mt-1">Chạy tối đa {tier.accountQuota} tài khoản Zalo cùng lúc trên 1 máy.</p>
              </div>
            </div>
            {tier.id === 'tier-1' ? (
              <div className="mt-6">
                <Link
                  href="/api/claim-free"
                  className="inline-flex items-center justify-center border border-green-300 bg-green-50 text-green-700 rounded-lg px-5 py-3 hover:bg-green-100 transition"
                >
                  Nhận key miễn phí
                </Link>
              </div>
            ) : (
              <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {DURATIONS.map(d => (
                  <Link
                    key={d}
                    href={`/checkout/${tier.id}?d=${d}`}
                    className="block border border-gray-200 rounded-lg p-4 hover:border-brand hover:bg-blue-50 transition"
                  >
                    <div className="text-sm text-gray-500">{DURATION_LABEL[d]}</div>
                    <div className="mt-1 text-2xl font-bold text-brand">{formatVnd(tier.prices[d])}</div>
                    <div className="mt-2 text-xs text-gray-500">Mua →</div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

    </div>
  )
}

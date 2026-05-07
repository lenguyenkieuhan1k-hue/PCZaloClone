import Link from 'next/link'
import { PLAN_TIERS, DURATION_LABEL, formatVnd } from '@/lib/plans'

export default function HomePage() {
  const releaseUrl = process.env.NEXT_PUBLIC_RELEASE_URL || '/pricing'

  return (
    <div className="max-w-6xl mx-auto px-6">
      {/* Hero */}
      <section className="py-20 grid md:grid-cols-2 gap-10 items-center">
        <div>
          <h1 className="text-4xl md:text-5xl font-bold leading-tight">
            Chạy nhiều tài khoản Zalo <span className="text-brand">cùng lúc</span> trên một máy.
          </h1>
          <p className="mt-6 text-lg text-gray-600 leading-relaxed">
            ZaloMask cô lập từng tài khoản, sao lưu / khôi phục session đa máy không cần quét QR,
            ẩn trạng thái online — phù hợp cho quản lý fanpage, sales, CSKH chạy nhiều account.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/pricing" className="px-6 py-3 rounded-lg bg-brand text-white font-medium hover:bg-brand-dark">
              Xem bảng giá
            </Link>
            <a href={releaseUrl}
               className="px-6 py-3 rounded-lg border border-gray-300 hover:border-brand hover:text-brand font-medium">
              Tải bản mới nhất
            </a>
          </div>
        </div>
        <div className="bg-gradient-to-br from-blue-50 to-blue-100 rounded-2xl p-8 border border-blue-200">
          <div className="bg-white rounded-xl shadow-lg p-6">
            <div className="flex items-center gap-3 pb-4 border-b">
              <div className="w-10 h-10 rounded-lg bg-brand grid place-items-center text-white font-bold">Z</div>
              <div>
                <div className="font-semibold">ZaloMask</div>
                <div className="text-xs text-gray-500">v26.3.x · Windows</div>
              </div>
            </div>
            <ul className="mt-4 space-y-3 text-sm">
              <li className="flex items-start gap-2"><span className="text-green-500 mt-0.5">✓</span> Có gói miễn phí 1 Zalo và các gói 6 / 15 / 25 / 50 / 100</li>
              <li className="flex items-start gap-2"><span className="text-green-500 mt-0.5">✓</span> Sao lưu &amp; khôi phục session đa máy không quét QR</li>
              <li className="flex items-start gap-2"><span className="text-green-500 mt-0.5">✓</span> Proxy riêng cho mỗi tài khoản (HTTP / SOCKS5)</li>
              <li className="flex items-start gap-2"><span className="text-green-500 mt-0.5">✓</span> Ẩn đang soạn / đã xem / đã nhận</li>
              <li className="flex items-start gap-2"><span className="text-green-500 mt-0.5">✓</span> Tự động cập nhật trong app</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Pricing preview */}
      <section className="py-16 border-t">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold">Bảng giá đơn giản</h2>
          <p className="mt-3 text-gray-600">Một license chỉ active trên một máy tại một thời điểm. Đăng nhập máy mới = tự kick máy cũ.</p>
        </div>
        <div className="mt-10 grid md:grid-cols-3 lg:grid-cols-5 gap-4">
          {PLAN_TIERS.map(tier => (
            <div key={tier.id} className="border border-gray-200 rounded-xl p-5 hover:border-brand transition">
              <div className="text-sm text-gray-500">{tier.label}</div>
              <div className="text-3xl font-bold mt-2">{tier.accountQuota}<span className="text-sm font-normal text-gray-500"> Zalo</span></div>
              <div className="mt-4 space-y-1 text-sm">
                {(['1m', '3m', '6m', '1y'] as const).map(d => (
                  <div key={d} className="flex justify-between">
                    <span className="text-gray-500">{DURATION_LABEL[d]}</span>
                    <span className="font-medium">{formatVnd(tier.prices[d])}</span>
                  </div>
                ))}
              </div>
              {tier.id === 'tier-1' ? (
                <Link href="/api/claim-free" className="mt-4 inline-block text-sm text-green-700 hover:underline">
                  Nhận miễn phí →
                </Link>
              ) : (
                <Link href={`/pricing#${tier.id}`} className="mt-4 inline-block text-sm text-brand hover:underline">
                  Mua →
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 text-center">
        <h2 className="text-2xl font-bold">Cần hỗ trợ trước khi mua?</h2>
        <p className="mt-3 text-gray-600">Inbox Zalo / Telegram, mình rep trong giờ làm việc.</p>
        <div className="mt-6 flex justify-center gap-3 flex-wrap">
          <a href="https://zalo.me/0981897779" target="_blank" rel="noreferrer"
             className="px-6 py-3 rounded-lg border border-gray-300 hover:border-brand">Zalo: 0981897779</a>
          <a href="https://t.me/zalomask" target="_blank" rel="noreferrer"
             className="px-6 py-3 rounded-lg border border-gray-300 hover:border-brand">Telegram: @zalomask</a>
        </div>
      </section>
    </div>
  )
}

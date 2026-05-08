import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth-helpers'
import { findPlan, formatVnd, DURATION_LABEL, type Duration } from '@/lib/plans'
import PaymentWatcher from './PaymentWatcher'

export const metadata = { title: 'Thanh toán — ZaloMask' }

interface PageProps {
  params: { plan: string }
  searchParams: { d?: string }
}

function envOrEmpty(value: string | undefined): string {
  const v = String(value || '').trim()
  return !v || v.startsWith('PLACEHOLDER_') ? '' : v
}

export default async function CheckoutPage({ params, searchParams }: PageProps) {
  const user = await getSessionUser()
  if (!user) redirect(`/auth/sign-in?next=${encodeURIComponent(`/checkout/${params.plan}?d=${searchParams.d || ''}`)}`)

  const duration = (searchParams.d as Duration) || '1m'
  const plan = findPlan(params.plan, duration)
  if (!plan) {
    return <div className="max-w-2xl mx-auto px-6 py-20 text-center text-gray-600">Gói không hợp lệ.</div>
  }

  if (plan.price <= 0 || plan.tier.id === 'tier-1') {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold">Nhận gói miễn phí</h1>
        <p className="mt-2 text-gray-600 text-sm">
          Gói này cho phép <strong>1 tài khoản Zalo</strong>. Bấm nút bên dưới để hệ thống cấp key miễn phí cho tài khoản <strong>{user.email}</strong>.
        </p>

        <div className="mt-8 border rounded-xl p-6">
          <h2 className="font-semibold">{plan.tier.label}</h2>
          <p className="mt-1 text-sm text-gray-500">{plan.tier.accountQuota} Zalo • {DURATION_LABEL[duration]}</p>
          <div className="mt-6 text-3xl font-bold text-green-700">Miễn phí</div>
          <a
            href="/api/claim-free"
            className="mt-6 inline-flex items-center justify-center rounded-lg px-5 py-3 border border-green-300 bg-green-50 text-green-700 hover:bg-green-100"
          >
            Nhận key miễn phí
          </a>
        </div>
      </div>
    )
  }

  // SePay QR url format: https://qr.sepay.vn/img?bank=<BANK>&acc=<ACC>&amount=<N>&des=<MEMO>
  const bank = envOrEmpty(process.env.SEPAY_BANK_NAME)
  const acc = envOrEmpty(process.env.SEPAY_BANK_ACCOUNT_NUMBER)
  const accountHolder = envOrEmpty(process.env.SEPAY_ACCOUNT_HOLDER)
  // Memo format: ZM <userIdShort> <tierId> <duration> — must match parser in webhook.
  const memo = `ZM ${user.id.replace(/-/g, '').slice(0, 8)} ${plan.tier.id} ${duration}`.toUpperCase()
  const qrUrl = bank && acc
    ? `https://qr.sepay.vn/img?bank=${encodeURIComponent(bank)}&acc=${encodeURIComponent(acc)}&amount=${plan.price}&des=${encodeURIComponent(memo)}`
    : ''

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold">Thanh toán</h1>
      <p className="mt-2 text-gray-500 text-sm">Quét QR để chuyển khoản, key sẽ được gửi vào email <strong>{user.email}</strong> sau khi giao dịch xác nhận (~30 giây).</p>

      <div className="mt-8 grid md:grid-cols-2 gap-6">
        <div className="border rounded-xl p-6">
          <h2 className="font-semibold">{plan.tier.label}</h2>
          <p className="mt-1 text-sm text-gray-500">{plan.tier.accountQuota} Zalo • {DURATION_LABEL[duration]}</p>
          <div className="mt-6 text-3xl font-bold text-brand">{formatVnd(plan.price)}</div>

          <dl className="mt-8 text-sm space-y-2">
            <div className="flex justify-between"><dt className="text-gray-500">Ngân hàng</dt><dd className="font-mono">{bank || '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Số TK</dt><dd className="font-mono">{acc || '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Chủ TK</dt><dd>{accountHolder || '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Số tiền</dt><dd className="font-mono">{formatVnd(plan.price)}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Nội dung CK</dt><dd className="font-mono text-xs">{memo}</dd></div>
          </dl>
          <p className="mt-4 text-xs text-amber-700">Quan trọng: nội dung chuyển khoản phải đúng nguyên văn để hệ thống tự match.</p>
        </div>

        <div className="border rounded-xl p-6 flex flex-col items-center justify-center text-center">
          {qrUrl ? (
            <img src={qrUrl} alt="QR thanh toán SePay" className="w-64 h-64" />
          ) : (
            <div className="w-64 h-64 bg-gray-100 grid place-items-center text-sm text-gray-500 rounded">
              SePay chưa được cấu hình.
            </div>
          )}
          <p className="mt-4 text-xs text-gray-500">Mở app ngân hàng → Quét QR → Xác nhận.</p>
          <p className="mt-2 text-xs text-gray-400">Powered by SePay</p>
        </div>
      </div>

      <PaymentWatcher memo={memo} />

      <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm">
        Sau khi chuyển khoản, key sẽ được gửi qua email kèm hướng dẫn nhập vào app.
        Nếu sau 5 phút chưa nhận được, inbox <a href="https://zalo.me/0981897779" className="text-brand underline">Zalo 0981897779</a> để được xử lý thủ công.
      </div>
    </div>
  )
}

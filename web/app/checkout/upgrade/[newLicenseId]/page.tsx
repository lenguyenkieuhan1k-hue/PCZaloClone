import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth-helpers'
import { serverClient } from '@/lib/supabase'
import { DURATION_LABEL, formatVnd, PLAN_TIERS, DURATION_DAYS, type Duration } from '@/lib/plans'

export const metadata = { title: 'Nâng cấp — ZaloMask' }

interface PageProps {
  params: { newLicenseId: string }
}

function envOrEmpty(value: string | undefined): string {
  const v = String(value || '').trim()
  return !v || v.startsWith('PLACEHOLDER_') ? '' : v
}

export default async function UpgradeCheckoutPage({ params }: PageProps) {
  const user = await getSessionUser()
  if (!user) redirect(`/auth/sign-in?next=${encodeURIComponent(`/checkout/upgrade/${params.newLicenseId}`)}`)

  const supabase = serverClient(user.accessToken)

  // Get new license details
  const { data: newLicense, error: licenseError } = await supabase
    .from('licenses')
    .select('id, key, tier_id, account_quota, duration, expires_at, status')
    .eq('id', params.newLicenseId)
    .single()

  if (licenseError || !newLicense) {
    return <div className="max-w-2xl mx-auto px-6 py-20 text-center text-gray-600">License không tìm thấy.</div>
  }

  // Get payment record
  const { data: payment } = await supabase
    .from('payments')
    .select('id, amount_vnd')
    .eq('license_id', params.newLicenseId)
    .eq('method', 'upgrade')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const price = payment?.amount_vnd || 0
  const tier = PLAN_TIERS.find((t) => t.id === newLicense.tier_id)
  const memo = `ZM ${user.id.replace(/-/g, '').slice(0, 8)} ${newLicense.tier_id} ${newLicense.duration}`.toUpperCase()

  // SePay QR
  const bank = envOrEmpty(process.env.SEPAY_BANK_NAME)
  const acc = envOrEmpty(process.env.SEPAY_BANK_ACCOUNT_NUMBER)
  const accountHolder = envOrEmpty(process.env.SEPAY_ACCOUNT_HOLDER)
  const qrUrl = bank && acc
    ? `https://qr.sepay.vn/img?bank=${encodeURIComponent(bank)}&acc=${encodeURIComponent(acc)}&amount=${price}&des=${encodeURIComponent(memo)}`
    : ''

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold">Nâng cấp License</h1>
      <p className="mt-2 text-gray-500 text-sm">
        Quét QR để chuyển khoản. Key mới sẽ được kích hoạt sau ~30 giây khi giao dịch xác nhận.
      </p>

      <div className="mt-8 grid md:grid-cols-2 gap-6">
        {/* Left: License details */}
        <div className="border rounded-xl p-6">
          <h2 className="font-semibold">{tier?.label}</h2>
          <p className="mt-1 text-sm text-gray-500">{newLicense.account_quota} Zalo • {DURATION_LABEL[newLicense.duration as Duration]}</p>
          
          <div className="mt-6 text-3xl font-bold text-brand">{formatVnd(price)}</div>

          <dl className="mt-8 text-sm space-y-2">
            <div className="flex justify-between">
              <dt className="text-gray-500">Key mới</dt>
              <dd className="font-mono text-xs break-all">{newLicense.key}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Ngân hàng</dt>
              <dd className="font-mono">{bank || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Số TK</dt>
              <dd className="font-mono">{acc || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Chủ TK</dt>
              <dd>{accountHolder || '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Số tiền</dt>
              <dd className="font-mono font-semibold text-lg">{formatVnd(price)}</dd>
            </div>
            <div className="flex justify-between pt-2 border-t">
              <dt className="text-gray-700 font-medium">Nội dung CK</dt>
              <dd className="font-mono text-xs text-right break-all text-amber-700 font-semibold">{memo}</dd>
            </div>
          </dl>

          <p className="mt-4 text-xs text-amber-700">
            ⚠️ Quan trọng: Nội dung chuyển khoản phải đúng nguyên văn để hệ thống tự nhận diện.
          </p>
        </div>

        {/* Right: QR Code */}
        <div className="border rounded-xl p-6 flex flex-col items-center justify-center">
          {qrUrl ? (
            <>
              <img src={qrUrl} alt="SePay QR Code" className="w-full max-w-xs" />
              <p className="mt-4 text-sm text-gray-600 text-center">Quét mã QR bằng ứng dụng ngân hàng</p>
            </>
          ) : (
            <div className="text-center text-gray-500">
              <p className="font-medium">Cấu hình ngân hàng chưa sẵn sàng</p>
              <p className="text-sm mt-1">Vui lòng liên hệ admin</p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 p-4 rounded-xl border border-green-200 bg-green-50 text-green-800 text-sm">
        <strong>✓ Sau khi chuyển khoản:</strong> Hệ thống sẽ xác nhận trong ~30 giây. Bạn sẽ nhận email xác nhận kích hoạt key.
        Nếu chưa nhận, bấm <strong>"Làm mới"</strong> trên dashboard để kiểm tra trạng thái.
      </div>

      <div className="mt-6 flex gap-3">
        <a href="/dashboard" className="flex-1 px-4 py-3 rounded-lg border border-gray-300 text-center hover:bg-gray-50">
          Quay lại Dashboard
        </a>
      </div>
    </div>
  )
}

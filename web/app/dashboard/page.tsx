import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth-helpers'
import { serverClient } from '@/lib/supabase'
import { formatVnd, DURATION_LABEL, type Duration } from '@/lib/plans'
import LicenseTable from './LicenseTable'

export const metadata = { title: 'Tài khoản — ZaloMask' }

interface DashboardSearchParams { paid?: string; msg?: string }

export default async function DashboardPage({ searchParams }: { searchParams: DashboardSearchParams }) {
  const user = await getSessionUser()
  if (!user) redirect('/auth/sign-in')

  const supabase = serverClient(user.accessToken)

  let licenses: any[] = []
  const { data: rawLicenses, error: licenseErr } = await supabase
    .from('licenses')
    .select('id, key, tier_id, account_quota, duration, expires_at, status, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (licenseErr) {
    console.error('[dashboard] failed to fetch licenses:', licenseErr)
  } else {
    licenses = await Promise.all(
      (rawLicenses || []).map(async (license) => {
        const { count } = await supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('license_id', license.id)

        return {
          ...license,
          profileCount: count || 0,
        }
      })
    )
  }

  const paidLicenseId = String(searchParams?.paid || '').trim()
  const paidLicenseExists = !!paidLicenseId && licenses.some((l) => l.id === paidLicenseId)

  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, license_id, device_name, app_version, last_seen_at, created_at, ended_at')
    .is('ended_at', null)
    .order('last_seen_at', { ascending: false })

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold">Tài khoản</h1>
          <p className="mt-1 text-gray-500 text-sm">{user.email}</p>
        </div>
        <div className="flex items-center gap-2">
          {user.isAdmin && (
            <Link href="/admin" className="px-4 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 text-sm hover:bg-amber-100">
              Quản trị Admin
            </Link>
          )}
          <Link href="/pricing" className="px-4 py-2 rounded-lg bg-brand text-white text-sm hover:bg-brand-dark">
            Mua key mới
          </Link>
        </div>
      </div>

      {(searchParams?.paid || searchParams?.msg) && (
        <div className="mt-6 p-4 rounded-xl border border-green-200 bg-green-50 text-green-800 text-sm">
          {paidLicenseExists ? (
            <>
              <strong>✅ Thanh toán thành công.</strong> License vừa được cấp đã hiển thị bên dưới.
              Bấm vào key để copy, mở app ZaloMask → Cài đặt → License → dán key vào.
            </>
          ) : searchParams.paid ? (
            <>
              <strong>⏳ Đã ghi nhận thanh toán.</strong> Hệ thống đang đồng bộ license, vui lòng tải lại trang sau vài giây.
            </>
          ) : (
            <>{decodeURIComponent(String(searchParams.msg || ''))}</>
          )}
        </div>
      )}

      <h2 className="text-xl font-semibold mt-10">License đã mua</h2>
      <LicenseTable licenses={licenses} />

      <h2 className="text-xl font-semibold mt-10">Thiết bị đang active</h2>
      {!sessions || sessions.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">Chưa có thiết bị nào.</p>
      ) : (
        <div className="mt-4 border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2">Thiết bị</th>
                <th className="px-4 py-2">App</th>
                <th className="px-4 py-2">Lần hoạt động</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.id} className="border-t">
                  <td className="px-4 py-2">{s.device_name || 'Không tên'}</td>
                  <td className="px-4 py-2">{s.app_version || '-'}</td>
                  <td className="px-4 py-2">{new Date(s.last_seen_at).toLocaleString('vi-VN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

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
  
  // Fetch licenses from new API to get profileCount
  let licenses = []
  try {
    const res = await fetch(`${process.env.NEXTAUTH_URL || 'https://zalomask.com'}/api/licenses`, {
      headers: {
        'Cookie': `sb-access-token=${user.accessToken}`,
      },
      cache: 'no-store',
    })
    const data = await res.json()
    if (data.ok) {
      licenses = data.licenses || []
    }
  } catch (err) {
    console.error('Failed to fetch licenses:', err)
  }

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
          {searchParams.paid ? (
            <>
              <strong>✅ Thanh toán thành công.</strong> License vừa được cấp đã hiển thị bên dưới.
              Bấm vào key để copy, mở app ZaloMask → Cài đặt → License → dán key vào.
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

import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth-helpers'
import { serverClient } from '@/lib/supabase'
import { formatVnd, DURATION_LABEL, type Duration } from '@/lib/plans'

export const metadata = { title: 'Tài khoản — ZaloMask' }

export default async function DashboardPage() {
  const user = await getSessionUser()
  if (!user) redirect('/auth/sign-in')

  const supabase = serverClient(user.accessToken)
  const { data: licenses } = await supabase
    .from('licenses')
    .select('id, key, tier_id, account_quota, duration, expires_at, status, active_session_id, active_device_name, created_at')
    .order('created_at', { ascending: false })

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
        <Link href="/pricing" className="px-4 py-2 rounded-lg bg-brand text-white text-sm hover:bg-brand-dark">
          Mua key mới
        </Link>
      </div>

      <h2 className="text-xl font-semibold mt-10">License đã mua</h2>
      {!licenses || licenses.length === 0 ? (
        <div className="mt-4 p-8 border border-dashed rounded-xl">
          <p className="text-gray-700 font-medium">Bạn chưa kích hoạt key trả phí.</p>
          <p className="mt-2 text-sm text-gray-600">Hiện tại bạn vẫn dùng được theo gói miễn phí: tối đa 1 tài khoản Zalo.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/api/claim-free" className="px-4 py-2 rounded-lg border border-green-300 bg-green-50 text-green-700 hover:bg-green-100">
              Nhận key miễn phí
            </Link>
            <Link href="/pricing" className="px-4 py-2 rounded-lg border border-gray-300 hover:border-brand hover:text-brand">
              Xem gói trả phí
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          {licenses.map(l => (
            <div key={l.id} className="border border-gray-200 rounded-xl p-5 flex flex-wrap gap-4 items-start justify-between">
              <div className="min-w-0">
                <div className="font-mono text-lg">{l.key}</div>
                <div className="mt-1 text-sm text-gray-500">
                  {l.tier_id} • {l.account_quota} Zalo • {DURATION_LABEL[l.duration as Duration]} • Hết hạn: {new Date(l.expires_at).toLocaleDateString('vi-VN')}
                </div>
                <div className="mt-1 text-xs">
                  Trạng thái: <span className={l.status === 'active' ? 'text-green-600' : 'text-red-600'}>{l.status}</span>
                  {' • '}Active trên: <span className="text-gray-700">{l.active_device_name || (l.active_session_id ? 'thiết bị ẩn danh' : 'chưa có')}</span>
                </div>
              </div>
              <button className="px-3 py-1.5 rounded-lg border text-sm hover:border-brand"
                      onClick={() => { /* TODO(phase-3): implement copy + renew flow */ }}>
                Gia hạn
              </button>
            </div>
          ))}
        </div>
      )}

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

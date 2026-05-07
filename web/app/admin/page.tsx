import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth-helpers'
import { adminClient } from '@/lib/supabase'
import { formatVnd } from '@/lib/plans'
import RevokeLicenseButton from './RevokeLicenseButton'
import CreateKeyForm from './CreateKeyForm'

export const metadata = { title: 'Admin — ZaloMask' }

export default async function AdminPage() {
  const user = await getSessionUser()
  if (!user) redirect('/auth/sign-in')
  if (!user.isAdmin) redirect('/dashboard')

  // adminClient bypasses RLS — only reachable after isAdmin check above.
  const admin = adminClient()
  const [{ data: payments }, { data: licenses }, { data: users }] = await Promise.all([
    admin.from('payments').select('id, amount_vnd, status, created_at, paid_at').eq('status', 'paid').order('paid_at', { ascending: false }).limit(50),
    admin.from('licenses').select('id, key, tier_id, status, expires_at, user_id, created_at').order('created_at', { ascending: false }).limit(50),
    admin.from('users').select('id, email, display_name, created_at, is_admin').order('created_at', { ascending: false }).limit(50)
  ])

  const totalRevenue = (payments || []).reduce((acc, p) => acc + Number(p.amount_vnd || 0), 0)

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-3xl font-bold">Admin</h1>
        <p className="text-sm text-gray-500">{user.email}</p>
      </div>

      <div className="mt-8 grid sm:grid-cols-3 gap-4">
        <Stat label="Doanh thu (đã thanh toán)" value={formatVnd(totalRevenue)} />
        <Stat label="Tổng license" value={String(licenses?.length || 0) + '+'} />
        <Stat label="Tổng user" value={String(users?.length || 0) + '+'} />
      </div>

      <h2 className="text-xl font-semibold mt-12">Tạo key thủ công</h2>
      <p className="text-sm text-gray-500 mt-1">Tạo key với tier và ngày hết hạn tuỳ chỉnh. Ghi vào audit_log.</p>
      <CreateKeyForm />

      <h2 className="text-xl font-semibold mt-12">License gần đây</h2>
      <div className="mt-4 border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2">Key</th>
              <th className="px-4 py-2">Tier</th>
              <th className="px-4 py-2">Trạng thái</th>
              <th className="px-4 py-2">Hết hạn</th>
              <th className="px-4 py-2">Tạo</th>
              <th className="px-4 py-2">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {(licenses || []).map(l => (
              <tr key={l.id} className="border-t">
                <td className="px-4 py-2 font-mono text-xs">{l.key}</td>
                <td className="px-4 py-2">{l.tier_id}</td>
                <td className="px-4 py-2"><span className={l.status === 'active' ? 'text-green-600' : 'text-red-600'}>{l.status}</span></td>
                <td className="px-4 py-2">{new Date(l.expires_at).toLocaleDateString('vi-VN')}</td>
                <td className="px-4 py-2">{new Date(l.created_at).toLocaleDateString('vi-VN')}</td>
                <td className="px-4 py-2">
                  <RevokeLicenseButton licenseId={l.id} keyText={l.key} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="text-xl font-semibold mt-10">User gần đây</h2>
      <div className="mt-4 border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr><th className="px-4 py-2">Email</th><th className="px-4 py-2">Tên</th><th className="px-4 py-2">Admin?</th><th className="px-4 py-2">Tạo</th></tr>
          </thead>
          <tbody>
            {(users || []).map(u => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2">{u.display_name}</td>
                <td className="px-4 py-2">{u.is_admin ? 'Có' : ''}</td>
                <td className="px-4 py-2">{new Date(u.created_at).toLocaleDateString('vi-VN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border rounded-xl p-5">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  )
}

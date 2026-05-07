import { NextRequest, NextResponse } from 'next/server'
import { adminClient, isAdminEmail, serverClient } from '@/lib/supabase'
import { PLAN_TIERS } from '@/lib/plans'
import crypto from 'crypto'

// POST /api/admin/create-key
// Body: { tierId, accountQuota, expiresAt, note?, userEmail? }
// userEmail: gán key cho user có sẵn (nếu muốn). Không bắt buộc.
export async function POST(req: NextRequest) {
  // Auth: chỉ admin mới được gọi
  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
  const supabase = serverClient(accessToken)
  const { data, error: authErr } = await supabase.auth.getUser(accessToken)
  if (authErr || !data?.user?.email) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
  if (!isAdminEmail(data.user.email)) return NextResponse.json({ ok: false, message: 'Forbidden' }, { status: 403 })

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })
  }

  const tierId = String(body?.tierId || '').trim()
  const expiresAt = String(body?.expiresAt || '').trim()
  const note = String(body?.note || '').slice(0, 200)
  const userEmail = String(body?.userEmail || '').trim().toLowerCase()

  // Validate tier
  const tier = PLAN_TIERS.find(t => t.id === tierId)
  if (!tier) return NextResponse.json({ ok: false, message: 'Tier không hợp lệ' }, { status: 400 })

  // Validate expiresAt
  const expDate = new Date(expiresAt)
  if (isNaN(expDate.getTime()) || expDate <= new Date()) {
    return NextResponse.json({ ok: false, message: 'Ngày hết hạn không hợp lệ (phải trong tương lai)' }, { status: 400 })
  }

  // Custom accountQuota override (optional, default = tier.accountQuota)
  const accountQuota = Number(body?.accountQuota) > 0 ? Number(body.accountQuota) : tier.accountQuota

  const admin = adminClient()

  // Resolve target user. Nếu để trống email thì gán key cho chính admin đang đăng nhập.
  let userId = data.user.id
  if (userEmail) {
    const { data: userRow } = await admin
      .from('users')
      .select('id')
      .eq('email', userEmail)
      .maybeSingle()
    if (!userRow) return NextResponse.json({ ok: false, message: `Không tìm thấy user với email: ${userEmail}` }, { status: 404 })
    userId = userRow.id
  } else {
    const { data: selfUser } = await admin
      .from('users')
      .select('id')
      .eq('id', data.user.id)
      .maybeSingle()
    if (!selfUser) {
      await admin.from('users').upsert({
        id: data.user.id,
        email: data.user.email,
        display_name: (data.user.user_metadata?.name as string) || data.user.email,
      })
    }
  }

  // Generate key
  const licenseKey = 'ZM-' + crypto.randomBytes(8).toString('hex').toUpperCase()

  const { data: license, error: licErr } = await admin
    .from('licenses')
    .insert({
      user_id: userId,
      key: licenseKey,
      tier_id: tierId,
      account_quota: accountQuota,
      duration: 'custom',
      expires_at: expDate.toISOString(),
      status: 'active',
    })
    .select('id, key')
    .single()

  if (licErr || !license) {
    return NextResponse.json({ ok: false, message: licErr?.message || 'Tạo license thất bại' }, { status: 500 })
  }

  // Audit log
  const adminUserId = data.user.id
  await admin.from('audit_log').insert({
    actor_id: adminUserId,
    action: 'admin-create-key',
    license_id: license.id,
    detail: { adminEmail: data.user.email, tierId, accountQuota, expiresAt: expDate.toISOString(), userEmail: userEmail || null, note },
  })

  return NextResponse.json({ ok: true, key: license.key, licenseId: license.id, expiresAt: expDate.toISOString() })
}

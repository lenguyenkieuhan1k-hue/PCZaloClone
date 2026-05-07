import { NextRequest, NextResponse } from 'next/server'
import { adminClient, isAdminEmail, serverClient } from '@/lib/supabase'

async function getAdminUser(req: NextRequest) {
  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) return null
  const supabase = serverClient(accessToken)
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data?.user?.id || !isAdminEmail(data.user.email)) return null
  return { id: data.user.id, email: data.user.email || '' }
}

export async function POST(req: NextRequest) {
  const actor = await getAdminUser(req)
  if (!actor) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })
  }

  const licenseId = String(body?.licenseId || '').trim()
  const key = String(body?.key || '').trim()
  const reason = String(body?.reason || 'admin-revoke').slice(0, 200)

  if (!licenseId && !key) {
    return NextResponse.json({ ok: false, message: 'Thiếu licenseId hoặc key' }, { status: 400 })
  }

  const admin = adminClient()
  let query = admin
    .from('licenses')
    .select('id, key, user_id, status, active_session_id')
    .limit(1)
  query = licenseId ? query.eq('id', licenseId) : query.eq('key', key)

  const { data: license, error } = await query.maybeSingle()
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!license) return NextResponse.json({ ok: false, message: 'Không tìm thấy license' }, { status: 404 })

  if (String(license.status || '').toLowerCase() === 'revoked') {
    return NextResponse.json({ ok: true, alreadyRevoked: true, licenseId: license.id, key: license.key })
  }

  const now = new Date().toISOString()
  const { error: updateErr } = await admin
    .from('licenses')
    .update({ status: 'revoked', active_session_id: null })
    .eq('id', license.id)

  if (updateErr) return NextResponse.json({ ok: false, message: updateErr.message }, { status: 500 })

  await admin
    .from('sessions')
    .update({ ended_at: now })
    .eq('license_id', license.id)
    .is('ended_at', null)

  await admin.from('audit_log').insert({
    actor_id: actor.id,
    license_id: license.id,
    action: 'revoke-admin',
    detail: { reason, actorEmail: actor.email },
  })

  return NextResponse.json({ ok: true, licenseId: license.id, key: license.key })
}

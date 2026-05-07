import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase'
import { signLicenseToken } from '@/lib/license-token'

/* POST /api/activate
 *
 * Body: { key: string, deviceFingerprint: string, deviceName?: string,
 *         appVersion?: string }
 *
 * Returns: { ok, sessionId, token, expiresAt } or { ok: false, message }
 *
 * Single-session rule: writes a fresh sessions row + overwrites
 * licenses.active_session_id. Any previous machine that polls heartbeat will
 * see its own session_id ≠ the new one and self-kick. */

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 }) }

  const key = String(body.key || '').trim()
  const fp = String(body.deviceFingerprint || '').trim()
  if (!key || !fp) return NextResponse.json({ ok: false, message: 'Thiếu key hoặc device fingerprint' }, { status: 400 })

  const admin = adminClient()
  const { data: license, error } = await admin
    .from('licenses')
    .select('*')
    .eq('key', key)
    .eq('status', 'active')
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!license) return NextResponse.json({ ok: false, message: 'Key không tồn tại hoặc đã bị thu hồi' }, { status: 404 })
  if (new Date(license.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ ok: false, message: 'Key đã hết hạn' }, { status: 403 })
  }

  // Insert new session, then overwrite license.active_session_id atomically.
  const { data: sessionRow, error: sessErr } = await admin
    .from('sessions')
    .insert({
      license_id: license.id,
      device_fingerprint: fp,
      device_name: body.deviceName || null,
      app_version: body.appVersion || null,
      ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null,
      user_agent: req.headers.get('user-agent')
    })
    .select('id')
    .single()
  if (sessErr || !sessionRow) return NextResponse.json({ ok: false, message: sessErr?.message || 'Insert session failed' }, { status: 500 })

  const previousSessionId = license.active_session_id as string | null
  await admin.from('licenses').update({
    active_session_id: sessionRow.id,
    active_device_name: body.deviceName || null
  }).eq('id', license.id)

  // Mark previous session ended (best-effort; the heartbeat from old client
  // will also notice the kick on its next poll).
  if (previousSessionId && previousSessionId !== sessionRow.id) {
    await admin.from('sessions').update({ ended_at: new Date().toISOString() }).eq('id', previousSessionId)
  }

  await admin.from('audit_log').insert({
    actor_id: license.user_id,
    license_id: license.id,
    action: 'activate',
    detail: { previousSessionId, newSessionId: sessionRow.id, deviceName: body.deviceName, appVersion: body.appVersion }
  })

  // Sign Ed25519 token with sessionId + expiry — client trusts only signed tokens.
  const tokenExpiresAt = new Date(Math.min(
    new Date(license.expires_at).getTime(),
    Date.now() + 1000 * 60 * 60 * 24 * 7   // refresh weekly
  )).toISOString()

  const token = await signLicenseToken({
    sub: license.id,
    session_id: sessionRow.id,
    quota: license.account_quota,
    exp: Math.floor(new Date(tokenExpiresAt).getTime() / 1000)
  })

  return NextResponse.json({
    ok: true,
    sessionId: sessionRow.id,
    token,
    expiresAt: tokenExpiresAt,
    licenseExpiresAt: license.expires_at,
    accountQuota: license.account_quota
  })
}

import { NextRequest, NextResponse } from 'next/server'
import { serverClient, adminClient } from '@/lib/supabase'
import { Resend } from 'resend'

export const runtime = 'nodejs'

/**
 * POST /api/deactivate-license
 * 
 * User deactivates one of their licenses. Status transitions:
 * - 'active' → 'revoked' (graceful deactivation)
 * - Grace period: 24h before auto-delete profiles (allows user to download first)
 * - After 24h, profiles are deleted automatically (job or next heartbeat)
 * 
 * Request:
 * {
 *   "license_id": "uuid",
 *   "reason": "no-longer-needed" | "switching-key" | "other"
 * }
 * 
 * Response:
 * {
 *   "ok": true,
 *   "message": "License revoked. Profiles will be deleted after 24h.",
 *   "revokedAt": "2026-05-07T12:34:56Z",
 *   "profileCount": 5
 * } or { "ok": false, "message": "..." }
 */
export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get('sb-access-token')?.value
    if (!token) {
      return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const { license_id, reason } = body

    if (!license_id) {
      return NextResponse.json({ ok: false, message: 'license_id required' }, { status: 400 })
    }

    const client = serverClient(token)

    // Verify license belongs to current user
    const { data: license, error: licErr } = await client
      .from('licenses')
      .select('id, user_id, key, status, tier_id')
      .eq('id', license_id)
      .single()

    if (licErr || !license) {
      return NextResponse.json({ ok: false, message: 'License not found' }, { status: 404 })
    }

    // Prevent deactivating already non-active licenses
    if (license.status === 'revoked') {
      return NextResponse.json(
        { ok: false, message: 'License này đã huỷ trước đó.' },
        { status: 400 }
      )
    }
    if (license.status !== 'active') {
      return NextResponse.json(
        { ok: false, message: `Không thể huỷ key ở trạng thái ${license.status}.` },
        { status: 400 }
      )
    }

    const admin = adminClient()

    // Set revoked status + grace period timestamp
    const revokedAt = new Date().toISOString()
    const deleteAfter = new Date(Date.now() + 24 * 3600 * 1000).toISOString()

    const { error: updateErr } = await admin
      .from('licenses')
      .update({
        status: 'revoked',
        revoked_at: revokedAt,
        delete_after: deleteAfter,
        active_session_id: null,
        active_device_name: null,
      })
      .eq('id', license_id)

    if (updateErr) {
      return NextResponse.json(
        { ok: false, message: 'Failed to revoke license' },
        { status: 500 }
      )
    }

    const { count: profileCountRaw } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('license_id', license.id)

    const profileCount = profileCountRaw || 0

    await admin
      .from('sessions')
      .update({ ended_at: revokedAt })
      .eq('license_id', license.id)
      .is('ended_at', null)

    // Get user info for email
    const { data: user } = await admin
      .from('users')
      .select('email, display_name')
      .eq('id', license.user_id)
      .single()

    // Send revocation email (best effort)
    try {
      if (process.env.RESEND_API_KEY && user) {
        const resend = new Resend(process.env.RESEND_API_KEY)
        await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL || 'ZaloMask <noreply@zalomask.com>',
          to: user.email,
          subject: 'License ZaloMask đã được huỷ bỏ',
          html: `<p>Chào ${user.display_name || ''},</p>
                 <p>License <strong style="font-family:monospace">${license.key}</strong> của bạn đã được huỷ bỏ.</p>
                 <p style="color:#e74c3c"><strong>⚠️ Chú ý:</strong> Tất cả profiles liên kết với key này sẽ bị xoá sau <strong>24 giờ</strong>.</p>
                 <p>Nếu bạn muốn giữ lại dữ liệu, vui lòng:</p>
                 <ol>
                   <li>Mở lại ZaloMask trong 24h</li>
                   <li>Sử dụng "Đồng bộ đám mây" để backup profiles</li>
                   <li>Nếu cần, kích hoạt key mới và khôi phục từ cloud</li>
                 </ol>
                 <p>Hỗ trợ: <a href="https://zalo.me/0981897779">Zalo 0981897779</a></p>`,
        })
      }
    } catch {
      // ignore — user still sees revoked status in dashboard
    }

    // Audit log
    await admin.from('audit_log').insert({
      actor_id: license.user_id,
      license_id: license.id,
      action: 'revoke-license',
      detail: { reason, revoked_at: revokedAt, delete_after: deleteAfter },
    })

    return NextResponse.json({
      ok: true,
      message: 'Đã huỷ key. Profiles sẽ bị xoá sau 24 giờ nếu bạn không khôi phục.',
      revokedAt,
      deleteAfter,
      profileCount,
    })
  } catch (err) {
    console.error('[deactivate-license]', err)
    return NextResponse.json({ ok: false, message: 'Server error' }, { status: 500 })
  }
}

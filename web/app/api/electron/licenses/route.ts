import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase'

export const runtime = 'nodejs'

/**
 * POST /api/electron/licenses
 *
 * Body: { key: string }
 *
 * Electron app fetches active licenses for a given key.
 * Used to:
 * 1. Validate key on app startup
 * 2. Calculate total profile quota from all active licenses
 * 3. Check single-session enforcement (session_id must match)
 *
 * Why POST not GET:
 *   The license key is a credential. Putting it in the query string would
 *   leak it into server logs, browser history, proxy logs, and any support
 *   screenshots. POST + JSON body keeps the key out of those leak channels.
 *
 * Returns:
 * {
 *   ok: true,
 *   user: { id, email, display_name },
 *   licenses: [...],
 *   totalQuota: number,
 *   effectiveQuota: number
 * }
 * or { ok: false, message }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { key?: string } | null
    const key = String(body?.key || '').trim()

    if (!key) {
      return NextResponse.json(
        { ok: false, message: 'key bắt buộc trong body JSON' },
        { status: 400 }
      )
    }

    const admin = adminClient()

    // 1. Find license by key
    const { data: license, error: licErr } = await admin
      .from('licenses')
      .select('id, user_id, license_id, key, tier_id, account_quota, duration, expires_at, status, active_session_id, revoked_at, delete_after')
      .eq('key', key)
      .maybeSingle()

    if (licErr || !license) {
      return NextResponse.json({ ok: false, message: 'License key not found' }, { status: 404 })
    }

    // 2. Get user info
    const { data: user } = await admin
      .from('users')
      .select('id, email, display_name')
      .eq('id', license.user_id)
      .single()

    if (!user) {
      return NextResponse.json({ ok: false, message: 'User not found' }, { status: 404 })
    }

    // 3. Get all licenses for this user (multi-key scenario)
    const { data: allLicenses, error: allErr } = await admin
      .from('licenses')
      .select('id, license_id, key, tier_id, account_quota, duration, expires_at, status, active_session_id, revoked_at, delete_after')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (allErr) {
      return NextResponse.json({ ok: false, message: 'Failed to fetch licenses' }, { status: 500 })
    }

    // 4. Filter active licenses
    const now = new Date()
    const activeLicenses = (allLicenses || []).filter((lic) => {
      return lic.status === 'active' && new Date(lic.expires_at) > now
    })

    if (activeLicenses.length === 0) {
      return NextResponse.json(
        { ok: false, message: 'No active licenses found', licenses: allLicenses || [] },
        { status: 403 }
      )
    }

    // 5. Calculate quotas
    const totalQuota = (allLicenses || []).reduce((sum, lic) => sum + (lic.account_quota || 0), 0)
    const effectiveQuota = activeLicenses.reduce((sum, lic) => sum + (lic.account_quota || 0), 0)

    // 6. Audit log — never log full key, only last 4
    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'electron-licenses-fetch',
      detail: { key_last4: key.slice(-4), license_count: allLicenses?.length || 0, active_count: activeLicenses.length },
    })

    return NextResponse.json({
      ok: true,
      user,
      licenses: allLicenses || [],
      totalQuota,
      effectiveQuota,
    })
  } catch (err) {
    console.error('[electron/licenses]', err)
    return NextResponse.json({ ok: false, message: 'Server error' }, { status: 500 })
  }
}

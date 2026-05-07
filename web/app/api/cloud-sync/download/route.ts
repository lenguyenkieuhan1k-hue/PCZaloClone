import { NextRequest, NextResponse } from 'next/server'
import { adminClient, serverClient } from '@/lib/supabase'
import { verifyLicenseToken } from '@/lib/license-token'

async function resolveCloudAuth(req: NextRequest, sessionId: string) {
  const admin = adminClient()

  const bearer = req.headers.get('authorization') || ''
  if (bearer.toLowerCase().startsWith('bearer ')) {
    const token = bearer.slice(7).trim()
    const payload = await verifyLicenseToken(token)
    if (payload?.sub && payload?.session_id === sessionId) {
      const { data: license } = await admin
        .from('licenses')
        .select('id, user_id, active_session_id, status')
        .eq('id', payload.sub)
        .eq('status', 'active')
        .eq('active_session_id', sessionId)
        .maybeSingle()
      if (license?.user_id) {
        return { userId: license.user_id as string, licenseId: license.id as string }
      }
    }
  }

  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) return null
  const supabase = serverClient(accessToken)
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data?.user?.id) return null

  const { data: user } = await admin
    .from('users')
    .select('id')
    .eq('id', data.user.id)
    .maybeSingle()
  if (!user) return null

  const { data: license } = await admin
    .from('licenses')
    .select('id, active_session_id, status')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .eq('active_session_id', sessionId)
    .maybeSingle()
  if (!license) return null

  return { userId: user.id, licenseId: license.id as string }
}

// GET /api/cloud-sync/download?sessionId=<sid>
// Trả về profiles đã upload trước đó, chỉ cho phép nếu sessionId là active.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId') || ''
  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })

  const auth = await resolveCloudAuth(req, sessionId)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  const admin = adminClient()

  const { data: backup, error } = await admin
    .from('cloud_backups')
    .select('profiles_json, profile_count, uploaded_at')
    .eq('user_id', auth.userId)
    .maybeSingle()

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!backup) return NextResponse.json({ ok: true, profiles: [], uploadedAt: null })

  await admin.from('audit_log').insert({
    actor_id: auth.userId,
    license_id: auth.licenseId,
    action: 'cloud-download',
    detail: { profileCount: backup.profile_count, sessionId },
  })

  return NextResponse.json({
    ok: true,
    profiles: backup.profiles_json,
    profileCount: backup.profile_count,
    uploadedAt: backup.uploaded_at,
  })
}

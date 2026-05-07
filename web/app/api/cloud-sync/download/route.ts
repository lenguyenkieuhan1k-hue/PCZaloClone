import { NextRequest, NextResponse } from 'next/server'
import { adminClient, serverClient } from '@/lib/supabase'

async function getActiveSession(req: NextRequest) {
  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) return null
  const supabase = serverClient(accessToken)
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data?.user?.id) return null

  const admin = adminClient()
  const { data: user } = await admin
    .from('users')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .maybeSingle()
  if (!user) return null
  return { userId: user.id }
}

// GET /api/cloud-sync/download?sessionId=<sid>
// Trả về profiles đã upload trước đó, chỉ cho phép nếu sessionId là active.
export async function GET(req: NextRequest) {
  const auth = await getActiveSession(req)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  const sessionId = req.nextUrl.searchParams.get('sessionId') || ''
  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })

  const admin = adminClient()

  // Chỉ cho phép download nếu sessionId khớp active_session_id.
  const { data: license } = await admin
    .from('licenses')
    .select('id, active_session_id, status')
    .eq('user_id', auth.userId)
    .in('status', ['active'])
    .eq('active_session_id', sessionId)
    .maybeSingle()

  if (!license) {
    return NextResponse.json(
      { ok: false, message: 'Session không hợp lệ hoặc không phải session đang active.' },
      { status: 403 }
    )
  }

  const { data: backup, error } = await admin
    .from('cloud_backups')
    .select('profiles_json, profile_count, uploaded_at')
    .eq('user_id', auth.userId)
    .maybeSingle()

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!backup) return NextResponse.json({ ok: true, profiles: [], uploadedAt: null })

  await admin.from('audit_log').insert({
    actor_id: auth.userId,
    license_id: license.id,
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

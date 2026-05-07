import { NextRequest, NextResponse } from 'next/server'
import { adminClient, serverClient } from '@/lib/supabase'

// Xác thực: session phải là active session của license.
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

// POST /api/cloud-sync/upload
// Body: { sessionId: string, profiles: object[] }
export async function POST(req: NextRequest) {
  const auth = await getActiveSession(req)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })
  }

  const sessionId = String(body?.sessionId || '').trim()
  const profiles = Array.isArray(body?.profiles) ? body.profiles : []

  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })

  const admin = adminClient()

  // Chỉ cho phép upload nếu sessionId khớp active_session_id của license hiện tại.
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

  // Sanitize profiles — bỏ trường quá nhạy cảm không cần thiết khi chuyển máy.
  const sanitized = profiles.map((p: any) => ({
    profileName: p.profileName,
    displayName: p.displayName,
    launchMode: p.launchMode,
    createdAt: p.createdAt,
    proxy: p.proxy ?? null,
    fingerprint: p.fingerprint ?? null,
    webSession: p.webSession ?? null,
  }))

  const { error } = await admin
    .from('cloud_backups')
    .upsert(
      {
        user_id: auth.userId,
        license_id: license.id,
        session_id: sessionId,
        profiles_json: sanitized,
        profile_count: sanitized.length,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })

  await admin.from('audit_log').insert({
    actor_id: auth.userId,
    license_id: license.id,
    action: 'cloud-upload',
    detail: { profileCount: sanitized.length, sessionId },
  })

  return NextResponse.json({ ok: true, profileCount: sanitized.length })
}

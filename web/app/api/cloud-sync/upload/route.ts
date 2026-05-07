import { NextRequest, NextResponse } from 'next/server'
import { adminClient, serverClient } from '@/lib/supabase'
import { verifyLicenseToken } from '@/lib/license-token'

function sanitizeUnicodeString(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)

    // JSONB does not accept NUL.
    if (code === 0) continue

    // High surrogate must be followed by a low surrogate.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1]
        i++
      } else {
        out += '�'
      }
      continue
    }

    // Unpaired low surrogate.
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += '�'
      continue
    }

    out += input[i]
  }
  return out
}

function sanitizeJsonValue(value: any): any {
  if (typeof value === 'string') return sanitizeUnicodeString(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item))
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeJsonValue(v)
    }
    return out
  }
  return value
}

// Xác thực theo 2 mode:
// 1) Web cookie (dashboard)
// 2) Electron bearer token (license token signed)
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

// POST /api/cloud-sync/upload
// Body: { sessionId: string, profiles: object[] }
export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })
  }

  const sessionId = String(body?.sessionId || '').trim()
  const profiles = Array.isArray(body?.profiles) ? body.profiles : []

  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })

  const auth = await resolveCloudAuth(req, sessionId)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  const admin = adminClient()

  // Sanitize profiles — bỏ trường quá nhạy cảm không cần thiết khi chuyển máy.
  const sanitized = profiles.map((p: any) => sanitizeJsonValue({
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
        license_id: auth.licenseId,
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
    license_id: auth.licenseId,
    action: 'cloud-upload',
    detail: { profileCount: sanitized.length, sessionId },
  })

  return NextResponse.json({ ok: true, profileCount: sanitized.length })
}

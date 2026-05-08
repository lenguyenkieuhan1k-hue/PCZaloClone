import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase'
import { resolveCloudAuth } from '@/lib/cloud-sync-auth'

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

// POST /api/cloud-sync/upload
// Body (legacy): { sessionId: string, profiles: object[] }
// Desktop .zmb không còn gửi base64 qua route này — dùng upload-init + PUT Storage + upload-commit.
export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch {
    return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })
  }

  const sessionId = String(body?.sessionId || '').trim()
  const profiles = Array.isArray(body?.profiles) ? body.profiles : []
  const packageRaw = body?.desktopPackage && typeof body.desktopPackage === 'object' ? body.desktopPackage : null

  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })
  if (packageRaw) {
    return NextResponse.json(
      {
        ok: false,
        message:
          'Backup desktop không gửi qua API (giới hạn Vercel). Cập nhật ZaloMask và dùng đồng bộ qua Storage (upload-init → PUT → upload-commit).',
      },
      { status: 410 },
    )
  }
  if (profiles.length === 0) {
    return NextResponse.json({ ok: false, message: 'Thiếu dữ liệu backup' }, { status: 400 })
  }

  const auth = await resolveCloudAuth(req, sessionId)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  const admin = adminClient()
  let profileCount = 0
  let payloadToStore: any = []

  // Legacy sanitize — giữ tương thích dữ liệu cloud cũ.
  const sanitized = profiles.map((p: any) =>
    sanitizeJsonValue({
      profileName: p.profileName,
      displayName: p.displayName,
      launchMode: p.launchMode,
      createdAt: p.createdAt,
      proxy: p.proxy ?? null,
      fingerprint: p.fingerprint ?? null,
      webSession: p.webSession ?? null,
    }),
  )
  profileCount = sanitized.length
  payloadToStore = sanitized

  const { error } = await admin
    .from('cloud_backups')
    .upsert(
      {
        user_id: auth.userId,
        license_id: auth.licenseId,
        session_id: sessionId,
        profiles_json: payloadToStore,
        profile_count: profileCount,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })

  await admin.from('audit_log').insert({
    actor_id: auth.userId,
    license_id: auth.licenseId,
    action: 'cloud-upload',
    detail: { profileCount, sessionId, mode: 'legacy-profiles-json' },
  })

  return NextResponse.json({ ok: true, profileCount })
}

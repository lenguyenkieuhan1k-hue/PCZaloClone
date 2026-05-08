import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase'
import { resolveCloudAuth } from '@/lib/cloud-sync-auth'

const BUCKET = 'cloud-backups'
const MAX_BYTES = 524288000

function sanitizeUnicodeString(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code === 0) continue
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
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += '�'
      continue
    }
    out += input[i]
  }
  return out
}

/** POST — sau khi client PUT file xong: ghi metadata vào cloud_backups. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })
  }

  const sessionId = String(body.sessionId || '').trim()
  const objectPath = String(body.objectPath || '').trim()

  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })
  if (!objectPath) return NextResponse.json({ ok: false, message: 'Thiếu objectPath' }, { status: 400 })

  const auth = await resolveCloudAuth(req, sessionId)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  const prefix = `${auth.userId}/`
  if (!objectPath.startsWith(prefix) || objectPath.includes('..') || objectPath.length > 512) {
    return NextResponse.json({ ok: false, message: 'objectPath không hợp lệ' }, { status: 400 })
  }

  const byteLength = Number(body.byteLength || 0)
  if (!Number.isFinite(byteLength) || byteLength <= 0 || byteLength > MAX_BYTES) {
    return NextResponse.json({ ok: false, message: 'byteLength không hợp lệ' }, { status: 400 })
  }

  const checksumSha256 = String(body.checksumSha256 || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(checksumSha256)) {
    return NextResponse.json({ ok: false, message: 'checksumSha256 không hợp lệ' }, { status: 400 })
  }

  const profileCount = Math.max(0, Math.floor(Number(body.profileCount || 0)))
  if (profileCount <= 0) {
    return NextResponse.json({ ok: false, message: 'profileCount phải > 0' }, { status: 400 })
  }

  const format = sanitizeUnicodeString(String(body.format || 'zalomask-portable-profile-bundle').slice(0, 120))
  const version = Math.max(1, Math.floor(Number(body.version || 2)))
  const fileName = sanitizeUnicodeString(String(body.fileName || 'cloud-backup.zmb').slice(0, 240))

  const admin = adminClient()
  const baseName = objectPath.slice(prefix.length)
  if (!baseName || baseName.includes('/')) {
    return NextResponse.json({ ok: false, message: 'objectPath không hợp lệ' }, { status: 400 })
  }

  const { data: listed, error: listErr } = await admin.storage.from(BUCKET).list(auth.userId, { limit: 200 })
  if (listErr) {
    return NextResponse.json({ ok: false, message: listErr.message }, { status: 500 })
  }
  let hit = listed?.find((x) => x.name === baseName && x.id != null)
  if (!hit) hit = listed?.find((x) => x.name === baseName)
  if (!hit) {
    return NextResponse.json(
      { ok: false, message: 'Chưa thấy file trên storage — upload PUT có thể chưa hoàn tất.' },
      { status: 400 },
    )
  }

  const listedSize = Number((hit as { metadata?: { size?: number } }).metadata?.size)
  if (Number.isFinite(listedSize) && listedSize > 0 && listedSize !== byteLength) {
    return NextResponse.json(
      { ok: false, message: `Kích thước file không khớp (${listedSize} ≠ ${byteLength}).` },
      { status: 400 },
    )
  }

  const { data: prevRow } = await admin.from('cloud_backups').select('profiles_json').eq('user_id', auth.userId).maybeSingle()
  const prevStored = prevRow?.profiles_json as { kind?: string; objectPath?: string } | null

  const payloadToStore = {
    kind: 'desktop-package-storage',
    bucket: BUCKET,
    objectPath,
    format,
    version,
    fileName,
    checksumSha256,
    profileCount,
    byteLength,
  }

  const { error: upsertErr } = await admin
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
      { onConflict: 'user_id' },
    )

  if (upsertErr) return NextResponse.json({ ok: false, message: upsertErr.message }, { status: 500 })

  if (prevStored?.kind === 'desktop-package-storage' && prevStored.objectPath && prevStored.objectPath !== objectPath) {
    await admin.storage.from(BUCKET).remove([prevStored.objectPath]).catch(() => {})
  }

  await admin.from('audit_log').insert({
    actor_id: auth.userId,
    license_id: auth.licenseId,
    action: 'cloud-upload',
    detail: { profileCount, sessionId, mode: 'desktop-package-storage', objectPath },
  })

  return NextResponse.json({ ok: true, profileCount })
}

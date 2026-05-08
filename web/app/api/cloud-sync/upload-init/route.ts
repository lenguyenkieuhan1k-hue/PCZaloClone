import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { adminClient } from '@/lib/supabase'
import { resolveCloudAuth } from '@/lib/cloud-sync-auth'

const BUCKET = 'cloud-backups'
const MAX_BYTES = 524288000

/** POST — trả signed upload URL; client PUT nhị phân thẳng lên Supabase Storage. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })
  }

  const sessionId = String(body.sessionId || '').trim()
  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })

  const auth = await resolveCloudAuth(req, sessionId)
  if (!auth) return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })

  const byteLength = Number(body.byteLength || 0)
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return NextResponse.json({ ok: false, message: 'byteLength không hợp lệ' }, { status: 400 })
  }
  if (byteLength > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, message: `Gói vượt giới hạn ${Math.floor(MAX_BYTES / 1048576)} MiB` },
      { status: 400 },
    )
  }

  const checksumSha256 = String(body.checksumSha256 || '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(checksumSha256)) {
    return NextResponse.json({ ok: false, message: 'checksumSha256 không hợp lệ' }, { status: 400 })
  }

  const profileCount = Math.max(0, Math.floor(Number(body.profileCount || 0)))
  if (profileCount <= 0) {
    return NextResponse.json({ ok: false, message: 'profileCount phải > 0' }, { status: 400 })
  }

  const admin = adminClient()
  const safeTail = `${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.zmb`
  const objectPath = `${auth.userId}/${safeTail}`

  const { data: signed, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(objectPath, { upsert: true })

  if (error || !signed?.signedUrl || !signed.token) {
    return NextResponse.json(
      { ok: false, message: error?.message || 'Không tạo được signed upload URL (bucket cloud-backups đã tạo chưa?)' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    bucket: BUCKET,
    objectPath,
    signedUrl: signed.signedUrl,
    token: signed.token,
    byteLength,
    checksumSha256,
    profileCount,
  })
}

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { adminClient, serverClient } from '@/lib/supabase'

/* POST /api/extension-import
 *
 * Chrome extension AutoZalo Bridge gọi endpoint này sau khi user đăng nhập
 * Zalo Web trong cửa sổ incognito. Body chứa cookies + localStorage +
 * sessionIdentity được trích từ chat.zalo.me. Server lưu thành một row
 * `web_sessions` thuộc về user hiện tại; Electron app pull về để mở thẳng
 * profile mà không cần quét QR.
 *
 * Auth — hai cách (chọn 1):
 *   1. Header `Authorization: Bearer <sb-access-token>` → server biết user.
 *   2. Header `Authorization: Apikey <EXTENSION_IMPORT_SECRET>` cho luồng
 *      headless test. Khi dùng cách này, body PHẢI chứa `userEmail` để
 *      server resolve user.
 *
 * Body shape (lấy từ extension AutoZalo Bridge):
 *   {
 *     userEmail?: string,
 *     displayName: string,
 *     account: {
 *       me: { ... },          // optional, dùng để tự sinh displayName nếu thiếu
 *       zUuid: string,        // sh_z_uuid hoặc z_uuid
 *       cookies: [...],
 *       localStorage: { ... },
 *       sessionInfo?: { ... }
 *     }
 *   }
 */

interface IncomingPayload {
  userEmail?: string
  displayName?: string
  account?: {
    me?: { displayName?: string; zaloName?: string; userId?: string }
    zUuid?: string
    cookies?: any[]
    localStorage?: Record<string, string>
    sessionInfo?: any
  }
}

async function resolveUserId(req: NextRequest, body: IncomingPayload): Promise<{ userId: string | null; email: string | null; reason?: string }> {
  const auth = req.headers.get('authorization') || ''
  const m = auth.match(/^(\w+)\s+(.+)$/)
  if (!m) return { userId: null, email: null, reason: 'missing-auth' }
  const scheme = m[1].toLowerCase()
  const value = m[2].trim()

  if (scheme === 'bearer') {
    const supabase = serverClient(value)
    const { data, error } = await supabase.auth.getUser(value)
    if (error || !data?.user?.id) return { userId: null, email: null, reason: 'invalid-token' }
    return { userId: data.user.id, email: data.user.email || null }
  }

  if (scheme === 'apikey') {
    const expected = String(process.env.EXTENSION_IMPORT_SECRET || '').trim()
    if (!expected) return { userId: null, email: null, reason: 'apikey-not-configured' }
    const a = Buffer.from(value.padEnd(64, '0'))
    const b = Buffer.from(expected.padEnd(64, '0'))
    if (!crypto.timingSafeEqual(a, b) || value.length !== expected.length) {
      return { userId: null, email: null, reason: 'wrong-apikey' }
    }
    const email = String(body.userEmail || '').trim().toLowerCase()
    if (!email) return { userId: null, email: null, reason: 'apikey-missing-email' }
    const admin = adminClient()
    const { data, error } = await admin.from('users').select('id, email').eq('email', email).maybeSingle()
    if (error || !data?.id) return { userId: null, email, reason: 'user-not-found' }
    return { userId: data.id, email: data.email }
  }

  return { userId: null, email: null, reason: 'unsupported-scheme' }
}

export async function POST(req: NextRequest) {
  let body: IncomingPayload
  try { body = (await req.json()) as IncomingPayload } catch { return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 }) }

  const auth = await resolveUserId(req, body)
  if (!auth.userId) {
    return NextResponse.json({ ok: false, message: 'Không xác thực được người dùng', reason: auth.reason }, { status: 401 })
  }

  const account = body.account || {}
  const zUuid = String(account.zUuid || '').trim()
  const cookies = Array.isArray(account.cookies) ? account.cookies : []
  if (!zUuid || cookies.length === 0) {
    return NextResponse.json({ ok: false, message: 'Payload thiếu zUuid hoặc cookies' }, { status: 400 })
  }

  const displayName = String(
    body.displayName
      || account.me?.zaloName
      || account.me?.displayName
      || `Zalo ${zUuid.slice(0, 6)}`
  ).slice(0, 100)

  const admin = adminClient()
  // Insert (or upsert) — schema for web_sessions table is created in
  // 0001_init.sql migration. Until that table exists we still return ok=true
  // so extension does not retry-bomb; the audit log captures the attempt.
  const insertPayload = {
    user_id: auth.userId,
    z_uuid: zUuid,
    display_name: displayName,
    cookies,
    local_storage: account.localStorage || {},
    session_info: account.sessionInfo || null,
  }

  const { data, error } = await admin
    .from('web_sessions')
    .upsert(insertPayload, { onConflict: 'user_id,z_uuid' })
    .select('id, display_name, z_uuid, created_at, updated_at')
    .single()

  if (error) {
    // Fallback: log payload size to audit so we can debug missing table issues.
    await admin.from('audit_log').insert({
      actor_id: auth.userId,
      action: 'extension-import-failed',
      detail: { reason: error.message, displayName, cookieCount: cookies.length },
    })
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  await admin.from('audit_log').insert({
    actor_id: auth.userId,
    action: 'extension-import',
    detail: { sessionId: data?.id, displayName, cookieCount: cookies.length, zUuid },
  })

  return NextResponse.json({
    ok: true,
    session: {
      id: data?.id,
      displayName: data?.display_name,
      zUuid: data?.z_uuid,
      updatedAt: data?.updated_at,
    },
  })
}

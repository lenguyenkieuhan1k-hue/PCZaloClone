import { NextRequest, NextResponse } from 'next/server'
import { adminClient } from '@/lib/supabase'

/* POST /api/heartbeat
 *
 * Body: { sessionId: string }
 * Returns: { ok: 'ok' | 'kicked' | 'expired' }
 *
 * Client polls every ~30s. If sessionId no longer matches the license's
 * active_session_id, server reports 'kicked' and client closes itself. */

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 }) }

  const sessionId = String(body.sessionId || '').trim()
  if (!sessionId) return NextResponse.json({ ok: false, message: 'Thiếu sessionId' }, { status: 400 })

  const admin = adminClient()
  const { data: sessionRow, error } = await admin
    .from('sessions')
    .select('id, license_id, ended_at')
    .eq('id', sessionId)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  if (!sessionRow) return NextResponse.json({ status: 'kicked' })

  const { data: license } = await admin
    .from('licenses')
    .select('id, active_session_id, expires_at, status')
    .eq('id', sessionRow.license_id)
    .maybeSingle()
  if (!license) return NextResponse.json({ status: 'kicked' })

  if (license.status !== 'active') return NextResponse.json({ status: 'expired' })
  if (new Date(license.expires_at).getTime() < Date.now()) return NextResponse.json({ status: 'expired' })
  if (license.active_session_id !== sessionId) return NextResponse.json({ status: 'kicked' })
  if (sessionRow.ended_at) return NextResponse.json({ status: 'kicked' })

  // Bump last_seen_at — used in dashboard "last active" display.
  await admin.from('sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', sessionId)
  return NextResponse.json({ status: 'ok' })
}

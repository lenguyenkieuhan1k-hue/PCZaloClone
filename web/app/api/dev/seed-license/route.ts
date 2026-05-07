import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { adminClient } from '@/lib/supabase'
import { PLAN_TIERS, DURATION_DAYS, type Duration } from '@/lib/plans'

interface SeedBody {
  userId?: string
  email?: string
  tierId?: string
  duration?: Duration
}

function makeFallbackKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = 'ZM-'
  for (let i = 0; i < 16; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)]
    if (i === 3 || i === 7 || i === 11) out += '-'
  }
  return out
}

function safeSecretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided || '').trim())
  const b = Buffer.from(String(expected || '').trim())
  const len = Math.max(a.length, b.length, 1)
  const ap = Buffer.alloc(len)
  const bp = Buffer.alloc(len)
  a.copy(ap)
  b.copy(bp)
  return crypto.timingSafeEqual(ap, bp) && a.length === b.length
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ ok: false, message: 'Not found' }, { status: 404 })
  }

  const expected = String(process.env.DEV_SEED_SECRET || '').trim()
  if (!expected) {
    return NextResponse.json({ ok: false, message: 'DEV_SEED_SECRET chưa cấu hình' }, { status: 500 })
  }

  const provided = String(req.headers.get('x-dev-seed-secret') || '').trim()
  if (!safeSecretEquals(provided, expected)) {
    return NextResponse.json({ ok: false, message: 'Sai dev seed secret' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as SeedBody
  const tierId = String(body?.tierId || 'tier-6').trim().toLowerCase()
  const duration = String(body?.duration || '1m').trim().toLowerCase() as Duration

  const tier = PLAN_TIERS.find((x) => x.id === tierId)
  if (!tier) return NextResponse.json({ ok: false, message: 'tierId không hợp lệ' }, { status: 400 })
  if (!Object.prototype.hasOwnProperty.call(DURATION_DAYS, duration)) {
    return NextResponse.json({ ok: false, message: 'duration không hợp lệ' }, { status: 400 })
  }

  const admin = adminClient()
  let userId = String(body?.userId || '').trim()
  const email = String(body?.email || '').trim().toLowerCase()

  if (!userId) {
    if (!email) return NextResponse.json({ ok: false, message: 'Thiếu userId hoặc email' }, { status: 400 })
    const { data: userRow, error: userErr } = await admin
      .from('users')
      .select('id,email')
      .eq('email', email)
      .maybeSingle()
    if (userErr) return NextResponse.json({ ok: false, message: userErr.message }, { status: 500 })
    if (!userRow?.id) return NextResponse.json({ ok: false, message: 'Không tìm thấy user theo email' }, { status: 404 })
    userId = userRow.id
  }

  const { data: keyResp } = await admin.rpc('generate_license_key')
  const key = String(keyResp || makeFallbackKey())

  const expiresAt = new Date(Date.now() + DURATION_DAYS[duration] * 24 * 60 * 60 * 1000).toISOString()
  const { data: created, error: createErr } = await admin
    .from('licenses')
    .insert({
      user_id: userId,
      key,
      tier_id: tier.id,
      account_quota: tier.accountQuota,
      duration,
      expires_at: expiresAt,
      status: 'active',
    })
    .select('id,key,tier_id,account_quota,duration,expires_at,status,user_id')
    .single()

  if (createErr || !created) {
    return NextResponse.json({ ok: false, message: createErr?.message || 'Không tạo được license test' }, { status: 500 })
  }

  await admin.from('audit_log').insert({
    actor_id: userId,
    license_id: created.id,
    action: 'dev-seed-license',
    detail: { tierId: tier.id, duration },
  })

  return NextResponse.json({ ok: true, license: created })
}

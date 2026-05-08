import { NextRequest, NextResponse } from 'next/server'
import { serverClient } from '@/lib/supabase'
import { parseMemo, canonicalKey, normalizeMemoText } from '@/lib/memo'
import type { Duration } from '@/lib/plans'

/* GET /api/payment-status?memo=<memo>
 *
 * Polled by checkout/PaymentWatcher every few seconds. Returns the payment
 * row matching the user + memo within the last 24h.
 *
 * Match precedence:
 *   1. canonical key (userId8|tier|duration) parsed by web/lib/memo.ts —
 *      same parser the SePay webhook uses. As long as both sides see a
 *      complete "ZM <id> <tier> <duration>" triple anywhere in the memo,
 *      they will produce the same key.
 *   2. recency fallback — if no canonical match but the user has a
 *      status='paid' payment of the SAME tier+duration created in the last
 *      30 minutes, treat it as the same checkout. Closes the race where
 *      SePay wrote a memo we can't parse but the webhook still issued a
 *      license correctly.
 *   3. raw substring fallback — same lowercased string match, last resort.
 *
 * Auth: requires sb-access-token cookie (user must be signed in). */

const RECENCY_WINDOW_MS = 30 * 60 * 1000   // 30 minutes

function asDuration(value: unknown): Duration | null {
  const v = String(value || '').toLowerCase()
  return ['1m', '3m', '6m', '1y'].includes(v) ? (v as Duration) : null
}

export async function GET(req: NextRequest) {
  const memo = String(req.nextUrl.searchParams.get('memo') || '').trim()
  const startedAtRaw = String(req.nextUrl.searchParams.get('startedAt') || '').trim()
  const startedAtMs = Number(startedAtRaw)
  const validStartedAt = Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : null
  if (!memo) return NextResponse.json({ ok: false, message: 'Thiếu memo' }, { status: 400 })

  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) return NextResponse.json({ ok: false, status: 'unauthorized' }, { status: 401 })

  const userClient = serverClient(accessToken)
  const { data: authData, error: authErr } = await userClient.auth.getUser(accessToken)
  if (authErr || !authData?.user?.id) {
    return NextResponse.json({ ok: false, status: 'unauthorized' }, { status: 401 })
  }

  const userId = authData.user.id
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: rows, error } = await userClient
    .from('payments')
    .select('id, status, memo, license_id, tier_id, duration, created_at, paid_at, sepay_txn_id')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  const targetKey = canonicalKey(memo)
  const targetParsed = parseMemo(memo)
  const target = normalizeMemoText(memo)
  // Only match payments whose row was CREATED after this checkout session started.
  // We use created_at (webhook insert time) with a small forward grace of 30s
  // for clock skew — but NO backward grace, so a payment from a previous session
  // (same tier/duration) never auto-matches a fresh checkout.
  const currentCheckoutWindowStart = validStartedAt ? (validStartedAt - 30 * 1000) : null

  const candidateRows = (rows || []).filter((row) => {
    if (!currentCheckoutWindowStart) return true
    const ts = Date.parse(String(row.created_at || ''))
    if (!Number.isFinite(ts)) return false
    return ts >= currentCheckoutWindowStart
  })

  // -- Stage 1: canonical key match (most reliable) --
  let matched = candidateRows.find((row) => {
    const got = canonicalKey(String(row.memo || ''))
    return targetKey && got && got === targetKey
  })

  // -- Stage 2: recency fallback —
  // user matched, paid, same tier+duration column values, recent.
  if (!matched && targetParsed) {
    const recencyCutoff = Date.now() - RECENCY_WINDOW_MS
    matched = candidateRows.find((row) => {
      if (row.status !== 'paid') return false
      const rowTier = String(row.tier_id || '').toLowerCase()
      const rowDuration = asDuration(row.duration)
      if (!rowTier || !rowDuration) return false
      if (rowTier !== targetParsed.tierId) return false
      if (rowDuration !== targetParsed.duration) return false
      const created = Date.parse(String(row.created_at || ''))
      const paid = Date.parse(String(row.paid_at || row.created_at || ''))
      const ts = isFinite(paid) ? paid : created
      return isFinite(ts) && ts >= recencyCutoff
    })
  }

  // -- Stage 3: raw substring fallback (legacy) --
  if (!matched) {
    matched = candidateRows.find((row) => {
      const got = normalizeMemoText(String(row.memo || ''))
      if (!got) return false
      return got === target || got.includes(target) || target.includes(got)
    })
  }

  if (!matched) {
    return NextResponse.json({
      ok: true,
      status: 'pending',
      matched: false,
      // dev-only diag — helps when log access is limited.
      diag: process.env.NODE_ENV !== 'production' ? {
        targetKey,
        rowCount: rows?.length || 0,
        candidateCount: candidateRows.length,
        startedAtMs: validStartedAt,
        rowKeys: (rows || []).map((r) => canonicalKey(String(r.memo || ''))).slice(0, 10),
      } : undefined,
    })
  }

  const status = matched.status === 'paid' ? 'paid'
    : matched.status === 'failed' ? 'failed'
    : 'pending'

  return NextResponse.json({
    ok: true,
    status,
    matched: true,
    licenseId: matched.license_id || null,
    paidAt: matched.paid_at || null,
  })
}

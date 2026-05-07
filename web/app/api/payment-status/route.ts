import { NextRequest, NextResponse } from 'next/server'
import { serverClient } from '@/lib/supabase'

/* GET /api/payment-status?memo=<memo>
 *
 * Polled by checkout/PaymentWatcher every few seconds. Returns the payment
 * row matching the user + memo within the last 24h.
 *
 * Auth: requires sb-access-token cookie (user must be signed in). */

function normalizeMemo(input: string): string {
  return String(input || '')
    .replace(/[^A-Za-z0-9\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

export async function GET(req: NextRequest) {
  const memo = String(req.nextUrl.searchParams.get('memo') || '').trim()
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
    .select('id, status, memo, license_id, created_at, paid_at, sepay_txn_id')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(25)

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 })

  const target = normalizeMemo(memo)
  const matched = (rows || []).find((row) => {
    const got = normalizeMemo(String(row.memo || ''))
    if (!got) return false
    return got === target || got.includes(target) || target.includes(got)
  })

  if (!matched) return NextResponse.json({ ok: true, status: 'pending', matched: false })
  return NextResponse.json({
    ok: true,
    status: matched.status === 'paid' ? 'paid'
      : matched.status === 'failed' ? 'failed'
      : 'pending',
    matched: true,
    licenseId: matched.license_id || null,
    paidAt: matched.paid_at || null,
  })
}

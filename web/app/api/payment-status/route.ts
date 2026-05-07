import { NextRequest, NextResponse } from 'next/server'
import { serverClient } from '@/lib/supabase'

/* GET /api/payment-status?memo=<memo>
 *
 * Polled by checkout/PaymentWatcher every few seconds. Returns the payment
 * row matching the user + memo within the last 24h.
 *
 * Auth: requires sb-access-token cookie (user must be signed in). */

function normalizeMemo(input: string): string {
  let normalized = String(input || '')
    .replace(/[^A-Za-z0-9\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
  
  // Handle tier ID variants: TIERTEST1K → TIER TEST 1K, TIER6 → TIER 6, etc.
  // This handles the case where SePay sends "TIERTEST1K" but we normalize QR memo as "TIER TEST 1K"
  normalized = normalized.replace(/TIER([A-Z0-9]+)(\d+[A-Z]?)/g, (match, part1, part2) => {
    return `TIER ${part1} ${part2}`
  })
  // Also handle: TIER[num] → TIER [num]
  normalized = normalized.replace(/TIER(\d+)/g, 'TIER $1')
  
  return normalized
}

export async function GET(req: NextRequest) {
  const LOG_PREFIX = '[PAYMENT-STATUS-DEBUG]'
  const memo = String(req.nextUrl.searchParams.get('memo') || '').trim()
  console.error(`${LOG_PREFIX} Query received: memo="${memo}", timestamp=${new Date().toISOString()}`)
  
  if (!memo) {
    console.error(`${LOG_PREFIX} ERROR: Missing memo parameter`)
    return NextResponse.json({ ok: false, message: 'Thiếu memo' }, { status: 400 })
  }

  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) {
    console.error(`${LOG_PREFIX} ERROR: No access token cookie`)
    return NextResponse.json({ ok: false, status: 'unauthorized' }, { status: 401 })
  }

  const userClient = serverClient(accessToken)
  const { data: authData, error: authErr } = await userClient.auth.getUser(accessToken)
  if (authErr || !authData?.user?.id) {
    console.error(`${LOG_PREFIX} ERROR: Auth failed:`, authErr)
    return NextResponse.json({ ok: false, status: 'unauthorized' }, { status: 401 })
  }

  const userId = authData.user.id
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  console.error(`${LOG_PREFIX} Querying for userId=${userId}, since=${sinceIso}`)

  const { data: rows, error } = await userClient
    .from('payments')
    .select('id, status, memo, license_id, created_at, paid_at, sepay_txn_id')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(25)

  if (error) {
    console.error(`${LOG_PREFIX} ERROR: DB query failed:`, error)
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 })
  }

  console.error(`${LOG_PREFIX} DB returned ${rows?.length || 0} payment rows`)
  if (rows && rows.length > 0) {
    console.error(`${LOG_PREFIX} Payment rows:`, JSON.stringify(rows.slice(0, 3), null, 2))
  }

  const target = normalizeMemo(memo)
  console.error(`${LOG_PREFIX} Normalized target memo: "${target}"`)
  
  const matchedRows = (rows || []).filter((row) => {
    const got = normalizeMemo(String(row.memo || ''))
    if (!got) return false
    const match = got === target || got.includes(target) || target.includes(got)
    console.error(`${LOG_PREFIX} Comparing: got="${got}" vs target="${target}" → ${match}`)
    return match
  })

  console.error(`${LOG_PREFIX} Matched ${matchedRows.length} rows`)

  const matched =
    matchedRows.find((row) => row.status === 'paid') ||
    matchedRows.find((row) => row.status === 'failed') ||
    matchedRows[0]

  if (!matched) {
    console.error(`${LOG_PREFIX} No match found. Returning pending.`)
    return NextResponse.json({ ok: true, status: 'pending', matched: false })
  }
  
  const finalStatus = matched.status === 'paid' ? 'paid'
    : matched.status === 'failed' ? 'failed'
    : 'pending'
  
  console.error(`${LOG_PREFIX} MATCHED! Returning status='${finalStatus}', licenseId=${matched.license_id}, paid_at=${matched.paid_at}`)
  
  return NextResponse.json({
    ok: true,
    status: finalStatus,
    matched: true,
    licenseId: matched.license_id || null,
    paidAt: matched.paid_at || null,
  })
}

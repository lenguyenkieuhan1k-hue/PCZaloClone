import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { adminClient } from '@/lib/supabase'
import { PLAN_TIERS, DURATION_DAYS, type Duration } from '@/lib/plans'
import { Resend } from 'resend'

/* POST /api/sepay-webhook
 *
 * SePay calls this with a JSON body when a bank transfer matching one of our
 * accounts arrives. We parse the memo (format: ZM-<userId>-<tier>-<duration>),
 * issue a license, mark payment paid, email the key.
 *
 * SePay docs: https://sepay.vn/docs/webhook
 *
 * Security: verify HMAC signature in `Authorization: Apikey <secret>` header.
 * Anyone can hit this URL — without the right secret they can't forge a
 * payment. */

interface SePayPayload {
  id: number
  gateway: string
  transactionDate: string
  accountNumber: string
  content: string                  // bank transfer memo
  transferType: 'in' | 'out'
  transferAmount: number           // VND
  referenceCode: string
  description?: string
}

function parseMemo(memo: string): { userId: string; tierId: string; duration: Duration } | null {
  // Expected format: ZM <uuidShort> <tier> <duration>
  // We're lenient — any whitespace separator + uppercase normalize.
  const cleaned = String(memo || '').replace(/[^A-Za-z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase()
  const match = cleaned.match(/ZM[ \-]?([A-F0-9]{8})[ \-]?(TIER-\d+)[ \-]?(1M|3M|6M|1Y)/)
  if (!match) return null
  return { userId: match[1].toLowerCase(), tierId: match[2].toLowerCase(), duration: match[3].toLowerCase() as Duration }
}

export async function POST(req: NextRequest) {
  const expected = process.env.SEPAY_WEBHOOK_SECRET
  if (!expected) return NextResponse.json({ ok: false, message: 'Webhook secret chưa cấu hình' }, { status: 500 })

  const auth = req.headers.get('authorization') || ''
  const provided = auth.replace(/^Apikey\s+/i, '').trim()
  if (!crypto.timingSafeEqual(Buffer.from(provided.padEnd(64, '0')), Buffer.from(expected.padEnd(64, '0')))) {
    return NextResponse.json({ ok: false, message: 'Sai secret' }, { status: 401 })
  }

  const payload = await req.json().catch(() => null) as SePayPayload | null
  if (!payload || payload.transferType !== 'in') {
    return NextResponse.json({ ok: true, ignored: true })
  }

  const memo = parseMemo(payload.content || payload.description || '')
  if (!memo) {
    // Log unmatched payment so admin can match manually later.
    await adminClient().from('payments').insert({
      amount_vnd: payload.transferAmount,
      sepay_txn_id: String(payload.id),
      memo: payload.content,
      status: 'pending'
    })
    return NextResponse.json({ ok: true, matched: false })
  }

  const tier = PLAN_TIERS.find(t => t.id === memo.tierId)
  if (!tier) return NextResponse.json({ ok: false, message: 'Tier không hợp lệ' }, { status: 400 })
  const expectedAmount = tier.prices[memo.duration]
  if (payload.transferAmount < expectedAmount) {
    await adminClient().from('payments').insert({
      amount_vnd: payload.transferAmount,
      sepay_txn_id: String(payload.id),
      memo: payload.content,
      tier_id: tier.id,
      duration: memo.duration,
      status: 'failed'
    })
    return NextResponse.json({ ok: false, message: 'Số tiền không đủ' }, { status: 400 })
  }

  const admin = adminClient()
  // Resolve full user UUID from short prefix.
  const { data: userMatch } = await admin.from('users').select('id, email, display_name').like('id', `${memo.userId}%`).limit(2)
  if (!userMatch || userMatch.length !== 1) {
    await admin.from('payments').insert({
      amount_vnd: payload.transferAmount,
      sepay_txn_id: String(payload.id),
      memo: payload.content,
      tier_id: tier.id,
      duration: memo.duration,
      status: 'pending'  // admin resolves manually
    })
    return NextResponse.json({ ok: true, matched: false, reason: 'ambiguous-user' })
  }
  const user = userMatch[0]

  // Generate key + create license + mark payment.
  const { data: keyResp } = await admin.rpc('generate_license_key')
  const licenseKey = String(keyResp || ('ZM-' + crypto.randomBytes(8).toString('hex').toUpperCase()))
  const days = DURATION_DAYS[memo.duration]
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()

  const { data: license, error: licErr } = await admin.from('licenses').insert({
    user_id: user.id,
    key: licenseKey,
    tier_id: tier.id,
    account_quota: tier.accountQuota,
    duration: memo.duration,
    expires_at: expiresAt,
    status: 'active'
  }).select('id').single()
  if (licErr) return NextResponse.json({ ok: false, message: licErr.message }, { status: 500 })

  await admin.from('payments').insert({
    user_id: user.id,
    license_id: license.id,
    tier_id: tier.id,
    duration: memo.duration,
    amount_vnd: payload.transferAmount,
    sepay_txn_id: String(payload.id),
    memo: payload.content,
    status: 'paid',
    paid_at: new Date().toISOString()
  })

  await admin.from('audit_log').insert({
    actor_id: user.id,
    license_id: license.id,
    action: 'create-via-sepay',
    detail: { sepay_txn_id: payload.id, amount: payload.transferAmount }
  })

  // Send email with the key. Wrap in try so the webhook still 200s even if
  // email is down — admin can resend manually.
  try {
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY)
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'ZaloMask <noreply@zalomask.com>',
        to: user.email,
        subject: 'License ZaloMask của bạn',
        html: `<p>Chào ${user.display_name || ''},</p>
               <p>Cảm ơn bạn đã mua. Đây là license key của bạn:</p>
               <p style="font-family:monospace;font-size:18px;background:#f4f4f4;padding:10px 14px;border-radius:6px"><strong>${licenseKey}</strong></p>
               <p>Gói: ${tier.label} • Thời hạn: ${memo.duration} • Hết hạn: ${new Date(expiresAt).toLocaleDateString('vi-VN')}</p>
               <p>Cách dùng: mở ZaloMask → Cài đặt → License → dán key vào.</p>
               <p>Hỗ trợ: <a href="https://zalo.me/0981897779">Zalo 0981897779</a> hoặc Telegram @zalomask.</p>`
      })
    }
  } catch (e) {
    // Best-effort: ignore.
  }

  return NextResponse.json({ ok: true, licenseId: license.id })
}

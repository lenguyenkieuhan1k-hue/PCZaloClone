import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { adminClient } from '@/lib/supabase'
import { PLAN_TIERS, DURATION_DAYS, type Duration } from '@/lib/plans'
import { Resend } from 'resend'

/* POST /api/sepay-webhook
 *
 * SePay calls this with a JSON body when a bank transfer matching one of our
 * accounts arrives. We parse the memo (format: ZM <userId8> <tier> <duration>),
 * issue a license, mark payment paid, email the key.
 *
 * SePay docs: https://sepay.vn/docs/webhook
 *
 * Security: secret in either `Authorization: Apikey <secret>` header or
 *           `?secret=<secret>` query param (some providers can only do one).
 *
 * Idempotency: SePay retries on non-2xx for up to ~24h. We dedupe by
 *   sepay_txn_id BEFORE any insert/license-create, so a retry of a paid
 *   transaction returns ok=true with the existing licenseId without
 *   duplicating either the payment row or the license. Failed/pending rows
 *   are likewise reused. */

interface SePayPayload {
  id: number | string
  gateway?: string
  transactionDate?: string
  accountNumber?: string
  content?: string
  transferType?: 'in' | 'out'
  transferAmount?: number
  referenceCode?: string
  description?: string
}

function parseMemo(memo: string): { userId: string; tierId: string; duration: Duration } | null {
  // Tolerate spaces, dashes, mixed case, surrounding noise.
  const cleaned = String(memo || '')
    .replace(/[^A-Za-z0-9 \-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
  const match = cleaned.match(/ZM[ \-]?([A-F0-9]{8})[ \-]?(TIER[A-Z0-9\-]+)[ \-]?(1M|3M|6M|1Y)/)
  if (!match) return null
  let tierId = match[2].toLowerCase()
  // Backward-compat: TIER6 -> tier-6
  if (/^tier\d/.test(tierId)) {
    tierId = tierId.replace(/^tier(\d)/, 'tier-$1')
  }
  // Normalize missing dash after "tier" for custom ids.
  if (!tierId.startsWith('tier-') && tierId.startsWith('tier')) {
    tierId = `tier-${tierId.slice(4).replace(/^-+/, '')}`
  }
  return { userId: match[1].toLowerCase(), tierId, duration: match[3].toLowerCase() as Duration }
}

function ok(extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: true, ...extra })
}

function safeSecretEquals(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const expected = String(process.env.SEPAY_WEBHOOK_SECRET || '').trim()
  if (!expected) {
    return NextResponse.json({ ok: false, message: 'Webhook secret chưa cấu hình' }, { status: 500 })
  }

  const auth = req.headers.get('authorization') || ''
  const headerSecret = auth
    .replace(/^Apikey\s+/i, '')
    .replace(/^Bearer\s+/i, '')
    .trim()
  const querySecret = String(req.nextUrl.searchParams.get('secret') || '').trim()
  const provided = headerSecret || querySecret
  if (!safeSecretEquals(provided, expected)) {
    return NextResponse.json({ ok: false, message: 'Sai secret' }, { status: 401 })
  }

  const payload = (await req.json().catch(() => null)) as SePayPayload | null
  if (!payload) return NextResponse.json({ ok: false, message: 'Bad JSON' }, { status: 400 })

  // SePay reports both inbound and outbound on some accounts — only react to inbound.
  if (payload.transferType !== 'in') return ok({ ignored: 'non-inbound' })

  const sepayTxnId = String(payload.id || '').trim()
  if (!sepayTxnId) return ok({ ignored: 'missing-txn-id' })

  const admin = adminClient()

  // -- Idempotency check: have we already processed this transaction? --
  const { data: existing } = await admin
    .from('payments')
    .select('id, status, license_id, sepay_txn_id, method, user_id')
    .eq('sepay_txn_id', sepayTxnId)
    .maybeSingle()

  if (existing) {
    // Handle upgrade payment
    if (existing.method === 'upgrade' && existing.status === 'pending') {
      // Activate the new license
      const { data: newLicense } = await admin
        .from('licenses')
        .update({ status: 'active' })
        .eq('id', existing.license_id)
        .select('id, key, tier_id, duration, expires_at')
        .single()

      // Mark payment as paid
      await admin.from('payments').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', existing.id)

      // Get user for email
      const { data: user } = await admin.from('users').select('email, display_name').eq('id', existing.user_id).single()
      
      // Send email — best effort
      try {
        if (process.env.RESEND_API_KEY && user) {
          const resend = new Resend(process.env.RESEND_API_KEY)
          const tier = PLAN_TIERS.find((t) => t.id === newLicense?.tier_id)
          await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'ZaloMask <noreply@zalomask.com>',
            to: user.email,
            subject: 'Nâng cấp License ZaloMask thành công',
            html: `<p>Chào ${user.display_name || ''},</p>
                   <p>Nâng cấp license của bạn đã hoàn tất! 🎉</p>
                   <p>Key mới: <strong style="font-family:monospace">${newLicense?.key}</strong></p>
                   <p>Gói: ${tier?.label} • Hết hạn: ${new Date(newLicense?.expires_at || '').toLocaleDateString('vi-VN')}</p>
                   <p>Cập nhật key trong app: Cài đặt → License → xoá key cũ → dán key mới.</p>`,
          })
        }
      } catch {
        // ignore
      }

      return ok({ duplicate: true, licenseId: existing.license_id })
    }

    // Handle renewal payment
    if (existing.method === 'renewal' && existing.status === 'pending') {
      // Get current license to calculate new expiry
      const { data: currentLicense } = await admin
        .from('licenses')
        .select('id, key, tier_id, duration, expires_at')
        .eq('id', existing.license_id)
        .single()

      if (currentLicense) {
        const days = DURATION_DAYS[currentLicense.duration as Duration]
        const currentExpires = new Date(currentLicense.expires_at)
        const newExpires = new Date(currentExpires)
        newExpires.setDate(newExpires.getDate() + days)

        // Update license expiry
        await admin
          .from('licenses')
          .update({ expires_at: newExpires.toISOString() })
          .eq('id', existing.license_id)

        // Mark payment as paid
        await admin.from('payments').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', existing.id)

        // Get user for email
        const { data: user } = await admin.from('users').select('email, display_name').eq('id', existing.user_id).single()
        
        // Send email — best effort
        try {
          if (process.env.RESEND_API_KEY && user) {
            const resend = new Resend(process.env.RESEND_API_KEY)
            const tier = PLAN_TIERS.find((t) => t.id === currentLicense.tier_id)
            await resend.emails.send({
              from: process.env.RESEND_FROM_EMAIL || 'ZaloMask <noreply@zalomask.com>',
              to: user.email,
              subject: 'Gia hạn License ZaloMask thành công',
              html: `<p>Chào ${user.display_name || ''},</p>
                     <p>Gia hạn license của bạn đã hoàn tất! ✓</p>
                     <p>Key: <strong style="font-family:monospace">${currentLicense.key}</strong></p>
                     <p>Gói: ${tier?.label} • Hạn mới: ${newExpires.toLocaleDateString('vi-VN')}</p>
                     <p>License sẽ tự động cập nhật trong app.</p>`,
            })
          }
        } catch {
          // ignore
        }
      }

      return ok({ duplicate: true, licenseId: existing.license_id })
    }

    // Handle existing new purchase payment
    if (existing.status === 'paid' && existing.license_id) {
      return ok({ duplicate: true, licenseId: existing.license_id })
    }
    // pending / failed — let it fall through and reprocess (user may have topped up)
  }

  const memo = parseMemo(String(payload.content || payload.description || ''))
  const rawAmount = Number(payload.transferAmount || 0)
  const memoText = String(payload.content || payload.description || '').slice(0, 500)

  if (!memo) {
    // Unmatched — store as pending so admin can resolve manually.
    await upsertPaymentRow(admin, sepayTxnId, {
      amount_vnd: rawAmount,
      memo: memoText,
      status: 'pending',
    }, existing?.id)
    return ok({ matched: false, reason: 'no-memo' })
  }

  const tier = PLAN_TIERS.find((t) => t.id === memo.tierId)
  if (!tier) {
    await upsertPaymentRow(admin, sepayTxnId, {
      amount_vnd: rawAmount,
      memo: memoText,
      status: 'failed',
      tier_id: memo.tierId,
      duration: memo.duration,
    }, existing?.id)
    return NextResponse.json({ ok: false, message: 'Tier không hợp lệ', tier: memo.tierId }, { status: 400 })
  }

  const expectedAmount = tier.prices[memo.duration]
  if (rawAmount < expectedAmount) {
    await upsertPaymentRow(admin, sepayTxnId, {
      amount_vnd: rawAmount,
      memo: memoText,
      status: 'failed',
      tier_id: tier.id,
      duration: memo.duration,
    }, existing?.id)
    return ok({ matched: true, accepted: false, reason: 'insufficient-amount', expected: expectedAmount, got: rawAmount })
  }

  // Resolve user from short prefix. Could be ambiguous → record pending.
  const { data: userMatch } = await admin
    .from('users')
    .select('id, email, display_name')
    .like('id', `${memo.userId}%`)
    .limit(2)

  if (!userMatch || userMatch.length !== 1) {
    await upsertPaymentRow(admin, sepayTxnId, {
      amount_vnd: rawAmount,
      memo: memoText,
      status: 'pending',
      tier_id: tier.id,
      duration: memo.duration,
    }, existing?.id)
    return ok({ matched: true, accepted: false, reason: userMatch?.length ? 'ambiguous-user' : 'user-not-found' })
  }
  const user = userMatch[0]

  // -- Mint license --
  const { data: keyResp } = await admin.rpc('generate_license_key')
  const licenseKey = String(keyResp || ('ZM-' + crypto.randomBytes(8).toString('hex').toUpperCase()))
  const days = DURATION_DAYS[memo.duration]
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()

  const { data: license, error: licErr } = await admin
    .from('licenses')
    .insert({
      user_id: user.id,
      key: licenseKey,
      tier_id: tier.id,
      account_quota: tier.accountQuota,
      duration: memo.duration,
      expires_at: expiresAt,
      status: 'active',
    })
    .select('id')
    .single()
  if (licErr || !license) {
    // Don't 500 to SePay — record as pending and let us debug.
    await upsertPaymentRow(admin, sepayTxnId, {
      user_id: user.id,
      amount_vnd: rawAmount,
      memo: memoText,
      status: 'pending',
      tier_id: tier.id,
      duration: memo.duration,
    }, existing?.id)
    await admin.from('audit_log').insert({
      actor_id: user.id,
      action: 'sepay-license-insert-failed',
      detail: { sepay_txn_id: sepayTxnId, error: licErr?.message || 'no-row' },
    })
    return ok({ matched: true, accepted: false, reason: 'license-insert-failed', error: licErr?.message })
  }

  await upsertPaymentRow(admin, sepayTxnId, {
    user_id: user.id,
    license_id: license.id,
    amount_vnd: rawAmount,
    memo: memoText,
    tier_id: tier.id,
    duration: memo.duration,
    method: 'purchase',
    status: 'paid',
    paid_at: new Date().toISOString(),
  }, existing?.id)

  await admin.from('audit_log').insert({
    actor_id: user.id,
    license_id: license.id,
    action: 'create-via-sepay',
    detail: { sepay_txn_id: sepayTxnId, amount: rawAmount },
  })

  // Send email — best effort. Webhook still 200s if email fails.
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
               <p>Hỗ trợ: <a href="https://zalo.me/0981897779">Zalo 0981897779</a> hoặc Telegram @zalomask.</p>`,
      })
    }
  } catch {
    // ignore — admin can resend
  }

  return ok({ accepted: true, licenseId: license.id })
}

/* Helper: insert a new payments row keyed on sepay_txn_id, or update the
 * existing one in place. Avoids the unique-constraint 500 on retries. */
async function upsertPaymentRow(
  admin: ReturnType<typeof adminClient>,
  sepayTxnId: string,
  fields: Record<string, unknown>,
  existingId: string | undefined,
) {
  if (existingId) {
    await admin.from('payments').update(fields).eq('id', existingId)
    return
  }
  // Insert with sepay_txn_id; if a concurrent webhook beat us to it, the
  // unique constraint will fire — catch & no-op.
  const { error } = await admin
    .from('payments')
    .insert({ sepay_txn_id: sepayTxnId, ...fields })
  if (error && !/duplicate|unique/i.test(error.message || '')) {
    // surface to audit log so we can debug; webhook still continues.
    await admin.from('audit_log').insert({
      action: 'sepay-payment-upsert-failed',
      detail: { sepay_txn_id: sepayTxnId, error: error.message },
    })
  }
}

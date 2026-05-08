import { NextRequest, NextResponse } from 'next/server'
import { serverClient, adminClient } from '@/lib/supabase'
import { PLAN_TIERS, DURATION_DAYS, type Duration } from '@/lib/plans'

interface RenewRequest {
  license_id: string
  duration: Duration
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get('sb-access-token')?.value
  if (!token) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
  }

  const client = serverClient(token)

  try {
    const { data: { user }, error: authError } = await client.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
    }

    const body: RenewRequest = await req.json()
    const { license_id, duration } = body

    if (!license_id || !duration) {
      return NextResponse.json({ ok: false, message: 'Missing required fields' }, { status: 400 })
    }

    // Verify license
    const { data: license, error: licenseError } = await client
      .from('licenses')
      .select('id, user_id, key, tier_id, expires_at, account_quota')
      .eq('id', license_id)
      .single()

    if (licenseError || !license || license.user_id !== user.id) {
      return NextResponse.json({ ok: false, message: 'License not found' }, { status: 404 })
    }

    const expired = new Date(license.expires_at).getTime() <= Date.now()
    if (!expired) {
      return NextResponse.json(
        { ok: false, message: 'Chỉ được gia hạn khi key đã hết hạn.' },
        { status: 400 }
      )
    }

    // Verify tier exists and get price
    const tier = PLAN_TIERS.find((t) => t.id === license.tier_id)
    if (!tier) {
      return NextResponse.json(
        { ok: false, message: 'Gói hiện tại đã ngừng bán. Vui lòng dùng chức năng Nâng cấp tier.' },
        { status: 400 }
      )
    }

    const price = tier.prices[duration]
    const durationDays = DURATION_DAYS[duration]

    // Preview expiry for UI only. Actual expires_at is updated in webhook
    // after payment status changes to paid.
    const currentExpires = new Date(license.expires_at)
    const newExpires = new Date(currentExpires)
    newExpires.setDate(newExpires.getDate() + durationDays)

    const admin = adminClient()

    // Create payment record
    const { data: payment } = await admin
      .from('payments')
      .insert({
        user_id: user.id,
        license_id, // Original license
        tier_id: license.tier_id,
        duration,
        amount_vnd: price,
        method: 'renewal', // Mark as renewal so webhook knows what to do
        status: 'pending', // Awaiting SePay payment
        memo: `Gia hạn ${duration} cho ${license.key}`,
      })
      .select()
      .single()

    return NextResponse.json({
      ok: true,
      message: 'Đã tạo giao dịch gia hạn, vui lòng thanh toán để kích hoạt thêm thời hạn.',
      key: license.key,
      licenseId: license.id, // Return for checkout page
      oldExpires: license.expires_at,
      newExpires: newExpires.toISOString(),
      price,
      payment: payment?.id,
    })
  } catch (error) {
    console.error('[/api/renew-license]', error)
    return NextResponse.json({ ok: false, message: 'Internal server error' }, { status: 500 })
  }
}

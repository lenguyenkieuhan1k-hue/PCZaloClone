import { NextRequest, NextResponse } from 'next/server'
import { serverClient, adminClient } from '@/lib/supabase'
import { PLAN_TIERS, DURATION_DAYS, type Duration } from '@/lib/plans'
import { randomUUID as uuidv4 } from 'node:crypto'

interface UpgradeRequest {
  licenseid?: string
  license_id?: string
  new_tier_id: string
  duration: Duration
}

const DURATION_RANK: Record<Duration, number> = {
  '1m': 1,
  '3m': 2,
  '6m': 3,
  '1y': 4,
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

    const body: UpgradeRequest = await req.json()
    const oldLicenseId = body.license_id || body.licenseid
    const { new_tier_id, duration } = body

    if (!oldLicenseId || !new_tier_id || !duration) {
      return NextResponse.json({ ok: false, message: 'Missing required fields' }, { status: 400 })
    }

    const { data: oldLicense, error: oldLicenseError } = await client
      .from('licenses')
      .select('id, user_id, key, tier_id, duration, expires_at, account_quota')
      .eq('id', oldLicenseId)
      .single()

    if (oldLicenseError || !oldLicense || oldLicense.user_id !== user.id) {
      return NextResponse.json({ ok: false, message: 'Old license not found' }, { status: 404 })
    }

    const newTier = PLAN_TIERS.find((t) => t.id === new_tier_id)
    if (!newTier) {
      return NextResponse.json({ ok: false, message: 'Invalid new tier' }, { status: 400 })
    }

    const oldTier = PLAN_TIERS.find((t) => t.id === oldLicense.tier_id)
    if (!oldTier) {
      return NextResponse.json({ ok: false, message: 'Old tier is invalid' }, { status: 400 })
    }

    const tierUp = newTier.accountQuota > oldTier.accountQuota
    const sameTier = newTier.id === oldTier.id
    const longerDuration = DURATION_RANK[duration] > DURATION_RANK[oldLicense.duration as Duration]

    if (!tierUp && !(sameTier && longerDuration)) {
      return NextResponse.json(
        {
          ok: false,
          message: 'Chỉ được nâng cấp lên gói cao hơn, hoặc cùng gói nhưng thời hạn dài hơn hiện tại.',
        },
        { status: 400 }
      )
    }

    const price = newTier.prices[duration]
    const durationDays = DURATION_DAYS[duration]
    const newExpiresAt = new Date()
    newExpiresAt.setDate(newExpiresAt.getDate() + durationDays)

    const admin = adminClient()
    const newLicenseId = uuidv4()
    const newKey = `ZM-${Date.now().toString(36).toUpperCase().slice(-6)}`

    const { error: createLicenseError } = await admin
      .from('licenses')
      .insert({
        id: newLicenseId,
        user_id: user.id,
        license_id: uuidv4(),
        key: newKey,
        tier_id: new_tier_id,
        account_quota: newTier.accountQuota,
        duration,
        expires_at: newExpiresAt.toISOString(),
        status: 'pending',
        parent_license_id: oldLicenseId,
      })

    if (createLicenseError) {
      return NextResponse.json({ ok: false, message: 'Failed to create new license' }, { status: 500 })
    }

    const { data: oldProfiles, error: getProfilesError } = await admin
      .from('profiles')
      .select('*')
      .eq('license_id', oldLicenseId)

    if (getProfilesError) {
      await admin.from('licenses').delete().eq('id', newLicenseId)
      return NextResponse.json({ ok: false, message: 'Failed to read old profiles' }, { status: 500 })
    }

    let transferCount = 0
    if (oldProfiles && oldProfiles.length > 0) {
      const profilesToInsert = oldProfiles.map((p) => ({
        user_id: user.id,
        license_id: newLicenseId,
        profile_name: p.profile_name,
        display_name: p.display_name,
        metadata: p.metadata,
      }))

      const { error: insertProfilesError } = await admin.from('profiles').insert(profilesToInsert)

      if (insertProfilesError) {
        await admin.from('licenses').delete().eq('id', newLicenseId)
        return NextResponse.json({ ok: false, message: 'Failed to transfer profiles' }, { status: 500 })
      }

      transferCount = oldProfiles.length
    }

    await admin.from('license_upgrades').insert({
      user_id: user.id,
      old_license_id: oldLicenseId,
      new_license_id: newLicenseId,
      old_tier_id: oldLicense.tier_id,
      new_tier_id,
      upgrade_type: sameTier ? 'renewal' : 'upgrade',
      transfer_profile_count: transferCount,
      transfer_status: 'completed',
    })

    const { data: payment } = await admin.from('payments').insert({
      user_id: user.id,
      license_id: newLicenseId,
      tier_id: new_tier_id,
      duration,
      amount_vnd: price,
      method: 'upgrade',
      status: 'pending',
      memo: `Upgrade từ ${oldLicense.tier_id}/${oldLicense.duration} → ${new_tier_id}/${duration}`,
    }).select().single()

    return NextResponse.json({
      ok: true,
      message: 'Đã tạo giao dịch nâng cấp, vui lòng thanh toán để kích hoạt key mới.',
      newLicenseId,
      newKey,
      transferCount,
      price,
      payment: payment?.id,
    })
  } catch (error) {
    console.error('[/api/upgrade-license]', error)
    return NextResponse.json({ ok: false, message: 'Internal server error' }, { status: 500 })
  }
}
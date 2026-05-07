import { NextRequest, NextResponse } from 'next/server'
import { getServerClient, adminClient } from '@/lib/supabase'
import { PLAN_TIERS, DURATION_DAYS, type Duration } from '@/lib/plans'
import { v4 as uuidv4 } from 'uuid'

interface UpgradeRequest {
  licenseid: string
  new_tier_id: string
  duration: Duration
}

export async function POST(req: NextRequest) {
  const client = getServerClient()

  try {
    const { data: { user }, error: authError } = await client.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
    }

    const body: UpgradeRequest = await req.json()
    const { licenseid: oldLicenseId, new_tier_id, duration } = body

    if (!oldLicenseId || !new_tier_id || !duration) {
      return NextResponse.json({ ok: false, message: 'Missing required fields' }, { status: 400 })
    }

    // Verify old license
    const { data: oldLicense, error: oldLicenseError } = await client
      .from('licenses')
      .select('id, user_id, key, tier_id, expires_at, account_quota')
      .eq('id', oldLicenseId)
      .single()

    if (oldLicenseError || !oldLicense || oldLicense.user_id !== user.id) {
      return NextResponse.json({ ok: false, message: 'Old license not found' }, { status: 404 })
    }

    // Verify new tier exists
    const newTier = PLAN_TIERS.find((t) => t.id === new_tier_id)
    if (!newTier) {
      return NextResponse.json({ ok: false, message: 'Invalid new tier' }, { status: 400 })
    }

    const price = newTier.prices[duration]
    const durationDays = DURATION_DAYS[duration]

    // -- Create new license with same or extended expiry --
    const newExpiresAt = new Date()
    newExpiresAt.setDate(newExpiresAt.getDate() + durationDays)

    const admin = adminClient()
    const newLicenseId = uuidv4()
    const newKey = `ZM-${Date.now().toString(36).toUpperCase().slice(-6)}`

    // Start transaction via admin client
    const { data: newLicense, error: createLicenseError } = await admin
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
        status: 'active',
        parent_license_id: oldLicenseId, // Link to old license
      })
      .select()
      .single()

    if (createLicenseError) {
      return NextResponse.json({ ok: false, message: 'Failed to create new license' }, { status: 500 })
    }

    // -- Copy profiles from old license to new license --
    const { data: oldProfiles, error: getProfilesError } = await admin
      .from('profiles')
      .select('*')
      .eq('license_id', oldLicenseId)

    if (getProfilesError) {
      // Rollback: delete new license if profile copy fails
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
        // Rollback: delete new license if profile copy fails
        await admin.from('licenses').delete().eq('id', newLicenseId)
        return NextResponse.json({ ok: false, message: 'Failed to transfer profiles' }, { status: 500 })
      }

      transferCount = oldProfiles.length
    }

    // -- Record upgrade in license_upgrades table --
    await admin.from('license_upgrades').insert({
      user_id: user.id,
      old_license_id: oldLicenseId,
      new_license_id: newLicenseId,
      old_tier_id: oldLicense.tier_id,
      new_tier_id,
      upgrade_type: 'upgrade',
      transfer_profile_count: transferCount,
      transfer_status: 'completed',
    })

    // -- Create payment record for this upgrade --
    const { data: payment } = await admin.from('payments').insert({
      user_id: user.id,
      license_id: newLicenseId,
      tier_id: new_tier_id,
      duration,
      amount_vnd: price,
      method: 'upgrade',
      status: 'pending', // Awaiting SePay payment
      memo: `Upgrade từ ${oldLicense.tier_id} → ${new_tier_id}`,
    }).select().single()

    return NextResponse.json({
      ok: true,
      message: 'Upgrade created, awaiting payment',
      newKey,
      newLicenseId,
      transferCount,
      price,
      payment: payment?.id,
    })
  } catch (error) {
    console.error('[/api/upgrade-license]', error)
    return NextResponse.json({ ok: false, message: 'Internal server error' }, { status: 500 })
  }
}

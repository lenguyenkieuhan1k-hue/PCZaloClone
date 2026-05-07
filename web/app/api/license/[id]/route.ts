import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const client = getServerClient()
  const licenseId = params.id

  try {
    const { data: { user }, error: authError } = await client.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
    }

    // Verify license belongs to user
    const { data: license, error: licenseError } = await client
      .from('licenses')
      .select('id, user_id, key, tier_id, account_quota')
      .eq('id', licenseId)
      .single()

    if (licenseError || !license || license.user_id !== user.id) {
      return NextResponse.json({ ok: false, message: 'License not found' }, { status: 404 })
    }

    // Get profiles for this license
    const { data: profiles, error: profilesError } = await client
      .from('profiles')
      .select('id, profile_name, display_name, metadata, created_at, updated_at')
      .eq('license_id', licenseId)
      .order('created_at', { ascending: false })

    if (profilesError) {
      return NextResponse.json({ ok: false, message: profilesError.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      license: {
        id: license.id,
        key: license.key,
        tier_id: license.tier_id,
        account_quota: license.account_quota,
      },
      profiles: profiles || [],
      profileCount: profiles?.length || 0,
    })
  } catch (error) {
    console.error('[/api/license/:id/profiles]', error)
    return NextResponse.json({ ok: false, message: 'Internal server error' }, { status: 500 })
  }
}

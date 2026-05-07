import { NextRequest, NextResponse } from 'next/server'
import { serverClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const client = serverClient()

  try {
    const { data: { user }, error: authError } = await client.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 })
    }

    // Get all active licenses for user
    const { data: licenses, error: licensesError } = await client
      .from('licenses')
      .select('id, license_id, key, tier_id, account_quota, duration, expires_at, status, active_machine_id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (licensesError) {
      return NextResponse.json({ ok: false, message: licensesError.message }, { status: 500 })
    }

    // For each license, count profiles
    const licensesWithProfileCount = await Promise.all(
      (licenses || []).map(async (license) => {
        const { count } = await client
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('license_id', license.id)

        return {
          ...license,
          profileCount: count || 0,
        }
      })
    )

    // Calculate total active quota
    const totalQuota = licensesWithProfileCount
      .filter((l) => l.status === 'active' && new Date(l.expires_at) > new Date())
      .reduce((sum: number, l: any) => sum + l.account_quota, 0)

    return NextResponse.json({
      ok: true,
      licenses: licensesWithProfileCount,
      totalQuota: totalQuota || 1, // fallback to free tier
    })
  } catch (error) {
    console.error('[/api/licenses]', error)
    return NextResponse.json({ ok: false, message: 'Internal server error' }, { status: 500 })
  }
}

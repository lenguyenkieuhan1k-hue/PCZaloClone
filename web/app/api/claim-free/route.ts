import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { adminClient, serverClient } from '@/lib/supabase'
import { DURATION_DAYS, findPlan } from '@/lib/plans'

function redirectWithMessage(request: NextRequest, path: string, message: string) {
  const origin = new URL(request.url).origin
  const url = new URL(path, origin)
  url.searchParams.set('msg', message)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) {
    const origin = new URL(req.url).origin
    return NextResponse.redirect(`${origin}/auth/sign-in?next=${encodeURIComponent('/api/claim-free')}`)
  }

  const userClient = serverClient(accessToken)
  const { data: authData, error: authErr } = await userClient.auth.getUser(accessToken)
  if (authErr || !authData?.user?.id) {
    return redirectWithMessage(req, '/pricing', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
  }

  const userId = authData.user.id
  const freePlan = findPlan('tier-1', '1y')
  if (!freePlan) {
    return redirectWithMessage(req, '/pricing', 'Cấu hình gói miễn phí chưa sẵn sàng.')
  }

  const admin = adminClient()
  const { data: existing, error: existingErr } = await admin
    .from('licenses')
    .select('id,key,status,expires_at')
    .eq('user_id', userId)
    .eq('tier_id', 'tier-1')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingErr) {
    return redirectWithMessage(req, '/pricing', `Không kiểm tra được key miễn phí: ${existingErr.message}`)
  }

  if (existing?.key) {
    return redirectWithMessage(req, '/dashboard', `Bạn đã có key miễn phí: ${existing.key}`)
  }

  const { data: keyResp } = await admin.rpc('generate_license_key')
  const key = String(keyResp || ('ZM-' + crypto.randomBytes(8).toString('hex').toUpperCase()))
  const expiresAt = new Date(Date.now() + DURATION_DAYS['1y'] * 24 * 60 * 60 * 1000).toISOString()

  const { data: created, error: createErr } = await admin
    .from('licenses')
    .insert({
      user_id: userId,
      key,
      tier_id: freePlan.tier.id,
      account_quota: freePlan.tier.accountQuota,
      duration: '1y',
      expires_at: expiresAt,
      status: 'active',
    })
    .select('id,key')
    .single()

  if (createErr || !created?.id) {
    return redirectWithMessage(req, '/pricing', `Không tạo được key miễn phí: ${createErr?.message || 'unknown'}`)
  }

  await admin.from('audit_log').insert({
    actor_id: userId,
    license_id: created.id,
    action: 'claim-free-license',
    detail: { tierId: 'tier-1', quota: 1 },
  })

  return redirectWithMessage(req, '/dashboard', `Đã cấp key miễn phí thành công: ${created.key}`)
}

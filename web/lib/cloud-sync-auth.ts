import { NextRequest } from 'next/server'
import { adminClient, serverClient } from '@/lib/supabase'
import { verifyLicenseToken } from '@/lib/license-token'

/** Cookie dashboard hoặc Bearer license JWT — khớp session active. */
export async function resolveCloudAuth(req: NextRequest, sessionId: string) {
  const admin = adminClient()

  const bearer = req.headers.get('authorization') || ''
  if (bearer.toLowerCase().startsWith('bearer ')) {
    const token = bearer.slice(7).trim()
    const payload = await verifyLicenseToken(token)
    if (payload?.sub && payload?.session_id === sessionId) {
      const { data: license } = await admin
        .from('licenses')
        .select('id, user_id, active_session_id, status')
        .eq('id', payload.sub)
        .eq('status', 'active')
        .eq('active_session_id', sessionId)
        .maybeSingle()
      if (license?.user_id) {
        return { userId: license.user_id as string, licenseId: license.id as string }
      }
    }
  }

  const accessToken = req.cookies.get('sb-access-token')?.value
  if (!accessToken) return null
  const supabase = serverClient(accessToken)
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data?.user?.id) return null

  const { data: user } = await admin.from('users').select('id').eq('id', data.user.id).maybeSingle()
  if (!user) return null

  const { data: license } = await admin
    .from('licenses')
    .select('id, active_session_id, status')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .eq('active_session_id', sessionId)
    .maybeSingle()
  if (!license) return null

  return { userId: user.id, licenseId: license.id as string }
}

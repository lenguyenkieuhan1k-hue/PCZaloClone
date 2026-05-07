import { cookies } from 'next/headers'
import { serverClient, isAdminEmail } from '@/lib/supabase'

/* Read the user's auth cookie set by /auth/callback and resolve to a
 * Supabase user object on the server side. */

export interface SessionUser {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  accessToken: string
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const accessToken = cookies().get('sb-access-token')?.value
  if (!accessToken) return null
  const supabase = serverClient(accessToken)
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data?.user) return null
  return {
    id: data.user.id,
    email: data.user.email || '',
    displayName: (data.user.user_metadata?.name as string) || data.user.email || '',
    isAdmin: isAdminEmail(data.user.email),
    accessToken
  }
}

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/* Three flavors of Supabase client to keep secrets where they belong:
 *
 *   browserClient   — anon key, runs in the user's browser. RLS enforced.
 *   serverClient    — anon key, runs in Server Components / API routes.
 *                     Forwards the user's cookie session so RLS still works.
 *   adminClient     — SERVICE_ROLE_KEY, bypasses RLS. Use only inside API
 *                     routes that need to write licenses / log audit etc.
 *                     NEVER import this from a client component.
 */

// Next.js only statically inlines NEXT_PUBLIC_* vars via literal access,
// not dynamic bracket notation. So we must resolve known vars explicitly.
const ENV_MAP: Record<string, string | undefined> = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
}

function requireEnv(name: string): string {
  const value = ENV_MAP[name] ?? process.env[name]
  if (!value) throw new Error(`Missing env: ${name}`)
  return value
}

let _browserSingleton: SupabaseClient | null = null
export function browserClient(): SupabaseClient {
  if (_browserSingleton) return _browserSingleton
  _browserSingleton = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { persistSession: true, autoRefreshToken: true } }
  )
  return _browserSingleton
}

/** Server-side client for Route Handlers / Server Components. Pass the
 *  Authorization header from the incoming request to enforce RLS. */
export function serverClient(accessToken?: string): SupabaseClient {
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : undefined,
    }
  )
}

export function adminClient(): SupabaseClient {
  return createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const list = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase())
  return list.includes(email.toLowerCase())
}

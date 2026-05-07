'use strict'

/* ZaloMask Supabase session provider — STUB.
 *
 * Wires up the Cowork-mode "Đồng bộ đám mây" UI without yet hitting the
 * network. When Phase 2 of KE_HOACH lands (Supabase project created, anon
 * key in config.json), the TODOs below get replaced by real fetch calls.
 *
 * Schema we expect on Supabase side (Postgres table `zalo_sessions`):
 *   id              uuid primary key
 *   user_id         uuid (Supabase Auth user)
 *   profile_name    text not null
 *   display_name    text
 *   clone_id        text
 *   z_uuid          text
 *   payload         jsonb         — full SessionStore snapshot, AES encrypted client-side with passphrase
 *   payload_nonce   bytea
 *   updated_at      timestamptz default now()
 *   device_id       text          — fingerprint of the writer
 *   unique (user_id, profile_name)
 *
 * RLS: row visible only to its user_id. Edge function `sync-session` validates
 * device single-session rule (see KE_HOACH Phase 2).
 *
 * Until configured, every method returns a `not configured` error so the UI
 * surfaces it in tooltips / disabled buttons rather than silently failing.
 */

class SupabaseSessionProvider {
  constructor(options) {
    options = options || {}
    this.endpoint = options.endpoint || ''
    this.anonKey = options.anonKey || ''
    this.userToken = options.userToken || ''
    this.deviceId = options.deviceId || ''
  }

  getKind() { return 'supabase' }

  isConfigured() {
    return Boolean(this.endpoint && this.anonKey && this.userToken)
  }

  getStatus() {
    if (!this.endpoint || !this.anonKey) {
      return { ok: false, configured: false, message: 'Chưa nạp endpoint/anon key Supabase' }
    }
    if (!this.userToken) {
      return { ok: false, configured: false, message: 'Chưa đăng nhập tài khoản' }
    }
    return { ok: true, configured: true, message: 'Sẵn sàng đồng bộ đám mây' }
  }

  async push(_snapshot) {
    // TODO(phase-2): POST to /rest/v1/zalo_sessions?on_conflict=user_id,profile_name
    //                with `Prefer: resolution=merge-duplicates`. AES-GCM
    //                encrypt the payload field with the user's passphrase
    //                first; only the encrypted blob touches the network.
    return { ok: false, message: 'Supabase provider chưa được cấu hình (Phase 2)' }
  }

  async pull(_profileName) {
    // TODO(phase-2): GET /rest/v1/zalo_sessions?profile_name=eq.<name>&select=*
    //                Decrypt payload locally before returning.
    return null
  }

  async list() {
    // TODO(phase-2): GET /rest/v1/zalo_sessions?select=profile_name,display_name,z_uuid,updated_at
    return []
  }

  async remove(_profileName) {
    // TODO(phase-2): DELETE /rest/v1/zalo_sessions?profile_name=eq.<name>
    return { ok: false, message: 'Supabase provider chưa được cấu hình (Phase 2)' }
  }
}

module.exports = { SupabaseSessionProvider }

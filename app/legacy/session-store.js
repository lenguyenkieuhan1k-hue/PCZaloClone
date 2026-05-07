'use strict'

/* ZaloMask SessionStore
 *
 * Single source of truth for portable account state. Snapshots produced by
 * the live runtime collector (clone-runtime-collector.js → preload bridge →
 * IPC) are merged here, then exported / imported / synced through a
 * pluggable provider interface.
 *
 * The whole point of this module is that consumers — main.js export/import
 * handlers, the cloud-sync UI, future Supabase background sync — never poke
 * inside Zalo's data dirs themselves. They just call store.get / store.put /
 * store.list / store.applySeedFor and let the store handle persistence.
 */

const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 1
const SNAPSHOT_FILENAME = 'session-snapshot.json'
const SEED_FILENAME = 'zalomask-seed.json'

/* ---------- Helpers ---------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const text = fs.readFileSync(filePath, 'utf8')
    if (!text.trim()) return null
    return JSON.parse(text)
  } catch (_) {
    return null
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath))
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

function nowIso() { return new Date().toISOString() }

function pickString(value) {
  return typeof value === 'string' ? value : ''
}

function makeEmptySnapshot(meta) {
  return {
    schemaVersion: SCHEMA_VERSION,
    profileName: pickString(meta && meta.profileName),
    displayName: pickString(meta && meta.displayName),
    cloneId: pickString(meta && meta.cloneId),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastCollectedAt: null,
    lastSyncedAt: null,
    identity: { zUuid: '', clientId: '' },
    session: {
      decryptKey: '',
      commonParams: '',
      labelVersion: '',
      userId: '',
      rawHints: {}
    },
    me: null,
    storage: { localStorage: {}, sessionStorage: {} },
    cookies: [],
    cookieKeyB64: null,
    page: { url: '', userAgent: '' }
  }
}

function mergeSnapshot(base, incoming) {
  // "Most recent non-empty wins" merge. Cookie key & cookies are owned by
  // main-process collectors and have separate setters; we don't drop them
  // when a renderer-only snapshot arrives without those fields.
  const out = base || makeEmptySnapshot({})
  out.schemaVersion = SCHEMA_VERSION

  if (incoming && incoming.identity) {
    if (incoming.identity.zUuid) out.identity.zUuid = String(incoming.identity.zUuid).trim()
    if (incoming.identity.clientId) out.identity.clientId = String(incoming.identity.clientId).trim()
  }

  if (incoming && incoming.session) {
    const src = incoming.session
    if (src.decryptKey) out.session.decryptKey = String(src.decryptKey)
    if (src.commonParams) out.session.commonParams = String(src.commonParams)
    if (src.labelVersion) out.session.labelVersion = String(src.labelVersion)
    if (src.userId) out.session.userId = String(src.userId)
    if (src.rawHints && typeof src.rawHints === 'object') {
      out.session.rawHints = Object.assign({}, out.session.rawHints || {}, src.rawHints)
    }
  }

  if (incoming && incoming.me && typeof incoming.me === 'object') {
    out.me = incoming.me
  }

  if (incoming && incoming.storage) {
    if (incoming.storage.localStorage && typeof incoming.storage.localStorage === 'object') {
      out.storage.localStorage = incoming.storage.localStorage
    }
    if (incoming.storage.sessionStorage && typeof incoming.storage.sessionStorage === 'object') {
      out.storage.sessionStorage = incoming.storage.sessionStorage
    }
  }

  if (incoming && incoming.page) {
    if (incoming.page.url) out.page.url = String(incoming.page.url)
    if (incoming.page.userAgent) out.page.userAgent = String(incoming.page.userAgent)
  }

  out.updatedAt = nowIso()
  out.lastCollectedAt = (incoming && incoming.capturedAt) || nowIso()
  return out
}

/* ---------- Provider interface ----------
 *
 * A provider is anything with this shape:
 *   async push(snapshot)        => { ok, message?, remoteId? }
 *   async pull(profileName)     => snapshot|null
 *   async list()                => array of { profileName, displayName, lastSyncedAt }
 *   async remove(profileName)   => { ok, message? }
 *   getKind()                   => 'local' | 'supabase' | ...
 *   getStatus()                 => { ok, configured, message }
 *
 * Local provider is the default and always available.
 */

class LocalSessionProvider {
  constructor({ profilesRoot }) {
    if (!profilesRoot) throw new Error('LocalSessionProvider needs profilesRoot')
    this.profilesRoot = profilesRoot
  }
  getKind() { return 'local' }
  getStatus() { return { ok: true, configured: true, message: 'Lưu local trên máy này' } }

  _snapshotPath(profileName) {
    return path.join(this.profilesRoot, profileName, SNAPSHOT_FILENAME)
  }

  async push(snapshot) {
    if (!snapshot || !snapshot.profileName) return { ok: false, message: 'Snapshot thiếu profileName' }
    const target = this._snapshotPath(snapshot.profileName)
    const stamped = Object.assign({}, snapshot, { lastSyncedAt: nowIso() })
    writeJsonAtomic(target, stamped)
    return { ok: true, remoteId: target }
  }

  async pull(profileName) {
    if (!profileName) return null
    return readJsonSafe(this._snapshotPath(profileName))
  }

  async list() {
    if (!fs.existsSync(this.profilesRoot)) return []
    const out = []
    for (const entry of fs.readdirSync(this.profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const snap = readJsonSafe(path.join(this.profilesRoot, entry.name, SNAPSHOT_FILENAME))
      if (!snap) continue
      out.push({
        profileName: snap.profileName || entry.name,
        displayName: snap.displayName || entry.name,
        cloneId: snap.cloneId || '',
        lastCollectedAt: snap.lastCollectedAt || null,
        lastSyncedAt: snap.lastSyncedAt || null,
        zUuid: (snap.identity && snap.identity.zUuid) || '',
        cookieCount: Array.isArray(snap.cookies) ? snap.cookies.length : 0
      })
    }
    return out
  }

  async remove(profileName) {
    if (!profileName) return { ok: false, message: 'profileName trống' }
    const target = this._snapshotPath(profileName)
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target)
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e.message }
    }
  }
}

/* ---------- SessionStore ---------- */

class SessionStore {
  constructor({ profilesRoot, cloneDataRootResolver, providers, defaultProvider }) {
    if (!profilesRoot) throw new Error('SessionStore needs profilesRoot')
    if (typeof cloneDataRootResolver !== 'function') {
      throw new Error('SessionStore needs cloneDataRootResolver(cloneId) -> path')
    }
    this.profilesRoot = profilesRoot
    this.cloneDataRootResolver = cloneDataRootResolver
    this.providers = Object.assign({}, providers || {})
    if (!this.providers.local) {
      this.providers.local = new LocalSessionProvider({ profilesRoot })
    }
    this.defaultProvider = defaultProvider || 'local'
  }

  _snapshotPath(profileName) {
    return path.join(this.profilesRoot, profileName, SNAPSHOT_FILENAME)
  }

  _seedPath(cloneId) {
    const dataRoot = this.cloneDataRootResolver(cloneId)
    return path.join(dataRoot, SEED_FILENAME)
  }

  ensureProfileDir(profileName) {
    ensureDir(path.join(this.profilesRoot, profileName))
  }

  /* ---------- Snapshot CRUD ---------- */

  async get(profileName) {
    if (!profileName) return null
    return readJsonSafe(this._snapshotPath(profileName))
  }

  async list() {
    return this.providers.local.list()
  }

  /** Merge an incoming runtime snapshot from a clone renderer into storage. */
  async record(profileName, incoming, meta) {
    if (!profileName) return { ok: false, message: 'profileName trống' }
    this.ensureProfileDir(profileName)
    const existing = readJsonSafe(this._snapshotPath(profileName))
      || makeEmptySnapshot({ profileName, displayName: meta && meta.displayName, cloneId: meta && meta.cloneId })
    if (meta && meta.displayName) existing.displayName = String(meta.displayName)
    if (meta && meta.cloneId) existing.cloneId = String(meta.cloneId)
    existing.profileName = profileName
    const merged = mergeSnapshot(existing, incoming)
    writeJsonAtomic(this._snapshotPath(profileName), merged)
    // Also refresh the seed file used at next clone launch.
    if (merged.cloneId) {
      try { this.writeSeedFor(merged.cloneId, merged) } catch (_) {}
    }
    return { ok: true, snapshot: merged }
  }

  /** Replace cookie + cookieKey fields (these come from main process, not renderer). */
  async setCookies(profileName, cookies, cookieKeyB64) {
    if (!profileName) return { ok: false, message: 'profileName trống' }
    this.ensureProfileDir(profileName)
    const existing = readJsonSafe(this._snapshotPath(profileName)) || makeEmptySnapshot({ profileName })
    existing.profileName = profileName
    if (Array.isArray(cookies)) existing.cookies = cookies
    if (typeof cookieKeyB64 === 'string' && cookieKeyB64) existing.cookieKeyB64 = cookieKeyB64
    existing.updatedAt = nowIso()
    writeJsonAtomic(this._snapshotPath(profileName), existing)
    return { ok: true, snapshot: existing }
  }

  async removeProfile(profileName) {
    try {
      const snapPath = this._snapshotPath(profileName)
      if (fs.existsSync(snapPath)) fs.unlinkSync(snapPath)
    } catch (_) {}
    for (const key of Object.keys(this.providers)) {
      try { await this.providers[key].remove(profileName) } catch (_) {}
    }
  }

  /* ---------- Seed file (consumed by clone-session-preload at boot) ---------- */

  /** Produce the seed JSON the preload reads on next renderer boot.
   *
   * Zalo PC keeps many login-relevant flags in localStorage besides
   * sh_z_uuid (sh_login_info, sh_user_ids, sh_zpw_ver, sh_zlast_uid,
   * 0_first_login_time, etc.). Without those the destination machine still
   * shows the QR screen even though cookies + cookieKey + uuid match. So we
   * include the WHOLE captured localStorage / sessionStorage map.
   *
   * Identity values from snapshot.identity / snapshot.session take
   * precedence over storage values so re-export → import preserves
   * everything even if the source-side collector ran one frame too late. */
  buildSeed(snapshot) {
    if (!snapshot) return null
    const fromStorage = (snapshot.storage && snapshot.storage.localStorage) || {}
    const fromSession = (snapshot.storage && snapshot.storage.sessionStorage) || {}
    const localStorageSeed = {}
    const sessionStorageSeed = {}
    for (const [k, v] of Object.entries(fromStorage)) {
      if (typeof k === 'string' && typeof v === 'string') localStorageSeed[k] = v
    }
    for (const [k, v] of Object.entries(fromSession)) {
      if (typeof k === 'string' && typeof v === 'string') sessionStorageSeed[k] = v
    }
    // Identity overrides — make sure both keys are present even if the
    // captured storage lacked one of them.
    if (snapshot.identity && snapshot.identity.zUuid) {
      localStorageSeed.sh_z_uuid = snapshot.identity.zUuid
      localStorageSeed.z_uuid = snapshot.identity.zUuid
    }
    if (snapshot.session) {
      if (snapshot.session.decryptKey) localStorageSeed.decryptKey = snapshot.session.decryptKey
      if (snapshot.session.commonParams) localStorageSeed.commonParams = snapshot.session.commonParams
      if (snapshot.session.labelVersion) localStorageSeed.labelVersion = snapshot.session.labelVersion
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      writtenAt: nowIso(),
      identity: { zUuid: (snapshot.identity && snapshot.identity.zUuid) || '' },
      localStorage: localStorageSeed,
      sessionStorage: sessionStorageSeed
    }
  }

  writeSeedFor(cloneId, snapshot) {
    if (!cloneId) return null
    const seed = this.buildSeed(snapshot)
    if (!seed) return null
    const seedPath = this._seedPath(cloneId)
    writeJsonAtomic(seedPath, seed)
    return seedPath
  }

  /** Read the source-of-truth snapshot for a profile and (re)write its seed file. */
  async refreshSeed(profileName) {
    const snap = await this.get(profileName)
    if (!snap || !snap.cloneId) return { ok: false, message: 'Profile không có cloneId hoặc snapshot' }
    const seedPath = this.writeSeedFor(snap.cloneId, snap)
    return { ok: !!seedPath, seedPath }
  }

  getSeedPathFor(cloneId) {
    return this._seedPath(cloneId)
  }

  /* ---------- Provider sync ---------- */

  getProvider(name) {
    return this.providers[name] || this.providers[this.defaultProvider]
  }

  listProviders() {
    return Object.keys(this.providers).map((key) => ({
      key,
      kind: this.providers[key].getKind(),
      status: this.providers[key].getStatus(),
      isDefault: key === this.defaultProvider
    }))
  }

  async pushTo(providerKey, profileName) {
    const provider = this.getProvider(providerKey)
    if (!provider) return { ok: false, message: 'Provider không tồn tại' }
    const snap = await this.get(profileName)
    if (!snap) return { ok: false, message: 'Chưa có snapshot cho profile này' }
    const result = await provider.push(snap)
    if (result && result.ok) {
      snap.lastSyncedAt = nowIso()
      writeJsonAtomic(this._snapshotPath(profileName), snap)
    }
    return result
  }

  async pullFrom(providerKey, profileName) {
    const provider = this.getProvider(providerKey)
    if (!provider) return { ok: false, message: 'Provider không tồn tại' }
    const remote = await provider.pull(profileName)
    if (!remote) return { ok: false, message: 'Chưa có snapshot trên cloud cho profile này' }
    this.ensureProfileDir(profileName)
    writeJsonAtomic(this._snapshotPath(profileName), remote)
    if (remote.cloneId) {
      try { this.writeSeedFor(remote.cloneId, remote) } catch (_) {}
    }
    return { ok: true, snapshot: remote }
  }
}

module.exports = {
  SessionStore,
  LocalSessionProvider,
  SCHEMA_VERSION,
  SNAPSHOT_FILENAME,
  SEED_FILENAME,
  // Exposed for tests / future migrations.
  _internal: { mergeSnapshot, makeEmptySnapshot }
}
